/**
 * Gemini client used by the Hermes orchestrator "brain".
 *
 * - Native Google AI Studio endpoint (generativelanguage.googleapis.com).
 * - Supports Function Calling so Gemini can invoke Circle / x402 tools as
 *   part of the hackathon's Gemini track requirement.
 * - On quota 429 (common on free tier for Gemini 3.x) falls back to AIMLAPI,
 *   which proxies Gemini through paid credits. The fallback keeps demos
 *   usable without stopping execution mid-task.
 *
 * Why a hand-rolled client instead of the official SDK: the project already
 * ships a custom HTTPS proxy shim in shared/load-env.mjs, so a raw fetch is
 * guaranteed to route through the VPN correctly. An SDK would bring its own
 * transport and would silently bypass the shim.
 */

import { aimlChat } from "./aimlapi-client.mjs";

function getGeminiBaseUrl() {
  return process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
}

function getGeminiKey() {
  return process.env.GEMINI_API_KEY || "";
}

function getGeminiModel() {
  return process.env.GEMINI_MODEL || "gemini-2.5-pro";
}

function getGeminiFlashModel() {
  return process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash";
}

function getGeminiTimeoutMs() {
  return Math.max(2_000, Number(process.env.GEMINI_TIMEOUT_MS || 30_000));
}

function shouldFallbackToAimlapi() {
  return (process.env.GEMINI_FALLBACK_TO_AIMLAPI || "true") !== "false";
}

// Circuit-breaker: when Gemini native API refuses us (quota 429, 403, 401)
// we skip the native endpoint for a while so we don't waste timeouts on it.
// The fallback to AIMLAPI keeps demos flowing.
let nativeCircuit = { openUntil: 0, reason: null };

function isNativeCircuitOpen() {
  return Date.now() < nativeCircuit.openUntil;
}

function tripNativeCircuit(reason, durationMs = 10 * 60_000) {
  nativeCircuit = { openUntil: Date.now() + durationMs, reason };
}

function resetNativeCircuit() {
  if (nativeCircuit.openUntil !== 0) {
    nativeCircuit = { openUntil: 0, reason: null };
  }
}

export function hasGeminiKey() {
  return Boolean(getGeminiKey());
}

export function hasNativeGeminiCapacity() {
  return Boolean(getGeminiKey()) && !isNativeCircuitOpen();
}

export function getGeminiCircuitStatus() {
  return { ...nativeCircuit, open: isNativeCircuitOpen() };
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

function convertMessagesToGeminiContents({ systemPrompt, userPrompt, messages }) {
  if (Array.isArray(messages) && messages.length > 0) {
    const systemInstruction = messages.find((m) => m.role === "system")?.content;
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: String(m.content || "") }]
      }));
    return { systemInstruction, contents };
  }

  const contents = [];
  if (userPrompt) {
    contents.push({ role: "user", parts: [{ text: String(userPrompt) }] });
  }

  return {
    systemInstruction: systemPrompt ? String(systemPrompt) : null,
    contents
  };
}

function isQuotaError(status, errorBody) {
  if (status === 429) return true;
  if (status === 403 && /quota|billing/i.test(String(errorBody || ""))) return true;
  return false;
}

/**
 * Chat-style call with optional function tool declarations.
 *
 * @param {Object} params
 * @param {string} [params.model]
 * @param {string} [params.systemPrompt]
 * @param {string} [params.userPrompt]
 * @param {Array<{role:string, content:string}>} [params.messages]
 * @param {number} [params.maxTokens=1024]
 * @param {number} [params.temperature=0.3]
 * @param {boolean} [params.jsonMode=false]            Force response_mime_type=application/json.
 * @param {Array}   [params.tools]                      Function declarations.
 * @param {string}  [params.toolChoice]                 "auto" | "any" | "none".
 * @param {boolean} [params.enableThinking=true]        Use thinking budget when available.
 * @param {number}  [params.thinkingBudget=8192]        Token budget for thinking.
 * @param {number}  [params.timeoutMs]
 *
 * Returns `{ ok, text, functionCalls, model, raw, reason, errorMessage }`.
 */
export async function geminiChat({
  model,
  systemPrompt,
  userPrompt,
  messages,
  maxTokens = 1024,
  temperature = 0.3,
  jsonMode = false,
  tools = null,
  toolChoice = null,
  enableThinking = true,
  thinkingBudget = 8192,
  timeoutMs
}) {
  const key = getGeminiKey();
  if (!key) {
    return { ok: false, reason: "no-api-key", text: null };
  }

  // If native Gemini already tripped its quota this session, skip straight
  // to the AIMLAPI fallback instead of burning another 429.
  if (isNativeCircuitOpen() && shouldFallbackToAimlapi()) {
    return fallbackToAimlapi({
      model: model || getGeminiModel(),
      systemPrompt,
      userPrompt,
      messages,
      maxTokens,
      temperature,
      jsonMode,
      timeoutMs: timeoutMs ?? getGeminiTimeoutMs(),
      reason: `native-breaker-${nativeCircuit.reason || "open"}`,
      errorMessage: "native Gemini circuit breaker open"
    });
  }

  const resolvedModel = model || getGeminiModel();
  const resolvedTimeoutMs = timeoutMs ?? getGeminiTimeoutMs();
  const { systemInstruction, contents } = convertMessagesToGeminiContents({
    systemPrompt,
    userPrompt,
    messages
  });

  const generationConfig = {
    temperature,
    maxOutputTokens: maxTokens
  };

  if (jsonMode) {
    generationConfig.responseMimeType = "application/json";
  }

  if (enableThinking) {
    generationConfig.thinkingConfig = {
      thinkingBudget,
      includeThoughts: false
    };
  }

  const body = { contents, generationConfig };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = [{ functionDeclarations: tools }];
    if (toolChoice) {
      const mode = toolChoice === "any" ? "ANY" : toolChoice === "none" ? "NONE" : "AUTO";
      body.toolConfig = { functionCallingConfig: { mode } };
    }
  }

  const url = `${getGeminiBaseUrl()}/models/${encodeURIComponent(resolvedModel)}:generateContent`;

  let response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify(body)
      },
      resolvedTimeoutMs
    );
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timeout" : "network";
    if (shouldFallbackToAimlapi()) {
      return fallbackToAimlapi({
        model: resolvedModel,
        systemPrompt,
        userPrompt,
        messages,
        maxTokens,
        temperature,
        jsonMode,
        timeoutMs: resolvedTimeoutMs,
        reason: `gemini-${reason}`,
        errorMessage: String(error?.message || error)
      });
    }
    return {
      ok: false,
      reason,
      text: null,
      errorMessage: String(error?.message || error),
      model: resolvedModel
    };
  }

  const bodyText = await response.text().catch(() => "");

  if (!response.ok) {
    if (isQuotaError(response.status, bodyText) && shouldFallbackToAimlapi()) {
      // Trip the circuit so subsequent calls skip native right away.
      tripNativeCircuit(`http-${response.status}`);
      return fallbackToAimlapi({
        model: resolvedModel,
        systemPrompt,
        userPrompt,
        messages,
        maxTokens,
        temperature,
        jsonMode,
        timeoutMs: resolvedTimeoutMs,
        reason: `gemini-${response.status}`,
        errorMessage: bodyText.slice(0, 400)
      });
    }
    return {
      ok: false,
      reason: `http-${response.status}`,
      text: null,
      errorBody: bodyText.slice(0, 400),
      model: resolvedModel
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      ok: false,
      reason: "invalid-json",
      text: null,
      errorBody: bodyText.slice(0, 400),
      model: resolvedModel
    };
  }

  const candidate = parsed?.candidates?.[0];
  if (!candidate) {
    return {
      ok: false,
      reason: "no-candidate",
      text: null,
      errorBody: JSON.stringify(parsed).slice(0, 400),
      model: resolvedModel
    };
  }

  const parts = candidate.content?.parts || [];
  const textParts = parts
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
  // Cap extracted function calls so a pathological Gemini response (or a
  // compromised proxy) cannot force the orchestrator into an unbounded
  // tool-dispatch fan-out in a single turn.
  const MAX_FUNCTION_CALLS_PER_TURN = 16;
  const functionCalls = parts
    .filter((p) => p.functionCall)
    .slice(0, MAX_FUNCTION_CALLS_PER_TURN)
    .map((p) => ({ name: p.functionCall.name, args: p.functionCall.args || {} }));

  // Native quota recovered — clear the breaker so later callers stop paying
  // the AIMLAPI fallback unnecessarily. Only reset if the native path
  // actually returned (we reached this codepath after a direct 2xx from
  // generativelanguage.googleapis.com). AIMLAPI fallback successes return
  // earlier via fallbackToAimlapi() and must NOT clear the breaker, or
  // we'd re-hammer Gemini 429 → fallback → reset → 429 in a loop.
  resetNativeCircuit();

  return {
    ok: true,
    text: textParts,
    functionCalls,
    finishReason: candidate.finishReason || null,
    usage: parsed.usageMetadata || null,
    model: resolvedModel,
    raw: parsed,
    via: "native"
  };
}

/**
 * AIMLAPI fallback. Routes Gemini requests through the AIMLAPI key which
 * already ships with the project. Used when Google's free tier returns 429.
 */
async function fallbackToAimlapi({
  model,
  systemPrompt,
  userPrompt,
  messages,
  maxTokens,
  temperature,
  jsonMode,
  timeoutMs,
  reason,
  errorMessage
}) {
  // AIMLAPI exposes Gemini 3.1 Pro via paid credits. We always prefer 3.1 Pro
  // for the fallback because 2.5 Pro sometimes returns empty bodies for
  // large / structured prompts through the AIMLAPI proxy.
  const aimlModelMap = {
    "gemini-2.5-pro": "google/gemini-3-1-pro-preview",
    "gemini-2.5-flash": "google/gemini-3-flash-preview",
    "gemini-3-pro-preview": "google/gemini-3-1-pro-preview",
    "gemini-3-flash-preview": "google/gemini-3-flash-preview",
    "gemini-3.1-pro-preview": "google/gemini-3-1-pro-preview",
    "gemini-3.1-pro-preview-customtools": "google/gemini-3-1-pro-preview"
  };
  const aimlModel = aimlModelMap[model] || "google/gemini-3-1-pro-preview";

  // One retry with backoff — AIMLAPI sometimes returns transient network
  // errors or empty bodies on the first try, especially for larger prompts.
  let result = await aimlChat({
    model: aimlModel,
    systemPrompt,
    userPrompt,
    messages,
    maxTokens,
    temperature,
    responseFormat: jsonMode ? { type: "json_object" } : undefined,
    timeoutMs
  });

  if (!result.ok) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    result = await aimlChat({
      model: aimlModel,
      systemPrompt,
      userPrompt,
      messages,
      maxTokens,
      temperature,
      responseFormat: jsonMode ? { type: "json_object" } : undefined,
      timeoutMs
    });
  }

  if (!result.ok) {
    return {
      ok: false,
      reason: `aimlapi-fallback-${result.reason}`,
      text: null,
      errorMessage: `Gemini failed (${reason}) and AIMLAPI fallback failed: ${result.errorMessage || result.reason}`,
      model
    };
  }

  return {
    ok: true,
    text: result.text,
    functionCalls: [],
    model: aimlModel,
    via: "aimlapi-fallback",
    originalReason: reason,
    originalError: errorMessage
  };
}

/**
 * Convenience helper for JSON-only responses (variant planner, etc.).
 */
function stripJsonPreamble(raw) {
  if (typeof raw !== "string") return "";
  let text = raw.trim();
  // Remove markdown fences: ```json ... ``` or ``` ... ```
  text = text.replace(/^```(?:json|JSON)?\s*/m, "").replace(/```$/m, "").trim();
  return text;
}

export async function geminiJson(options) {
  const result = await geminiChat({ ...options, jsonMode: true });
  if (!result.ok) return result;

  const attempts = [result.text, stripJsonPreamble(result.text)];
  const match = result.text.match(/\{[\s\S]*\}/);
  if (match) attempts.push(match[0]);

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      return { ...result, json: parsed };
    } catch {
      // try next candidate
    }
  }

  return { ...result, ok: false, reason: "json-parse-failed", json: null, rawText: result.text };
}

export function getDefaultGeminiModel() {
  return getGeminiModel();
}

export function getDefaultGeminiFlashModel() {
  return getGeminiFlashModel();
}
