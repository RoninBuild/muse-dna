"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type HistoryTask = {
  id: string;
  brand_name?: string | null;
  prompt?: string | null;
  task_type?: string | null;
  status?: string | null;
  total_spent_usdc?: number | null;
  created_at?: string | null;
};

const OPEN_WIDTH = 364;   // 260 × 1.4 — 40% wider per request
const CLOSED_WIDTH = 36;  // just enough to show the toggle handle

/**
 * ChatGPT-style left sidebar listing the user's past tasks. Collapsible:
 * clicking the handle on the right edge slides it shut with a gentle easing
 * transition so the main canvas gets more room when needed.
 */
export default function HistorySidebar({
  open,
  onToggle,
  onNewTask,
  visible = true
}: {
  open: boolean;
  onToggle: () => void;
  onNewTask?: () => void;
  // When false, the sidebar collapses to width:0 with a fade — used on
  // landing before wallet connect so the sidebar slides in smoothly instead
  // of popping in abruptly when `mainWallet` flips from null to an address.
  visible?: boolean;
}) {
  const router = useRouter();
  const [tasks, setTasks] = useState<HistoryTask[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/history", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const list: HistoryTask[] = Array.isArray(data.tasks) ? data.tasks : [];
        list.sort((a, b) => {
          const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
          const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
          return tb - ta;
        });
        setTasks(list);
      } catch { /* backend offline — keep existing list */ }
      finally { if (!cancelled) setLoading(false); }
    }
    load();
    const timer = setInterval(load, 20_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  return (
    <aside
      aria-hidden={!visible}
      style={{
        width: visible ? (open ? OPEN_WIDTH : CLOSED_WIDTH) : 0,
        flexShrink: 0,
        borderRight: visible ? "1px solid rgba(255,255,255,0.06)" : "1px solid transparent",
        background: "rgba(5,5,8,0.72)",
        backdropFilter: "blur(6px)",
        position: "sticky",
        top: 0,
        alignSelf: "flex-start",
        height: "calc(100vh - 56px)",
        display: "flex",
        flexDirection: "column",
        zIndex: 5,
        // Animate width AND opacity so the mount transition on wallet
        // connect reads as a smooth slide-in from the left rather than a
        // sudden layout shift. Using the same easing curve as the open/close
        // toggle keeps the motion language consistent.
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
        transition: "width 360ms cubic-bezier(0.22, 1, 0.36, 1), opacity 260ms ease, border-color 260ms ease",
        overflow: "hidden"
      }}
    >
      {/* Toggle handle — lives on the right edge so it's reachable in both
          open and closed states. Turns into a "hamburger" when closed. */}
      <button
        type="button"
        onClick={onToggle}
        aria-label={open ? "Collapse task list" : "Expand task list"}
        title={open ? "Collapse" : "Expand"}
        style={{
          position: "absolute",
          top: 12,
          right: 8,
          width: 22,
          height: 22,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "1px solid rgba(198,245,31,0.35)",
          color: "var(--acid)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          lineHeight: 1,
          cursor: "pointer",
          padding: 0,
          zIndex: 6,
          transition: "transform 220ms ease"
        }}
      >
        {open ? "⟨" : "⟩"}
      </button>

      {/* Content fades + slides in/out in sync with the width transition so
          closed state reads as a clean narrow gutter instead of cut-off text. */}
      <div
        aria-hidden={!open}
        style={{
          width: OPEN_WIDTH,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          height: "100%",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 220ms ease"
        }}
      >
        <div style={{ padding: "0.9rem 0.9rem 0.5rem", paddingRight: 36 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.58rem", letterSpacing: "0.26em", color: "var(--text-dim)", marginBottom: "0.5rem" }}>
            TASKS
          </div>
          <button
            type="button"
            onClick={() => {
              onNewTask?.();
              const el = document.getElementById("task-flow");
              if (el) {
                el.scrollIntoView({ behavior: "smooth", block: "start" });
                return;
              }
              // No task-flow on the current page (e.g. /task/[id]) — jump to
              // the landing page where the task form lives. Use a hash so the
              // landing page auto-scrolls to the describe-task section once
              // it mounts.
              router.push("/#task-flow");
            }}
            style={{
              width: "100%",
              background: "transparent",
              border: "1px dashed rgba(198,245,31,0.5)",
              color: "var(--acid)",
              padding: "0.55rem 0.7rem",
              fontFamily: "var(--font-mono)",
              fontSize: "0.72rem",
              letterSpacing: "0.12em",
              textAlign: "left",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between"
            }}
          >
            <span>+ NEW TASK</span>
            <span style={{ fontSize: "0.6rem", color: "var(--text-dim)" }}>↘</span>
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "0.3rem 0.55rem 1rem" }}>
          {loading && (
            <p style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "0.7rem", padding: "0.5rem" }}>
              Loading…
            </p>
          )}

          {!loading && tasks.length === 0 && (
            <p style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "0.7rem", padding: "0.5rem", lineHeight: 1.5 }}>
              No tasks yet. Describe one on the right to get started — Hermes will propose three priced variants.
            </p>
          )}

          {tasks.map((t) => {
            const status = (t.status || "").toLowerCase();
            const dotColor =
              status === "completed" ? "var(--acid)" :
              status === "failed" ? "var(--red, #FF5A5A)" :
              "var(--yellow, #ffd21a)";
            const title = t.brand_name?.trim() || (t.prompt ? t.prompt.slice(0, 40) : "Untitled task");
            const snippet = t.prompt ? t.prompt.slice(0, 72) + (t.prompt.length > 72 ? "…" : "") : "";
            return (
              <Link
                key={t.id}
                href={`/task/${t.id}`}
                style={{
                  display: "block",
                  padding: "0.55rem 0.6rem",
                  margin: "0.15rem 0",
                  border: "1px solid transparent",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.72rem",
                  color: "var(--text)",
                  textDecoration: "none",
                  transition: "background 120ms, border-color 120ms"
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(198,245,31,0.05)";
                  e.currentTarget.style.borderColor = "rgba(198,245,31,0.18)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.borderColor = "transparent";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: 2 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {title}
                  </span>
                </div>
                {snippet && (
                  <div style={{ color: "var(--text-dim)", fontSize: "0.64rem", lineHeight: 1.45, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {snippet}
                  </div>
                )}
                {t.total_spent_usdc != null && Number(t.total_spent_usdc) > 0 && (
                  <div style={{ color: "var(--acid)", fontSize: "0.62rem", marginTop: 2 }}>
                    ${Number(t.total_spent_usdc).toFixed(3)} USDC
                  </div>
                )}
              </Link>
            );
          })}
        </div>

        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "0.55rem 0.9rem" }}>
          <Link
            href="/history"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              letterSpacing: "0.18em",
              color: "var(--text-dim)",
              textDecoration: "none"
            }}
          >
            <span>↗ FULL PROOF DASHBOARD</span>
          </Link>
        </div>
      </div>
    </aside>
  );
}
