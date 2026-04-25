import crypto from "node:crypto";
import { verifyMessage } from "viem";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;
const NONCE_CAP = 8192;
const SESSION_CAP = 4096;

const usedNonces = new Map();
const sessions = new Map();

function normalizePath(pathValue) {
  const raw = String(pathValue || "").split("?")[0].trim();
  if (!raw) return "/";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed || "/";
}

function parseCookies(headerValue) {
  const parsed = {};
  const raw = String(headerValue || "");
  if (!raw) return parsed;
  for (const chunk of raw.split(";")) {
    const [key, ...rest] = chunk.split("=");
    const name = String(key || "").trim();
    if (!name) continue;
    parsed[name] = decodeURIComponent(rest.join("=").trim());
  }
  return parsed;
}

function pruneMap(map, maxAgeMs, cap) {
  const now = Date.now();
  for (const [key, entry] of map.entries()) {
    if (!entry || now - Number(entry.createdAt || 0) > maxAgeMs) {
      map.delete(key);
    }
  }
  while (map.size > cap) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function timingSafeEqual(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function getHeadlessContext(req) {
  const adminTokenExpected = String(process.env.MUSE_ADMIN_TOKEN || "").trim();
  const adminTokenProvided = String(req.get("x-muse-admin-token") || "").trim();
  const adminTokenMatches = timingSafeEqual(adminTokenExpected, adminTokenProvided);
  const headlessAuthorised =
    process.env.MUSE_SKIP_PREFLIGHT === "true" || adminTokenMatches;
  const wantsHeadless = req.body?.headless === true && headlessAuthorised;
  return {
    adminTokenMatches,
    headlessAuthorised,
    wantsHeadless
  };
}

function isSiweRequired() {
  const configured = String(process.env.MUSE_REQUIRE_SIWE || "").trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.NODE_ENV !== "development";
}

function getCanonicalPath(req) {
  return normalizePath(req.originalUrl || `${req.baseUrl || ""}${req.path || ""}`);
}

function getSignatureBundle(req) {
  return {
    signature: req.body?.signature || req.get("x-muse-siwe-signature") || "",
    nonce: req.body?.nonce || req.get("x-muse-siwe-nonce") || "",
    timestamp: req.body?.timestamp || req.get("x-muse-siwe-timestamp") || ""
  };
}

function getMainWallet(req) {
  if (typeof req.body?.mainWallet === "string") return req.body.mainWallet.trim();
  if (typeof req.query?.mainWallet === "string") return req.query.mainWallet.trim();
  return "";
}

function buildAuthMessage({ mainWallet, path, timestamp, nonce }) {
  return `MUSE_AUTH:${String(mainWallet).toLowerCase()}:${normalizePath(path)}:${timestamp}:${nonce}`;
}

function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const cookieToken = typeof cookies.muse_session === "string" ? cookies.muse_session.trim() : "";
  const headerToken = String(req.get("x-muse-session") || "").trim();
  return headerToken || cookieToken || "";
}

export function issueMuseSession(res, mainWallet) {
  const normalizedWallet = String(mainWallet || "").trim().toLowerCase();
  if (!normalizedWallet) return null;
  pruneMap(sessions, SESSION_TTL_MS, SESSION_CAP);
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  sessions.set(token, {
    mainWallet: normalizedWallet,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + SESSION_TTL_MS
  });
  res.cookie("muse_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS,
    path: "/"
  });
  return token;
}

export function readMuseSession(req) {
  pruneMap(sessions, SESSION_TTL_MS, SESSION_CAP);
  const token = getSessionToken(req);
  if (!token) return null;
  const entry = sessions.get(token);
  if (!entry) return null;
  if (Date.now() > Number(entry.expiresAt || 0)) {
    sessions.delete(token);
    return null;
  }
  entry.lastSeenAt = Date.now();
  return {
    token,
    mainWallet: entry.mainWallet,
    expiresAt: entry.expiresAt,
    lastSeenAt: entry.lastSeenAt
  };
}

export function requireSession(req, res, next) {
  const session = readMuseSession(req);
  if (!session) {
    return res.status(401).json({
      error: "SESSION_REQUIRED",
      message: "Run an authenticated task first to establish a Muse session."
    });
  }
  req.session = session;
  return next();
}

export function requireSignedMainWallet(options = {}) {
  const { allowHeadless = false } = options;
  return async function requireSignedMainWalletMiddleware(req, res, next) {
    const mainWallet = getMainWallet(req);
    const headless = getHeadlessContext(req);
    req.museAuth = {
      ...headless,
      mainWallet: mainWallet ? mainWallet.toLowerCase() : ""
    };

    if (allowHeadless && headless.wantsHeadless) {
      req.verifiedMainWallet = mainWallet ? mainWallet.toLowerCase() : null;
      return next();
    }

    if (!mainWallet || !/^0x[0-9a-fA-F]{40}$/.test(mainWallet)) {
      return next();
    }

    if (!isSiweRequired()) {
      console.warn(`[siwe] bypassed for ${getCanonicalPath(req)} (${mainWallet.toLowerCase()}) because MUSE_REQUIRE_SIWE=false`);
      req.verifiedMainWallet = mainWallet.toLowerCase();
      return next();
    }

    const { signature, nonce, timestamp } = getSignatureBundle(req);
    if (!signature || !nonce || !timestamp) {
      return res.status(401).json({
        error: "SIWE_REQUIRED",
        message: "A fresh Muse signature is required for this wallet action."
      });
    }

    const timestampMs = Number(timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > FIVE_MINUTES_MS) {
      return res.status(401).json({
        error: "SIWE_TIMESTAMP_INVALID",
        message: "Signature timestamp is outside the 5 minute replay window."
      });
    }

    const nonceKey = `${mainWallet.toLowerCase()}:${String(nonce)}`;
    pruneMap(usedNonces, FIVE_MINUTES_MS, NONCE_CAP);
    if (usedNonces.has(nonceKey)) {
      return res.status(401).json({
        error: "SIWE_NONCE_REPLAYED",
        message: "This signature nonce has already been used."
      });
    }

    const message = buildAuthMessage({
      mainWallet,
      path: getCanonicalPath(req),
      timestamp: String(timestampMs),
      nonce: String(nonce)
    });

    let verified = false;
    try {
      verified = await verifyMessage({
        address: mainWallet,
        message,
        signature: String(signature)
      });
    } catch (error) {
      return res.status(401).json({
        error: "SIWE_INVALID_SIGNATURE",
        message: error?.message || "Failed to verify signature."
      });
    }

    if (!verified) {
      return res.status(401).json({
        error: "SIWE_INVALID_SIGNATURE",
        message: "Signature does not match mainWallet."
      });
    }

    usedNonces.set(nonceKey, { createdAt: Date.now() });
    req.verifiedMainWallet = mainWallet.toLowerCase();
    return next();
  };
}

export { buildAuthMessage, getCanonicalPath };
