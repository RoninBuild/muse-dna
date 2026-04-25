#!/usr/bin/env node
/**
 * Single-process launcher that runs the backend + 4 agent services in
 * one container. Used for cost-conscious deployments (Render free tier,
 * Fly.io single VM) where 5 separate web services would exceed the free
 * quota.
 *
 * Topology inside the container:
 *   - backend  → ${PORT}       (publicly exposed by the host)
 *   - strategy → 3101 (loopback only)
 *   - search   → 3102 (loopback only)
 *   - copy     → 3103 (loopback only)
 *   - image    → 3104 (loopback only)
 *
 * Backend's STRATEGY_AGENT_URL / FAST_SEARCH_AGENT_URL / etc default to
 * `http://localhost:31xx/execute` which lines up exactly. Each child
 * inherits process.env minus its own PORT override.
 *
 * If ANY child crashes the whole process exits non-zero so the host
 * (Render) restarts the container. This is intentional — partial
 * availability (backend up, image-agent down) creates confusing demo
 * states.
 */

import { spawn } from "node:child_process";
import process from "node:process";

const HOST_PORT = String(process.env.PORT || "3001");

const services = [
  { name: "backend",  cwd: "backend",            port: HOST_PORT, args: ["index.js"]  },
  { name: "strategy", cwd: "agents/strategy",    port: "3101",    args: ["server.js"] },
  { name: "search",   cwd: "agents/fast-search", port: "3102",    args: ["server.js"] },
  { name: "copy",     cwd: "agents/copywriter",  port: "3103",    args: ["server.js"] },
  { name: "image",    cwd: "agents/image",       port: "3104",    args: ["server.js"] }
];

const colors = {
  backend: "\x1b[36m",
  strategy: "\x1b[33m",
  search: "\x1b[32m",
  copy: "\x1b[34m",
  image: "\x1b[35m"
};
const RESET = "\x1b[0m";

const children = [];
let shuttingDown = false;

function pipe(name, stream, dst) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      dst.write(`${colors[name] || ""}[${name}]${RESET} ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (buf) dst.write(`${colors[name] || ""}[${name}]${RESET} ${buf}\n`);
  });
}

function start(svc) {
  const env = { ...process.env, PORT: svc.port };
  const child = spawn("node", svc.args, {
    cwd: svc.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  pipe(svc.name, child.stdout, process.stdout);
  pipe(svc.name, child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[launcher] ${svc.name} exited code=${code} signal=${signal}; tearing down.`);
    shutdown(code ?? 1);
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try { c.kill("SIGTERM"); } catch { /* already dead */ }
  }
  // Hard cap: if children won't exit in 8s, force-kill the whole process.
  setTimeout(() => process.exit(code), 8_000).unref();
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT",  () => shutdown(0));

console.log(`[launcher] starting ${services.length} services (backend on ${HOST_PORT}, agents on 3101-3104)`);
for (const svc of services) {
  children.push(start(svc));
}
