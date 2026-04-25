"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Live USDC-spent sparkline.
 *
 * Feed it a cumulative spent value; the component pushes a new datapoint on
 * every change and draws a thin acid-green sparkline. Ideal for the right
 * rail on /task/[id] or the landing ledger so judges see the per-second
 * spending cadence that makes nanopayments feel real.
 */
export default function CostSparkline({
  spentUsdc,
  width = 180,
  height = 44,
  maxPoints = 60
}: {
  spentUsdc: number;
  width?: number;
  height?: number;
  maxPoints?: number;
}) {
  const [points, setPoints] = useState<number[]>([0]);
  const lastSpent = useRef(spentUsdc);

  useEffect(() => {
    if (spentUsdc !== lastSpent.current) {
      lastSpent.current = spentUsdc;
      setPoints((prev) => {
        const next = [...prev.slice(-(maxPoints - 1)), spentUsdc];
        return next;
      });
    }
  }, [spentUsdc, maxPoints]);

  // Heartbeat every second so the chart animates even when there are no
  // new payments. Pauses while the tab is hidden so we don't burn CPU for
  // a chart nobody can see.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const startTimer = () => {
      if (timer) return;
      timer = setInterval(() => {
        setPoints((prev) => {
          if (prev.length >= maxPoints) {
            return [...prev.slice(-(maxPoints - 1)), lastSpent.current];
          }
          return [...prev, lastSpent.current];
        });
      }, 1000);
    };
    const stopTimer = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") startTimer();
      else stopTimer();
    };

    if (document.visibilityState === "visible") startTimer();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stopTimer();
    };
  }, [maxPoints]);

  const { path, fillPath, last } = useMemo(() => {
    if (points.length === 0) return { path: "", fillPath: "", last: 0 };
    const max = Math.max(...points, 0.00001);
    const min = 0;
    const stepX = width / Math.max(1, points.length - 1);
    const toY = (v: number) => height - ((v - min) / Math.max(0.00001, max - min)) * (height - 6) - 3;
    const coords = points.map((v, i) => `${i * stepX},${toY(v)}`);
    const p = `M ${coords.join(" L ")}`;
    const fp = `${p} L ${width},${height} L 0,${height} Z`;
    return { path: p, fillPath: fp, last: points[points.length - 1] };
  }, [points, width, height]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.25em", color: "var(--text-dim)" }}>
        <span>USDC · LIVE</span>
        <span style={{ color: "var(--acid)", fontWeight: 700 }}>${last.toFixed(4)}</span>
      </div>
      <svg width={width} height={height} style={{ display: "block" }} aria-hidden="true">
        <defs>
          <linearGradient id="muse-spark-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#C6F51F" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#C6F51F" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={fillPath} fill="url(#muse-spark-fill)" />
        <path d={path} fill="none" stroke="#C6F51F" strokeWidth={1.5} strokeLinecap="square" />
      </svg>
    </div>
  );
}
