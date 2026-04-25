import { circleWallet } from "./circleWallet.js";

// Agent fallback chains (Featherless → AIMLAPI → Hermes) can spend ~24s
// resolving before producing a response. Plus the agent runs TWO Circle
// Gateway round trips (verify + settle) with 1.5s fixed sleeps each, so
// the total worst-case inbound request window is ~32s even on a
// healthy network. Setting to 45s gives real margin — previous 30s
// caused orchestrator AbortErrors just as the agent was about to hand
// back its PAYMENT-RESPONSE header.
const DEFAULT_X402_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.MUSE_X402_TIMEOUT_MS || 45_000)
);

function normalizeAddress(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function getTimeoutMs(timeoutMs) {
  const parsed = Number(timeoutMs || DEFAULT_X402_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_X402_TIMEOUT_MS;
}

async function runWithTimeout(taskFactory, timeoutMs, agentName, stage) {
  let timer = null;

  try {
    return await Promise.race([
      taskFactory(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Agent ${agentName} ${stage} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function mergeSettlementIntoBody(body, settlement) {
  if (!settlement) {
    return body;
  }

  const existingPayment = body?.payment && typeof body.payment === "object"
    ? body.payment
    : {};
  const transactionReference =
    existingPayment.txHash ||
    existingPayment.transaction ||
    settlement.transaction ||
    null;

  return {
    ...body,
    payment: {
      ...existingPayment,
      txHash: transactionReference,
      transaction: existingPayment.transaction || transactionReference,
      amountUsdc:
        existingPayment.amountUsdc ??
        (settlement.amount ? Number(settlement.amount) / 1_000_000 : undefined),
      network: existingPayment.network || settlement.network || null,
      payer: existingPayment.payer || settlement.payer || null,
      arcUrl: existingPayment.arcUrl || null
    }
  };
}

function describeErrorBody(bodyText) {
  const normalized = String(bodyText || "").trim();

  if (!normalized) {
    return "";
  }

  try {
    const parsed = JSON.parse(normalized);
    const errorMessage =
      parsed?.error ||
      parsed?.detail ||
      parsed?.message ||
      parsed?.payment?.error ||
      null;

    if (typeof errorMessage === "string" && errorMessage.trim()) {
      return errorMessage.trim();
    }
  } catch {
    // Response body is not JSON - fall back to the raw text.
  }

  return normalized.slice(0, 300);
}

function constrainPaymentRequiredToExpectedSeller(paymentRequired, agentWalletAddress, agentName) {
  const expectedAddress = normalizeAddress(agentWalletAddress);

  if (!expectedAddress) {
    return paymentRequired;
  }

  const matchingRequirements = (paymentRequired.accepts || []).filter(
    (requirement) => normalizeAddress(requirement.payTo) === expectedAddress
  );

  if (matchingRequirements.length === 0) {
    throw new Error(`Agent ${agentName} challenged payment to an unexpected wallet`);
  }

  return {
    ...paymentRequired,
    accepts: matchingRequirements
  };
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs, agentName, stage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    const message = String(error?.message || "");
    const wasAborted = error?.name === "AbortError" || /aborted|timed out/i.test(message);

    if (wasAborted) {
      throw new Error(`Agent ${agentName} ${stage} timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function callAgentWithX402({
  url,
  payload,
  agentName,
  circleWalletClient = circleWallet,
  agentWalletAddress = null,
  fetchImpl = fetch,
  requireChallenge = process.env.REQUIRE_X402_CHALLENGE !== "false",
  timeoutMs = DEFAULT_X402_TIMEOUT_MS
}) {
  const requestTimeoutMs = getTimeoutMs(timeoutMs);

  const initialResponse = await fetchWithTimeout(fetchImpl, url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  }, requestTimeoutMs, agentName, "payment discovery");

  if (initialResponse.status === 402) {
    let challengeBody = null;

    try {
      challengeBody = await runWithTimeout(
        () => initialResponse.json(),
        requestTimeoutMs,
        agentName,
        "payment challenge body"
      );
    } catch (error) {
      if (/timed out/i.test(String(error?.message || ""))) {
        throw error;
      }

      challengeBody = null;
    }

    const paymentRequired = constrainPaymentRequiredToExpectedSeller(
      circleWalletClient.getPaymentRequiredResponse(
        (name) =>
          typeof initialResponse.headers?.get === "function"
            ? initialResponse.headers.get(name)
            : null,
        challengeBody
      ),
      agentWalletAddress,
      agentName
    );
    const paymentPayload = await circleWalletClient.createPaymentPayload(paymentRequired);
    const paidResponse = await fetchWithTimeout(fetchImpl, url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...circleWalletClient.encodePaymentSignatureHeader(paymentPayload)
      },
      body: JSON.stringify(payload)
    }, requestTimeoutMs, agentName, "paid execution");

    if (!paidResponse.ok) {
      const body = await runWithTimeout(
        () => paidResponse.text(),
        requestTimeoutMs,
        agentName,
        "paid response body"
      );
      const reason = describeErrorBody(body);
      throw new Error(
        `Agent ${agentName} failed after x402 payment with ${paidResponse.status}: ${reason}`
      );
    }

    const settlement = (() => {
      const getHeader = (name) =>
        typeof paidResponse.headers?.get === "function"
          ? paidResponse.headers.get(name)
          : null;
      const rawHeader = getHeader("PAYMENT-RESPONSE");
      if (!rawHeader) {
        console.warn(`Agent ${agentName} paid response did not include a PAYMENT-RESPONSE header`);
        return null;
      }
      try {
        return circleWalletClient.getPaymentSettleResponse(getHeader);
      } catch (error) {
        console.warn(`Agent ${agentName} PAYMENT-RESPONSE header could not be decoded: ${error?.message || error}`);
        return null;
      }
    })();
    const responseBody = await runWithTimeout(
      () => paidResponse.json(),
      requestTimeoutMs,
      agentName,
      "paid response body"
    );

    const merged = mergeSettlementIntoBody(responseBody, settlement);
    // A settled unit MUST carry a transaction reference (Gateway receipt
    // or body-provided txHash) — otherwise the orchestrator's direct
    // on-chain path has nothing to override and the ledger row ends up
    // with a null hash. Fail fast so the unit retry kicks in.
    const txRef = merged?.payment?.txHash || merged?.payment?.transaction;
    if (!txRef || typeof txRef !== "string" || !txRef.trim()) {
      throw new Error(`Agent ${agentName} returned 200 with no payment receipt (missing txHash)`);
    }

    return merged;
  }

  if (requireChallenge) {
    throw new Error(`Agent ${agentName} returned 200 without an x402 payment challenge`);
  }

  if (!initialResponse.ok) {
    const body = await runWithTimeout(
      () => initialResponse.text(),
      requestTimeoutMs,
      agentName,
      "response body"
    );
    const reason = describeErrorBody(body);
    throw new Error(
      `Agent ${agentName} failed with ${initialResponse.status}: ${reason}`
    );
  }

  return runWithTimeout(
    () => initialResponse.json(),
    requestTimeoutMs,
    agentName,
    "response body"
  );
}
