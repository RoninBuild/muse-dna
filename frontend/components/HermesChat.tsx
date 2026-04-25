"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
  model?: string | null;
  via?: string | null;
};

type HermesChatProps = {
  open: boolean;
  onClose: () => void;
  /** Optional: the connected MetaMask address. Passed to backend so Hermes
   *  reads THIS user's orchestrator balance, not the shared env wallet. */
  mainWallet?: string | null;
};

const SUGGESTED = [
  "What's our orchestrator balance right now?",
  "List the last 10 micro-payments.",
  "Why are nanopayments viable for 52 authorizations at $0.005 each?",
  "Show me the agent wallet directory.",
  "Which tiers are available and how do they differ?"
];

const HERMES_CHAT_TIMEOUT_MS = 45_000;

export default function HermesChat({ open, onClose, mainWallet }: HermesChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  // P2-4: request ID ensures only the latest in-flight fetch can clear busy.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, busy]);

  // Cancel any in-flight fetch when the component unmounts so we never set
  // state on a dead instance and we stop the upstream request.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // Esc-to-close: when the drawer is open, intercept Escape at the window
  // level so users on any focused element (including the input) can dismiss
  // without reaching for the mouse. Listener only registers while open so
  // it can't accidentally fire when the drawer is hidden.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const send = useCallback(async (text: string) => {
    if (!text.trim() || busy) return;
    const userMsg: ChatMessage = { role: "user", content: text.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setBusy(true);
    setError(null);

    // P2-4: capture this request's ID before any await so the finally clause
    // only clears busy when the LATEST request finishes, not a stale one.
    const myRequestId = ++requestIdRef.current;

    // Abort any in-flight request before kicking off a new one. Otherwise
    // a slow first call still resolves in the background after the user
    // sends a second message, and we end up appending two assistant
    // replies — or worse, the older one races and overwrites the newer.
    if (abortRef.current && !abortRef.current.signal.aborted) {
      try { abortRef.current.abort(); } catch { /* ignore */ }
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), HERMES_CHAT_TIMEOUT_MS);

    try {
      const res = await fetch("/api/hermes/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text.trim(),
          history: messages.map((m) => ({ role: m.role, content: m.content })),
          // P2-1: pass the connected wallet so Hermes reads the right
          // orchestrator balance rather than the env-level fallback.
          mainWallet: mainWallet || undefined
        }),
        signal: controller.signal
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setError(payload?.detail || payload?.error || `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      if (!mountedRef.current) return;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.text || "(empty response)",
          toolCalls: data.toolCalls,
          model: data.model,
          via: data.via
        }
      ]);
    } catch (err: any) {
      if (!mountedRef.current) return;
      const aborted = err?.name === "AbortError";
      setError(aborted ? `Request timed out after ${HERMES_CHAT_TIMEOUT_MS / 1000}s` : (err?.message || "Network error"));
    } finally {
      clearTimeout(timer);
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      // P2-4: only the most recent request is allowed to flip busy back off.
      if (mountedRef.current && myRequestId === requestIdRef.current) {
        setBusy(false);
      }
    }
  }, [busy, messages, mainWallet]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(480px, 96vw)",
        background: "rgba(5, 5, 8, 0.97)",
        borderLeft: "1px solid rgba(102, 241, 208, 0.3)",
        boxShadow: "-24px 0 64px -12px rgba(102, 241, 208, 0.2)",
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        animation: "muse-hermes-slide 240ms cubic-bezier(0.2, 0.8, 0.2, 1)"
      }}
    >
      <header
        style={{
          padding: "0.9rem 1.1rem",
          borderBottom: "1px solid rgba(255,255,255,0.1)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between"
        }}
      >
        <div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", letterSpacing: "0.3em", color: "var(--text-dim)" }}>
            GEMINI · FUNCTION CALLING
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "1.1rem", color: "var(--acid)", letterSpacing: "-0.01em", marginTop: 2 }}>
            HERMES BRAIN
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            letterSpacing: "0.15em",
            background: "transparent",
            color: "var(--text-dim)",
            border: "1px solid rgba(255,255,255,0.15)",
            padding: "0.35rem 0.7rem",
            cursor: "pointer"
          }}
        >
          [ CLOSE ]
        </button>
      </header>

      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: "auto", padding: "1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}
      >
        {messages.length === 0 && (
          <div>
            <p style={{ color: "var(--text-dim)", fontSize: "0.85rem", lineHeight: 1.5, margin: 0 }}>
              Ask Hermes anything about the DNA economy. Gemini 2.5/3.1 Pro will reason over
              your question and call the right Circle / x402 / Hermes tool to answer.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", marginTop: "0.9rem" }}>
              {SUGGESTED.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => send(q)}
                  style={{
                    textAlign: "left",
                    padding: "0.55rem 0.7rem",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.72rem",
                    background: "rgba(102, 241, 208, 0.05)",
                    border: "1px solid rgba(102, 241, 208, 0.15)",
                    color: "var(--text)",
                    cursor: "pointer",
                    transition: "background 150ms, border-color 150ms"
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "94%",
              background: m.role === "user" ? "rgba(102, 241, 208, 0.12)" : "rgba(255,255,255,0.04)",
              border: `1px solid ${m.role === "user" ? "rgba(102, 241, 208, 0.4)" : "rgba(255,255,255,0.08)"}`,
              padding: "0.6rem 0.75rem",
              color: "var(--text)",
              fontSize: "0.82rem",
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word"
            }}
          >
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.2em", color: m.role === "user" ? "var(--acid)" : "var(--text-dim)", marginBottom: 4 }}>
              {m.role === "user" ? "YOU" : `HERMES${m.model ? ` · ${m.model}` : ""}${m.via ? ` · ${m.via}` : ""}`}
            </div>
            {m.content}

            {m.toolCalls && m.toolCalls.length > 0 && (
              <details style={{ marginTop: "0.6rem" }}>
                <summary style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", letterSpacing: "0.15em", color: "var(--acid)", cursor: "pointer" }}>
                  ▸ {m.toolCalls.length} TOOL CALL{m.toolCalls.length > 1 ? "S" : ""}
                </summary>
                <div style={{ marginTop: "0.4rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                  {m.toolCalls.map((tc, j) => (
                    <div key={j} style={{ background: "rgba(0,0,0,0.4)", padding: "0.45rem", border: "1px solid rgba(255,255,255,0.06)" }}>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--acid)", marginBottom: 2 }}>
                        {tc.name}({Object.keys(tc.args || {}).length > 0 ? JSON.stringify(tc.args) : ""})
                      </div>
                      <pre style={{ margin: 0, fontSize: "0.62rem", color: "var(--text-dim)", overflowX: "auto", maxHeight: 140 }}>
                        {JSON.stringify(tc.result, null, 2).slice(0, 1200)}
                      </pre>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        ))}

        {busy && (
          <div
            style={{
              alignSelf: "flex-start",
              fontFamily: "var(--font-mono)",
              fontSize: "0.7rem",
              color: "var(--acid)",
              animation: "muse-pulse 1.2s ease-in-out infinite"
            }}
          >
            HERMES IS REASONING...
          </div>
        )}

        {error && (
          <div style={{ alignSelf: "flex-start", fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--red)", border: "1px solid var(--red)", padding: "0.5rem" }}>
            ⚠ {error}
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        style={{ borderTop: "1px solid rgba(255,255,255,0.1)", padding: "0.7rem", display: "flex", gap: "0.4rem" }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask Hermes…"
          disabled={busy}
          style={{
            flex: 1,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "var(--text)",
            padding: "0.55rem 0.7rem",
            fontFamily: "var(--font-mono)",
            fontSize: "0.8rem"
          }}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          style={{
            background: busy || !input.trim() ? "rgba(255,255,255,0.08)" : "var(--acid)",
            color: busy || !input.trim() ? "var(--text-dim)" : "#000",
            border: "none",
            padding: "0.55rem 0.9rem",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: "0.75rem",
            letterSpacing: "0.1em",
            cursor: busy || !input.trim() ? "not-allowed" : "pointer"
          }}
        >
          ▶ SEND
        </button>
      </form>

      <style jsx>{`
        @keyframes muse-hermes-slide {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @keyframes muse-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
