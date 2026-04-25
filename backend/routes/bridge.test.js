import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import bridgeRouter from "./bridge.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/bridge", bridgeRouter);
  return app;
}

async function post(app, path, body) {
  // Use supertest-style in-process dispatch via fetch against a listening port.
  // Awaits server.close() before resolving so --test-force-exit doesn't race
  // libuv's handle cleanup on Windows (UV_HANDLE_CLOSING assertion).
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      let result;
      let error;
      try {
        const { port } = server.address();
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        const payload = await res.json().catch(() => null);
        result = { status: res.status, body: payload };
      } catch (err) {
        error = err;
      } finally {
        await new Promise((done) => server.close(done));
        if (error) reject(error);
        else resolve(result);
      }
    });
  });
}

test("POST /api/bridge/preview rejects amounts larger than the configured cap", async () => {
  const prev = process.env.BRIDGE_PREVIEW_MAX_USDC;
  process.env.BRIDGE_PREVIEW_MAX_USDC = "1000";

  // Re-import so the module recomputes the cap constant.
  const freshRouter = (await import(`./bridge.js?cap=${Date.now()}`)).default;
  const app = express();
  app.use(express.json());
  app.use("/api/bridge", freshRouter);

  try {
    const { status, body } = await post(app, "/api/bridge/preview", {
      amountUsdc: 1_000_000,
      destinationChainId: 84532,
      destinationAddress: "0x1111111111111111111111111111111111111111"
    });
    assert.equal(status, 400);
    assert.match(String(body?.error || ""), /exceeds preview cap/i);
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_PREVIEW_MAX_USDC;
    else process.env.BRIDGE_PREVIEW_MAX_USDC = prev;
  }
});

test("POST /api/bridge/preview rejects zero / negative amounts", async () => {
  const app = createApp();
  const { status, body } = await post(app, "/api/bridge/preview", {
    amountUsdc: 0,
    destinationChainId: 84532,
    destinationAddress: "0x1111111111111111111111111111111111111111"
  });
  assert.equal(status, 400);
  assert.match(String(body?.error || ""), /must be > 0/i);
});

test("POST /api/bridge/preview rejects unsupported destination chains", async () => {
  const app = createApp();
  const { status, body } = await post(app, "/api/bridge/preview", {
    amountUsdc: 1,
    destinationChainId: 99999,
    destinationAddress: "0x1111111111111111111111111111111111111111"
  });
  assert.equal(status, 400);
  assert.match(String(body?.error || ""), /unsupported destinationchainid/i);
});

test("POST /api/bridge/preview rejects malformed destination addresses", async () => {
  const app = createApp();
  const { status, body } = await post(app, "/api/bridge/preview", {
    amountUsdc: 1,
    destinationChainId: 84532,
    destinationAddress: "not-an-address"
  });
  assert.equal(status, 400);
  assert.match(String(body?.error || ""), /valid evm address/i);
});
