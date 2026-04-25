import { aimlChat, aimlImage, hasAimlKey } from "../../shared/aimlapi-client.mjs";
import { fireworksImage, hasFireworksKey } from "../../shared/fireworks-client.mjs";
import { resolveImageRoute } from "../../shared/agent-models.mjs";

const FAL_API_KEY = process.env.FAL_API_KEY || "";
const FAL_API_URL = process.env.FAL_API_URL || "https://fal.run/fal-ai/flux/schnell";
const REQUEST_TIMEOUT_MS = Math.max(
  3_000,
  Number(process.env.AGENT_IMAGE_TIMEOUT_MS || 30_000)
);

// Whitelist of hostnames we are willing to surface image URLs from. Fal.ai
// returns CDN URLs on a handful of domains; anything else (injected via a
// compromised upstream / MITM) must not reach the buyer because the
// orchestrator and browser will load it blindly.
const FAL_ALLOWED_IMAGE_HOSTS = new Set([
  "fal.run",
  "fal.media",
  "v2.fal.media",
  "v3.fal.media",
  "cdn.fal.ai",
  "storage.fal.ai"
]);

export function isTrustedFalImageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    for (const allowed of FAL_ALLOWED_IMAGE_HOSTS) {
      if (host === allowed || host.endsWith(`.${allowed}`)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function svgDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildFallbackImage({ brandName, taskType, prompt, caption, styleNote }) {
  // The fallback used to also paint the raw user prompt and a styleNote
  // line on the banner — that's why a Russian "Необходимо создать рекламу
  // автосалона…" prompt ended up baked into a banner that's supposed to
  // be a creative asset. Strip those: keep only the brand mark + tagline,
  // matching how a real generated image would look. Also drop the prompt
  // payload from the SVG entirely so the operator-side input never leaks
  // back into the visible asset.
  void prompt;
  void styleNote;
  const brand = escapeXml(String(brandName || "BRAND").slice(0, 40)).toUpperCase();
  const tagline = escapeXml(
    String(caption || `${brandName} on Arc Testnet — sub-cent micro-actions`).slice(0, 80)
  );
  const kicker = escapeXml(String(taskType || "twitter_post").replace(/_/g, " ").toUpperCase());

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#08090c" />
          <stop offset="60%" stop-color="#0c1018" />
          <stop offset="100%" stop-color="#050708" />
        </linearGradient>
        <radialGradient id="halo" cx="78%" cy="22%" r="70%">
          <stop offset="0%" stop-color="#C6F51F" stop-opacity="0.32" />
          <stop offset="100%" stop-color="#C6F51F" stop-opacity="0" />
        </radialGradient>
        <pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
          <path d="M 60 0 L 0 0 0 60" fill="none" stroke="rgba(198,245,31,0.05)" stroke-width="1" />
        </pattern>
      </defs>
      <rect width="1200" height="675" fill="url(#bg)" />
      <rect width="1200" height="675" fill="url(#grid)" />
      <rect width="1200" height="675" fill="url(#halo)" />
      <!-- corner ticks -->
      <path d="M 52 52 L 100 52 M 52 52 L 52 100" stroke="#C6F51F" stroke-width="3" fill="none" />
      <path d="M 1148 52 L 1100 52 M 1148 52 L 1148 100" stroke="#C6F51F" stroke-width="3" fill="none" />
      <path d="M 52 623 L 100 623 M 52 623 L 52 575" stroke="#C6F51F" stroke-width="3" fill="none" />
      <path d="M 1148 623 L 1100 623 M 1148 623 L 1148 575" stroke="#C6F51F" stroke-width="3" fill="none" />
      <!-- kicker -->
      <text x="92" y="148" fill="#C6F51F" font-size="22" font-family="JetBrains Mono, Consolas, monospace" letter-spacing="6">— ${kicker}</text>
      <!-- huge brand mark (Archivo Black-style weight) -->
      <text x="92" y="370" fill="#f5f7fb" font-size="180" font-family="Arial Black, sans-serif" font-weight="900" letter-spacing="-4">${brand}</text>
      <!-- acid bar -->
      <rect x="92" y="420" width="240" height="6" fill="#C6F51F" />
      <!-- tagline -->
      <text x="92" y="500" fill="#d9e4f7" font-size="30" font-family="Segoe UI, Arial, sans-serif">${tagline}</text>
      <!-- footer mark -->
      <text x="92" y="610" fill="#7a8294" font-size="18" font-family="JetBrains Mono, Consolas, monospace" letter-spacing="4">MUSE.DNA · ARC TESTNET · GENERATED</text>
    </svg>
  `;

  return {
    url: svgDataUrl(svg),
    width: 1200,
    height: 675
  };
}

async function generateWithFal(imagePrompt) {
  if (!FAL_API_KEY) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(FAL_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Key ${FAL_API_KEY}`
      },
      body: JSON.stringify({
        prompt: imagePrompt,
        image_size: "landscape_16_9",
        num_images: 1
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      console.warn(`fal.ai returned ${response.status}`);
      return null;
    }

    const data = await response.json();
    const imageUrl = data.images?.[0]?.url || data.image?.url || data.output?.url;

    if (imageUrl && isTrustedFalImageUrl(imageUrl)) {
      return {
        url: imageUrl,
        width: data.images?.[0]?.width || 1200,
        height: data.images?.[0]?.height || 675
      };
    }

    if (imageUrl) {
      console.warn(`fal.ai returned an image URL outside the allowed host list — dropping: ${imageUrl.slice(0, 120)}`);
    }

    return null;
  } catch (error) {
    console.warn("fal.ai image generation failed:", error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function generateJsonMetadata({ unit, brandName, taskType, prompt, copyText, newsContext, tier }) {
  if (!hasAimlKey()) return null;

  const model = resolveImageRoute(unit, tier).model;
  const systemPrompt =
    "You are a senior visual director. Respond ONLY with compact JSON (no prose, no markdown). " +
    "Use short strings and short arrays. No extra commentary.";
  const userPrompt =
    `Brand: ${brandName}\nTask type: ${taskType}\nCampaign prompt: ${String(prompt || "").slice(0, 200)}\n` +
    `${copyText ? `Copy excerpt: ${String(copyText).slice(0, 200)}\n` : ""}` +
    `${newsContext ? `News angle: ${String(newsContext).slice(0, 160)}\n` : ""}` +
    `\nTask: produce the JSON object for visual unit "${unit}" with premium dark glassmorphism style. ` +
    `Keep it operator-friendly and commercially credible.`;

  const result = await aimlChat({
    model,
    systemPrompt,
    userPrompt,
    maxTokens: 400,
    temperature: 0.35,
    responseFormat: { type: "json_object" },
    timeoutMs: REQUEST_TIMEOUT_MS
  });

  if (!result.ok) {
    console.warn(
      `Image metadata unit ${unit} AIMLAPI (${model}) failed: ${result.reason}${result.errorMessage ? ` (${result.errorMessage})` : ""}`
    );
    return null;
  }

  try {
    const parsed = JSON.parse(result.text);
    return { ...parsed, model: result.model, source: "aimlapi" };
  } catch {
    const match = result.text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return { ...JSON.parse(match[0]), model: result.model, source: "aimlapi" };
      } catch {
        // fall through
      }
    }
    return null;
  }
}

function fallbackMetadata({ brandName, copyText, unit }) {
  const templates = {
    "visual-brief": {
      theme: "premium dark glassmorphism",
      goal: `${brandName} should feel precise, agentic, and commercially credible.`
    },
    "scene-prompt": {
      prompt: `${brandName} in a premium interface scene about programmable USDC value and high-frequency agent actions`
    },
    composition: {
      layout: "hero headline left, proof grid right, subtle glow behind the focal card"
    },
    "render-style": {
      style: "dark glass, restrained cyan glow, sharp typography, no generic dashboard clutter"
    },
    "caption-lockup": {
      caption: `${brandName} • ${copyText ? "Memory-backed execution" : "Programmable value"}`,
      subhead: "Arc settlement for creative micro-actions"
    },
    "brand-palette": {
      colors: ["#07131f", "#10253b", "#66f1d0", "#f5f7fb"]
    },
    "motif-board": {
      motifs: ["ledger cascade", "DNA blocks", "micro-checks", "operator console"]
    },
    "layout-grid": {
      grid: "12-column wide card with dual information rail"
    },
    "icon-language": {
      icons: ["check", "spark", "ledger rail", "DNA node"]
    },
    "surface-texture": {
      texture: "subtle grid with blurred glow pockets"
    },
    "brand-guard": {
      avoid: "generic SaaS gradients, loud neon overload, and stock-photo vibes"
    }
  };
  return templates[unit] ? { ...templates[unit], source: "template" } : null;
}

async function generateWithAimlImage({ unit, prompt, tier }) {
  const model = resolveImageRoute(unit, tier).model;
  const result = await aimlImage({
    model,
    prompt,
    size: "1024x1024",
    timeoutMs: REQUEST_TIMEOUT_MS
  });

  if (!result.ok) {
    console.warn(
      `AIMLAPI image (${model}) failed: ${result.reason}${result.errorMessage ? ` (${result.errorMessage})` : ""}`
    );
    return null;
  }

  return {
    url: result.url,
    width: 1024,
    height: 1024,
    model: result.model
  };
}

export async function runImageUnit(input) {
  const tier = input.tier || "deep";
  if (input.unit === "banner-render") {
    const caption = input.copyText
      ? String(input.copyText).split("\n")[0]
      : `${input.brandName} turns agent actions into USDC micro-settlements`;

    const styleNote = input.newsContext || "Sub-cent payments that remain visible, explorable, and reusable.";
    const imagePrompt =
      `Premium dark glassmorphism banner for ${input.brandName}. ` +
      `${input.taskType} campaign visual. Cyber blue-green glow, dark navy background. ` +
      `Modern fintech dashboard aesthetic. Text overlay: "${caption.slice(0, 60)}". ` +
      `Clean, minimal, professional. No generic stock photo look.`;

    // Fallback chain: AIMLAPI (primary, hackathon-claimed) → fal.ai →
    // Fireworks (round-robin across 5 keys) → SVG template (degraded).
    // Each fallback is independently catchable so a single provider's
    // outage doesn't take the whole image step down.
    if (hasAimlKey()) {
      const aimlResult = await generateWithAimlImage({ unit: "banner-render", prompt: imagePrompt, tier }).catch(() => null);
      if (aimlResult) {
        return { ...aimlResult, source: "aimlapi", tier };
      }
    }

    const falResult = await generateWithFal(imagePrompt).catch(() => null);
    if (falResult) {
      // Always echo `tier` back so the orchestrator gets a consistent
      // shape regardless of which backend ran. Earlier the FAL branch
      // dropped `tier` while the AIML branch above included it — UI
      // would render a NaN tier badge for half the agent's tasks.
      return { ...falResult, source: "fal", tier };
    }

    if (hasFireworksKey()) {
      const fireworks = await fireworksImage({
        prompt: imagePrompt,
        width: 1024,
        height: 1024
      }).catch((err) => ({ ok: false, reason: "fireworks-image:throw", errorMessage: String(err?.message || err) }));
      if (fireworks?.ok) {
        return {
          url: fireworks.url,
          width: 1024,
          height: 1024,
          model: fireworks.model,
          source: "fireworks",
          tier
        };
      }
      console.warn(
        `[image-agent] Fireworks fallback failed: ${fireworks?.reason || "unknown"}${fireworks?.errorMessage ? ` (${fireworks.errorMessage})` : ""}`
      );
    }

    return {
      ...buildFallbackImage({
        brandName: input.brandName,
        taskType: input.taskType,
        prompt: input.prompt,
        caption,
        styleNote
      }),
      source: "svg-fallback",
      // Explicit signal to the orchestrator / buyer that this is a static
      // SVG template, not a generated image. Downstream UI can render a
      // "degraded output" badge when it sees this flag.
      isTemplate: true,
      tier
    };
  }

  const fromLlm = await generateJsonMetadata({
    unit: input.unit,
    brandName: input.brandName,
    taskType: input.taskType,
    prompt: input.prompt,
    copyText: input.copyText,
    newsContext: input.newsContext,
    tier
  }).catch(() => null);

  if (fromLlm) {
    return { ...fromLlm, tier };
  }

  const fallback = fallbackMetadata({
    brandName: input.brandName,
    copyText: input.copyText,
    unit: input.unit
  });

  if (!fallback) {
    throw new Error(`Unsupported image unit: ${input.unit}`);
  }

  return fallback;
}
