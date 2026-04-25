"use client";

import { useMemo } from "react";
import type { LiveUnit } from "@/lib/useTaskLive";
import AgentAvatar from "@/components/AgentAvatar";

const SERVICE_COLORS: Record<string, string> = {
  strategy: "#66F1D0",
  search: "#5FA8FF",
  copy: "#FFD21A",
  image: "#FF6B9D"
};

const SERVICE_LABELS: Record<string, string> = {
  strategy: "Strategy DNA",
  search: "Search Signal",
  copy: "Copy Pulse",
  image: "Visual Frame"
};

const STATUS_GLYPHS: Record<LiveUnit["status"], string> = {
  pending: "□",
  requesting: "◎",
  paying: "⟳",
  validated: "▰",
  reused: "↺",
  failed: "⚠"
};

const ARC_EXPLORER_BASE =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_ARC_EXPLORER_BASE) ||
  "https://testnet.arcscan.app";

function short(hash: string | null | undefined) {
  if (!hash) return "";
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

/**
 * Build an ArcScan URL for a row even if the backend didn't persist one.
 * Older task records stored `arc_url = null` when the payment `network` field
 * didn't exactly match the Arc CAIP-2 string at write time — the ↗ button
 * disappeared on those rows even though the tx hash itself is valid. We
 * reconstruct the URL on the client so the button shows up whenever the
 * hash looks like a real EVM transaction (`0x` + 64 hex).
 */
function resolveArcUrl(u: LiveUnit): string | null {
  if (u.arcUrl) return u.arcUrl;
  const hash = u.txHash;
  if (!hash || typeof hash !== "string") return null;
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) return null;
  return `${ARC_EXPLORER_BASE}/tx/${hash}`;
}

export default function LiveLedger({
  units,
  emptyHint
}: {
  units: LiveUnit[];
  emptyHint?: string;
}) {
  const ordered = useMemo(() => {
    // Preserve arrival order (orchestrator already pushes in execution order).
    return units;
  }, [units]);

  const completed = useMemo(() => ordered.filter((u) => u.status === "validated").length, [ordered]);
  const paying = useMemo(() => ordered.filter((u) => u.status === "paying" || u.status === "requesting").length, [ordered]);

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden", border: "1px solid rgba(102,241,208,0.18)" }}>
      <div
        style={{
          padding: "0.65rem 0.9rem",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: "linear-gradient(90deg, rgba(102,241,208,0.08) 0%, transparent 80%)"
        }}
      >
        <div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.56rem", letterSpacing: "0.25em", color: "var(--text-dim)" }}>
            CHRONO LEDGER
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "0.9rem", color: "var(--acid)", marginTop: 2 }}>
            {completed} settled · {paying} in-flight
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: paying > 0 ? "#FFD21A" : "var(--acid)",
              boxShadow: `0 0 10px ${paying > 0 ? "#FFD21A" : "#39FF14"}`,
              animation: paying > 0 ? "muse-ledger-ping 1.1s ease-in-out infinite" : undefined
            }}
          />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-dim)" }}>
            {paying > 0 ? "SIGNING" : "IDLE"}
          </span>
        </div>
      </div>

      <div style={{ maxHeight: 560, overflowY: "auto" }}>
        {ordered.length === 0 && (
          <div style={{ padding: "1.5rem", fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--text-dim)" }}>
            {emptyHint || "Awaiting micro-plan from Hermes…"}
          </div>
        )}

        {ordered.map((u) => {
          const color = SERVICE_COLORS[u.service] || "#fff";
          const isActive = u.status === "paying" || u.status === "requesting";
          const isValidated = u.status === "validated";
          const isReused = u.status === "reused";
          const isFailed = u.status === "failed";
          const arcUrl = resolveArcUrl(u);
          return (
            <div
              // Stable key — service+unit uniquely identifies a ledger row
              // even if the upsert moves it around the list. Using an index
              // would re-mount the row on reorder and kill the bloom anim.
              key={`${u.service}-${u.unit}`}
              style={{
                display: "grid",
                gridTemplateColumns: "28px 28px 90px 1fr 130px 130px 34px",
                gap: "0.5rem",
                alignItems: "center",
                padding: "0.6rem 1rem",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
                background: isActive
                  ? `linear-gradient(90deg, ${color}20 0%, transparent 70%)`
                  : isValidated
                  ? `linear-gradient(90deg, rgba(57,255,20,0.08) 0%, transparent 70%)`
                  : isFailed
                  ? "rgba(255,77,106,0.08)"
                  : "transparent",
                opacity: u.status === "pending" ? 0.35 : 1,
                transition: "background 320ms ease, opacity 280ms ease",
                fontFamily: "var(--font-mono)",
                fontSize: "0.74rem",
                position: "relative",
                overflow: "hidden",
                animation: isValidated ? "muse-ledger-bloom 600ms cubic-bezier(0.22, 1, 0.36, 1)" : undefined
              }}
            >
              {/* Scanner line that moves across an active row */}
              {isActive && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    background: `linear-gradient(90deg, transparent 0%, ${color}33 50%, transparent 100%)`,
                    animation: "muse-ledger-scan 1.6s linear infinite",
                    pointerEvents: "none"
                  }}
                />
              )}

              <span
                style={{
                  color: isValidated ? "var(--acid)" : isActive ? "#FFD21A" : isReused ? "#5FA8FF" : isFailed ? "#FF4D6A" : "#444",
                  fontSize: "0.95rem",
                  textShadow: isActive ? `0 0 10px ${color}` : isValidated ? "0 0 10px #39FF14" : "none",
                  animation: isActive ? "muse-ledger-ping 1.2s ease-in-out infinite" : undefined,
                  position: "relative",
                  zIndex: 1
                }}
              >
                {STATUS_GLYPHS[u.status]}
              </span>

              <span style={{ position: "relative", zIndex: 1 }}>
                <AgentAvatar service={u.service} letter={u.service[0]} size={22} title={`${u.service} agent`} />
              </span>

              <span
                style={{
                  color,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  fontSize: "0.6rem",
                  letterSpacing: "0.1em",
                  position: "relative",
                  zIndex: 1
                }}
                title={SERVICE_LABELS[u.service]}
              >
                {u.service}
              </span>

              <span
                style={{ color: "var(--text)", position: "relative", zIndex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={u.label}
              >
                {u.label}
              </span>

              <span style={{ color: isValidated ? "var(--acid)" : isReused ? "#5FA8FF" : "var(--text-dim)", textAlign: "right", position: "relative", zIndex: 1, fontVariantNumeric: "tabular-nums" }}>
                {(() => {
                  if (isValidated) {
                    const raw = Number(u.amountUsdc ?? u.price);
                    const safe = Number.isFinite(raw) ? raw : 0;
                    return `$${safe.toFixed(4)}`;
                  }
                  if (isReused) {
                    // Show the price that WOULD have been paid had Hermes not
                    // reused this block from DNA memory. Makes the savings
                    // story visible on every row instead of hiding behind the
                    // word "reused".
                    const raw = Number(u.price);
                    const safe = Number.isFinite(raw) ? raw : 0;
                    return (
                      <span title="Reused from Hermes DNA memory — no payment this run">
                        <span style={{ textDecoration: "line-through", opacity: 0.5, marginRight: 4 }}>${safe.toFixed(4)}</span>
                        <span style={{ color: "#5FA8FF", fontSize: "0.6rem", letterSpacing: "0.08em" }}>SAVED</span>
                      </span>
                    );
                  }
                  return isFailed ? "failed" : u.status === "paying" ? "signing…" : "—";
                })()}
              </span>

              {/* Hash is now the primary link — the whole short hash is
                  clickable, not just a tiny arrow, because that's the
                  mental model: click the hash to see it on the explorer. */}
              <span style={{ position: "relative", zIndex: 1, overflow: "hidden", textOverflow: "ellipsis" }} title={u.txHash || ""}>
                {u.txHash && arcUrl ? (
                  <a
                    href={arcUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={`Click to view on Arc Testnet explorer · ${u.txHash}`}
                    style={{
                      color: color,
                      textDecoration: "none",
                      fontFamily: "var(--font-mono)",
                      borderBottom: `1px dashed ${color}66`,
                      paddingBottom: 1,
                      transition: "color 140ms ease, border-color 140ms ease"
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "#fff"; e.currentTarget.style.borderBottomColor = "#fff"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = color; e.currentTarget.style.borderBottomColor = `${color}66`; }}
                  >
                    {short(u.txHash)}
                  </a>
                ) : u.txHash ? (
                  // We have a tx reference but it isn't a valid Arc 0x hash
                  // (most likely a Circle Gateway UUID from the async batch
                  // path that hasn't been overridden by the direct settle
                  // yet). Render dim + non-clickable with a tooltip so the
                  // user understands why ArcScan isn't hyperlinked.
                  <span
                    style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}
                    title="Circle Gateway receipt · on-chain Arc hash pending"
                  >
                    {short(u.txHash)}
                  </span>
                ) : null}
              </span>

              <span style={{ position: "relative", zIndex: 1, textAlign: "right" }}>
                {arcUrl ? (
                  <a
                    href={arcUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open on Arc explorer"
                    title="Open on Arc explorer"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 26,
                      height: 22,
                      border: `1px solid ${color}88`,
                      color,
                      textDecoration: "none",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.8rem",
                      fontWeight: 700,
                      transition: "background 160ms ease, box-shadow 160ms ease, color 140ms ease",
                      background: `${color}12`
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = color;
                      e.currentTarget.style.color = "#0a0a0a";
                      e.currentTarget.style.boxShadow = `0 0 14px ${color}88`;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = `${color}12`;
                      e.currentTarget.style.color = color;
                      e.currentTarget.style.boxShadow = "none";
                    }}
                  >
                    ↗
                  </a>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>

      <style jsx>{`
        @keyframes muse-ledger-scan {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes muse-ledger-bloom {
          0%   { background-color: rgba(57, 255, 20, 0.35); }
          100% { background-color: transparent; }
        }
        @keyframes muse-ledger-ping {
          0%, 100% { opacity: 0.7; transform: scale(1); }
          50%      { opacity: 1;   transform: scale(1.15); }
        }
      `}</style>
    </div>
  );
}
