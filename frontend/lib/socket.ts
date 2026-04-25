import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

/**
 * Resolve the socket.io endpoint. In same-origin deployments (Next.js dev
 * proxy or a rewrite rule pointing /socket.io at the backend) no URL is
 * needed. In split-domain deployments NEXT_PUBLIC_BACKEND_URL must point at
 * the backend so the browser does not try to connect to the frontend host.
 *
 * We intentionally ignore a value that clearly points back at the frontend
 * (the default placeholder in .env.example is http://localhost:3000, i.e.
 * the same port as the Next.js dev server) — that would be a misconfig that
 * breaks the socket at runtime.
 */
function resolveSocketEndpoint(): string | undefined {
  const raw = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_BACKEND_URL : undefined;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (typeof window !== "undefined") {
      if (url.host === window.location.host) {
        return undefined;
      }
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

// Explicit reconnect tuning so a backend restart doesn't trigger a
// thundering-herd hammer from every open tab. socket.io defaults retry
// every ~100ms — that's fine for a single dev session, brutal in any
// multi-tab scenario. We back off geometrically with jitter and cap the
// total retry count so a permanently-down backend stops eventually.
const SOCKET_OPTS = {
  path: "/socket.io",
  transports: ["websocket", "polling"] as string[],
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: 30,
  reconnectionDelay: 1_000,
  reconnectionDelayMax: 8_000,
  randomizationFactor: 0.5,
  timeout: 20_000
};

export function getMuseSocket() {
  if (!socket) {
    const endpoint = resolveSocketEndpoint();
    socket = endpoint ? io(endpoint, SOCKET_OPTS) : io(SOCKET_OPTS);
  }

  return socket;
}
