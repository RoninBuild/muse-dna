"use client";

/**
 * BottomBar — sticky strip at the page footer with a marquee tx ticker
 * (left) and a fixed ARC TESTNET / HERMES AGENT / NANOPAYMENTS tag row
 * (right). Ported from .design-handoff/muse2504/project/primitives.jsx.
 *
 * The marquee uses the `.muse-marquee` keyframe defined in acid.css and
 * doubles the items so the slide loops seamlessly.
 */

const DEFAULT_TX_ITEMS = [
  "TX 0xb52429…2f36d3 SETTLED $0.0050",
  "TX 0x5eafa1…fc9e3 SETTLED $0.0050",
  "TX 0x91ac72…ad120 SETTLED $0.0080",
  "TX 0xff012c…0091a IN-FLIGHT $0.0050",
  "TX 0x2027b3…6340 SETTLED $0.0040",
  "TX 0x4ee881…b8a72 SETTLED $0.0050",
  "BLOCK #38,939,274 MINED",
  "DNA BRAND AUTOCRM MINTED 24/24",
  "TX 0x70a1d2…3492c SETTLED $0.0050"
];

const DEFAULT_TAGS = ["ARC TESTNET", "HERMES AGENT", "NANOPAYMENTS"];

export function BottomBar({
  items = DEFAULT_TX_ITEMS,
  tags = DEFAULT_TAGS,
  fixed = true
}: {
  items?: string[];
  tags?: string[];
  fixed?: boolean;
}) {
  const seq = [...items, ...items];

  return (
    <div
      style={{
        ...(fixed
          ? { position: "fixed", left: 0, right: 0, bottom: 0 }
          : { position: "relative" }),
        height: 36,
        display: "flex",
        alignItems: "stretch",
        background: "var(--bg)",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        // Sit above DnaChainStrip (z:50) so the marquee owns the bottom
        // 36px exclusively. DnaChainStrip's CSS reserves 60px below 0;
        // we also shift it up by 36px via a body class so the two bars
        // stack instead of overlapping.
        zIndex: 60,
        pointerEvents: "auto"
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          overflow: "hidden",
          borderRight: "1px solid rgba(255,255,255,0.08)"
        }}
      >
        <div className="muse-marquee" style={{ animationDuration: "80s" }}>
          {seq.map((it, i) => (
            <span
              key={i}
              style={{
                padding: "0 24px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--text-dim)",
                display: "inline-flex",
                alignItems: "center",
                gap: 10,
                whiteSpace: "nowrap"
              }}
            >
              {it}
              <span style={{ color: "var(--acid)" }}>◆</span>
            </span>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", flexShrink: 0 }}>
        {tags.map((t) => (
          <div
            key={t}
            style={{
              padding: "0 14px",
              display: "flex",
              alignItems: "center",
              borderLeft: "1px solid rgba(255,255,255,0.08)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "var(--acid)"
            }}
          >
            {t}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * CornerTick — small acid-bordered L-corner ornament. Used at the
 * four corners of the NEW TASK hero card.
 */
export function CornerTick({ where = "tl", color = "var(--acid)" }: { where?: "tl" | "tr" | "bl" | "br"; color?: string }) {
  const styles: Record<string, React.CSSProperties> = {
    tl: { top: 6, left: 6, borderTop: `2px solid ${color}`, borderLeft: `2px solid ${color}` },
    tr: { top: 6, right: 6, borderTop: `2px solid ${color}`, borderRight: `2px solid ${color}` },
    bl: { bottom: 6, left: 6, borderBottom: `2px solid ${color}`, borderLeft: `2px solid ${color}` },
    br: { bottom: 6, right: 6, borderBottom: `2px solid ${color}`, borderRight: `2px solid ${color}` }
  };
  return <div aria-hidden="true" style={{ position: "absolute", width: 10, height: 10, ...styles[where] }} />;
}

export default BottomBar;
