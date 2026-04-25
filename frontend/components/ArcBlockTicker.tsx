"use client";

import { useEffect, useRef, useState } from "react";

const ARC_RPC = process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://rpc.testnet.arc.network";

function formatNumber(n: number) {
  return n.toLocaleString("en-US");
}

/**
 * Live Arc Testnet block-height ticker.
 *
 * Polls eth_blockNumber every 6s. Shows a monospaced terminal-style counter
 * with a blinking cursor and a "ping" dot each time a new block lands.
 *
 * Graceful offline mode: if the RPC isn't reachable (locked-down sandbox),
 * shows the last known height dim + "OFFLINE" label so the UI doesn't break.
 */
export default function ArcBlockTicker() {
  const [height, setHeight] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const [pulse, setPulse] = useState(0);
  const lastHeight = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function fetchHeight() {
      // Abort after 4s so a stuck RPC doesn't block the whole ticker loop.
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 4_000);
      try {
        const res = await fetch(ARC_RPC, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
          cache: "no-store",
          signal: controller.signal
        });
        if (!res.ok) throw new Error(`rpc ${res.status}`);
        const data = await res.json();
        if (data?.result) {
          const parsed = parseInt(data.result, 16);
          if (!cancelled && Number.isFinite(parsed)) {
            if (lastHeight.current !== null && parsed > lastHeight.current) setPulse((p) => p + 1);
            lastHeight.current = parsed;
            setHeight(parsed);
            // Reset stale on every successful fetch so the ticker recovers
            // automatically once the RPC comes back online.
            setStale(false);
          }
        }
      } catch {
        if (!cancelled) setStale(true);
      } finally {
        clearTimeout(abortTimer);
        if (!cancelled) timer = setTimeout(fetchHeight, 6_000);
      }
    }

    fetchHeight();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5rem",
        fontFamily: "var(--font-mono)",
        fontSize: "0.65rem",
        letterSpacing: "0.15em",
        color: stale ? "var(--text-dim)" : "var(--text)",
        padding: "0.25rem 0.55rem",
        border: `1px solid ${stale ? "rgba(255,255,255,0.15)" : "rgba(198,245,31,0.35)"}`,
        background: stale ? "transparent" : "rgba(198,245,31,0.05)"
      }}
    >
      <span
        key={pulse}
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: stale ? "var(--text-dim)" : "var(--acid)",
          boxShadow: stale ? "none" : "0 0 8px var(--acid-glow-strong)",
          animation: stale ? undefined : "muse-block-pulse 900ms ease-out"
        }}
      />
      <span style={{ color: "var(--text-dim)" }}>ARC TESTNET</span>
      <span style={{ color: stale ? "var(--text-dim)" : "var(--acid)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
        {height !== null ? `#${formatNumber(height)}` : "·········"}
      </span>
      {stale && <span style={{ color: "var(--text-dim)" }}>OFFLINE</span>}
      <style jsx>{`
        @keyframes muse-block-pulse {
          0%   { transform: scale(2.6); opacity: 0; }
          40%  { opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
