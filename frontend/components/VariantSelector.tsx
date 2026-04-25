"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MuseMark } from "@/components/MuseMark";
import { CornerTick } from "@/components/BottomBar";
import type { VariantCard, VariantTier } from "@/lib/types";

type VariantSelectorProps = {
  variants: VariantCard[];
  recommendedTier: VariantTier;
  rationale: string;
  brandName: string;
  dnaExists: boolean;
  model: string | null;
  source: string;
  onPick: (tier: VariantTier) => void;
  onCancel: () => void;
  submitting?: boolean;
  pendingTier?: VariantTier | null;
};

const TIER_ACCENT: Record<VariantTier, { ring: string; label: string; subtitle: string }> = {
  lite: { ring: "#5FA8FF", label: "LITE", subtitle: "FAST DRAFT, MINIMAL DNA" },
  balanced: { ring: "#C6F51F", label: "BALANCED", subtitle: "FULL SWARM, FULL DNA MINT" },
  deep: { ring: "#FF6B9D", label: "DEEP", subtitle: "DEEPSWARM · MULTI-VARIANT" }
};

function formatSeconds(s: number): string {
  if (s < 60) return `~${Math.round(s)}s`;
  const mins = Math.floor(s / 60);
  const rem = Math.round(s - mins * 60);
  return rem > 0 ? `~${mins}m${rem}s` : `~${mins}m`;
}

function formatUsd(v: number): string {
  return `$${v.toFixed(3)}`;
}

export default function VariantSelector({
  variants,
  recommendedTier,
  rationale,
  brandName,
  dnaExists,
  model,
  source,
  onPick,
  onCancel,
  submitting = false,
  pendingTier = null
}: VariantSelectorProps) {
  void model;
  void source;
  const [hoveredTier, setHoveredTier] = useState<VariantTier | null>(recommendedTier);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Hold onCancel in a ref so the ESC keydown effect doesn't re-bind every
  // parent re-render (the parent passes a fresh inline arrow each time).
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  // ESC closes the modal — matches the [ESC] button affordance.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onCancelRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [submitting]);

  const sortedVariants = useMemo(() => {
    const order: VariantTier[] = ["lite", "balanced", "deep"];
    return [...variants].sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
  }, [variants]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Choose execution tier"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(8, 9, 12, 0.78)",
        backdropFilter: "blur(2px)",
        zIndex: 9000,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "2.5rem 1rem",
        overflowY: "auto",
        animation: "muse-modal-enter 320ms cubic-bezier(0.22, 1, 0.36, 1)"
      }}
    >
      <div
        ref={dialogRef}
        className="muse-variant-card"
        style={{
          maxWidth: 1080,
          width: "100%",
          margin: "0 auto",
          background: "var(--bg)",
          border: "2px solid var(--acid)",
          boxShadow: "6px 6px 0 var(--acid)",
          padding: 24,
          position: "relative",
          animation: "muse-modal-content 420ms cubic-bezier(0.22, 1, 0.36, 1)"
        }}
      >
        <CornerTick where="tl" />
        <CornerTick where="tr" />
        <CornerTick where="bl" />
        <CornerTick where="br" />

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <MuseMark size={36} variant="helix" fg="var(--acid)" bg="var(--bg)" spin />
            <div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", letterSpacing: "0.22em", color: "var(--text-dim)", textTransform: "uppercase" }}>
                HERMES PLANNER · STEP 02 / 03
              </div>
              <div style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "1.55rem", color: "var(--text)", textTransform: "uppercase", letterSpacing: "-0.02em", lineHeight: 1.05, marginTop: 2 }}>
                CHOOSE EXECUTION TIER {brandName ? <span style={{ color: "var(--acid)" }}>· {brandName.toUpperCase()}</span> : null}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            aria-label="Close (ESC)"
            style={{
              background: "transparent",
              color: "var(--text-dim)",
              border: "1px solid rgba(255,255,255,0.18)",
              padding: "0.4rem 0.85rem",
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              cursor: submitting ? "wait" : "pointer"
            }}
          >
            ESC
          </button>
        </div>

        {/* Hermes reasoning byline + DNA-memory chip — re-surfaced from the
            old design so judges see WHY a tier is recommended rather than
            picking blind. */}
        {(rationale || dnaExists) && (
          <div style={{ marginBottom: 18, display: "flex", flexWrap: "wrap", gap: "0.6rem", alignItems: "center" }}>
            {rationale && (
              <p style={{
                margin: 0,
                fontFamily: "var(--font-mono)",
                fontSize: "0.74rem",
                color: "var(--text-dim)",
                lineHeight: 1.55,
                maxWidth: "62ch",
                fontStyle: "italic"
              }}>
                {rationale}
              </p>
            )}
            {dnaExists && (
              <span style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "0.2rem 0.55rem",
                border: "1px solid var(--acid)",
                background: "rgba(198,245,31,0.06)",
                color: "var(--acid)",
                fontFamily: "var(--font-mono)",
                fontSize: "0.58rem",
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                fontWeight: 700
              }}>
                HERMES MEMORY FOUND · DIVIDEND RUN
              </span>
            )}
          </div>
        )}

        {/* Tier cards */}
        <div className="muse-variant-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, alignItems: "stretch" }}>
          {sortedVariants.map((variant) => {
            const accent = TIER_ACCENT[variant.tier];
            const isRecommended = variant.tier === recommendedTier;
            const isHovered = hoveredTier === variant.tier;
            const isPending = pendingTier === variant.tier && submitting;
            const cost = formatUsd(variant.estimatedCostUsdc);
            const time = formatSeconds(variant.timeEstimateSeconds);
            const dnaStr = `${variant.dnaBlocks ?? 0}/${variant.dnaBlocksTotal ?? 24}`;
            const saved = variant.savingsUsdc > 0 ? formatUsd(variant.savingsUsdc) : null;

            return (
              <div
                key={variant.tier}
                onMouseEnter={() => setHoveredTier(variant.tier)}
                onMouseLeave={() => setHoveredTier(recommendedTier)}
                style={{
                  position: "relative",
                  border: `2px solid ${accent.ring}`,
                  background: isRecommended ? "rgba(198,245,31,0.04)" : "rgba(12, 14, 19, 0.85)",
                  boxShadow: isRecommended ? "6px 6px 0 0 var(--acid)" : "none",
                  padding: 18,
                  display: "flex",
                  flexDirection: "column",
                  cursor: submitting ? "wait" : "pointer",
                  transition: "transform 180ms ease",
                  transform: isHovered && !isRecommended ? "translateY(-1px)" : "translateY(0)"
                }}
              >
                {isRecommended && (
                  <div
                    style={{
                      position: "absolute",
                      top: -12,
                      left: 14,
                      padding: "0.18rem 0.6rem",
                      background: "var(--acid)",
                      color: "var(--bg)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.6rem",
                      letterSpacing: "0.2em",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      border: "1px solid var(--acid)"
                    }}
                  >
                    RECOMMENDED
                  </div>
                )}

                <div
                  style={{
                    fontFamily: "var(--font-display-brand, var(--font-display))",
                    fontSize: "2rem",
                    color: accent.ring,
                    letterSpacing: "-0.02em",
                    lineHeight: 1
                  }}
                >
                  {accent.label}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.6rem",
                    color: "var(--text-dim)",
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    marginTop: 6,
                    marginBottom: 16
                  }}
                >
                  {accent.subtitle}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                  <div>
                    <div className="label" style={{ fontSize: "0.55rem", margin: 0, letterSpacing: "0.22em" }}>TIME</div>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: "1.05rem", marginTop: 2 }}>{time}</div>
                  </div>
                  <div>
                    <div className="label" style={{ fontSize: "0.55rem", margin: 0, letterSpacing: "0.22em" }}>UNITS</div>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: "1.05rem", marginTop: 2 }}>{variant.units}</div>
                  </div>
                  <div>
                    <div className="label" style={{ fontSize: "0.55rem", margin: 0, letterSpacing: "0.22em" }}>USDC COST</div>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: "1.05rem", marginTop: 2, color: "var(--acid)" }}>{cost}</div>
                  </div>
                  <div>
                    <div className="label" style={{ fontSize: "0.55rem", margin: 0, letterSpacing: "0.22em" }}>AGENTS</div>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: "1.05rem", marginTop: 2 }}>{variant.agents ?? "—"}</div>
                  </div>
                </div>

                {saved && (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      padding: "0.25rem 0.55rem",
                      border: "1px solid var(--acid)",
                      color: "var(--acid)",
                      background: "rgba(198,245,31,0.06)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.6rem",
                      letterSpacing: "0.18em",
                      textTransform: "uppercase",
                      marginBottom: 12,
                      alignSelf: "flex-start"
                    }}
                  >
                    DNA REUSE · SAVED {saved}
                  </div>
                )}

                <div className="label" style={{ fontSize: "0.55rem", margin: 0, letterSpacing: "0.22em", marginBottom: 4 }}>DNA BLOCKS</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text)", marginBottom: 14 }}>{dnaStr}</div>

                <div style={{ flex: 1 }} />

                <button
                  type="button"
                  onClick={() => onPick(variant.tier)}
                  disabled={submitting}
                  style={{
                    width: "100%",
                    padding: "0.7rem 1rem",
                    fontFamily: "var(--font-display)",
                    fontWeight: 800,
                    fontSize: "0.78rem",
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    cursor: submitting ? "wait" : "pointer",
                    background: isRecommended ? "var(--acid)" : "transparent",
                    color: isRecommended ? "var(--bg)" : accent.ring,
                    border: `2px solid ${accent.ring}`,
                    boxShadow: isRecommended ? "3px 3px 0 var(--bg)" : "none",
                    transition: "background 160ms ease, transform 100ms ease"
                  }}
                >
                  {isPending ? "▶ EXECUTING…" : `▶ RUN ${accent.label}`}
                </button>
              </div>
            );
          })}
        </div>

        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            color: "var(--text-dim)",
            marginTop: 18,
            textAlign: "center",
            letterSpacing: "0.18em",
            textTransform: "uppercase"
          }}
        >
          EVERY TIER SETTLES PER-ACTION ON ARC TESTNET · CANCEL ANY TIME · UNUSED USDC RETURNS TO ORCHESTRATOR
        </div>
      </div>

      <style jsx>{`
        @media (max-width: 980px) {
          :global(.muse-variant-grid) {
            grid-template-columns: 1fr !important;
          }
        }
        @keyframes muse-modal-enter {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes muse-modal-content {
          0% { opacity: 0; transform: translateY(20px) scale(0.97); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
