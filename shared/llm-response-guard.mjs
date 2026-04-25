/**
 * Content-quality guard for paid LLM responses.
 *
 * Every Muse agent unit is paid at settlement time. If the model silently
 * returns an empty string, a refusal ("I cannot help with that"), or a
 * one-liner that does not actually fulfil the unit contract, the buyer is
 * still billed. This guard classifies such responses so the worker can
 * fall back to the Hermes daemon or the deterministic template instead of
 * shipping garbage.
 *
 * The heuristics are intentionally conservative — we only reject responses
 * that match well-known refusal phrasing or fall below an obviously-too-
 * short length. Legitimate copy (a 20-character headline, "Fast, reliable,
 * proven.") must pass unchanged.
 */

const REFUSAL_PATTERNS = [
  /^\s*i\s*(?:can(?:not|['’]t)|am\s*unable|won['’]t)\b/i,
  /^\s*i['’]m\s+(?:sorry|not\s+able|unable)\b/i,
  /^\s*(?:i\s*am\s*sorry|sorry,?\s*but\s*i)\b[\s\S]{0,40}?(?:can(?:not|['’]t)|won['’]t|unable)/i,
  /\bas\s+an\s+ai\s+(?:language\s+)?model\b/i,
  /\bas\s+an?\s+ai\b[\s\S]{0,40}?(?:cannot|can['’]t|unable|do\s+not)\b/i,
  /\bi\s+(?:do\s*not|don['’]t)\s+(?:have|possess)\s+(?:the\s+)?ability\b/i,
  /\bunable\s+to\s+(?:assist|help|comply|provide)\b/i,
  /\bi['’]m\s+not\s+able\s+to\b/i,
  /\bagainst\s+(?:my\s+)?(?:guidelines|policy|programming)\b/i
];

const DEFAULT_MIN_CHARS = 12;

/**
 * Classify an LLM response for paid use.
 * @returns {{ ok: boolean, reason?: "empty"|"too-short"|"refusal" }}
 */
export function classifyLlmText(text, { minChars = DEFAULT_MIN_CHARS } = {}) {
  if (typeof text !== "string") {
    return { ok: false, reason: "empty" };
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty" };
  }
  if (trimmed.length < minChars) {
    return { ok: false, reason: "too-short" };
  }
  for (const pattern of REFUSAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason: "refusal" };
    }
  }
  return { ok: true };
}

/**
 * Boolean convenience wrapper for the common pattern
 *   if (!isUsableLlmText(result.text)) fallback();
 */
export function isUsableLlmText(text, opts) {
  return classifyLlmText(text, opts).ok;
}
