"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MuseMark } from "@/components/MuseMark";
import { BottomBar } from "@/components/BottomBar";

type AnalyticsEntry = {
  id: string;
  capturedAt: string;
  source: string;
  text: string;
  metrics: Record<string, number | string>;
};

type DnaItem = {
  fileName: string;
  brandKey: string;
  brandName: string;
  stats: { sizeBytes: number; modifiedAt: string } | null;
  analytics: AnalyticsEntry[];
};

function fmtBytes(n: number | undefined | null) {
  if (!Number.isFinite(n) || (n ?? 0) <= 0) return "0 B";
  const v = n as number;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function sourceTone(src: string): string {
  const s = src.toLowerCase();
  if (s.includes("twit")) return "var(--info, #5FA8FF)";
  if (s.includes("linkedin")) return "#66F1D0";
  if (s.includes("email")) return "var(--yellow, #ffd21a)";
  return "var(--acid)";
}

export default function DnaPage() {
  const [items, setItems] = useState<DnaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [activeContent, setActiveContent] = useState<string>("");
  const [contentLoading, setContentLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [analyticsDraft, setAnalyticsDraft] = useState<{ source: string; text: string; metrics: string }>({
    source: "twitter",
    text: "",
    metrics: ""
  });
  const [savingAnalytics, setSavingAnalytics] = useState(false);

  // Read the connected MetaMask address that the landing page persisted
  // so the DNA archive can be scoped to brands the user actually minted,
  // not all brands every other user has produced. Falls through to the
  // unscoped (legacy) view if no wallet is in localStorage.
  const refreshList = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      let walletQs = "";
      try {
        const stored = window.localStorage.getItem("muse.main_wallet");
        if (stored && /^0x[0-9a-fA-F]{40}$/.test(stored)) {
          walletQs = `?mainWallet=${encodeURIComponent(stored)}`;
        }
      } catch { /* storage disabled — silently fall back to unscoped list */ }

      const res = await fetch(`/api/hermes/dna${walletQs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refreshList(); }, [refreshList]);

  useEffect(() => {
    if (items.length === 0) return;
    if (!activeFile) {
      setActiveFile(items[0].fileName);
      return;
    }
    if (!items.some((it) => it.fileName === activeFile)) {
      setActiveFile(items[0].fileName);
    }
  }, [items, activeFile]);

  useEffect(() => {
    if (!activeFile) return;
    let cancelled = false;
    setContentLoading(true);
    (async () => {
      try {
        let walletQs = "";
        try {
          const stored = window.localStorage.getItem("muse.main_wallet");
          if (stored && /^0x[0-9a-fA-F]{40}$/.test(stored)) {
            walletQs = `?mainWallet=${encodeURIComponent(stored)}`;
          }
        } catch { /* ignore */ }
        const res = await fetch(
          `/api/hermes/dna/${encodeURIComponent(activeFile)}${walletQs}`,
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setActiveContent(typeof data?.content === "string" ? data.content : "");
      } catch (err) {
        if (cancelled) return;
        setActiveContent(`# Failed to load\n\n${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (!cancelled) setContentLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeFile]);

  const activeItem = useMemo(
    () => items.find((it) => it.fileName === activeFile) || null,
    [items, activeFile]
  );

  const filteredItems = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) =>
      (it.brandName || "").toLowerCase().includes(q) ||
      (it.brandKey || "").toLowerCase().includes(q) ||
      (it.fileName || "").toLowerCase().includes(q)
    );
  }, [items, filter]);

  const submitAnalytics = useCallback(async () => {
    if (!activeFile || !analyticsDraft.text.trim() || savingAnalytics) return;
    setSavingAnalytics(true);
    try {
      let metrics: Record<string, number | string> = {};
      const raw = analyticsDraft.metrics.trim();
      if (raw.startsWith("{")) {
        try { metrics = JSON.parse(raw); } catch { metrics = {}; }
      } else if (raw) {
        for (const pair of raw.split(/[,\n]/)) {
          const [k, v] = pair.split(/[:=]/).map((s) => (s || "").trim());
          if (!k || !v) continue;
          const num = Number(v.replace(/[, ]/g, ""));
          metrics[k] = Number.isFinite(num) && /^[\d., ]+$/.test(v) ? num : v;
        }
      }
      const res = await fetch(`/api/hermes/dna/${encodeURIComponent(activeFile)}/analytics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: analyticsDraft.source.trim() || "manual",
          text: analyticsDraft.text.trim(),
          metrics
        })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      setAnalyticsDraft({ source: analyticsDraft.source, text: "", metrics: "" });
      await refreshList();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAnalytics(false);
    }
  }, [activeFile, analyticsDraft, refreshList, savingAnalytics]);

  const handleDownload = useCallback(() => {
    if (!activeFile || !activeContent) return;
    const blob = new Blob([activeContent], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = activeFile;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [activeFile, activeContent]);

  const blockCountForActive = activeItem
    ? Math.min(24, Math.max(0, Math.round((activeItem.stats?.sizeBytes || 0) / 500)))
    : 0;
  const reusedEstimate = activeItem ? Math.min(24, blockCountForActive + Math.min(3, activeItem.analytics.length)) : 0;
  const estCost = Math.max(0, 0.248 * (1 - reusedEstimate / 24));
  const estSaved = Math.max(0, 0.248 - estCost);

  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", color: "var(--text)", display: "flex", flexDirection: "column" }}>
      {/* Topbar */}
      <header className="topbar" style={{ position: "relative", zIndex: 2, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.85rem 1.25rem", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <Link href="/" className="topbar-logo" style={{ display: "flex", alignItems: "center", gap: "0.6rem", textDecoration: "none" }}>
          <MuseMark variant="helix" fg="var(--acid)" bg="var(--bg)" size={32} />
          <span style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "1.2rem", letterSpacing: "-0.03em", textTransform: "uppercase", lineHeight: 1, color: "var(--text)" }}>
            MUSE<span style={{ color: "var(--acid)" }}>.DNA</span>
          </span>
        </Link>
        <nav className="topbar-nav" style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <Link href="/" style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", letterSpacing: "0.2em", color: "var(--text-dim)", textDecoration: "none" }}>HOME</Link>
          <Link href="/dna" style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", letterSpacing: "0.2em", color: "var(--acid)", textDecoration: "none" }}>DNA</Link>
          <Link href="/history" style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", letterSpacing: "0.2em", color: "var(--text-dim)", textDecoration: "none" }}>HISTORY</Link>
        </nav>
      </header>

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "320px 1fr", overflow: "hidden", paddingBottom: 36 }}>
        {/* LEFT — brand sidebar */}
        <aside style={{
          borderRight: "2px solid rgba(255,255,255,0.06)",
          padding: "1rem 0.85rem",
          overflow: "auto",
          background: "linear-gradient(180deg, rgba(198,245,31,0.04) 0%, transparent 100%)"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.85rem" }}>
            <div style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "0.95rem", color: "var(--acid)", letterSpacing: "-0.01em" }}>
              DNA ARCHIVE
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.22em", color: "var(--text-dim)", textTransform: "uppercase" }}>
              {filteredItems.length} BRAND{filteredItems.length === 1 ? "" : "S"}
            </div>
          </div>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="FILTER BRAND…"
            className="input"
            style={{ marginBottom: "0.85rem", fontSize: "0.7rem", padding: "0.5rem 0.65rem", letterSpacing: "0.08em" }}
          />
          {!loading && filteredItems.length === 0 && (
            <div style={{ padding: "0.7rem 0.5rem", fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: errorMsg ? "var(--red, #FF4D6A)" : "var(--text-dim)" }}>
              {errorMsg
                ? `⚠ Failed: ${errorMsg}`
                : items.length === 0 ? "No DNA files yet. Run a task to mint one." : "No brands match that filter."}
            </div>
          )}
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {filteredItems.map((it) => {
              const active = it.fileName === activeFile;
              const blocks = Math.min(24, Math.max(0, Math.round((it.stats?.sizeBytes || 0) / 500)));
              return (
                <button
                  key={it.fileName}
                  type="button"
                  onClick={() => setActiveFile(it.fileName)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: active ? "rgba(198,245,31,0.05)" : "rgba(12,14,19,0.85)",
                    border: active ? "2px solid var(--acid)" : "1px solid rgba(255,255,255,0.08)",
                    boxShadow: active ? "3px 3px 0 var(--acid)" : "none",
                    padding: "0.65rem 0.7rem",
                    cursor: "pointer",
                    color: "var(--text)",
                    transition: "background 140ms ease, border-color 140ms ease"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "0.85rem", color: active ? "var(--acid)" : "var(--text)", letterSpacing: "-0.01em", textTransform: "uppercase" }}>
                      {it.brandName || it.brandKey}
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", color: "var(--text-dim)" }}>
                      {fmtBytes(it.stats?.sizeBytes)}
                    </span>
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", color: "var(--text-dim)", marginTop: 2 }}>{it.fileName}</div>
                  <div style={{ display: "flex", gap: 5, marginTop: 6 }}>
                    <span style={{ padding: "0.1rem 0.35rem", border: "1px solid rgba(255,255,255,0.18)", fontFamily: "var(--font-mono)", fontSize: "0.5rem", letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--text-dim)" }}>
                      {blocks}/24 BLOCKS
                    </span>
                    <span style={{ padding: "0.1rem 0.35rem", border: "1px solid rgba(95,168,255,0.4)", fontFamily: "var(--font-mono)", fontSize: "0.5rem", letterSpacing: "0.16em", textTransform: "uppercase", color: "#5FA8FF", background: "rgba(95,168,255,0.06)" }}>
                      {it.analytics?.length || 0} FB
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* RIGHT — content + composer + timeline */}
        <div style={{ display: "grid", gridTemplateRows: "auto 1fr auto", overflow: "hidden", minWidth: 0 }}>
          {/* Brand header bar */}
          <div style={{ padding: "0.95rem 1.4rem", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.22em", color: "var(--text-dim)", textTransform: "uppercase", marginBottom: 4 }}>
              BRAND · {(activeItem?.brandName || "—").toUpperCase()} · DNA FILE
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: "0.85rem", flexWrap: "wrap" }}>
              <div style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "1.6rem", color: "var(--text)", letterSpacing: "-0.03em" }}>
                {(activeItem?.brandKey || "—")}<span style={{ color: "var(--acid)" }}>.dna</span>.md
              </div>
              <span style={{ padding: "0.18rem 0.55rem", border: "1px solid var(--acid)", color: "var(--acid)", background: "rgba(198,245,31,0.06)", fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.18em", textTransform: "uppercase" }}>
                {blockCountForActive}/24 BLOCKS MINTED
              </span>
              <span style={{ padding: "0.18rem 0.55rem", border: "1px solid rgba(255,255,255,0.18)", fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-dim)" }}>
                {activeItem?.analytics?.length || 0} FEEDBACK
              </span>
              <span style={{ padding: "0.18rem 0.55rem", border: "1px solid rgba(255,255,255,0.18)", fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-dim)" }}>
                UPDATED {fmtDate(activeItem?.stats?.modifiedAt).slice(0, 16)}
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                onClick={handleDownload}
                disabled={!activeContent}
                style={{
                  padding: "0.45rem 0.75rem",
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.18)",
                  color: "var(--text)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.62rem",
                  letterSpacing: "0.18em",
                  cursor: activeContent ? "pointer" : "not-allowed",
                  textTransform: "uppercase",
                  opacity: activeContent ? 1 : 0.4
                }}
              >
                ↗ DOWNLOAD .MD
              </button>
              <button
                type="button"
                onClick={refreshList}
                disabled={loading}
                style={{
                  padding: "0.45rem 0.75rem",
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.18)",
                  color: "var(--text)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.62rem",
                  letterSpacing: "0.18em",
                  cursor: loading ? "wait" : "pointer",
                  textTransform: "uppercase"
                }}
              >
                {loading ? "…" : "↻ REFRESH"}
              </button>
            </div>
          </div>

          {errorMsg && (
            <div style={{ padding: "0.6rem 1.4rem", borderBottom: "1px solid rgba(255,77,106,0.4)", background: "rgba(255,77,106,0.08)", color: "#FF8AA0", fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}>
              {errorMsg}
            </div>
          )}

          {/* Body — markdown left, composer + timeline right */}
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", overflow: "hidden", minHeight: 0 }}>
            {/* Markdown content */}
            <div style={{
              overflow: "auto",
              padding: "1.1rem 1.4rem",
              borderRight: "2px solid rgba(255,255,255,0.06)",
              background: "radial-gradient(ellipse at top left, rgba(198,245,31,0.03) 0%, transparent 50%)"
            }}>
              <pre style={{
                margin: 0,
                fontFamily: "var(--font-mono)",
                fontSize: "0.78rem",
                lineHeight: 1.7,
                color: "var(--text)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word"
              }}>
                {contentLoading ? "loading…" : (
                  (activeContent || "(empty)").split("\n").map((line, i) => {
                    const trimmed = line.trimStart();
                    if (line.startsWith("##")) {
                      return <div key={i} style={{ fontFamily: "var(--font-display-brand, var(--font-display))", color: "var(--acid)", fontSize: "0.95rem", letterSpacing: "-0.01em", marginTop: i === 0 ? 0 : "0.55rem" }}>{line}</div>;
                    }
                    if (line.startsWith("#")) {
                      return <div key={i} style={{ fontFamily: "var(--font-display-brand, var(--font-display))", color: "var(--acid)", fontSize: "1.1rem", letterSpacing: "-0.02em", marginTop: i === 0 ? 0 : "0.6rem" }}>{line}</div>;
                    }
                    if (line.startsWith(">")) {
                      return <div key={i} style={{ color: "var(--text-dim)" }}>{line}</div>;
                    }
                    if (trimmed.startsWith("-") || trimmed.startsWith("•")) {
                      return <div key={i}><span style={{ color: "var(--acid)" }}>·</span>{line.replace(/^(\s*)[-•]/, "$1")}</div>;
                    }
                    if (/^\s*\d+/.test(line)) {
                      return <div key={i} style={{ color: "#5FA8FF" }}>{line}</div>;
                    }
                    return <div key={i}>{line || " "}</div>;
                  })
                )}
              </pre>
            </div>

            {/* Composer + timeline */}
            <div style={{ display: "grid", gridTemplateRows: "auto 1fr", overflow: "hidden", background: "radial-gradient(ellipse at bottom right, rgba(95,168,255,0.04) 0%, transparent 50%)" }}>
              {/* Composer */}
              <div style={{ padding: "1rem 1.2rem", borderBottom: "1px solid rgba(255,255,255,0.08)", background: "rgba(12,14,19,0.6)", borderLeft: "3px solid #5FA8FF" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.22em", color: "#5FA8FF", textTransform: "uppercase", marginBottom: "0.6rem" }}>
                  + ATTACH POST ANALYTICS · SECONDARY
                </div>
                <div style={{ display: "grid", gap: "0.5rem" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                    <select
                      className="select"
                      value={analyticsDraft.source}
                      onChange={(e) => setAnalyticsDraft((d) => ({ ...d, source: e.target.value }))}
                      style={{ fontSize: "0.7rem", padding: "0.5rem 0.6rem", letterSpacing: "0.1em", textTransform: "uppercase" }}
                    >
                      <option value="twitter">SOURCE · TWITTER</option>
                      <option value="linkedin">SOURCE · LINKEDIN</option>
                      <option value="email">SOURCE · EMAIL</option>
                      <option value="manual">SOURCE · MANUAL</option>
                    </select>
                    <input
                      className="input"
                      placeholder="VIEWS=1200, LIKES=47…"
                      value={analyticsDraft.metrics}
                      onChange={(e) => setAnalyticsDraft((d) => ({ ...d, metrics: e.target.value }))}
                      style={{ fontSize: "0.7rem", padding: "0.5rem 0.6rem", letterSpacing: "0.05em" }}
                    />
                  </div>
                  <textarea
                    className="textarea"
                    rows={2}
                    placeholder="WHAT WORKED / DIDN'T?"
                    value={analyticsDraft.text}
                    onChange={(e) => setAnalyticsDraft((d) => ({ ...d, text: e.target.value.slice(0, 2000) }))}
                    style={{ fontSize: "0.78rem", padding: "0.5rem 0.6rem", minHeight: "4rem" }}
                  />
                  <button
                    type="button"
                    onClick={submitAnalytics}
                    disabled={!activeFile || !analyticsDraft.text.trim() || savingAnalytics}
                    style={{
                      background: savingAnalytics ? "rgba(95,168,255,0.4)" : "#5FA8FF",
                      color: "var(--bg)",
                      border: "2px solid var(--bg)",
                      padding: "0.65rem 0.95rem",
                      fontFamily: "var(--font-mono)",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.12em",
                      fontSize: "0.7rem",
                      boxShadow: "3px 3px 0 var(--bg)",
                      cursor: !activeFile || !analyticsDraft.text.trim() || savingAnalytics ? "not-allowed" : "pointer",
                      opacity: !analyticsDraft.text.trim() ? 0.5 : 1
                    }}
                  >
                    {savingAnalytics ? "ATTACHING…" : "→ ATTACH FEEDBACK"}
                  </button>
                </div>
              </div>

              {/* Timeline */}
              <div style={{ overflow: "auto", padding: "1rem 1.2rem" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.22em", color: "var(--text-dim)", textTransform: "uppercase", marginBottom: "0.7rem" }}>
                  FEEDBACK TIMELINE · {activeItem?.analytics.length ?? 0} ENTRIES
                </div>
                {(!activeItem || activeItem.analytics.length === 0) ? (
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text-dim)" }}>
                    No feedback attached yet. Add a note above to seed the next run.
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: "0.55rem" }}>
                    {activeItem.analytics.slice().reverse().slice(0, 10).map((entry) => {
                      const tone = sourceTone(entry.source);
                      return (
                        <div
                          key={entry.id}
                          style={{
                            border: "1px solid rgba(255,255,255,0.08)",
                            borderLeft: `3px solid ${tone}`,
                            padding: "0.65rem 0.75rem",
                            background: "rgba(12,14,19,0.7)"
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.18em", textTransform: "uppercase" }}>
                            <span style={{ color: tone }}>{entry.source}</span>
                            <span style={{ color: "var(--text-dim)" }}>{fmtDate(entry.capturedAt)}</span>
                          </div>
                          <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text)", lineHeight: 1.55, marginBottom: 6, whiteSpace: "pre-wrap" }}>
                            {entry.text}
                          </div>
                          {Object.keys(entry.metrics).length > 0 && (
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {Object.entries(entry.metrics).map(([k, v]) => (
                                <span
                                  key={k}
                                  style={{
                                    padding: "0.1rem 0.4rem",
                                    border: "1px solid rgba(255,255,255,0.12)",
                                    fontFamily: "var(--font-mono)",
                                    fontSize: "0.55rem",
                                    color: "var(--text-dim)",
                                    background: "rgba(0,0,0,0.4)"
                                  }}
                                >
                                  {k}={String(v)}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div style={{ padding: "0.65rem 1.4rem", borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.6rem" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", letterSpacing: "0.16em", color: "var(--text-dim)", textTransform: "uppercase" }}>
              NEXT RUN ON {(activeItem?.brandName || "—").toUpperCase()} REUSES <span style={{ color: "var(--acid)" }}>{reusedEstimate}/24 BLOCKS</span> · ESTIMATED COST <span style={{ color: "var(--acid)" }}>${estCost.toFixed(3)}</span> · SAVES <span style={{ color: "var(--acid)" }}>${estSaved.toFixed(3)}</span>
            </div>
            <Link
              href="/#task-flow"
              style={{
                background: "var(--acid)",
                color: "var(--bg)",
                border: "2px solid var(--bg)",
                padding: "0.55rem 0.95rem",
                fontFamily: "var(--font-display-brand, var(--font-display))",
                fontSize: "0.7rem",
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                boxShadow: "3px 3px 0 var(--bg)",
                textDecoration: "none"
              }}
            >
              ↗ START FROM THIS DNA
            </Link>
          </div>
        </div>
      </div>

      <BottomBar />
    </div>
  );
}
