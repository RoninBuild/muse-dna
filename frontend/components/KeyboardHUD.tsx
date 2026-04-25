"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";

type Shortcut = { keys: string; label: string; note?: string };

// `⌘ K` is wired at landing-page level only (it toggles HermesChat which
// lives in `app/page.tsx`). Listing it on routes where it does nothing
// confuses judges who'll try the shortcut and see no response — so we
// gate that row to the landing route.
const ALL_SHORTCUTS: Shortcut[] = [
  { keys: "⌘ K", label: "Open Hermes chat", note: "Gemini Function Calling", forRoute: "/" } as Shortcut & { forRoute?: string },
  { keys: "⌘ /", label: "Show this help" },
  { keys: "Esc", label: "Close any overlay" }
];

/**
 * Floating keyboard-shortcut HUD opened with ⌘/ (Ctrl+/). Pure presentation —
 * the actual hotkeys are wired at page level.
 */
export default function KeyboardHUD() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const SHORTCUTS = useMemo(
    () =>
      ALL_SHORTCUTS.filter((s: any) => !s.forRoute || s.forRoute === pathname),
    [pathname]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Lock body scroll while the modal is open so the backdrop feels solid
  // and users can't accidentally scroll the page behind it.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        background: "rgba(0,0,0,0.72)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        animation: "muse-kbd-in 180ms ease-out"
      }}
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth: 380,
          padding: "1rem 1.2rem",
          background: "#07090c",
          border: "1px solid var(--acid)",
          boxShadow: "0 0 48px -8px var(--acid-glow-strong)",
          fontFamily: "var(--font-mono)"
        }}
      >
        <div style={{ fontSize: "0.58rem", letterSpacing: "0.3em", color: "var(--text-dim)" }}>
          MUSE DNA · KEYBOARD
        </div>
        <div style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "1.1rem", color: "var(--acid)", letterSpacing: "-0.02em", margin: "0.3rem 0 0.9rem", textTransform: "uppercase" }}>
          SHORTCUTS
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {SHORTCUTS.map((s) => (
            <div key={s.keys} style={{ display: "flex", alignItems: "center", gap: "0.6rem", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text)", fontSize: "0.8rem" }}>
                {s.label}
                {s.note && <span style={{ color: "var(--text-dim)", marginLeft: "0.4rem", fontSize: "0.7rem" }}>· {s.note}</span>}
              </span>
              <kbd
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.72rem",
                  letterSpacing: "0.1em",
                  padding: "0.18rem 0.55rem",
                  border: "1px solid rgba(198,245,31,0.45)",
                  color: "var(--acid)",
                  background: "rgba(198,245,31,0.08)"
                }}
              >
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
        <div style={{ marginTop: "1rem", fontSize: "0.65rem", color: "var(--text-dim)", letterSpacing: "0.1em" }}>
          (click anywhere to close)
        </div>
      </div>
      <style jsx>{`
        @keyframes muse-kbd-in {
          from { opacity: 0; transform: scale(0.96); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
