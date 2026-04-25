"use client";

/**
 * Muse DNA brand mark + helix primitives.
 *
 * Sourced from the design handoff at .design-handoff/muse2504/project/primitives.jsx.
 * The hero "DNA helix" mark replaced the older Ladder-M wordmark — every
 * topbar logo across the app now renders the helix variant. The retired
 * ladder/glyph variants are kept so legacy call sites keep type-checking;
 * they map to the helix renderer so the visual stays consistent.
 */

import { useEffect, useId, useRef, useState } from "react";

type Variant = "ladder" | "glyph" | "helix";

export function MuseMark({
  variant = "helix",
  fg = "#C6F51F",
  bg = "#0A0A0A",
  size = 32,
  spin = false,
  title = "Muse DNA"
}: {
  variant?: Variant;
  density?: number;
  fg?: string;
  bg?: string;
  accent?: string;
  size?: number;
  spin?: boolean;
  title?: string;
}) {
  // bg consumed as a kept prop for legacy call-sites; the helix mark draws
  // strands directly without a backing rect, so it isn't used here.
  void bg;
  void variant;
  return <HelixMark size={size} color={fg} spin={spin} title={title} />;
}

function HelixMark({ size, color, spin, title }: { size: number; color: string; spin: boolean; title: string }) {
  const rungs = 7;
  // String-coerce every numeric attribute via toFixed(3): Math.sin can differ
  // by 1 ULP between Node's V8 (SSR) and Chrome's V8 (client), which causes
  // a hydration mismatch warning even though the visual is identical.
  const fmt = (n: number) => n.toFixed(3);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={title}
      style={{
        display: "block",
        // Inline animation needs an explicit transform-origin: SVG's default
        // is 0 0 (top-left), which makes the spin orbit the corner instead
        // of rotating in place. The .helix-spin CSS class handles this for
        // CSS-driven cases, but inline styles bypass it.
        transformOrigin: "center",
        animation: spin ? "muse-spin-slow 14s linear infinite" : "none"
      }}
    >
      {/* horizontal rungs (DNA ladder) */}
      {Array.from({ length: rungs }).map((_, i) => {
        const t = i / (rungs - 1);
        const y = 2 + t * 20;
        const x1 = 12 + Math.sin(t * Math.PI * 2) * 7;
        const x2 = 12 - Math.sin(t * Math.PI * 2) * 7;
        return (
          <line
            key={`rung-${i}`}
            x1={fmt(x1)}
            y1={fmt(y)}
            x2={fmt(x2)}
            y2={fmt(y)}
            stroke={color}
            strokeWidth={1}
            opacity={0.55}
          />
        );
      })}
      {/* strand A */}
      <path
        d={Array.from({ length: 32 }, (_, i) => {
          const t = i / 31;
          const y = 2 + t * 20;
          const x = 12 + Math.sin(t * Math.PI * 2) * 7;
          return `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
        }).join(" ")}
        stroke={color}
        strokeWidth={2}
        fill="none"
      />
      {/* strand B */}
      <path
        d={Array.from({ length: 32 }, (_, i) => {
          const t = i / 31;
          const y = 2 + t * 20;
          const x = 12 - Math.sin(t * Math.PI * 2) * 7;
          return `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
        }).join(" ")}
        stroke={color}
        strokeWidth={2}
        fill="none"
        opacity={0.6}
      />
      {/* strand nucleotide dots */}
      {Array.from({ length: rungs }).map((_, i) => {
        const t = i / (rungs - 1);
        const y = 2 + t * 20;
        const x1 = 12 + Math.sin(t * Math.PI * 2) * 7;
        const x2 = 12 - Math.sin(t * Math.PI * 2) * 7;
        return (
          <g key={`dots-${i}`}>
            <circle cx={fmt(x1)} cy={fmt(y)} r={1.3} fill={color} />
            <circle cx={fmt(x2)} cy={fmt(y)} r={1.3} fill={color} opacity={0.7} />
          </g>
        );
      })}
    </svg>
  );
}

/**
 * DNA rail backdrop — vertical barcode pattern from `app.jsx · BgTexture`.
 * Sits behind the hero section as subtle ambient texture.
 */
export function DnaRailBackdrop({
  density = 0.55,
  opacity = 0.06,
  color = "#F2F1EC"
}: {
  density?: number;
  opacity?: number;
  color?: string;
}) {
  const safeDensity = Number.isFinite(density) && density >= 0 ? Math.min(density, 5) : 0.55;
  const cols = Math.round(12 + safeDensity * 24);
  return (
    <svg
      viewBox="0 0 1200 800"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        opacity,
        zIndex: 0
      }}
    >
      {Array.from({ length: cols }).map((_, i) => {
        const x = (i + 0.5) * (1200 / cols);
        return <rect key={i} x={x - 1} y={0} width={2} height={800} fill={color} />;
      })}
      {Array.from({ length: 30 }).map((_, i) => {
        const y = (i + 0.5) * (800 / 30);
        return <rect key={`h${i}`} x={0} y={y} width={1200} height={1} fill={color} opacity={0.45} />;
      })}
    </svg>
  );
}

/**
 * Animated double-helix strand — kept as a thin wrapper around DnaHelix
 * for legacy callers that imported `HelixAnimation`.
 */
export function HelixAnimation({
  color = "#C6F51F",
  opacity = 0.25
}: { color?: string; opacity?: number }) {
  return (
    <div style={{ opacity }}>
      <DnaHelix width={140} height={760} color={color} prominent={false} rotate3d />
    </div>
  );
}

/**
 * DnaHelix — phase-animated SVG hairpin with optional embedded labels and
 * a travelling pulse wave (top → bottom). Drives the side pillars on the
 * landing screen. The "3D" feel is faked by animating the sin-wave phase
 * + per-node depth (cos-derived radius/opacity), which is dramatically
 * cheaper than CSS perspective and survives behind blurred overlays.
 */
export function DnaHelix({
  width = 70,
  height = 760,
  color = "#C6F51F",
  strands = 16,
  prominent = false,
  rotate3d = false,
  spin = false,
  words
}: {
  width?: number;
  height?: number;
  color?: string;
  strands?: number;
  prominent?: boolean;
  rotate3d?: boolean;
  spin?: boolean;
  words?: string[];
}) {
  const labels = words ?? [
    "x402",
    "ARC",
    "CIRCLE",
    "USDC",
    "GATEWAY",
    "DNA",
    "MUSE",
    "CCTP",
    "SUB-CENT",
    "GEMINI"
  ];
  // Use (strands*2 - 1) so t reaches 1 inclusive — otherwise the last
  // rung sits at ~97% of the strand height and a naked tail dangles
  // below before the mask fade kicks in.
  const totalPts = strands * 2;
  const pts = Array.from({ length: totalPts }, (_, i) => i / Math.max(1, totalPts - 1));
  const amp = width * 0.42;
  const cx = width / 2;
  const id = useId().replace(/:/g, "_");
  const filterId = `muse-helix-glow-${id}`;
  // toFixed-coerce every numeric SVG attribute so SSR (Node V8) and
  // hydration (Chrome V8) emit identical strings even when Math.sin/cos
  // diverge by 1 ULP.
  const fmt = (n: number) => n.toFixed(3);

  const [phase, setPhase] = useState(0);
  const [pulse, setPulse] = useState(-0.2);
  // Defer all rendering until after first client paint so we never
  // serve floating-point SVG attributes from Node's V8 (SSR) that
  // could disagree with Chrome's V8 (hydration) by 1 ULP. Server emits
  // a blank placeholder; client hydrates it as a blank placeholder;
  // then this effect flips `mounted` and the rich SVG appears in a
  // post-hydration commit, free of mismatch warnings.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (!rotate3d) return;
    // Honor prefers-reduced-motion: don't drive the rAF loop for users
    // who opted out of motion. CSS-driven anims have a reduce-guard in
    // acid.css; this is the JS-driven counterpart.
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    // Throttle to ~12 fps. The strand offset is sub-pixel-precision SVG
    // — going faster than ~12 updates/sec just burns React reconciliation
    // on visually-identical frames. Two pillars × 60fps × ~64 SVG nodes
    // each was saturating the main thread on a 1280×800 viewport and
    // making the page unresponsive (eval/screenshot timed out).
    const FRAME_INTERVAL_MS = 80;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = performance.now();
    const startTimer = () => {
      if (timer) return;
      timer = setInterval(() => {
        const elapsed = (performance.now() - start) / 1000;
        setPhase((elapsed / 8) * Math.PI * 2);
        setPulse(((elapsed / 4.5) % 1.4) - 0.2);
      }, FRAME_INTERVAL_MS);
    };
    const stopTimer = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    if (typeof document !== "undefined" && !document.hidden) {
      startTimer();
    }
    // Pause when the tab is hidden — browsers throttle setInterval to 1Hz
    // in background tabs but don't pause it; React still reconciles every
    // tick. Drains battery for no visual benefit.
    const handleVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.hidden) stopTimer();
      else startTimer();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }
    return () => {
      stopTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, [rotate3d]);

  if (!mounted) {
    // Static placeholder with the same outer SVG box — keeps layout
    // stable across the hydration boundary. No floating-point children.
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
        style={{ display: "block", overflow: "visible" }}
      />
    );
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={spin ? "helix-spin" : undefined}
      aria-hidden="true"
      style={{ display: "block", overflow: "visible" }}
    >
      <defs>
        <filter id={filterId}>
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {pts.map((t, i) => {
        const y = t * height;
        const xOffset = Math.sin(t * Math.PI * 4 + phase) * amp;
        const x1 = cx + xOffset;
        const x2 = cx - xOffset;
        const depth = Math.cos(t * Math.PI * 4 + phase);
        const r1 = (prominent ? 2.4 : 1.6) * (1 + depth * 0.45);
        const r2 = (prominent ? 2.4 : 1.6) * (1 - depth * 0.45);
        const op1 = 0.55 + depth * 0.35;
        const op2 = 0.55 - depth * 0.35;
        const label = labels[i % labels.length];
        const showLabel = prominent && width > 40;

        const pulseDist = Math.abs(t - pulse);
        const pulseStrength = Math.max(0, 1 - pulseDist * 6);
        const labelScale = 1 + pulseStrength * 0.7;
        const labelOpacity = 0.35 + pulseStrength * 0.65;
        const labelGlow = 0.5 + pulseStrength * 6;

        return (
          <g key={i}>
            <line
              x1={fmt(x1)}
              y1={fmt(y)}
              x2={fmt(x2)}
              y2={fmt(y)}
              stroke={color}
              strokeWidth={prominent ? 1.3 : 0.9}
              opacity={prominent ? 0.45 : 0.3}
            />
            <circle
              cx={fmt(x1)}
              cy={fmt(y)}
              r={fmt(r1 * (1 + pulseStrength * 0.5))}
              fill={color}
              opacity={fmt(op1 + pulseStrength * 0.4)}
              filter={`url(#${filterId})`}
            />
            <circle
              cx={fmt(x2)}
              cy={fmt(y)}
              r={fmt(r2 * (1 + pulseStrength * 0.5))}
              fill={color}
              opacity={fmt(op2 + pulseStrength * 0.4)}
              filter={`url(#${filterId})`}
            />
            {showLabel && label && (
              <text
                x={fmt(cx)}
                y={fmt(y + 1.5)}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={fmt(5.5 * labelScale)}
                fontFamily="JetBrains Mono, IBM Plex Mono, monospace"
                fontWeight="700"
                fill={color}
                opacity={fmt(labelOpacity)}
                letterSpacing="1.4"
                style={{ filter: `drop-shadow(0 0 ${labelGlow.toFixed(2)}px ${color})` }}
              >
                {label}
              </text>
            )}
          </g>
        );
      })}

      {[0, 1].map((s) => (
        <path
          key={s}
          d={Array.from({ length: 60 }, (_, i) => {
            const t = i / 59;
            const y = t * height;
            const x =
              cx + (s ? -1 : 1) * Math.sin(t * Math.PI * 4 + phase) * amp;
            return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
          }).join(" ")}
          stroke={color}
          strokeWidth={prominent ? 2 : 1.2}
          fill="none"
          opacity={prominent ? 0.85 : 0.5}
          filter={`url(#${filterId})`}
        />
      ))}
    </svg>
  );
}

/**
 * DnaHeadline — green Archivo Black text with a continuous DNA flow living
 * inside the letterforms (SVG mask). Two crossed waves + a moving white
 * "ribosome nib" sweep L→R every 5s. Used for the ".DNA" word in the
 * landing hero.
 */
export function DnaHeadline({
  text = ".DNA",
  fontSize = 92,
  color = "#C6F51F"
}: {
  text?: string;
  fontSize?: number;
  color?: string;
}) {
  const [t, setT] = useState(0);
  // Defer dynamic SVG rendering past hydration — the SVG mask + path
  // attributes use floating-point math that can drift by 1 ULP between
  // Node and Chrome. Render a static text placeholder until mounted.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    // Throttled to ~16 fps. The mask-overlay flow is barely visible past
    // ~10 fps, but a 60fps rAF loop here was costing more than the rest
    // of the page combined.
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = performance.now();
    const startTimer = () => {
      if (timer) return;
      timer = setInterval(() => {
        setT(((performance.now() - start) / 1000) % 5);
      }, 60);
    };
    const stopTimer = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    if (typeof document !== "undefined" && !document.hidden) startTimer();
    const handleVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.hidden) stopTimer();
      else startTimer();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }
    return () => {
      stopTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, []);

  const w = Math.max(40, Math.round(fontSize * text.length * 0.62));
  const h = Math.max(40, Math.round(fontSize * 1.05));
  const id = useId().replace(/:/g, "_");
  const maskId = `muse-headline-mask-${id}`;

  // Pre-mount: render the green text without the animated overlay so the
  // headline reserves the same box on the server and on first client paint.
  if (!mounted) {
    return (
      <span
        aria-label={text}
        style={{
          display: "inline-block",
          fontFamily: "Archivo Black, system-ui, sans-serif",
          fontSize,
          color,
          letterSpacing: "-0.02em",
          lineHeight: 1
        }}
      >
        {text}
      </span>
    );
  }

  const local = t / 5;
  const flowX = local * 1.4 - 0.2;
  const glowStrength = Math.sin(local * Math.PI) * 0.45;
  const peakColor = `rgba(198,245,31,${glowStrength.toFixed(3)})`;

  const wavePts = (offset: number) =>
    Array.from({ length: 60 }, (_, i) => {
      const tt = i / 59;
      const x = tt * w;
      const y =
        h * 0.5 +
        Math.sin(tt * Math.PI * 6 + offset + t * 1.2) * h * 0.18;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-label={text}
      style={{
        display: "inline-block",
        overflow: "visible",
        verticalAlign: "baseline",
        filter:
          glowStrength > 0
            ? `drop-shadow(0 0 ${(glowStrength * 18).toFixed(1)}px ${peakColor})`
            : "none"
      }}
    >
      <defs>
        <mask id={maskId}>
          <rect width={w} height={h} fill="black" />
          <text
            x="0"
            y={h * 0.82}
            fontFamily="Archivo Black, system-ui, sans-serif"
            fontSize={fontSize}
            fill="white"
            letterSpacing="-0.02em"
          >
            {text}
          </text>
        </mask>
      </defs>
      <text
        x="0"
        y={h * 0.82}
        fontFamily="Archivo Black, system-ui, sans-serif"
        fontSize={fontSize}
        fill={color}
        letterSpacing="-0.02em"
      >
        {text}
      </text>
      <g mask={`url(#${maskId})`}>
        <path
          d={wavePts(0)}
          stroke="rgba(255,255,255,0.55)"
          strokeWidth={2}
          fill="none"
          opacity={0.5}
        />
        <path
          d={wavePts(Math.PI)}
          stroke="rgba(222,255,106,0.55)"
          strokeWidth={2}
          fill="none"
          opacity={0.5}
        />
        <ellipse
          cx={flowX * w}
          cy={h * 0.5}
          rx={w * 0.18}
          ry={h * 0.7}
          fill="white"
          opacity={0.7}
          style={{ filter: "blur(14px)" }}
        />
        <ellipse
          cx={flowX * w}
          cy={h * 0.5}
          rx={w * 0.05}
          ry={h * 0.55}
          fill="rgba(222,255,106,0.95)"
          style={{ filter: "blur(2px)" }}
        />
      </g>
    </svg>
  );
}
