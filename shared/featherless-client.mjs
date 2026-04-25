/**
 * Featherless client — specialized OSS model gateway.
 *
 * Used for 1-2 sub-agent units so the project qualifies for the Featherless
 * hackathon track. OpenAI-compatible API, so this module is intentionally
 * tiny and mirrors the AIMLAPI client shape.
 */

function getBaseUrl() {
  return process.env.FEATHERLESS_BASE_URL || "https://api.featherless.ai/v1";
}

function getApiKey() {
  return process.env.FEATHERLESS_API_KEY || "";
}

function getDefaultModel() {
  return process.env.FEATHERLESS_DEFAULT_MODEL || "meta-llama/Meta-Llama-3.1-70B-Instruct";
}

function getDefaultTimeoutMs() {
  return Math.max(2_000, Number(process.env.FEATHERLESS_TIMEOUT_MS || 25_000));
}

let featherlessCircuit = { openUntil: 0, reason: null };

function isCircuitOpen() {
  return Date.now() < featherlessCircuit.openUntil;
}

/**
 * Strip the Authorization bearer header from any error message before it
 * goes near a log. Some Node fetch implementations include the request
 * headers in the thrown error chain — without this redaction a single
 * `fetch failed` could leak the API key into stdout, then into log
 * shipping / GitHub Actions / Sentry breadcrumbs forever.
 */
function sanitizeErrorMessage(message) {
  return String(message || "")
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]")
    .replace(/(authorization["':\s=]+)["']?[A-Za-z0-9_\-.]+["']?/gi, "$1[REDACTED]")
    // Featherless keys start with `rc_`. Catch them anywhere in free-form
    // errors (e.g. "fetch failed for https://...?key=rc_xxx").
    .replace(/\brc_[A-Za-z0-9]{20,}/g, "rc_[REDACTED]");
}

function tripCircuit(reason, durationMs = 5 * 60_000) {
  featherlessCircuit = { openUntil: Date.now() + durationMs, reason };
}

function resetCircuit() {
  // Cleared explicitly on a successful response — without this a transient
  // 429 / rate-limit locked the client for 10+ minutes even after Featherless
  // recovered, silently forcing every unit onto the AIMLAPI fallback.
  if (featherlessCircuit.openUntil !== 0) {
    featherlessCircuit = { openUntil: 0, reason: null };
  }
}

export function hasFeatherlessKey() {
  return Boolean(getApiKey()) && !isCircuitOpen();
}

export function getFeatherlessCircuitStatus() {
  return { ...featherlessCircuit, open: isCircuitOpen() };
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

export async function featherlessChat({
  model,
  systemPrompt,
  userPrompt,
  messages,
  maxTokens = 400,
  temperature = 0.4,
  timeoutMs
}) {
  if (!getApiKey()) {
    return { ok: false, reason: "no-api-key", text: null };
  }

  const resolvedTimeoutMs = timeoutMs ?? getDefaultTimeoutMs();
  const resolvedModel = model || getDefaultModel();

  const payloadMessages = Array.isArray(messages) && messages.length
    ? messages
    : [
        ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
        ...(userPrompt ? [{ role: "user", content: userPrompt }] : [])
      ];

  if (payloadMessages.length === 0) {
    return { ok: false, reason: "empty-prompt", text: null };
  }

  try {
    const response = await fetchWithTimeout(
      `${getBaseUrl()}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${getApiKey()}`
        },
        body: JSON.stringify({
          model: resolvedModel,
          messages: payloadMessages,
          max_tokens: maxTokens,
          temperature
        })
      },
      resolvedTimeoutMs
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // Auth errors (401 / 403) are *configuration* failures — the key is
      // missing or wrong, not exhausted. Use a longer circuit cooldown and
      // emit a loud operator-facing log so nobody mistakes the silent
      // AIMLAPI fallback for "Featherless is just slow today".
      if (response.status === 401 || response.status === 403) {
        tripCircuit(`http-${response.status}`, 60 * 60_000);
        console.error(
          `[featherless] FEATHERLESS_API_KEY appears invalid (HTTP ${response.status}). ` +
          `Every Featherless-bound unit will silently fall back to AIMLAPI for the next hour — fix the key.`
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
