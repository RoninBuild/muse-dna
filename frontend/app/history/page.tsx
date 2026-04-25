"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { MuseMark } from "@/components/MuseMark";
import { DnaChainStrip } from "@/components/DnaCanvas";
import { BottomBar } from "@/components/BottomBar";

type HistoryTask = {
  id: string;
  brand_name?: string | null;
  prompt?: string | null;
  task_type?: string | null;
  status?: string | null;
  total_spent_usdc?: number | null;
  savings_usdc?: number | null;
  created_at?: string | null;
  result?: { metrics?: { paidMicroPayments?: number; reusedUnits?: number } } | null;
};

const MOCK_HISTORY: HistoryTask[] = [
  {
    id: "sim-demo-1",
    brand_name: "AutoCRM",
    prompt: "Create a Twitter post for AutoCRM",
    task_type: "twitter_post",
    status: "completed",
    total_spent_usdc: 0.232,
    savings_usdc: 0,
    result: { metrics: { paidMicroPayments: 44, reusedUnits: 0 } }
  },
  {
    id: "sim-demo-2",
    brand_name: "AutoCRM",
    prompt: "Email campaign for AutoCRM launch",
    task_type: "email_campaign",
    status: "completed",
    total_spent_usdc: 0.128,
    savings_usdc: 0.104,
    result: { metrics: { paidMicroPayments: 20, reusedUnits: 24 } }
  }
];

function formatTaskType(t: string | null | undefined) {
  if (!t) return "TASK";
  return t.replace(/_/g, " ").toUpperCase();
}

function shortId(id: string | null | undefined) {
  if (!id) return "—";
  if (id.startsWith("sim-")) return id.slice(0, 14);
  return `0x${id.slice(0, 4)}…${id.slice(-4)}`;
}

function timeAgo(isoOrMs: string | number | null | undefined): string {
  if (!isoOrMs) return "—";
  const t = typeof isoOrMs === "string" ? new Date(isoOrMs).getTime() : isoOrMs;
  if (!Number.isFinite(t)) return "—";
  const delta = Date.now() - t;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export default function HistoryPage() {
  const [tasks, setTasks] = useState<HistoryTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isMockData, setIsMockData] = useState(false);

  useEffect(() => {
    let active = true;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);

    fetch("/api/history", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Backend not available"))))
      .then((data: { tasks?: HistoryTask[] }) => {
        if (!active) return;
        setTasks((data.tasks || []).filter((t) => t.status === "completed" || t.status === "failed"));
        setIsMockData(false);
        setIsLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setTasks(MOCK_HISTORY);
        setIsMockData(true);
        setIsLoading(false);
      })
      .finally(() => clearTimeout(timer));

    return () => {
      active = false;
      clearTimeout(timer);
      if (!ctrl.signal.aborted) ctrl.abort();
    };
  }, []);

  const stats = useMemo(() => {
    const totalSpent = tasks.reduce((s, t) => s + Number(t.total_spent_usdc || 0), 0);
    const totalSaved = tasks.reduce((s, t) => s + Number(t.savings_usdc || 0), 0);
    const totalPaid = tasks.reduce((s, t) => s + Number(t.result?.metrics?.paidMicroPayments || 0), 0);
    const failedCount = tasks.filter((t) => t.status === "failed").length;
    return { totalSpent, totalSaved, totalPaid, failedCount };
  }, [tasks]);

  // 14d spend chart — bucket completed tasks by day. Guard against NaN
  // `created_at` (malformed strings like "yesterday" → invalid Date) so
  // rows don't silently drop out of the chart while still counting in
  // KPI totals — the contradiction was a P2 audit finding.
  const chartPoints = useMemo(() => {
    const buckets = Array.from({ length: 14 }, () => 0);
    const now = Date.now();
    for (const t of tasks) {
      let ts = t.created_at ? new Date(t.created_at).getTime() : now;
      if (!Number.isFinite(ts)) ts = now;
      const dayBack = Math.floor((now - ts) / 86_400_000);
      if (dayBack >= 0 && dayBack < 14) {
        buckets[13 - dayBack] += Number(t.total_spent_usdc || 0);
      }
    }
    // Only fall back to the decorative wave when there are NO tasks at
    // all. With real tasks costing $0 (DNA reuse, sim, failures) we'd
    // rather show a flat line than fake a non-zero pattern that
    // contradicts the rows below.
    if (tasks.length === 0) {
      return [0.012, 0.018, 0.009, 0.022, 0.030, 0.018, 0.024, 0.016, 0.036, 0.028, 0.042, 0.024, 0.038, 0.052];
    }
    return buckets;
  }, [tasks]);

  const last14dSpend = chartPoints.reduce((a, b) => a + b, 0);
  const avgPerTask = tasks.length > 0 ? stats.totalSpent / tasks.length : 0;

  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", color: "var(--text)" }}>
      <header className="topbar" style={{ position: "relative", zIndex: 2, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.85rem 1.25rem", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <Link href="/" className="topbar-logo" style={{ display: "flex", alignItems: "center", gap: "0.6rem", textDecoration: "none" }}>
          <MuseMark variant="helix" fg="var(--acid)" bg="var(--bg)" size={32} />
          <span style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "1.2rem", letterSpacing: "-0.03em", textTransform: "uppercase", lineHeight: 1, color: "var(--text)" }}>
            MUSE<span style={{ color: "var(--acid)" }}>.DNA</span>
          </span>
        </Link>
        <nav className="topbar-nav" style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <Link href="/" style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", letterSpacing: "0.2em", color: "var(--text-dim)", textDecoration: "none" }}>HOME</Link>
          <Link href="/dna" style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", letterSpacing: "0.2em", color: "var(--text-dim)", textDecoration: "none" }}>DNA</Link>
          <Link href="/history" style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", letterSpacing: "0.2em", color: "var(--acid)", textDecoration: "none" }}>HISTORY</Link>
        </nav>
      </header>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "1.4rem 1.25rem 4rem" }}>
        {/* Page header */}
        <div style={{ display: "flex", alignItems: "baseline", gap: "1rem", marginBottom: "1.2rem", flexWrap: "wrap" }}>
          <h1 style={{
            fontFamily: "var(--font-display-brand, var(--font-display))",
            fontSize: "clamp(1.8rem, 4vw, 2.4rem)",
            color: "var(--text)",
            margin: 0,
            letterSpacing: "-0.04em",
            textTransform: "uppercase"
          }}>
            HISTORY<span style={{ color: "var(--acid)" }}>.</span>
          </h1>
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            color: "var(--text-dim)",
            letterSpacing: "0.18em",
            textTransform: "uppercase"
          }}>
            ALL CAMPAIGNS · ALL WALLETS · ARC TESTNET
          </span>
        </div>

        {isMockData && !isLoading && (
          <div
            style={{
              border: "1px solid rgba(255,210,26,0.35)",
              background: "rgba(255,210,26,0.05)",
              padding: "0.55rem 0.85rem",
              fontFamily: "var(--font-mono)",
              fontSize: "0.72rem",
              color: "var(--yellow, #ffd21a)",
              letterSpacing: "0.06em",
              marginBottom: "1rem"
            }}
          >
            ⚠ Backend offline — showing demo seed rows. Real tasks will appear once it reconnects.
          </div>
        )}

        {/* KPI row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.8rem", marginBottom: "1.2rem" }}>
          <div style={{ border: "1px solid rgba(255,255,255,0.12)", background: "rgba(12,14,19,0.85)", padding: "1rem 1.1rem" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.22em", color: "var(--text-dim)", textTransform: "uppercase" }}>COMPLETED TASKS</div>
            <div style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "2.4rem", color: "var(--text)", letterSpacing: "-0.02em", marginTop: 4 }}>
              {isLoading ? "—" : tasks.filter((t) => t.status === "completed").length}
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-dim)", marginTop: 4 }}>
              {stats.totalPaid} micro-payments settled · {stats.failedCount} failed
            </div>
          </div>
          <div style={{ border: "1px solid rgba(255,255,255,0.12)", background: "rgba(12,14,19,0.85)", padding: "1rem 1.1rem" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.22em", color: "var(--text-dim)", textTransform: "uppercase" }}>TOTAL SPEND USDC</div>
            <div style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "2.4rem", color: "var(--text)", letterSpacing: "-0.02em", marginTop: 4 }}>
              ${isLoading ? "—" : stats.totalSpent.toFixed(3)}
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-dim)", marginTop: 4 }}>
              across {stats.totalPaid} micro-actions
            </div>
          </div>
          <div style={{
            position: "relative",
            border: "2px solid var(--acid)",
            background: "rgba(198,245,31,0.04)",
            boxShadow: "4px 4px 0 var(--acid)",
            padding: "1rem 1.1rem"
          }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.22em", color: "var(--acid)", textTransform: "uppercase" }}>HERMES SAVINGS · USDC</div>
            <div style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "2.4rem", color: "var(--acid)", letterSpacing: "-0.02em", marginTop: 4 }}>
              ${isLoading ? "—" : stats.totalSaved.toFixed(3)}
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-dim)", marginTop: 4 }}>
              via DNA reuse · {tasks.length > 0 ? Math.round((stats.totalSaved / Math.max(0.001, stats.totalSpent + stats.totalSaved)) * 100) : 0}% avg / repeat
            </div>
          </div>
        </div>

        {/* Spend chart */}
        <div style={{ border: "1px solid rgba(255,255,255,0.12)", padding: "0.9rem 1.1rem", marginBottom: "1.2rem", display: "grid", gridTemplateColumns: "auto 1fr auto", gap: "1.4rem", alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.22em", color: "var(--text-dim)", textTransform: "uppercase" }}>SPEND · LAST 14D</div>
            <div style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "1.4rem", color: "var(--acid)", marginTop: 2 }}>${last14dSpend.toFixed(3)}</div>
          </div>
          <svg viewBox="0 0 600 60" style={{ width: "100%", height: 60 }} preserveAspectRatio="none">
            {(() => {
              const max = Math.max(...chartPoints, 0.06);
              const w = 600;
              const h = 60;
              const pad = 4;
              const pts = chartPoints.map((v, i) => `${(i / (chartPoints.length - 1)) * w},${(h - (v / max) * (h - pad * 2) - pad).toFixed(2)}`);
              return (
                <>
                  <polyline points={pts.join(" ")} fill="none" stroke="var(--acid)" strokeWidth="1.5" />
                  {chartPoints.map((v, i) => (
                    <circle
                      key={i}
                      cx={(i / (chartPoints.length - 1)) * w}
                      cy={(h - (v / max) * (h - pad * 2) - pad).toFixed(2)}
                      r="2"
                      fill="var(--acid)"
                    />
                  ))}
                </>
              );
            })()}
          </svg>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.22em", color: "var(--text-dim)", textTransform: "uppercase" }}>AVG / TASK</div>
            <div style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "1.4rem", color: "var(--text)", marginTop: 2 }}>${avgPerTask.toFixed(3)}</div>
          </div>
        </div>

        {/* Task list */}
        <div style={{ display: "grid", gridTemplateColumns: "200px 1fr 120px 110px 100px 100px 80px", gap: "0.6rem", padding: "0.4rem 0.85rem", borderBottom: "1px solid rgba(255,255,255,0.12)", marginBottom: 6 }}>
          {["BRAND", "TASK", "STATUS", "MICROTX", "COST", "SAVED", ""].map((h) => (
            <div key={h} style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.22em", color: "var(--text-dim)", textTransform: "uppercase" }}>{h}</div>
          ))}
        </div>

        {isLoading ? (
          <p style={{ padding: "2rem", textAlign: "center", color: "var(--text-dim)" }}>Loading…</p>
        ) : tasks.length === 0 ? (
          <p style={{ padding: "2rem", textAlign: "center", color: "var(--text-dim)" }}>No completed tasks yet. Run a task first.</p>
        ) : (
          <div style={{ display: "grid", gap: "0.4rem" }}>
            {tasks.map((task) => {
              const isWarn = task.status === "failed" || task.status === "partial";
              const isNew = !!task.created_at && Date.now() - new Date(task.created_at).getTime() < 8 * 3_600_000;
              const tx = task.result?.metrics?.paidMicroPayments || 0;
              const cost = Number(task.total_spent_usdc || 0);
              const saved = Number(task.savings_usdc || 0);
              return (
                <Link
                  key={task.id}
                  href={`/task/${task.id}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "200px 1fr 120px 110px 100px 100px 80px",
                    gap: "0.6rem",
                    padding: "0.75rem 0.85rem",
                    background: "rgba(12,14,19,0.7)",
                    border: "1px solid rgba(255,255,255,0.06)",
                    borderLeft: isWarn
                      ? "3px solid var(--yellow, #ffd21a)"
                      : isNew
                        ? "3px solid var(--acid)"
                        : "3px solid rgba(255,255,255,0.06)",
                    alignItems: "center",
                    cursor: "pointer",
                    textDecoration: "none",
                    color: "var(--text)",
                    transition: "background 160ms ease"
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(198,245,31,0.04)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(12,14,19,0.7)")}
                >
                  <div>
                    <div style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "0.85rem", color: "var(--text)", letterSpacing: "0.02em" }}>{(task.brand_name || "—").toUpperCase()}</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", color: "var(--text-dim)" }}>{shortId(task.id)}</div>
                  </div>
                  <div>
                    <span style={{ display: "inline-block", padding: "0.18rem 0.5rem", border: "1px solid rgba(255,255,255,0.18)", fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text)" }}>
                      {formatTaskType(task.task_type)}
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-dim)", marginLeft: 8 }}>{timeAgo(task.created_at)}</span>
                  </div>
                  <div>
                    <span style={{
                      display: "inline-block",
                      padding: "0.18rem 0.5rem",
                      border: `1px solid ${isWarn ? "var(--yellow, #ffd21a)" : "var(--acid)"}`,
                      color: isWarn ? "var(--yellow, #ffd21a)" : "var(--acid)",
                      background: isWarn ? "rgba(255,210,26,0.06)" : "rgba(198,245,31,0.06)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.55rem",
                      letterSpacing: "0.18em",
                      textTransform: "uppercase"
                    }}>
                      {(task.status || "—").toUpperCase()}
                    </span>
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text)" }}>{tx} <span style={{ color: "var(--text-dim)" }}>tx</span></div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem", color: "var(--text)" }}>${cost.toFixed(3)}</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: saved > 0 ? "var(--acid)" : "var(--text-dim)" }}>{saved > 0 ? `$${saved.toFixed(3)}` : "—"}</div>
                  <div style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--acid)", letterSpacing: "0.18em", textTransform: "uppercase" }}>OPEN ↗</div>
                </Link>
              );
            })}
          </div>
        )}
      </main>

      <DnaChainStrip />
      <BottomBar />
    </div>
  );
}
