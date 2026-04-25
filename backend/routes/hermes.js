import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../db/index.js";
import { chatWithHermes } from "../services/hermesChat.js";
import { listSkillFiles, readSkillFile } from "../services/hermes.js";
import { getOrchestratorSigner } from "../services/orchestratorWallets.js";
import { filterByOwner, isOwnedBy } from "../services/dnaOwnership.js";
import { HERMES_TOOLS } from "../../shared/hermes-tools.mjs";

const router = express.Router();

// File-backed analytics annotations per DNA brand. Lives next to the
// orchestrator-wallets store so a backend restart preserves whatever the
// operator pasted in the DNA tab. Schema is intentionally tiny:
// { brandKey: [{ id, capturedAt, source, text, metrics: {...} }, ...] }
//
// Use fileURLToPath instead of new URL().pathname.replace(/^\//, "") —
// the regex strip works on Windows by accident (the leading slash
// becomes the drive marker) but on POSIX it produces a RELATIVE path
// that path.resolve then resolves against process.cwd() instead of
// this file's actual directory. Result: analytics writes silently land
// in the wrong place when the backend is started from a non-project
// cwd.
const DNA_ANALYTICS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "dna-analytics.json"
);

async function readDnaAnalytics() {
  try {
    const raw = await fs.readFile(DNA_ANALYTICS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeDnaAnalytics(store) {
  await fs.mkdir(path.dirname(DNA_ANALYTICS_PATH), { recursive: true });
  await fs.writeFile(DNA_ANALYTICS_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function brandKeyFromFileName(fileName) {
  return String(fileName || "")
    .replace(/\.md$/i, "")
    .replace(/_dna$/i, "")
    .toLowerCase();
}

/**
 * POST /api/hermes/chat
 *
 * Natural-language interface backed by Gemini Function Calling.
 * Gemini picks which Circle/x402 tool to invoke, the backend actually runs
 * that tool, and the answer is returned to the user. This is the payload
 * the frontend chat drawer talks to.
 */
const MAX_HERMES_HISTORY = 40;
const MAX_HERMES_MESSAGE_CHARS = 6_000;

const HERMES_CHAT_RATE_WINDOW_MS = 5 * 60 * 1000;
const HERMES_CHAT_RATE_MAX = 30;
const hermesChatAttempts = new Map();
const HERMES_CHAT_KEY_CAP = 4096;

router.post("/chat", async (req, res) => {
  try {
    // Rate limit: 30 requests / 5 min / IP to protect Gemini quota.
    const now = Date.now();
    const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
    const stamps = (hermesChatAttempts.get(ip) || []).filter(
      (t) => now - t < HERMES_CHAT_RATE_WINDOW_MS
    );
    if (stamps.length >= HERMES_CHAT_RATE_MAX) {
      const retryInSec = Math.ceil((stamps[0] + HERMES_CHAT_RATE_WINDOW_MS - now) / 1000);
      return res.status(429).json({
        error: `Too many Hermes requests. Try again in ~${retryInSec}s.`,
        retryAfter: retryInSec
      });
    }
    stamps.push(now);
    hermesChatAttempts.set(ip, stamps);
    if (hermesChatAttempts.size > HERMES_CHAT_KEY_CAP) {
      const drop = hermesChatAttempts.size - HERMES_CHAT_KEY_CAP;
      let i = 0;
      for (const key of hermesChatAttempts.keys()) {
        if (i++ >= drop) break;
        hermesChatAttempts.delete(key);
      }
    }

    const { message, history, mainWallet } = req.body || {};
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "message required" });
    }
    if (message.length > MAX_HERMES_MESSAGE_CHARS) {
      return res.status(413).json({ error: `message too long (max ${MAX_HERMES_MESSAGE_CHARS} chars)` });
    }
    // Protect against OOM from malicious oversize history payloads.
    const safeHistory = Array.isArray(history)
      ? history
          .slice(-MAX_HERMES_HISTORY)
          .filter((m) => m && typeof m === "object" && typeof m.role === "string" && typeof m.content === "string")
          .map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_HERMES_MESSAGE_CHARS) }))
      : [];

    // P2-1 fix: if the caller provides a mainWallet, resolve their actual
    // orchestrator address and use it for the balance tool call instead of
    // falling back to the env-level ORCHESTRATOR_WALLET_ADDRESS. This means
    // Hermes reports "$3.12" for the connected user's wallet, not the shared
    // backend wallet.
    const overrides = { db };
    const normalizedWallet = typeof mainWallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(mainWallet.trim())
      ? mainWallet.trim().toLowerCase()
      : null;
    if (normalizedWallet) {
      overrides.getWalletBalance = async () => {
        let orchAddress = null;
        try {
          const signer = await getOrchestratorSigner(normalizedWallet);
          orchAddress = signer?.address || null;
        } catch { /* no orch deployed yet */ }
        if (!orchAddress) {
          return { address: null, balanceUsdc: 0, source: "no-orchestrator" };
        }
        const rpcUrl =
          process.env.ARC_RPC_URL ||
          process.env.NEXT_PUBLIC_ARC_RPC_URL ||
          "https://rpc.testnet.arc.network";
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6_000);
        try {
          const response = await fetch(rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [orchAddress, "latest"], id: 1 }),
            signal: controller.signal
          });
          const data = await response.json();
          if (data.error || !data.result) {
            return { address: orchAddress, balanceUsdc: 0, source: "rpc-error" };
          }
          const usdc = Number(BigInt(data.result)) / 1e18;
          return { address: orchAddress, balanceUsdc: Number(usdc.toFixed(6)), network: "eip155:5042002", source: "arc-testnet-rpc" };
        } catch {
          return { address: orchAddress, balanceUsdc: 0, source: "rpc-fetch-failed" };
        } finally {
          clearTimeout(timer);
        }
      };
    }

    const result = await chatWithHermes(
      { message: message.trim(), history: safeHistory },
      overrides
    );

    if (!result.ok) {
      return res.status(502).json({
        error: result.reason,
        detail: result.errorMessage || null,
        toolCalls: result.toolCalls || []
      });
    }

    return res.json({
      text: result.text,
      toolCalls: result.toolCalls,
      model: result.model || null,
      via: result.via || null
    });
  } catch (error) {
    console.error("Hermes chat failed:", error.message);
    return res.status(500).json({ error: "Hermes chat failed." });
  }
});

/**
 * GET /api/hermes/tools — quick introspection so the demo can show which
 * function declarations Gemini has access to. Handy for the hackathon video.
 */
router.get("/tools", (_req, res) => {
  res.json({
    count: HERMES_TOOLS.length,
    tools: HERMES_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }))
  });
});

/**
 * GET /api/hermes/dna — list every brand DNA file Hermes has minted, plus
 * any operator-attached analytics annotations. Powers the DNA tab in the
 * frontend so the user can see brand memory accumulating across runs.
 */
router.get("/dna", async (req, res) => {
  try {
    const [files, analyticsStore] = await Promise.all([
      listSkillFiles(),
      readDnaAnalytics()
    ]);

    const allItems = await Promise.all(
      files.map(async (fileName) => {
        const brandKey = brandKeyFromFileName(fileName);
        let stats = null;
        try {
          // Stat for size + mtime — quick read so the listing stays cheap.
          const skillsDir = process.env.HERMES_SKILLS_DIR;
          if (skillsDir) {
            const fullPath = path.join(skillsDir, fileName);
            const s = await fs.stat(fullPath);
            stats = { sizeBytes: s.size, modifiedAt: s.mtime.toISOString() };
          }
        } catch { /* skill listed but stat failed — ignore */ }

        return {
          fileName,
          brandKey,
          // Capitalise the first letter of each word so the UI gets a
          // proper brand-style display name without a backend rename.
          brandName: brandKey
            .split(/[-_\s]+/)
            .filter(Boolean)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" "),
          stats,
          analytics: Array.isArray(analyticsStore[brandKey]) ? analyticsStore[brandKey] : []
        };
      })
    );

    // Per-user scoping: when the caller passes ?mainWallet=0x..., return
    // only DNA files this wallet minted (plus any legacy files with no
    // owner recorded — those predate the ownership index). Without the
    // query param everything stays public for back-compat / admin views.
    const mainWallet = typeof req.query?.mainWallet === "string" ? req.query.mainWallet : null;
    const items = await filterByOwner(allItems, mainWallet);

    res.json({ count: items.length, items });
  } catch (error) {
    console.error("DNA list failed:", error?.message || error);
    res.status(500).json({ error: "Failed to list DNA files." });
  }
});

/**
 * GET /api/hermes/dna/:fileName — return the markdown body of a single DNA
 * file plus its analytics annotations. The fileName is path-traversal-
 * guarded inside readSkillFile().
 */
router.get("/dna/:fileName", async (req, res) => {
  try {
    const fileName = String(req.params.fileName || "").trim();
    if (!fileName) {
      return res.status(400).json({ error: "fileName required" });
    }
    const [content, store] = await Promise.all([
      readSkillFile(fileName),
      readDnaAnalytics()
    ]);

    if (content === null) {
      return res.status(404).json({ error: "DNA file not found." });
    }

    const brandKey = brandKeyFromFileName(fileName);

    // Ownership check: when ?mainWallet=0x… is passed, refuse to serve
    // DNA files owned by another wallet (legacy files with no owner stay
    // readable). Returns 404 instead of 403 so we don't leak the existence
    // of other users' brands.
    const callerWallet = typeof req.query?.mainWallet === "string" ? req.query.mainWallet : null;
    if (callerWallet && !(await isOwnedBy(brandKey, callerWallet))) {
      return res.status(404).json({ error: "DNA file not found." });
    }

    res.json({
      fileName,
      brandKey,
      content,
      analytics: Array.isArray(store[brandKey]) ? store[brandKey] : []
    });
  } catch (error) {
    console.error("DNA read failed:", error?.message || error);
    res.status(500).json({ error: "Failed to read DNA file." });
  }
});

/**
 * Coarse rate limit for the unauthenticated DNA analytics POST. The
 * endpoint is open by design (judges paste post-launch metrics during
 * the demo without auth), but unrestricted writes mean a bot could fill
 * the 100-entry-per-brand cap with garbage in seconds. We cap requests
 * per IP per 60s window. The window is keyed off `req.ip` which Express
 * derives from the socket — for production behind a CDN we'd `app.set
 * ('trust proxy', ...)` and key off X-Forwarded-For instead.
 */
const DNA_ANALYTICS_RATE_LIMIT = Number(process.env.DNA_ANALYTICS_RATE_LIMIT || 30);
const DNA_ANALYTICS_RATE_WINDOW_MS = Number(process.env.DNA_ANALYTICS_RATE_WINDOW_MS || 60_000);
const dnaAnalyticsBuckets = new Map();
function checkDnaAnalyticsRate(ip) {
  const now = Date.now();
  const bucket = dnaAnalyticsBuckets.get(ip) || { count: 0, resetAt: now + DNA_ANALYTICS_RATE_WINDOW_MS };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + DNA_ANALYTICS_RATE_WINDOW_MS;
  }
  bucket.count += 1;
  dnaAnalyticsBuckets.set(ip, bucket);
  // Bound the Map: 1k unique IPs is plenty for hackathon scale, evict
  // oldest entries when we exceed.
  if (dnaAnalyticsBuckets.size > 1024) {
    const firstKey = dnaAnalyticsBuckets.keys().next().value;
    if (firstKey !== undefined) dnaAnalyticsBuckets.delete(firstKey);
  }
  return bucket.count <= DNA_ANALYTICS_RATE_LIMIT;
}

/**
 * POST /api/hermes/dna/:fileName/analytics — attach a free-form analytics
 * annotation (engagement screenshot text, KPI numbers, qualitative notes)
 * to the brand DNA so future runs can incorporate the feedback loop. Body:
 *   { source: "twitter", text: "1.2K views, 47 likes", metrics: { views: 1200, likes: 47 } }
 */
router.post("/dna/:fileName/analytics", async (req, res) => {
  try {
    if (!checkDnaAnalyticsRate(req.ip || "anon")) {
      return res.status(429).json({
        error: "RATE_LIMITED",
        message: `Too many analytics writes — limit is ${DNA_ANALYTICS_RATE_LIMIT} per ${DNA_ANALYTICS_RATE_WINDOW_MS / 1000}s.`
      });
    }
    const fileName = String(req.params.fileName || "").trim();
    if (!fileName) {
      return res.status(400).json({ error: "fileName required" });
    }
    const body = req.body || {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return res.status(400).json({ error: "text required" });
    }
    if (text.length > 4000) {
      return res.status(413).json({ error: "text too long (max 4000 chars)" });
    }
    const source = typeof body.source === "string" && body.source.trim()
      ? body.source.trim().slice(0, 32)
      : "manual";
    // Metrics must be a flat object of number/string values — silently drop
    // anything else so a malformed payload can't poison the persisted JSON.
    const metrics = {};
    if (body.metrics && typeof body.metrics === "object") {
      for (const [k, v] of Object.entries(body.metrics)) {
        if (typeof v === "number" || typeof v === "string") {
          metrics[String(k).slice(0, 40)] = typeof v === "number" ? v : String(v).slice(0, 200);
        }
      }
    }

    const brandKey = brandKeyFromFileName(fileName);
    const store = await readDnaAnalytics();
    const list = Array.isArray(store[brandKey]) ? store[brandKey] : [];
    const entry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      capturedAt: new Date().toISOString(),
      source,
      text,
      metrics
    };
    // Cap per-brand list at 100 entries — keeps the file bounded even if
    // someone scripts the endpoint.
    list.push(entry);
    store[brandKey] = list.slice(-100);
    await writeDnaAnalytics(store);

    res.status(201).json({ ok: true, entry, total: store[brandKey].length });
  } catch (error) {
    console.error("DNA analytics write failed:", error?.message || error);
    res.status(500).json({ error: "Failed to save analytics annotation." });
  }
});

export default router;
