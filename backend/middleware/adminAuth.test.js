import assert from "node:assert/strict";
import test from "node:test";
import { requireAdminAuth } from "./adminAuth.js";

function createReqRes({ headers = {} } = {}) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
  const req = {
    headers,
    get(name) {
      const key = name.toLowerCase();
      for (const [rawKey, value] of Object.entries(headers)) {
        if (rawKey.toLowerCase() === key) return value;
      }
      return undefined;
    }
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  return { req, res, next, get nextCalled() { return nextCalled; } };
}

test("requireAdminAuth falls open in development when MUSE_ADMIN_TOKEN is unset", () => {
  const prevToken = process.env.MUSE_ADMIN_TOKEN;
  const prevEnv = process.env.NODE_ENV;
  delete process.env.MUSE_ADMIN_TOKEN;
  process.env.NODE_ENV = "development";

  try {
    const ctx = createReqRes();
    requireAdminAuth(ctx.req, ctx.res, ctx.next);
    assert.equal(ctx.nextCalled, true);
    assert.equal(ctx.res.statusCode, 200);
  } finally {
    if (prevToken !== undefined) process.env.MUSE_ADMIN_TOKEN = prevToken;
    if (prevEnv !== undefined) process.env.NODE_ENV = prevEnv;
  }
});

test("requireAdminAuth fails closed in production when MUSE_ADMIN_TOKEN is unset", () => {
  const prevToken = process.env.MUSE_ADMIN_TOKEN;
  const prevEnv = process.env.NODE_ENV;
  delete process.env.MUSE_ADMIN_TOKEN;
  process.env.NODE_ENV = "production";

  try {
    const ctx = createReqRes();
    requireAdminAuth(ctx.req, ctx.res, ctx.next);
    assert.equal(ctx.nextCalled, false);
    assert.equal(ctx.res.statusCode, 503);
  } finally {
    if (prevToken !== undefined) process.env.MUSE_ADMIN_TOKEN = prevToken;
    if (prevEnv !== undefined) process.env.NODE_ENV = prevEnv;
    else delete process.env.NODE_ENV;
  }
});

test("requireAdminAuth rejects an invalid token", () => {
  const prevToken = process.env.MUSE_ADMIN_TOKEN;
  process.env.MUSE_ADMIN_TOKEN = "correct-secret-token";

  try {
    const ctx = createReqRes({ headers: { "x-muse-admin-token": "wrong" } });
    requireAdminAuth(ctx.req, ctx.res, ctx.next);
    assert.equal(ctx.nextCalled, false);
    assert.equal(ctx.res.statusCode, 401);
  } finally {
    if (prevToken !== undefined) process.env.MUSE_ADMIN_TOKEN = prevToken;
    else delete process.env.MUSE_ADMIN_TOKEN;
  }
});

test("requireAdminAuth accepts the correct token and uses timing-safe comparison for same-length inputs", () => {
  const prevToken = process.env.MUSE_ADMIN_TOKEN;
  process.env.MUSE_ADMIN_TOKEN = "correct-secret-token";

  try {
    const ctx = createReqRes({ headers: { "x-muse-admin-token": "correct-secret-token" } });
    requireAdminAuth(ctx.req, ctx.res, ctx.next);
    assert.equal(ctx.nextCalled, true);
    assert.equal(ctx.res.statusCode, 200);
  } finally {
    if (prevToken !== undefined) process.env.MUSE_ADMIN_TOKEN = prevToken;
    else delete process.env.MUSE_ADMIN_TOKEN;
  }
});

test("requireAdminAuth rejects a missing header even when token is configured", () => {
  const prevToken = process.env.MUSE_ADMIN_TOKEN;
  process.env.MUSE_ADMIN_TOKEN = "correct-secret-token";

  try {
    const ctx = createReqRes();
    requireAdminAuth(ctx.req, ctx.res, ctx.next);
    assert.equal(ctx.nextCalled, false);
    assert.equal(ctx.res.statusCode, 401);
    assert.match(String(ctx.res.body?.error || ""), /token required/i);
  } finally {
    if (prevToken !== undefined) process.env.MUSE_ADMIN_TOKEN = prevToken;
    else delete process.env.MUSE_ADMIN_TOKEN;
  }
});
