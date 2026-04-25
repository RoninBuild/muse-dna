import { timingSafeEqual } from "node:crypto";

/**
 * Guard for sensitive admin-level operations (wallet create, withdraw,
 * registry seed).
 *
 * Behaviour:
 *  - If MUSE_ADMIN_TOKEN is set, requests MUST send the matching value in
 *    `x-muse-admin-token`; mismatches are rejected with 401.
 *  - If it isn't set and `strict: true` is passed (e.g. on state-mutating
 *    endpoints like /registry/seed), we reject with 401 even in dev —
 *    those endpoints should never fall open.
 *  - If it isn't set, `strict` is false, and NODE_ENV !== "production",
 *    the request is allowed through so local dev tooling (scripts/e2e)
 *    can exercise the routes.
 *  - Production (NODE_ENV=production) with no token configured fails
 *    closed with 503 regardless of `strict`.
 */
export function requireAdminAuth(req, res, next) {
  return guard(req, res, next, { strict: false });
}

export function requireAdminAuthStrict(req, res, next) {
  return guard(req, res, next, { strict: true });
}

function guard(req, res, next, { strict }) {
  const expected = String(process.env.MUSE_ADMIN_TOKEN || "").trim();

  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      return res.status(503).json({
        error:
          "MUSE_ADMIN_TOKEN is not configured on the backend. Refuse to run admin endpoint in production."
      });
    }
    if (strict) {
      return res.status(401).json({
        error: "Admin endpoint disabled (set MUSE_ADMIN_TOKEN to enable)."
      });
    }
    return next();
  }

  const provided = String(req.get("x-muse-admin-token") || "").trim();

  if (!provided) {
    return res.status(401).json({ error: "Admin token required." });
  }

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);

  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    return res.status(401).json({ error: "Invalid admin token." });
  }

  return next();
}
