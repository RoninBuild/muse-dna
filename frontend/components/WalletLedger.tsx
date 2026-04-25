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

function shortAddr(addr: string | null | undefined) {
  if (!addr || typeof addr !== "string") return "";
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function shortHash(hash: string | null | undefined) {
  if (!hash) return "";
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

function resolveArcTxUrl(u: LiveUnit): string | null {
  if (u.arcUrl) return u.arcUrl;
  const hash = u.txHash;
  if (!hash || typeof hash !== "string") return null;
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) return null;
  return `${ARC_EXPLORER_BASE}/tx/${hash}`;
}

function explorerAddress(addr: string) {
  return `${ARC_EXPLORER_BASE}/address/${addr}`;
}

export type AgentWallet = { service: string; index: number; address: string };

/**
 * Per-wallet ledger view: one card per fresh EVM wallet the orchestrator
 * deployed for this task (4-15 cards). Each card shows the wallet badge,
 * an ArcScan link to the wallet, and every unit it earned, with each
 * unit's own ArcScan tx hash. Units the orchestrator hasn't dispatched
 * yet still show as `pending` placeholders so the cards don't grow as
 * results land — judges see the full plan up-front, not a half-empty
 * ledger that fills in over time.
 */
export default function WalletLedger({
  units,
  wallets,
  emptyHint
}: {
  units: LiveUnit[];
  wallets: AgentWallet[];
  emptyHint?: string;
}) {
  // Group units by walletAddress. Units missing an address (older snapshots
  // before the backend started emitting walletAddress) fall through to a
  // synthesised "service pool" bucket — better than dropping them.
  const groups = useMemo(() => {
    type Group = {
      key: string;
      service: string;
      index: number;
      address: string | null;
      label: string;
      units: LiveUnit[];
    };
    const map = new Map<string, Group>();

    // Seed empty buckets so every deployed wallet shows up even before its
    // first unit lands. Keeps the card grid stable from the second the
    // swarm is announced.
    for (const w of wallets) {
      const key = w.address.toLowerCase();
      map.set(key, {
        key,
        service: w.service,
        index: w.index,
        address: w.address,
        label: `${w.service.toUpperCase()} #${w.index + 1}`,
        units: []
      });
    }

    // Fold units in. Round-robin reconstruction kicks in only when a unit
    // arrived before the wallet broadcast and has no walletAddress yet.
    const rrCursors: Record<string, number> = {};
    const walletsByService: Record<string, AgentWallet[]> = {};
    for (const w of wallets) {
      walletsByService[w.service] = walletsByService[w.service] || [];
      walletsByService[w.service].push(w);
    }

    for (const u of units) {
      const direct = u.walletAddress ? u.walletAddress.toLowerCase() : null;
      let target = direct ? map.get(direct) : null;
      if (!target) {
        // Fallback: round-robin within the service pool. Same algorithm as
        // backend orchestrator.js so the assignment is identical even when
        // events arrive out-of-order.
        const pool = walletsByService[u.service] || [];
        if (pool.length > 0) {
          const cur = rrCursors[u.service] || 0;
          const w = pool[cur % pool.length];
          rrCursors[u.service] = cur + 1;
          target = map.get(w.address.toLowerCase()) || null;
        }
      }
      if (target) {
        target.units.push(u);
      } else {
        // Truly orphan unit (no wallet known at all). Park under a
        // synthetic service-level bucket so it stays visible.
        const fallbackKey = `service:${u.service}`;
        if (!map.has(fallbackKey)) {
          map.set(fallbackKey, {
            key: fallbackKey,
            service: u.service,
            index: -1,
            address: null,
            label: `${u.service.toUpperCase()} (pool)`,
            units: []
          });
        }
        map.get(fallbackKey)!.units.push(u);
      }
    }

    return Array.from(map.values()).sort((a, b) => {
      const order = ["strategy", "search", "copy", "image"];
      const sa = order.indexOf(a.service);
      const sb = order.indexOf(b.service);
      if (sa !== sb) return sa - sb;
      return a.index - b.index;
    });
  }, [units, wallets]);

  const totalSettled = useMemo(() => units.filter((u) => u.status === "validated").length, [units]);
  const totalInflight = useMemo(() => units.filter((u) => u.status === "paying" || u.status === "requesting").length, [units]);

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
            WALLETS · ACTIONS
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "0.9rem", color: "var(--acid)", marginTop: 2 }}>
            {totalSettled} settled · {totalInflight} in-flight · {groups.length} wallets
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: totalInflight > 0 ? "#FFD21A" : "var(--acid)",
              boxShadow: `0 0 10px ${totalInflight > 0 ? "#FFD21A" : "#39FF14"}`,
              animation: totalInflight > 0 ? "muse-wl-ping 1.1s ease-in-out infinite" : undefined
            }}
          />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-dim)" }}>
            {totalInflight > 0 ? "SIGNING" : "IDLE"}
          </span>
        </div>
      </div>

      <div style={{ maxHeight: 760, overflowY: "auto", padding: "0.6rem" }}>
        {groups.length === 0 && (
          <div style={{ padding: "1.5rem", fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--text-dim)" }}>
            {emptyHint || "Waiting for swarm deployment…"}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "0.6rem" }}>
          {groups.map((g) => {
            const color = SERVICE_COLORS[g.service] || "#fff";
            const settled = g.units.filter((u) => u.status === "validated").length;
            const failed = g.units.filter((u) => u.status === "failed").length;
            const active = g.units.some((u) => u.status === "paying" || u.status === "requesting");
            const earned = g.units
              .filter((u) => u.status === "validated")
              .reduce((sum, u) => sum + Number(u.amountUsdc ?? u.price ?? 0), 0);
            return (
              <div
                key={g.key}
                style={{
                  border: `1px solid ${color}33`,
                  background: active ? `${color}0c` : "rgba(0,0,0,0.25)",
                  display: "flex",
                  flexDirection: "column",
                  position: "relative",
                  overflow: "hidden",
                  transition: "background 240ms ease, border-color 240ms ease"
                }}
              >
                {/* Card header */}
                <div
                  style={{
                    padding: "0.55rem 0.7rem",
                    borderBottom: `1px solid ${color}22`,
                    display: "flex",
                    alignItems: "center",
                    gap: "0.55rem",
                    background: `linear-gradient(90deg, ${color}1a 0%, transparent 80%)`
                  }}
                >
                  <AgentAvatar service={g.service} letter={g.service[0]} size={26} title={SERVICE_LABELS[g.service]} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.58rem",
                        letterSpacing: "0.2em",
                        color,
                        fontWeight: 700,
                        textTransform: "uppercase"
                      }}
                    >
                      {g.label}
                    </div>
                    {g.address ? (
                      <a
                        href={explorerAddress(g.address)}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open ${g.address} on Arc explorer`}
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "0.7rem",
                          color: "var(--acid)",
                          textDecoration: "none",
                          borderBottom: `1px dashed ${color}55`
                        }}
                      >
                        {shortAddr(g.address)} ↗
                      </a>
                    ) : (
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text-dim)" }}>
                        pool · no fixed wallet
                      </span>
                    )}
                  </div>
                  <div style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.6rem", lineHeight: 1.2 }}>
                    <div style={{ color: "var(--acid)", fontWeight: 700 }}>{settled}/{g.units.length} done</div>
                    {failed > 0 && (
                      <div style={{ color: "#FF4D6A" }}>{failed} failed</div>
                    )}
                    <div style={{ color: "var(--text-dim)", marginTop: 1 }}>${earned.toFixed(4)}</div>
                  </div>
                </div>

                {/* Unit rows */}
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {g.units.length === 0 ? (
                    <div style={{ padding: "0.55rem 0.7rem", fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text-dim)" }}>
                      idle — awaiting dispatch
                    </div>
                  ) : (
                    g.units.map((u) => {
                      const isActive = u.status === "paying" || u.status === "requesting";
                      const isValidated = u.status === "validated";
                      const isReused = u.status === "reused";
                      const isFailed = u.status === "failed";
                      const arcUrl = resolveArcTxUrl(u);
                      return (
                        <div
                          key={`${u.service}-${u.unit}`}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "18px 1fr 56px 100px",
                            alignItems: "center",
                            gap: "0.4rem",
                            padding: "0.4rem 0.7rem",
                            borderBottom: "1px solid rgba(255,255,255,0.04)",
                            background: isActive
                              ? `linear-gradient(90deg, ${color}1c 0%, transparent 70%)`
                              : isValidated
                              ? "linear-gradient(90deg, rgba(57,255,20,0.05) 0%, transparent 70%)"
                              : isFailed
                              ? "rgba(255,77,106,0.06)"
                              : "transparent",
                            opacity: u.status === "pending" ? 0.5 : 1,
                            fontFamily: "var(--font-mono)",
                            fontSize: "0.7rem",
                            transition: "background 280ms ease",
                            animation: isValidated ? "muse-wl-bloom 600ms cubic-bezier(0.22,1,0.36,1)" : undefined
                          }}
                        >
                          <span
                            style={{
                              color: isValidated ? "var(--acid)" : isActive ? "#FFD21A" : isReused ? "#5FA8FF" : isFailed ? "#FF4D6A" : "#444",
                              fontSize: "0.85rem",
                              textShadow: isActive ? `0 0 10px ${color}` : isValidated ? "0 0 8px #39FF14" : "none",
                              animation: isActive ? "muse-wl-ping 1.2s ease-in-out infinite" : undefined
                            }}
                          >
                            {STATUS_GLYPHS[u.status]}
                          </span>
                          <span
                            style={{
                              color: "var(--text)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap"
                            }}
                            title={u.label}
                          >
                            {u.label}
                          </span>
                          <span
                            style={{
                              color: isValidated ? "var(--acid)" : isReused ? "#5FA8FF" : "var(--text-dim)",
                              textAlign: "right",
                              fontVariantNumeric: "tabular-nums"
                            }}
                          >
                            {(() => {
                              if (isValidated) {
                                const raw = Number(u.amountUsdc ?? u.price);
                                return `$${(Number.isFinite(raw) ? raw : 0).toFixed(4)}`;
                              }
                              if (isReused) {
                                const raw = Number(u.price);
                                return (
                                  <span title="Reused from Hermes DNA — no payment this run">
                                    <span style={{ textDecoration: "line-through", opacity: 0.5, marginRight: 3 }}>${(Number.isFinite(raw) ? raw : 0).toFixed(4)}</span>
                                    <span style={{ color: "#5FA8FF", fontSize: "0.55rem" }}>SAVED</span>
                                  </span>
                                );
                              }
                              return isFailed ? "failed" : isActive ? "signing…" : "—";
                            })()}
                          </span>
                          <span style={{ textAlign: "right", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {u.txHash && arcUrl ? (
                              <a
                                href={arcUrl}
                                target="_blank"
                                rel="noreferrer"
                                title={`Open tx on Arc · ${u.txHash}`}
                                style={{
                                  color,
                                  textDecoration: "none",
                                  fontFamily: "var(--font-mono)",
                                  borderBottom: `1px dashed ${color}55`
                                }}
                              >
                                {shortHash(u.txHash)} ↗
                              </a>
                            ) : u.txHash ? (
                              <span title="Circle Gateway receipt · on-chain Arc hash pending" style={{ color: "var(--text-dim)" }}>
                                {shortHash(u.txHash)}
                              </span>
                            ) : (
                              <span style={{ color: "var(--text-dim)" }}>—</span>
                            )}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <style jsx>{`
        @keyframes muse-wl-bloom {
          0%   { background-color: rgba(57, 255, 20, 0.32); }
          100% { background-color: transparent; }
        }
        @keyframes muse-wl-ping {
          0%, 100% { opacity: 0.7; transform: scale(1); }
          50%      { opacity: 1;   transform: scale(1.15); }
        }
      `}</style>
    </div>
  );
}
