"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export type ToastTone = "info" | "success" | "warning" | "danger";

export type Toast = {
  id: string;
  tone: ToastTone;
  title: string;
  body?: string;
  link?: { href: string; label: string };
  ttlMs?: number;
};

type ToastContextValue = {
  push: (toast: Omit<Toast, "id">) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_COLORS: Record<ToastTone, { accent: string; bg: string }> = {
  info:    { accent: "#66F1D0", bg: "rgba(102, 241, 208, 0.12)" },
  success: { accent: "#39FF14", bg: "rgba(57, 255, 20, 0.12)" },
  warning: { accent: "#FFD21A", bg: "rgba(255, 210, 26, 0.12)" },
  danger:  { accent: "#FF4D6A", bg: "rgba(255, 77, 106, 0.12)" }
};

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback<ToastContextValue["push"]>((toast) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Settled payments fire in bursts; 5.5s kept 4+ toasts stacked for a
    // long time and felt noisy. Shorter default, and we cap the queue at 3
    // instead of 5 so old ones roll off faster.
    const ttlMs = toast.ttlMs ?? (toast.tone === "danger" ? 7000 : 2800);
    setToasts((prev) => [...prev.slice(-2), { ...toast, id }]);
    if (ttlMs > 0) {
      const timer = setTimeout(() => dismiss(id), ttlMs);
      timers.current.set(id, timer);
    }
    return id;
  }, [dismiss]);

  useEffect(() => () => {
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
  }, []);

  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        style={{
          position: "fixed",
          // Was top:72, right:18 with maxWidth 380 — each toast popped 90px
          // wide bars that competed with the main UI. Pulled to bottom-left
          // corner, narrowed, and dialed down the glow so they read as
          // passive status pings rather than alerts demanding attention.
          bottom: 64,
          left: 14,
          zIndex: 70,
          display: "flex",
          flexDirection: "column-reverse",
          gap: "0.35rem",
          pointerEvents: "none",
          maxWidth: 260
        }}
      >
        {toasts.map((t) => {
          const tone = TONE_COLORS[t.tone];
          return (
            <div
              key={t.id}
              style={{
                pointerEvents: "auto",
                background: "rgba(5, 5, 8, 0.92)",
                border: `1px solid ${tone.accent}33`,
                // Trimmed glow (32px → 14px, -8 offset → -10 offset) so the
                // toast doesn't halo out into the surrounding page.
                boxShadow: `0 0 14px -10px ${tone.accent}`,
                padding: "0.4rem 0.55rem",
                backdropFilter: "blur(6px)",
                animation: "muse-toast-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1)",
                fontFamily: "var(--font-mono)",
                color: "var(--text)"
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.4rem" }}>
                <span style={{ fontSize: "0.58rem", letterSpacing: "0.14em", color: tone.accent, fontWeight: 700 }}>
                  ▸ {t.title.toUpperCase()}
                </span>
                <button
                  type="button"
                  onClick={() => dismiss(t.id)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--text-dim)",
                    fontSize: "0.6rem",
                    cursor: "pointer",
                    padding: 0,
                    lineHeight: 1
                  }}
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              </div>
              {t.body && (
                <div style={{ fontSize: "0.62rem", color: "var(--text-dim)", marginTop: 2, lineHeight: 1.35 }}>{t.body}</div>
              )}
              {t.link && (
                <a
                  href={t.link.href}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: "inline-block", marginTop: 4, fontSize: "0.6rem", color: tone.accent, textDecoration: "underline" }}
                >
                  {t.link.label} ↗
                </a>
              )}
            </div>
          );
        })}
      </div>

      <style jsx global>{`
        @keyframes muse-toast-in {
          from { opacity: 0; transform: translateX(20px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </ToastContext.Provider>
  );
}
