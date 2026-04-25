import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const rootEnvPath = path.resolve(currentDir, "..", ".env");

if (typeof process.loadEnvFile === "function" && fs.existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

const proxyUrl =
  process.env.GLOBAL_AGENT_HTTP_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  "";

const noProxyRules = String(
  process.env.NO_PROXY ||
    process.env.no_proxy ||
    "localhost,127.0.0.1,::1"
)
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

let proxyBootstrapApplied = false;

function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
}

function stripPort(hostname) {
  const raw = String(hostname || "").trim().toLowerCase();

  // Handle bracketed IPv6 with optional port: [::1]:8080
  const bracketMatch = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketMatch) {
    return bracketMatch[1];
  }

  const normalized = normalizeHostname(raw);

  const lastColonIndex = normalized.lastIndexOf(":");
  if (lastColonIndex === -1) {
    return normalized;
  }

  const maybePort = normalized.slice(lastColonIndex + 1);
  return /^\d+$/.test(maybePort) ? normalized.slice(0, lastColonIndex) : normalized;
}

function isLoopbackHost(hostname) {
  const normalized = stripPort(hostname);
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}

function matchesNoProxyRule(hostname, rule) {
  if (!rule) {
    return false;
  }

  if (rule === "*") {
    return true;
  }

  const normalizedHost = stripPort(hostname);
  const normalizedRule = stripPort(rule);

  if (!normalizedRule) {
    return false;
  }

  if (normalizedHost === normalizedRule) {
    return true;
  }

  if (normalizedRule.startsWith(".")) {
    return normalizedHost.endsWith(normalizedRule);
  }

  return normalizedHost.endsWith(`.${normalizedRule}`);
}

function shouldBypassProxy(hostname) {
  if (!hostname) {
    return true;
  }

  if (isLoopbackHost(hostname)) {
    return true;
  }

  return noProxyRules.some((rule) => matchesNoProxyRule(hostname, rule));
}

function getTargetHostname(input) {
  if (!input) {
    return "";
  }

  if (typeof input === "string") {
    try {
      return new URL(input).hostname;
    } catch {
      return "";
    }
  }

  if (input instanceof URL) {
    return input.hostname;
  }

  if (typeof input === "object") {
    return input.hostname || input.host || "";
  }

  return "";
}

function shouldProxyFetch(input, init) {
  if (!proxyUrl) {
    return false;
  }

  if (init?.dispatcher) {
    return false;
  }

  const targetHostname = getTargetHostname(input);
  return Boolean(targetHostname) && !shouldBypassProxy(targetHostname);
}

function patchGlobalFetch(proxyDispatcher) {
  const originalFetch = globalThis.fetch;

  if (typeof originalFetch !== "function" || originalFetch.__museProxyPatched) {
    return;
  }

  const patchedFetch = function patchedFetch(input, init = undefined) {
    if (!shouldProxyFetch(input, init)) {
      return originalFetch.call(this, input, init);
    }

    const nextInit = {
      ...(init || {}),
      dispatcher: proxyDispatcher
    };

    return undiciFetch(input, nextInit);
  };

  Object.defineProperty(patchedFetch, "__museProxyPatched", {
    value: true,
    enumerable: false
  });

  globalThis.fetch = patchedFetch;
}

function patchHttpsTransport(proxyAgent) {
  if (https.request.__museProxyPatched) {
    return;
  }

  const originalRequest = https.request.bind(https);
  const originalGet = https.get.bind(https);

  const patchArgs = (args) => {
    if (!proxyUrl) {
      return args;
    }

    if (typeof args[0] === "string" || args[0] instanceof URL) {
      const targetUrl = args[0] instanceof URL ? args[0] : new URL(args[0]);

      if (targetUrl.protocol !== "https:" || shouldBypassProxy(targetUrl.hostname)) {
        return args;
      }

      const secondArg = args[1];
      if (secondArg && typeof secondArg === "object" && secondArg.agent !== undefined) {
        return args;
      }

      const mergedOptions =
        secondArg && typeof secondArg === "object"
          ? { ...secondArg, agent: proxyAgent }
          : { agent: proxyAgent };

      return [args[0], mergedOptions, ...args.slice(2)];
    }

    if (args[0] && typeof args[0] === "object") {
      const options = args[0];
      const protocol = options.protocol || "https:";
      const hostname = options.hostname || options.host || "";

      if (protocol !== "https:" || shouldBypassProxy(hostname) || options.agent !== undefined) {
        return args;
      }

      return [{ ...options, agent: proxyAgent }, ...args.slice(1)];
    }

    return args;
  };

  const patchedRequest = function patchedHttpsRequest(...args) {
    return originalRequest(...patchArgs(args));
  };

  const patchedGet = function patchedHttpsGet(...args) {
    return originalGet(...patchArgs(args));
  };

  Object.defineProperty(patchedRequest, "__museProxyPatched", {
    value: true,
    enumerable: false
  });

  https.request = patchedRequest;
  https.get = patchedGet;
}

function isLocalProxy(url) {
  try {
    const parsed = new URL(url);
    // URL.hostname strips IPv6 brackets, so match the bare form. The previous
    // regex required "[::1]" and therefore never matched an IPv6 loopback
    // proxy, sending the probe to the wrong port.
    return /^(localhost|127\.0\.0\.1|::1)$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Async proxy probe. Resolves true iff the proxy host accepts a TCP
 * connection within the timeout. Used once at bootstrap (top-level await)
 * so we can decide whether to patch transports or bypass.
 */
function probeProxyAsync(url, timeoutMs = 500) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const socket = net.createConnection({
        host: parsed.hostname,
        port: Number(parsed.port || 80)
      });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

let proxySkipReason = null;

function redactProxyUrl(url) {
  // Strip user:password@ from the URL before logging — proxies often
  // embed bearer credentials in the URL (`http://user:pass@host:port`)
  // and we never want to leak those into log shipping / GitHub Actions
  // / pasted error reports.
  return String(url || "").replace(/(\/\/)([^/@]+)@/, "$1***@");
}

function skipProxyAndCleanEnv(reason) {
  proxySkipReason = reason;
  console.warn(`[load-env] ${reason}. Re-run after starting the VPN to route through ${redactProxyUrl(proxyUrl)}.`);
  delete process.env.GLOBAL_AGENT_HTTP_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;
  proxyBootstrapApplied = true;
}

async function bootstrapProxyTransport() {
  if (!proxyUrl || proxyBootstrapApplied) {
    return;
  }

  // If the configured proxy is local (VPN on 127.0.0.1 etc.) and the port is
  // not listening, silently skip patching — the user may not have the VPN
  // running and their network may reach APIs directly.
  if (isLocalProxy(proxyUrl)) {
    const reachable = await probeProxyAsync(proxyUrl);
    if (!reachable) {
      skipProxyAndCleanEnv(`local proxy ${proxyUrl} not reachable at startup — transports left unpatched`);
      return;
    }
  }

  const fetchProxyDispatcher = new ProxyAgent(proxyUrl);
  const httpsProxyAgent = new HttpsProxyAgent(proxyUrl);

  patchGlobalFetch(fetchProxyDispatcher);
  patchHttpsTransport(httpsProxyAgent);

  // Prevent axios/follow-redirects and other SDK internals from trying to
  // apply proxy env handling a second time on top of our explicit transport patch.
  delete process.env.GLOBAL_AGENT_HTTP_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;

  proxyBootstrapApplied = true;
}

await bootstrapProxyTransport();

export const museProxy = {
  enabled: Boolean(proxyUrl) && !proxySkipReason,
  proxyUrl: proxySkipReason ? "" : proxyUrl,
  configuredProxyUrl: proxyUrl,
  noProxyRules,
  skipReason: proxySkipReason
};
