"use client";
import { useEffect, useRef } from "react";

/**
 * Respect the OS-level reduced-motion preference. When the user has asked
 * the system to reduce motion we do not kick off the continuous RAF loops;
 * instead we render a single static frame so the logo still reads.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Ambient background: a faint square grid, with subtle pulsing ripples that
 * follow the cursor like drops on water. No big particle swarm, no helix trail
 * — just a restrained "the site reacts to you" feel.
 */
export function DnaCursorTrail() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cvs = ref.current;
    if (!cvs) return;
    const rawCtx = cvs.getContext("2d");
    if (!rawCtx) return;
    const ctx: CanvasRenderingContext2D = rawCtx;

    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    let cssW = window.innerWidth;
    let cssH = window.innerHeight;
    const resize = () => {
      cssW = window.innerWidth;
      cssH = window.innerHeight;
      cvs.width = Math.round(cssW * dpr);
      cvs.height = Math.round(cssH * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    };
    resize();

    // Grid geometry — 48px cells is a good compromise: dense enough to read as
    // "graph paper" without turning into noise on 4K displays.
    const CELL = 48;

    // Recent mouse positions. Each one seeds a ripple wave that expands and
    // fades over ~1.2s, pulsing the grid cells it crosses.
    type Ripple = { x: number; y: number; t0: number };
    const ripples: Ripple[] = [];
    const MAX_RIPPLES = 8;
    let mx = cssW / 2, my = cssH / 2;
    let lastSeed = 0;
    const onMove = (e: MouseEvent) => {
      mx = e.clientX; my = e.clientY;
      const now = performance.now();
      // Throttle ripple seeding so a fast mouse sweep doesn't stack 30 waves.
      if (now - lastSeed > 90) {
        lastSeed = now;
        ripples.push({ x: mx, y: my, t0: now });
        if (ripples.length > MAX_RIPPLES) ripples.shift();
      }
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("resize", resize);

    const reduced = prefersReducedMotion();
    let raf = 0;

    function drawFrame(now: number) {
      ctx.clearRect(0, 0, cssW, cssH);

      // Static background grid — very faint, always visible.
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(198, 245, 31, 0.05)";
      ctx.beginPath();
      for (let x = (mx % CELL) - CELL; x < cssW + CELL; x += CELL) {
        ctx.moveTo(x, 0); ctx.lineTo(x, cssH);
      }
      for (let y = (my % CELL) - CELL; y < cssH + CELL; y += CELL) {
        ctx.moveTo(0, y); ctx.lineTo(cssW, y);
      }
      ctx.stroke();

      if (reduced) return; // A11y: no animated ripple layer

      // Ripple layer — for each active wave, highlight grid intersections
      // inside a thin annulus whose radius expands with time.
      const DURATION = 1200; // ms — ripple lifetime
      const MAX_RADIUS = 260;
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        const age = now - r.t0;
        if (age > DURATION) { ripples.splice(i, 1); continue; }
        const k = age / DURATION;               // 0 → 1
        const radius = k * MAX_RADIUS;
        const alpha = (1 - k) * 0.55;           // fades out

        // Iterate only grid intersections within the ripple's bounding box —
        // keeps this cheap even with multiple simultaneous ripples.
        const x0 = Math.max(0, Math.floor((r.x - radius - CELL) / CELL) * CELL);
        const x1 = Math.min(cssW, Math.ceil((r.x + radius + CELL) / CELL) * CELL);
        const y0 = Math.max(0, Math.floor((r.y - radius - CELL) / CELL) * CELL);
        const y1 = Math.min(cssH, Math.ceil((r.y + radius + CELL) / CELL) * CELL);
        for (let x = x0; x <= x1; x += CELL) {
          for (let y = y0; y <= y1; y += CELL) {
            const dx = x - r.x;
            const dy = y - r.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            // Thin annulus: brightest at the expanding front, nothing elsewhere.
            const band = Math.max(0, 1 - Math.abs(d - radius) / 34);
            if (band <= 0) continue;
            ctx.fillStyle = `rgba(198, 245, 31, ${alpha * band})`;
            ctx.beginPath();
            ctx.arc(x, y, 1.6 + 1.2 * band, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      raf = requestAnimationFrame(drawFrame);
    }
    raf = requestAnimationFrame(drawFrame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={ref} style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }} />;
}

/**
 * Bottom DNA Chain Strip — a slowly-turning helix with hackathon keywords
 * woven into the band itself. The text rides the helix wave: each character
 * sits on the centreline but shifts vertically in sync with the strand it
 * belongs to, so it reads as part of the DNA rather than a separate marquee.
 */
const DNA_STRIP_WORDS = [
  "NANOPAYMENT",
  "x402",
  "ARC TESTNET",
  "CIRCLE GATEWAY",
  "CCTP v2",
  "HERMES DNA",
  "GEMINI 3.1",
  "ERC-8004",
  "SUB-CENT",
  "AGENT SWARM",
  "USDC GAS",
  "PAY-PER-STEP"
];

export function DnaChainStrip() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cvs = ref.current;
    if (!cvs) return;
    const rawCtx = cvs.getContext("2d");
    if (!rawCtx) return;
    const ctx: CanvasRenderingContext2D = rawCtx;

    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    let cssW = window.innerWidth;
    const cssH = 56;
    cvs.width = Math.round(cssW * dpr);
    cvs.height = Math.round(cssH * dpr);
    ctx.scale(dpr, dpr);

    let raf = 0;
    let offset = 0;
    const reduced = prefersReducedMotion();

    // Build the "phrase tape" once — single string that repeats, with fixed
    // character spacing. We draw it scrolling and let each character rise /
    // fall with the helix wave it happens to sit on.
    const phrase = DNA_STRIP_WORDS.join("   ◆   ") + "   ◆   ";
    const CHAR_W = 13;       // tuned to match the 0.72rem mono font
    const TAPE_W = phrase.length * CHAR_W;

    function draw() {
      // Slow drift — everything shares the same offset so the wave and the
      // word tape move in lockstep.
      offset += reduced ? 0 : 0.28;
      ctx.clearRect(0, 0, cssW, cssH);

      const cy = cssH / 2;
      const amp = 11;
      const freq = 0.045;

      // ── two helix strands ──
      ctx.lineWidth = 1.3;
      for (let strand = 0; strand < 2; strand++) {
        const phase = strand * Math.PI;
        ctx.beginPath();
        for (let x = -20; x < cssW + 20; x += 2) {
          const y = cy + Math.sin((x + offset) * freq + phase) * amp;
          x === -20 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = strand === 0 ? "rgba(57,255,20,0.38)" : "rgba(57,255,20,0.22)";
        ctx.stroke();
      }

      // ── base-pair rungs + node dots ──
      const RUNG = 24;
      for (let x = -RUNG; x < cssW + RUNG; x += RUNG) {
        const rx = x - (offset % RUNG);
        const y1 = cy + Math.sin((rx + offset) * freq) * amp;
        const y2 = cy + Math.sin((rx + offset) * freq + Math.PI) * amp;
        ctx.beginPath();
        ctx.moveTo(rx, y1);
        ctx.lineTo(rx, y2);
        ctx.strokeStyle = "rgba(57,255,20,0.09)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(rx, y1, 1.4, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(57,255,20,0.7)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(rx, y2, 1.4, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(57,255,20,0.4)";
        ctx.fill();
      }

      // ── woven keyword text ──
      // Each character rides the midline and drifts ±(amp*0.85) along the
      // wave — looks like the words are threaded through the helix.
      ctx.font = "700 11px var(--font-mono, ui-monospace, monospace)";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(198, 245, 31, 0.95)";
      ctx.shadowColor = "rgba(198, 245, 31, 0.5)";
      ctx.shadowBlur = 6;
      // Start the tape two repetitions to the left so we always cover the
      // whole strip including the seam.
      const startX = -((offset * 1.2) % TAPE_W) - TAPE_W;
      for (let x = startX; x < cssW + CHAR_W; x += TAPE_W) {
        for (let i = 0; i < phrase.length; i++) {
          const cx = x + i * CHAR_W;
          if (cx < -CHAR_W || cx > cssW + CHAR_W) continue;
          const ch = phrase[i];
          if (ch === " ") continue;
          const yOff = Math.sin((cx + offset) * freq) * amp * 0.55;
          ctx.fillText(ch, cx, cy + yOff);
        }
      }
      ctx.shadowBlur = 0;

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    const onResize = () => {
      cssW = window.innerWidth;
      cvs.width = Math.round(cssW * dpr);
      cvs.height = Math.round(cssH * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    };
    window.addEventListener("resize", onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
  }, []);

  return (
    <div className="dna-strip">
      <canvas ref={ref} className="dna-strip-canvas" />
    </div>
  );
}
