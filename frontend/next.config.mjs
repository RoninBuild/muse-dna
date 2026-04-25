import "../shared/load-env.mjs";

const backendInternalUrl =
  process.env.BACKEND_INTERNAL_URL || "http://localhost:3001";

// Baseline browser-facing security headers. Kept deliberately permissive for
// Next.js + inline styles + wagmi/web3 injection; tighten once the app has a
// real asset manifest.
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Next auto-redirects `/socket.io/` → `/socket.io` (trailing-slash
  // normalization) BEFORE applying rewrites. The socket.io client always
  // appends the trailing slash, so the redirect stripped it, the rewrite
  // source no longer matched, and the client landed on a 404. Result: the
  // task page stayed OFFLINE and never received orchestrator events.
  // Skipping the redirect lets the rewrite fire on the original URL.
  skipTrailingSlashRedirect: true,
  // Gemini + AIMLAPI fallback can take up to ~60s on a cold cache when the
  // variant planner is called. The default Next rewrite proxy timeout is 30s
  // and was silently turning a legitimate 200 from the backend into a 500 at
  // the proxy layer, which the UI surfaced as "Planner 500 — timed out".
  // Raising to 120s matches the backend worst-case ceiling.
  experimental: {
    proxyTimeout: 120_000
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS
      }
    ];
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${backendInternalUrl}/api/:path*`
      },
      {
        source: "/socket.io/:path*",
        destination: `${backendInternalUrl}/socket.io/:path*`
      },
      {
        source: "/health/backend",
        destination: `${backendInternalUrl}/health`
      }
    ];
  }
};

export default nextConfig;
