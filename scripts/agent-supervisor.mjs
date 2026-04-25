// Background supervisor: pings each agent every 10s and restarts any that
// stop responding. Keeps the swarm alive through transient crashes without
// requiring the operator to babysit terminals. Run alongside `npm run dev`:
//   node scripts/agent-supervisor.mjs &

import { spawn } from "node:child_process";

const AGENTS = [
  { name: "strategy",  port: 3101, workspace: "@muse/strategy-agent"    },
  { name: "search",    port: 3102, workspace: "@muse/fast-search-agent" },
  { name: "copy",      port: 3103, workspace: "@muse/copywriter-agent"  },
  { name: "image",     port: 3104, workspace: "@muse/image-agent"       }
];

const CHECK_INTERVAL_MS = Number(process.env.SUPERVISOR_INTERVAL_MS || 8000);
const PROBE_TIMEOUT_MS = 4000;
const restartsInProgress = new Set();
const lastRestartAt = new Map();
const RESTART_COOLDOWN_MS = 15_000;
// Track the last spawned PID per agent so we can ensure a previous spawn
// is no longer running before we kick off another. Without this, a slow-
// to-bind agent that probes as "down" while still alive would accumulate
// orphaned npm wrapper processes on every cycle.
const lastSpawnedPid = new Map();

async function probe(port) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ac.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    clearTimeout(t);
    return false;
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    // Sending signal 0 is a non-destructive existence check on POSIX.
    // On Windows, process.kill(pid, 0) throws if the process is gone.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function restart({ name, workspace }) {
  if (restartsInProgress.has(name)) return;
  const last = lastRestartAt.get(name) || 0;
  if (Date.now() - last < RESTART_COOLDOWN_MS) return;

  // If the previous spawn is still alive, the probe must be flapping
  // (binding/loading) — give it more time rather than stacking another
  // npm wrapper that'll race for the port.
  const prevPid = lastSpawnedPid.get(name);
  if (prevPid && isPidAlive(prevPid)) {
    console.log(`[supervisor] ${name} previous spawn pid=${prevPid} still alive — skipping restart`);
    return;
  }

  restartsInProgress.add(name);
  lastRestartAt.set(name, Date.now());
  console.log(`[supervisor] ${new Date().toISOString()} ${name} not reachable → restarting via ${workspace}`);

  const proc = spawn("npm", ["run", "dev", "--workspace", workspace], {
    cwd: process.cwd(),
    stdio: "ignore",
    detached: true,
    shell: true
  });
  if (proc.pid) lastSpawnedPid.set(name, proc.pid);
  proc.unref();

  setTimeout(() => {
    restartsInProgress.delete(name);
  }, RESTART_COOLDOWN_MS);
}

async function cycle() {
  for (const agent of AGENTS) {
    const ok = await probe(agent.port);
    if (!ok) restart(agent);
  }
}

console.log(`[supervisor] watching ${AGENTS.map(a => `${a.name}:${a.port}`).join(", ")} every ${CHECK_INTERVAL_MS}ms`);
await cycle();
setInterval(cycle, CHECK_INTERVAL_MS);
