/**
 * Fireworks AI fallback client.
 *
 * Backup model provider for image generation (and LLM cascade) when the
 * primary AIMLAPI / fal.ai paths fail or run out of credits. Five rotation
 * keys are read from `FIREWORKS_API_KEYS` (comma-separated). Rotation is
 * round-robin; keys that return 401/403/429 are temporarily quarantined
 * for `KEY_COOLDOWN_MS` so we don't keep hitting an exhausted key.
 *
 * Two exports:
 *   - `fireworksImage({ prompt, width, height, model })` →
 *       { ok, url: "data:image/png;base64,…", bytes, model } | { ok: false, reason }
 *   - `fireworksChat({ messages, model, temperature, maxTokens })` →
 *       { ok, text, model, finishReason } | { ok: false, reason }
 *
 * Networking goes through the global proxy agent if `HTTPS_PROXY` /
 * `GLOBAL_AGENT_HTTP_PROXY` is set (Windows-friendly).
 */

import process from "node:process";

const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
const KEY_COOLDOWN_MS = 5 * 60 * 1000; // 5 min after a 401/403/429
const REQUEST_TIMEOUT_MS = 60_000; // image generation can take 30s+

// Default models — biased toward speed + quality for banner generation.
const DEFAULT_IMAGE_MODEL = "accounts/fireworks/models/flux-1-schnell-fp8";
const DEFAULT_CHAT_MODEL = "accounts/fireworks/models/kimi-k2p5";

function readKeys() {
  const csv = String(process.env.FIREWORKS_API_KEYS || "").trim();
  if (!csv) return [];
  return csv
    .split(",")
    .map((k) => k.trim())
    .filter((k) => /^fw_[A-Za-z0-9_-]+$/.test(k));
}

const keyState = new Map(); // key → { quarantineUntil: number, lastReason: string }
let rotationIndex = 0;

function pickKey() {
  const keys = readKeys();
  if (keys.length === 0) return null;
  const now = Date.now();
  // Try every key once starting from rotationIndex; skip quarantined.
  for (let i = 0; i < keys.length; i += 1) {
    const idx = (rotationIndex + i) % keys.length;
    const key = keys[idx];
    const state = keyState.get(key);
    if (!state || state.quarantineUntil < now) {
      rotationIndex = (idx + 1) % keys.length; // advance for next caller
      return key;
    }
  }
  return null; // every key in cooldown
}

function quarantineKey(key, reason) {
  keyState.set(key, {
    quarantineUntil: Date.now() + KEY_COOLDOWN_MS,
    lastReason: String(reason).slice(0, 120)
  });
}

export function hasFireworksKey() {
  return readKeys().length > 0;
}

export function getFireworksKeyHealth() {
  const keys = readKeys();
  const now = Date.now();
  return {
    total: keys.length,
    available: keys.filter((k) => {
      const s = keyState.get(k);
      return !s || s.quarantineUntil < now;
    }).length,
    quarantined: keys
      .map((k) => {
        const s = keyState.get(k);
        if (!s || s.quarantineUntil < now) return null;
        return {
          keySuffix: k.slice(-6),
          quarantineUntil: new Date(s.quarantineUntil).toISOString(),
          reason: s.lastReason
        };
      })
      .filter(Boolean)
  };
}

/**
 * Generate an image. Returns a base64 data URL on success — inline-ready
 * for the frontend without going through any blob storage.
 */
export async function fireworksImage({
  prompt,
  width = 1024,
  height = 1024,
  model = DEFAULT_IMAGE_MODEL,
  timeoutMs = REQUEST_TIMEOUT_MS
} = {}) {
  if (!prompt || typeof prompt !== "string") {
    return { ok: false, reason: "fireworks-image:bad-prompt" };
  }
  const key = pickKey();
  if (!key) {
    return {
      ok: false,
      reason: hasFireworksKey() ? "fireworks-image:all-keys-quarantined" : "fireworks-image:no-key"
    };
  }

  const url = `${FIREWORKS_BASE_URL}/image_generation/${model}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "image/png"
      },
      body: JSON.stringify({
        prompt: String(prompt).slice(0, 1500),
        width,
        height,
        n: 1
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const reason = `http-${response.status}`;
      // Treat auth / quota errors as key-level — quarantine this key but
      // let the next caller try a different one.
      if ([401, 402, 403, 429].includes(response.status)) {
        quarantineKey(key, reason);
      }
      const detail = await response.text().catch(() => "");
      return { ok: false, reason: `fireworks-image:${reason}`, errorMessage: detail.slice(0, 240) };
    }

    const contentType = response.headers.get("content-type") || "image/png";
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length === 0) {
      return { ok: false, reason: "fireworks-image:empty-body" };
    }
    return {
      ok: true,
      url: `data:${contentType};base64,${buf.toString("base64")}`,
      bytes: buf.length,
      model,
      keySuffix: key.slice(-6)
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "fireworks-image:timeout" : "fireworks-image:network-error",
      errorMessage: String(error?.message || error).slice(0, 240)
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chat completion fallback. Used after Featherless / AIMLAPI break and
 * Gemini Function Calling tier is exhausted. Returns plain text — no
 * tool-use here (Fireworks supports tools on some models, but our cascade
 * routes tool-use to Gemini; this is the "give me a paragraph" backstop).
 */
export async function fireworksChat({
  messages,
  model = DEFAULT_CHAT_MODEL,
  temperature = 0.5,
  maxTokens = 1024,
  timeoutMs = REQUEST_TIMEOUT_MS
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, reason: "fireworks-chat:no-messages" };
  }
  const key = pickKey();
  if (!key) {
    return {
      ok: false,
      reason: hasFireworksKey() ? "fireworks-chat:all-keys-quarantined" : "fireworks-chat:no-key"
    };
  }

  const url = `${FIREWORKS_BASE_URL}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const reason = `http-${response.status}`;
      if ([401, 402, 403, 429].includes(response.status)) {
        quarantineKey(key, reason);
      }
      const detail = await response.text().catch(() => "");
      return { ok: false, reason: `fireworks-chat:${reason}`, errorMessage: detail.slice(0, 240) };
    }

    const data = await response.json();
    const choice = data?.choices?.[0];
    const text = choice?.message?.content;
    if (!text || typeof text !== "string") {
      return { ok: false, reason: "fireworks-chat:no-text", errorMessage: JSON.stringify(data).slice(0, 240) };
    }
    return {
      ok: true,
      text,
      model: data.model || model,
      finishReason: choice?.finish_reason || null,
      keySuffix: key.slice(-6)
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "fireworks-chat:timeout" : "fireworks-chat:network-error",
      errorMessage: String(error?.message || error).slice(0, 240)
    };
  } finally {
    clearTimeout(timer);
  }
}
