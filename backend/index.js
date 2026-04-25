import "../shared/load-env.mjs";
import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import bridgeRouter from "./routes/bridge.js";
import hermesRouter from "./routes/hermes.js";
import historyRouter from "./routes/history.js";
import registryRouter from "./routes/registry.js";
import tasksRouter from "./routes/tasks.js";
import walletRouter from "./routes/wallet.js";
import { db } from "./db/index.js";
import { seedMuseAgents } from "./services/agentRegistry.js";

// Backend hosts long-running socket.io rooms; a single rogue rejection in a
// fire-and-forget `runTask` branch used to kill the whole process and silently
// drop every in-flight task. Log and keep running — per-task failures are
// already surfaced through the room via `task:error`.
process.on("unhandledRejection", (reason) => {
  console.error("Backend unhandledRejection:", reason?.stack || reason?.message || reason);
});
process.on("uncaughtException", (error) => {
  console.error("Backend uncaughtException:", error?.stack || error?.message || error);
});

const port = Number(process.env.PORT || 3001);
const app = express();
const httpServer = createServer(app);
const ALLOWED_ORIGIN = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGIN,
    // Mirror the express CORS behaviour. Without `credentials: true` a
    // browser running the frontend on a different port (the dev setup:
    // localhost:3000 → backend localhost:3001) silently refuses the
    // socket handshake when the page later sets a session cookie.
    credentials: true
  }
});
const RECOVERY_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];
let recoveryPending = true;
let recoveryFailures = 0;
let recoveryTimer = null;
let recoveryInFlight = false;

function clearRecoveryTimer() {
  if (!recoveryTimer) {
    return;
  }

  clearTimeout(recoveryTimer);
  recoveryTimer = null;
}

async function recoverInterruptedTasks(trigger = "startup") {
  const recoveryEnabled = (process.env.MUSE_RECOVER_INTERRUPTED_TASKS || "true") !== "false";

  if (!recoveryEnabled) {
    recoveryPending = false;
    clearRecoveryTimer();
    return;
  }

  const interruptedTasks = await db.tasks.findByStatuses(["running"]);

  if (db.getMode() !== "postgres") {
    throw new Error(`Interrupted task recovery requires Postgres; current DB mode is ${db.getMode()}.`);
  }

  recoveryPending = false;
  recoveryFailures = 0;
  clearRecoveryTimer();

  if (interruptedTasks.length === 0) {
    return;
  }

  const completedAt = new Date().toISOString();
  const recoveryReason =
    "Backend restarted before orchestration finished. Re-run the task to rebuild the ledger cleanly.";

  await Promise.allSettled(
    interruptedTasks.map((task) =>
      db.tasks.update(task.id, {
        status: "failed",
        errorLog: recoveryReason,
        completedAt
      })
    )
  );

  console.warn(
    `Recovered ${interruptedTasks.length} interrupted task(s) by marking them failed after ${trigger}.`
  );
}

async function runInterruptedTaskRecovery(trigger) {
  if (!recoveryPending || recoveryInFlight) {
    return;
  }

  clearRecoveryTimer();
  recoveryInFlight = true;

  try {
    await recoverInterruptedTasks(trigger);
  } catch (error) {
    recoveryFailures += 1;

    if (recoveryFailures > RECOVERY_RETRY_DELAYS_MS.length) {
      recoveryPending = false;
      console.error(
        `Interrupted task recovery failed ${recoveryFailures} times; giving up until operator restart:`,
        error?.message || error
      );
      return;
    }

    const delayMs = RECOVERY_RETRY_DELAYS_MS[recoveryFailures - 1];
    console.error(
      `Interrupted task recovery failed (${trigger}); retry ${recoveryFailures}/${RECOVERY_RETRY_DELAYS_MS.length} in ${Math.round(delayMs / 1000)}s:`,
      error?.message || error
    );

    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      void runInterruptedTaskRecovery(`retry-${recoveryFailures}`);
    }, delayMs);

    if (recoveryTimer.unref) {
      recoveryTimer.unref();
    }
  } finally {
    recoveryInFlight = false;
  }
}

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: "256kb" }));
app.set("io", io);

// Accept either canonical UUID v1-5 OR the "sim-<ts>-<rand>" prefix used by
// the frontend simulation mode. Everything else is rejected so room names
// stay bounded and enumeration tricks are blocked.
const TASK_ID_PATTERN = /^(sim-[a-z0-9-]{6,32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

io.on("connection", (socket) => {
  socket.emit("server:ready", { message: "Muse backend connected." });

  socket.on("task:subscribe", async (taskId) => {
    if (typeof taskId !== "string" || !taskId.trim() || !TASK_ID_PATTERN.test(taskId.trim())) {
      return;
    }
    socket.join(`task:${taskId}`);

    try {
      const [task, steps] = await Promise.all([
        db.tasks.findById(taskId),
        db.steps.findByTask(taskId)
      ]);

      if (task) {
        socket.emit("task:snapshot", { task, steps });
      }
    } catch (error) {
      console.error("Task snapshot sync failed:", error.message);
    }
  });

  socket.on("task:unsubscribe", (taskId) => {
    if (typeof taskId !== "string" || !taskId.trim() || !TASK_ID_PATTERN.test(taskId.trim())) {
      return;
    }
    socket.leave(`task:${taskId}`);
  });

  socket.on("disconnect", () => {
    // M14 fix: only remove our custom listeners, not internal Socket.IO ones.
    socket.removeAllListeners("task:subscribe");
    socket.removeAllListeners("task:unsubscribe");
  });
});

app.get("/health", async (_req, res) => {
  const databaseHealth = await db
    .healthcheck()
    .catch((error) => {
      console.error("Database healthcheck failed:", error.message);
      return {
        ok: false,
        mode: "disconnected",
        reason: error.message
      };
    });

  const degraded = !databaseHealth.ok;

  res.status(degraded ? 503 : 200).json({
    status: degraded ? "degraded" : "ok",
    database: databaseHealth.mode,
    reason: databaseHealth.reason,
    service: "backend",
    timestamp: new Date().toISOString()
  });
});

app.use("/api/tasks", tasksRouter);
app.use("/api/history", historyRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/hermes", hermesRouter);
app.use("/api/registry", registryRouter);
app.use("/api/bridge", bridgeRouter);

// Body-parser size error → clean 413 JSON. Without this `express.json()`
// throws an HTML error page for "request entity too large" which the
// frontend then tries to JSON.parse and fails with a confusing message.
app.use((err, _req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({
      error: "PAYLOAD_TOO_LARGE",
      message: "Request body exceeds the 256kb limit."
    });
  }
  return next(err);
});

// Catch-all error handler — final defence against async throws inside
// route handlers that forgot a try/catch. Without this Express returns a
// blank HTML 500 page that the frontend can't parse. Logs the full
// stacktrace server-side; sends a stable JSON shape to the client.
// MUST be the last `app.use` after every route mount.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("Unhandled route error:", err?.stack || err?.message || err);
  if (res.headersSent) {
    // Express requires us to delegate to the default handler if headers
    // already went out — closing the connection ourselves desyncs HTTP/1.1.
    return _next(err);
  }
  res.status(500).json({
    error: "INTERNAL_ERROR",
    message: "Backend crashed on this request — check server logs."
  });
});

// 404 — falls through any router that didn't match. Keeps the JSON shape
// consistent so the frontend can branch on it instead of getting raw HTML.
app.use((_req, res) => {
  res.status(404).json({ error: "NOT_FOUND" });
});

async function start() {
  // Register the DB-reconnect hook BEFORE the first recovery attempt so that
  // if Postgres is down at startup and comes back 30 s later, recovery fires
  // automatically rather than waiting for an operator restart.
  db.onReconnect(() => runInterruptedTaskRecovery("pg-reconnect"));

  // Use the retry-aware wrapper (not recoverInterruptedTasks directly) so that
  // a startup failure schedules exponential-backoff retries instead of giving
  // up after the first attempt.
  void runInterruptedTaskRecovery("startup");

  try {
    const seeded = await seedMuseAgents();
    const onChain = seeded.filter((r) => r.mode === "on-chain").length;
    const inProcess = seeded.filter((r) => r.mode === "in-process").length;
    console.log(
      `Agent Registry seeded: ${onChain} on-chain, ${inProcess} in-process, ${seeded.length - onChain - inProcess} failed.`
    );
  } catch (error) {
    console.warn("Agent registry seeding failed:", error.message);
  }

  httpServer.listen(port, () => {
    console.log(`Muse backend listening on :${port}`);
  });
  httpServer.on("error", (err) => {
    console.error(`Backend failed to bind :${port}: ${err.code || err.message}`);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal} — stopping accepts, draining in-flight work.`);
    // Stop accepting new HTTP requests first. Do NOT close io yet — the
    // orchestrator's in-flight `socket.emit()` calls need the rooms to
    // stay alive so the frontend sees the final unit results.
    httpServer.close(() => {
      try { io.close(); } catch {}
      Promise.resolve(db.close?.()).catch(() => {}).finally(() => process.exit(0));
    });
    // Hard cap: if something holds the loop open for more than 12s, bail.
    setTimeout(() => process.exit(0), 12_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start();
