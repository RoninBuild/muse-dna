/**
 * Shared AIMLAPI client used by Muse DNA agents.
 *
 * AIMLAPI exposes an OpenAI-compatible surface, so the chat endpoint mirrors the
 * OpenAI schema. Each micro-agent picks a different model, so a single physical
 * API key fans out to many "specialized sub-agents" — this is the whole premise
 * the hackathon demo depends on.
 *
 * - Chat:   POST https://api.aimlapi.com/v1/chat/completions
 * - Images: POST https://api.aimlapi.com/v1/images/generations
 */

function getBaseUrl() {
  // Strip trailing slashes so `${base}/chat/completions` never produces a
  // double slash against operator-configured AIMLAPI_BASE_URL values.
  return String(process.env.AIMLAPI_BASE_URL || "https://api.aimlapi.com/v1").replace(/\/+$/, "");
}

function getApiKey() {
  return process.env.AIMLAPI_API_KEY || "";
}

// Circuit breaker — mirrors the featherless-client pattern. When AIMLAPI
// returns a hard auth / rate-limit failure we open the circuit so the next
// burst of calls fails fast instead of hammering the upstream and blocking
// on timeouts. Auth errors (401/403) are config failures and stay open for
// a full hour so operators notice; quota errors (429/402) open for 10 min.
const aimlCircuit = { openUntil: 0, reason: null };

function tripCircuit(reason, durationMs) {
  aimlCircuit.reason = reason;
  aimlCircuit.openUntil = Date.now() + durationMs;
}

function resetCircuit() {
  // Closing the breaker on a successful call lets us recover from a
  // transient 429 / 402 without waiting the full cool-down. Missing
  // this reset was the reason degraded mode stuck for 10 minutes even
  // after quota refilled.
  aimlCircuit.reason = null;
  aimlCircuit.openUntil = 0;
}

function isCircuitOpen() {
  return aimlCircuit.openUntil > Date.now();
}

export function getAimlCircuitStatus() {
  return {
    open: isCircuitOpen(),
    openUntil: aimlCircuit.openUntil,
    reason: aimlCircuit.reason
  };
}

function getDefaultChatModel() {
  return process.env.AIMLAPI_DEFAULT_CHAT_MODEL || "gpt-4o-mini";
}

function getDefaultImageModel() {
  return process.env.AIMLAPI_DEFAULT_IMAGE_MODEL || "flux/schnell";
}

function getDefaultTimeoutMs() {
  return Math.max(2_000, Number(process.env.AIMLAPI_TIMEOUT_MS || 20_000));
}

export function hasAimlKey() {
  return Boolean(getApiKey());
}

function authHeaders() {
  return {
    "content-type": "application/json",
    Authorization: `Bearer ${getApiKey()}`
  };
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Redact `Bearer <token>` fragments from arbitrary strings. Some fetch
 * implementations include the Authorization header verbatim in error
 * stacks / "fetch failed" serializations; if we route those through our
 * own logs we must never leak the API key.
 */
function sanitizeErrorMessage(value) {
  return String(value ?? "").replace(/Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, "Bearer [REDACTED]");
}

/**
 * Call the AIMLAPI chat endpoint. `model` is required — each unit picks its own
 * so we do not silently fold everything into one model.
 */
export async function aimlChat({
  model,
  systemPrompt,
  userPrompt,
  messages,
  maxTokens = 400,
  temperature = 0.4,
  responseFormat,
  timeoutMs
}) {
  if (!getApiKey()) {
    return { ok: false, reason: "no-api-key", text: null };
  }

  if (isCircuitOpen()) {
    // Fail fast instead of spending ~20s round-tripping to a known-broken
    // upstream. The circuit is opened on auth / quota failures below.
    return {
      ok: false,
      reason: `circuit-open:${aimlCircuit.reason || "unknown"}`,
      text: null,
      model: model || getDefaultChatModel()
    };
  }

  const resolvedTimeoutMs = timeoutMs ?? getDefaultTimeoutMs();
  const resolvedModel = model || getDefaultChatModel();

  // Claude models on AIMLAPI do NOT accept role=system inside messages.
  // Their schema expects only user/assistant. Merge the system prompt into
  // the first user turn when the target model is a Claude family member.
  const isClaudeModel = /(^|\/)(claude|anthropic)/i.test(resolvedModel);

  let payloadMessages;
  if (Array.isArray(messages) && messages.length) {
    if (isClaudeModel) {
      // Defensive: upstream bugs can produce `content: undefined` on a
      // system message. Naive `.join("\n")` would then interpolate the
      // literal string "undefined" into the merged Claude prompt. Coerce
      // to "" so the prompt is not poisoned.
      const systemCombined = messages
        .filter((m) => m.role === "system")
        .map((m) => String(m.content ?? ""))
        .join("\n")
        .trim();
      const nonSystem = messages.filter((m) => m.role !== "system");
      if (systemCombined) {
        const firstUserIndex = nonSystem.findIndex((m) => m.role === "user");
        if (firstUserIndex >= 0) {
          nonSystem[firstUserIndex] = {
            ...nonSystem[firstUserIndex],
            content: `${systemCombined}\n\n${nonSystem[firstUserIndex].content}`
          };
        } else {
          nonSystem.unshift({ role: "user", content: systemCombined });
        }
      }
      payloadMessages = nonSystem;
    } else {
      payloadMessages = messages;
    }
  } else {
    if (isClaudeModel) {
      const merged = [systemPrompt, userPrompt].filter(Boolean).join("\n\n").trim();
      payloadMessages = merged ? [{ role: "user", content: merged }] : [];
    } else {
      payloadMessages = [
        ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
        ...(userPrompt ? [{ role: "user", content: userPrompt }] : [])
      ];
    }
  }

  if (payloadMessages.length === 0) {
    return { ok: false, reason: "empty-prompt", text: null };
  }

  // Force every message through `String(... ?? "")` so a nested undefined
  // content field cannot get stripped by JSON.stringify and leave the
  // server with a role-only message that rejects or silently misbehaves.
  const sanitizedMessages = payloadMessages.map((m) => ({
    ...m,
    content: String(m?.content ?? "")
  }));

  const body = {
    model: resolvedModel,
    messages: sanitizedMessages,
    max_tokens: maxTokens,
    temperature
  };

  if (responseFormat) {
    body.response_format = responseFormat;
  }

  try {
    const response = await fetchWithTimeout(
      `${getBaseUrl()}/chat/completions`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body)
      },
      resolvedTimeoutMs
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        tripCircuit(`http-${response.status}`, 60 * 60_000);
        console.error(
          `[aimlapi] AIMLAPI_API_KEY appears invalid (HTTP ${response.status}). ` +
          `Every AIMLAPI-bound call will fail fast for the next hour — fix the key.`
        );
      } else if (response.status === 429 || response.status === 402) {
        tripCircuit(`http-${response.status}`, 10 * 60_000);
      }
      return {
        ok: false,
        reason: `http-${response.status}`,
        text: null,
        errorBody: text.slice(0, 400),
        model: resolvedModel
      };
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    const trimmed = typeof content === "string" ? content.trim() : "";

    if (!trimmed) {
      return {
        ok: false,
        reason: "empty-response",
        text: null,
        model: resolvedModel
      };
    }

    resetCircuit();
    return {
      ok: true,
      text: trimmed,
      model: resolvedModel,
      usage: data?.usage || null
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "timeout" : "network",
      text: null,
      errorMessage: sanitizeErrorMessage(error?.message || error),
      model: resolvedModel
    };
  }
}

/**
 * Generate an image via AIMLAPI. Returns `{ ok, url, model }`.
 */
export async function aimlImage({
  model,
  prompt,
  size = "1024x1024",
  timeoutMs
}) {
  if (!getApiKey()) {
    return { ok: false, reason: "no-api-key", url: null };
  }

  if (isCircuitOpen()) {
    return {
      ok: false,
      reason: `circuit-open:${aimlCircuit.reason || "unknown"}`,
      url: null,
      model: model || getDefaultImageModel()
    };
  }

  if (!prompt?.trim()) {
    return { ok: false, reason: "empty-prompt", url: null };
  }

  const resolvedTimeoutMs = timeoutMs ?? getDefaultTimeoutMs() * 2;
  const resolvedModel = model || getDefaultImageModel();
  const body = {
    model: resolvedModel,
    prompt: prompt.trim(),
    size,
    n: 1
  };

  try {
    const response = await fetchWithTimeout(
      `${getBaseUrl()}/images/generations`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body)
      },
      resolvedTimeoutMs
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        reason: `http-${response.status}`,
        url: null,
        errorBody: text.slice(0, 400),
        model: resolvedModel
      };
    }

    const data = await response.json();
    // Some AIMLAPI image backends return 200 OK with a structured error in
    // `errors` / `error` instead of an HTTP failure. Surface these as
    // specific `api-error` reasons so the caller can distinguish "bad
    // prompt" from "no url produced".
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      return {
        ok: false,
        reason: "api-error",
        errorBody: JSON.stringify(data.errors).slice(0, 400),
        url: null,
        model: resolvedModel
      };
    }
    if (data?.error) {
      return {
        ok: false,
        reason: "api-error",
        errorBody: String(typeof data.error === "string" ? data.error : JSON.stringify(data.error)).slice(0, 400),
        url: null,
        model: resolvedModel
      };
    }

    const url =
      data?.data?.[0]?.url ||
      data?.images?.[0]?.url ||
      data?.output?.[0]?.url ||
      data?.url ||
      null;
    const b64 = data?.data?.[0]?.b64_json || data?.images?.[0]?.b64_json || null;

    if (!url && !b64) {
      return {
        ok: false,
        reason: "missing-image-url",
        url: null,
        model: resolvedModel
      };
    }

    resetCircuit();
    return {
      ok: true,
      url: url || `data:image/png;base64,${b64}`,
      model: resolvedModel
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "timeout" : "network",
      url: null,
      errorMessage: sanitizeErrorMessage(error?.message || error),
      model: resolvedModel
    };
  }
}
