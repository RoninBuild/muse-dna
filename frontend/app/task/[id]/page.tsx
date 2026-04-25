"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import LiveLedger from "@/components/LiveLedger";
import WalletLedger from "@/components/WalletLedger";
import { DnaChainStrip } from "@/components/DnaCanvas";
import { MuseMark } from "@/components/MuseMark";
import { BottomBar } from "@/components/BottomBar";
import HistorySidebar from "@/components/HistorySidebar";
import { useTaskLive, type LiveUnit } from "@/lib/useTaskLive";
import { useToast } from "@/components/ToastProvider";
import ArcBlockTicker from "@/components/ArcBlockTicker";
import CostSparkline from "@/components/CostSparkline";
import KeyboardHUD from "@/components/KeyboardHUD";

const SERVICE_COLORS: Record<string, string> = {
  strategy: "#C6F51F",
  search: "#5FA8FF",
  copy: "#FFD21A",
  image: "#FF6B9D"
};

const SERVICE_LABELS: Record<string, string> = {
  strategy: "Strategy DNA",
  search: "Search Signal",
  copy: "Copy Pulse",
  image: "Visual Frame"
};

function short(addr: string | null | undefined) {
  if (!addr) return "";
  return addr.length > 14 ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : addr;
}

function fmtSeconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function useTypingEffect(text: string | null, speed = 14) {
  const [displayed, setDisplayed] = useState("");
  useEffect(() => {
    if (!text) { setDisplayed(""); return; }
    setDisplayed("");
    let i = 0;
    const iv = setInterval(() => {
      i += Math.max(1, Math.floor(text.length / 400));
      setDisplayed(text.slice(0, i));
      if (i >= text.length) clearInterval(iv);
    }, speed);
    return () => clearInterval(iv);
  }, [text, speed]);
  return displayed;
}

/**
 * Fallback simulator: used only for `sim-*` taskIds that never touched the
 * backend. Walks a deterministic script so the demo feels the same.
 */
function useSimulatedRun(enabled: boolean, brandName: string) {
  const [units, setUnits] = useState<LiveUnit[]>([]);
  const [phase, setPhase] = useState<"idle" | "executing" | "completed">("idle");
  const [spent, setSpent] = useState(0);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const script: Array<Partial<LiveUnit> & { service: LiveUnit["service"]; unit: string; price: number; label: string; delay: number }> = [
      { service: "strategy", unit: "product-summary", price: 0.005, label: "Product Summary", delay: 350 },
      { service: "strategy", unit: "audience-primary", price: 0.005, label: "Primary Audience", delay: 380 },
      { service: "strategy", unit: "voice-pillars", price: 0.005, label: "Voice Pillars", delay: 420 },
      { service: "search", unit: "news-query", price: 0.004, label: "News Query", delay: 380 },
      { service: "search", unit: "market-signal", price: 0.004, label: "Market Signal", delay: 360 },
      { service: "copy", unit: "headline", price: 0.005, label: "Headline", delay: 420 },
      { service: "copy", unit: "hook-line", price: 0.005, label: "Hook Line", delay: 420 },
      { service: "copy", unit: "final-copy", price: 0.005, label: "Final Copy", delay: 600 },
      { service: "image", unit: "visual-brief", price: 0.006, label: "Visual Brief", delay: 380 },
      { service: "image", unit: "banner-render", price: 0.006, label: "Banner Render", delay: 1200 }
    ];

    let cancelled = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    setPhase("executing");
    setUnits(script.map((s) => ({
      service: s.service,
      unit: s.unit,
      label: s.label,
      price: s.price,
      status: "pending"
    })));

    (async () => {
      for (let i = 0; i < script.length; i += 1) {
        if (cancelled) return;
        // Hold the active timer so we can abort it on unmount — previously
        // the setTimeout callback still fired after navigation and leaked
        // setUnits / setSpent calls into a dead component.
        await new Promise<void>((resolve) => {
          pendingTimer = setTimeout(() => {
            pendingTimer = null;
            resolve();
          }, script[i].delay);
        });
        if (cancelled) return;
        const txHash = `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
        setUnits((prev) => {
          const next = [...prev];
          next[i] = {
            ...next[i],
            status: "validated",
            txHash,
            amountUsdc: script[i].price,
            arcUrl: `https://testnet.arcscan.app/tx/${txHash}`,
            network: "eip155:5042002"
          };
          return next;
        });
        setSpent((s) => Number((s + script[i].price).toFixed(4)));
      }
      if (!cancelled) {
        setPhase("completed");
        setText(
          `${brandName} turns creative work into a stream of USDC micro-checks.\n\n` +
            `Hermes memorized every strategy block. Arc Testnet settled each authorization.\n\n` +
            `Run it twice — the second campaign is cheaper by half.\n\n#Arc #USDC #Nous`
        );
      }
    })();

    return () => {
      cancelled = true;
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    };
  }, [enabled, brandName]);

  return { units, phase, spent, text };
}

const ARC_EXPLORER_BASE = process.env.NEXT_PUBLIC_ARC_EXPLORER_BASE || "https://testnet.arcscan.app";
function explorerAddress(addr: string) { return `${ARC_EXPLORER_BASE}/address/${addr}`; }

const DISPATCH_STATUS_STEPS = [
  "Loading Hermes memory",
  "Resolving DNA blocks",
  "Dispatching strategy agents",
  "Opening x402 channels",
  "Priming Circle Gateway",
  "Waiting for first micro-settlement"
];

export default function TaskExecutionPage() {
  const params = useParams<{ id: string }>();
  const taskId = params?.id;
  const { push } = useToast();
  const isSimulation = !taskId || taskId.startsWith("sim-");

  // Pull wallet + orchestrator addresses persisted by the landing page so the
  // topbar matches what the user saw before launching the task. Purely
  // cosmetic — no signing is done on this page.
  const [persistedMain, setPersistedMain] = useState<string | null>(null);
  const [persistedOrch, setPersistedOrch] = useState<string | null>(null);
  // Mirror the landing page's history sidebar — reads the same localStorage
  // key so expand/collapse state is consistent across pages.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  useEffect(() => {
    try {
      setPersistedMain(window.localStorage.getItem("muse.main_wallet"));
      setPersistedOrch(window.localStorage.getItem("muse.orch_wallet"));
      const stored = window.localStorage.getItem("muse.sidebar.open");
      if (stored !== null) setSidebarOpen(stored === "1");
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem("muse.sidebar.open", sidebarOpen ? "1" : "0"); } catch { /* ignore */ }
  }, [sidebarOpen]);

  // Pull simulation metadata written by the landing page if the task isn't real.
  const [simInfo, setSimInfo] = useState<{ prompt?: string; taskType?: string; brandName?: string; tier?: string } | null>(null);
  useEffect(() => {
    if (!taskId || !isSimulation) return;
    try {
      const raw = sessionStorage.getItem(`muse_sim_${taskId}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      // Validate shape — corrupted sessionStorage (quota error, foreign
      // extension, stale schema) must not flow untrusted fields into state.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        setSimInfo({
          prompt: typeof obj.prompt === "string" ? obj.prompt : undefined,
          taskType: typeof obj.taskType === "string" ? obj.taskType : undefined,
          brandName: typeof obj.brandName === "string" ? obj.brandName : undefined,
          tier: typeof obj.tier === "string" ? obj.tier : undefined
        });
      }
    } catch { /* ignore malformed / unavailable storage */ }
  }, [taskId, isSimulation]);

  const live = useTaskLive(isSimulation ? undefined : taskId, {
    onToast: (evt) => {
      push({
        tone: evt.tone,
        title: evt.title,
        body: evt.message,
        link: evt.arcUrl ? { href: evt.arcUrl, label: "Open on Arc" } : undefined
      });
    }
  });

  const sim = useSimulatedRun(isSimulation, simInfo?.brandName || "AutoCRM");

  const units = isSimulation ? sim.units : live.units;
  const phase = isSimulation ? sim.phase : live.phase;
  const totalSpent = isSimulation ? sim.spent : live.totalSpent;
  const plan = live.plan;
  const result = isSimulation
    ? { text: sim.text, imageUrl: null }
    : live.result;

  const brandName = plan?.brandName || simInfo?.brandName || "AutoCRM";
  const taskType = simInfo?.taskType || "twitter_post";

  const totalUnits = units.length || plan?.totalUnits || 10;
  const completedCount = useMemo(() => units.filter((u) => u.status === "validated").length, [units]);
  const reusedCount = useMemo(() => units.filter((u) => u.status === "reused").length, [units]);
  const failedCount = useMemo(() => units.filter((u) => u.status === "failed").length, [units]);
  const strategyBlocks = useMemo(() => units.filter((u) => u.service === "strategy").length, [units]);
  const strategyBuilt = useMemo(() => units.filter((u) => u.service === "strategy" && u.status === "validated").length, [units]);
  const events = isSimulation ? [] : live.events;

  // Typing animation for generated copy
  const typed = useTypingEffect(result?.text || null, 10);

  // Confetti burst on task:completed. `confettiFired` makes sure we spawn
  // the dots exactly once per phase transition and that any timers we
  // queued are cleared when the component unmounts so no stray dots hang
  // around in the DOM.
  const confettiRef = useRef<HTMLDivElement>(null);
  const confettiFired = useRef(false);
  const confettiTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(() => {
    if (phase !== "completed") {
      confettiFired.current = false;
      return;
    }
    if (confettiFired.current || !confettiRef.current) return;
    confettiFired.current = true;

    const host = confettiRef.current;
    const bits = 24;
    for (let i = 0; i < bits; i += 1) {
      const dot = document.createElement("span");
      const angle = (i / bits) * Math.PI * 2 + Math.random() * 0.3;
      const dist = 120 + Math.random() * 140;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      dot.style.cssText = `position:absolute;left:50%;top:50%;width:${6 + Math.random() * 6}px;height:${6 + Math.random() * 6}px;background:${i % 3 === 0 ? "#C6F51F" : i % 3 === 1 ? "#FFD21A" : "#F2F1EC"};border-radius:${i % 2 === 0 ? 0 : 50}%;pointer-events:none;transform:translate(-50%,-50%);animation:muse-confetti-fly 1100ms cubic-bezier(0.2,0.8,0.2,1) forwards;--dx:${dx}px;--dy:${dy}px;z-index:2;`;
      host.appendChild(dot);
      const t = setTimeout(() => dot.remove(), 1400);
      confettiTimers.current.push(t);
    }
  }, [phase]);

  useEffect(() => () => {
    for (const t of confettiTimers.current) clearTimeout(t);
    confettiTimers.current = [];
  }, []);

  const connectBadge = live.connected ? "LIVE" : isSimulation ? "SIM" : "OFFLINE";

  // "Hermes is dispatching agents" rotating text for the initial window
  // between task creation and the first settled micro-payment. Without this,
  // a real backend run looks frozen — the user sees 0/10 and nothing moving.
  const isDispatching = phase !== "completed" && phase !== "failed" && completedCount === 0;
  const [dispatchStepIdx, setDispatchStepIdx] = useState(0);
  useEffect(() => {
    if (!isDispatching) { setDispatchStepIdx(0); return; }
    const id = setInterval(() => setDispatchStepIdx((i) => i + 1), 1800);
    return () => clearInterval(id);
  }, [isDispatching]);
  const dispatchStatus = DISPATCH_STATUS_STEPS[dispatchStepIdx % DISPATCH_STATUS_STEPS.length];

  function shortAddr(a: string) { return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a; }

  // Copy-to-clipboard feedback state: briefly flashes "✓ COPIED" on the
  // button so the user sees the action succeeded without pulling up a toast.
  const [copied, setCopied] = useState(false);
  const handleCopyText = async () => {
    const text = result?.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Fallback for rare browsers (mostly safe to ignore — modern Chromium
      // always has the async clipboard API on https / localhost).
    }
  };
  // Twitter Web Intent — opens the official tweet composer pre-filled with
  // the generated copy + #Muse hashtag. No API key, no OAuth, no backend
  // round trip. The user reviews and posts from their own account.
  const handlePublishToTwitter = () => {
    const text = result?.text;
    if (!text) return;
    // Twitter caps tweets at 280 chars including the hashtag (8 chars
    // including space). Trim the body so the URL builder doesn't have to.
    const HASHTAG = " #Muse";
    const maxBody = 280 - HASHTAG.length;
    const body = text.length > maxBody ? `${text.slice(0, maxBody - 1).trimEnd()}…` : text;
    const tweet = `${body}${HASHTAG}`;
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };
  // Download image via a temporary anchor. We fetch the bytes first so the
  // remote server's Content-Disposition doesn't open a new tab instead of
  // saving the file when the remote is cross-origin.
  const [downloading, setDownloading] = useState(false);
  const handleDownloadImage = async () => {
    const url = result?.imageUrl;
    if (!url) return;
    setDownloading(true);
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      const extMatch = /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.exec(url);
      const ext = extMatch ? extMatch[1] : "png";
      a.download = `${brandName || "muse"}-banner.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch {
      // Fallback — open in new tab so the user can right-click save.
      window.open(url, "_blank", "noopener");
    } finally {
      setDownloading(false);
    }
  };

  return (
    // No `zoom` here — it made this page render ~18% smaller than the
    // landing, which read as "different website" across navigation. Density
    // is now controlled by spacing/padding so every page uses the same type
    // scale.
    <div style={{ background: "var(--bg)", minHeight: "100vh", color: "var(--text)" }}>
      <header className="topbar" style={{
        padding: "0.8rem 1.2rem",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem"
      }}>
        <Link href="/" className="topbar-logo" style={{ display: "flex", alignItems: "center", gap: "0.55rem", textDecoration: "none", color: "var(--text)" }}>
          <MuseMark variant="helix" fg="var(--acid)" bg="var(--bg)" size={28} />
          <span style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "1rem", letterSpacing: "-0.03em", textTransform: "uppercase" }}>
            MUSE<span style={{ color: "var(--acid)" }}>.DNA</span>
          </span>
        </Link>
        <nav style={{ display: "flex", alignItems: "center", gap: "0.7rem", flexWrap: "wrap" }}>
          <ArcBlockTicker />
          {persistedOrch && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", padding: "0.28rem 0.5rem", border: "1px solid rgba(198,245,31,0.28)", background: "rgba(198,245,31,0.04)" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.22em", color: "var(--text-dim)" }}>ORCH</span>
              <a href={explorerAddress(persistedOrch)} target="_blank" rel="noopener noreferrer" style={{ color: "var(--acid)", fontFamily: "var(--font-mono)", fontSize: "0.7rem", textDecoration: "none" }}>
                {shortAddr(persistedOrch)} ↗
              </a>
            </div>
          )}
          {persistedMain && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", padding: "0.28rem 0.5rem", border: "1px solid rgba(198,245,31,0.5)" }}>
              <span className="wallet-dot" />
              <a href={explorerAddress(persistedMain)} target="_blank" rel="noopener noreferrer" style={{ color: "var(--acid)", fontFamily: "var(--font-mono)", fontSize: "0.7rem", textDecoration: "none" }}>
                {shortAddr(persistedMain)} ↗
              </a>
            </div>
          )}
          <Link href="/" className="topbar-link" style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", letterSpacing: "0.2em", color: "var(--text-dim)", textDecoration: "none" }}>HOME</Link>
          <Link href="/dna" className="topbar-link" style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", letterSpacing: "0.2em", color: "var(--acid)", textDecoration: "none" }}>DNA</Link>
          <Link href="/history" className="topbar-link" style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", letterSpacing: "0.2em", color: "var(--text-dim)", textDecoration: "none" }}>HISTORY</Link>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              letterSpacing: "0.2em",
              padding: "0.2rem 0.5rem",
              border: `1px solid ${live.connected ? "var(--acid)" : "rgba(255,255,255,0.15)"}`,
              color: live.connected ? "var(--acid)" : "var(--text-dim)",
              background: live.connected ? "rgba(198,245,31,0.08)" : "transparent"
            }}
          >
            {connectBadge} · {phase.toUpperCase()}
          </span>
        </nav>
      </header>

      <div style={{ display: "flex", alignItems: "stretch", minHeight: "calc(100vh - 64px)" }}>
        {persistedMain && (
          <HistorySidebar open={sidebarOpen} onToggle={() => setSidebarOpen((v) => !v)} />
        )}
        <main style={{ flex: 1, minWidth: 0 }}>
      {/* Breadcrumb chip row — matches design: ~/TASKS/<id> [TIER] [N AGENTS] [TASK TYPE] · timestamps */}
      <div style={{
        maxWidth: 1200,
        margin: "0 auto",
        padding: "0.5rem 1.2rem",
        display: "flex",
        alignItems: "center",
        gap: "0.6rem",
        flexWrap: "wrap",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        fontFamily: "var(--font-mono)",
        fontSize: "0.68rem"
      }}>
        <span style={{ color: "var(--text-dim)", letterSpacing: "0.12em" }}>~/TASKS/</span>
        <span style={{ color: "var(--acid)" }}>{taskId ? short(taskId) : ""}</span>
        <span style={{ color: "rgba(255,255,255,0.18)" }}>·</span>
        <span style={{
          padding: "0.18rem 0.55rem",
          background: "var(--acid)",
          color: "var(--bg)",
          fontSize: "0.58rem",
          letterSpacing: "0.18em",
          fontWeight: 700,
          textTransform: "uppercase"
        }}>
          {plan?.tierMeta?.label || plan?.tier?.toUpperCase() || (simInfo?.tier?.toUpperCase()) || "BALANCED"}
        </span>
        <span style={{
          padding: "0.18rem 0.55rem",
          border: "1px solid rgba(255,255,255,0.18)",
          color: "var(--text-dim)",
          fontSize: "0.58rem",
          letterSpacing: "0.18em",
          textTransform: "uppercase"
        }}>
          {(Array.isArray(live.agentWallets) && live.agentWallets.length > 0 ? live.agentWallets.length : 4)} AGENTS
        </span>
        <span style={{
          padding: "0.18rem 0.55rem",
          border: "1px solid rgba(255,255,255,0.18)",
          color: "var(--text-dim)",
          fontSize: "0.58rem",
          letterSpacing: "0.18em",
          textTransform: "uppercase"
        }}>
          {taskType.replace(/_/g, " ")}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--text-dim)", letterSpacing: "0.08em" }}>
          {connectBadge} · {phase.toUpperCase()}
        </span>
      </div>

      <section className="container mt-2" style={{ maxWidth: 1200, margin: "0 auto", padding: "1.2rem" }}>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", letterSpacing: "0.25em", color: "var(--text-dim)" }}>
              TASK · {taskId ? short(taskId) : ""}
            </div>
            <h1 style={{
              fontFamily: "var(--font-display-brand, var(--font-display))",
              fontSize: "clamp(1.5rem, 4vw, 2.4rem)",
              letterSpacing: "-0.04em",
              margin: "0.35rem 0 0",
              textTransform: "uppercase",
              lineHeight: 1
            }}>
              {brandName} <span style={{ background: "var(--acid)", color: "var(--bg)", padding: "0 0.3rem" }}>swarm</span>
            </h1>
            <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.4rem", maxWidth: 680 }}>
              {simInfo?.prompt || plan?.brandName ? `${plan?.tierMeta?.label || plan?.tier?.toUpperCase() || "DEEP"} tier · ${taskType.replace(/_/g, " ")}` : ""}
            </p>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
            {/* `AGENTS` = number of fresh EVM wallets the orchestrator
                deployed for THIS task (4-15 per Hermes/microeconomy plan).
                Falls back to 4 (the four service roles) until the
                `task:wallets_deployed` socket event lands so the chip is
                never empty during the planning phase. `ACTIONS` = number
                of paid micro-tasks dispatched across them. */}
            <StatChip
              label="AGENTS"
              value={String(Array.isArray(live.agentWallets) && live.agentWallets.length > 0 ? live.agentWallets.length : 4)}
            />
            <StatChip label="ACTIONS" value={`${completedCount}/${totalUnits}`} />
            <StatChip label="USDC SPENT" value={`$${totalSpent.toFixed(4)}`} accent />
            <StatChip label="DNA BLOCKS" value={`${strategyBuilt}/${strategyBlocks || (plan?.dnaBlocksTotal || 24)}`} />
          </div>
        </div>
        <div style={{
          marginTop: "0.8rem",
          height: 6,
          background: "rgba(255,255,255,0.06)",
          position: "relative",
          overflow: "hidden"
        }}>
          {isDispatching ? (
            <div className="muse-progress-indeterminate" aria-label="Dispatching agents" />
          ) : (
            <div style={{
              width: `${Math.min(100, (completedCount / Math.max(1, totalUnits)) * 100)}%`,
              height: "100%",
              background: "var(--acid)",
              boxShadow: "0 0 14px var(--acid-glow-strong)",
              transition: "width 520ms cubic-bezier(0.22, 1, 0.36, 1)"
            }} />
          )}
        </div>
        {isDispatching && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: "0.6rem", fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-dim)" }}>
            <span className="hermes-think-dot" aria-hidden="true" />
            <span>
              HERMES · {dispatchStatus}
              <span className="hermes-think-ellipsis">…</span>
            </span>
          </div>
        )}

        {Array.isArray(live.agentWallets) && live.agentWallets.length > 0 && (
          <div style={{
            marginTop: "0.9rem",
            border: "1px solid rgba(198,245,31,0.22)",
            background: "rgba(198,245,31,0.04)",
            padding: "0.55rem 0.75rem"
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, flexWrap: "wrap", gap: "0.4rem" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.22em", color: "var(--acid)", fontWeight: 700 }}>
                AGENT SWARM · {live.agentWallets.length} WALLETS
                {live.agentWalletsPerService && (
                  <span style={{ color: "var(--text-dim)", marginLeft: 8, fontWeight: 500 }}>
                    {Object.entries(live.agentWalletsPerService).map(([s, n]) => `${n} ${s}`).join(" · ")}
                  </span>
                )}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.35rem" }}>
              {live.agentWallets.map((w) => (
                <a
                  key={`${w.service}-${w.index}-${w.address}`}
                  href={explorerAddress(w.address)}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    padding: "0.35rem 0.55rem",
                    border: "1px solid rgba(255,255,255,0.08)",
                    textDecoration: "none",
                    background: "rgba(0,0,0,0.25)"
                  }}
                >
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.5rem", letterSpacing: "0.2em", color: "var(--text-dim)", fontWeight: 700, textTransform: "uppercase" }}>
                    {w.service}#{w.index + 1}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--acid)", marginTop: 1 }}>
                    {shortAddr(w.address)} ↗
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="container muse-task-grid" style={{
        maxWidth: 1200,
        margin: "0 auto",
        padding: "0.5rem 1.2rem 2rem",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 320px",
        gap: "1rem"
      }}>
        <div style={{ position: "relative", minWidth: 0 }} ref={confettiRef}>
          {/* Per-wallet card view is the primary narrative — one card per
              fresh EVM wallet, units nested under the wallet that earned
              them. The flat chrono ledger underneath is hidden behind a
              disclosure so the page reads cleanly; judges who want a raw
              tx feed expand it explicitly. */}
          <WalletLedger
            units={units}
            wallets={Array.isArray(live.agentWallets) ? live.agentWallets : []}
            emptyHint={isSimulation ? "Spawning simulated agent swarm…" : "Waiting for Hermes to dispatch agents…"}
          />
          <details style={{ marginTop: "1rem" }}>
            <summary
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.7rem",
                letterSpacing: "0.18em",
                color: "var(--text-dim)",
                cursor: "pointer",
                padding: "0.4rem 0.6rem",
                border: "1px dashed rgba(255,255,255,0.08)",
                userSelect: "none"
              }}
            >
              ⌄ SHOW CHRONO LEDGER · raw tx feed
            </summary>
            <div style={{ marginTop: "0.5rem" }}>
              <LiveLedger units={units} emptyHint={isSimulation ? "Spawning simulated agent swarm…" : "Waiting for Hermes to dispatch agents…"} />
            </div>
          </details>

          {result && (result.text || result.imageUrl) && (
            <div style={{
              marginTop: "1rem",
              padding: "1.1rem 1.2rem",
              background: "#07090c",
              border: "1px solid var(--acid)",
              boxShadow: "4px 4px 0 rgba(198,245,31,0.28)",
              position: "relative"
            }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.58rem", letterSpacing: "0.25em", color: "var(--text-dim)" }}>
                OUTPUT
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: "1rem", marginTop: "0.7rem" }}>
                {result.text && (
                  <div style={{
                    background: "var(--bg)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    padding: "0.9rem 1rem 0.9rem 1rem",
                    whiteSpace: "pre-wrap",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.82rem",
                    lineHeight: 1.55,
                    color: "var(--text)",
                    position: "relative",
                    overflow: "hidden"
                  }}>
                    <div style={{ position: "absolute", top: 8, right: 8, display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.2em", color: "var(--text-dim)" }}>
                        {(typed || "").length}/{(result.text || "").length}
                      </span>
                      <button
                        type="button"
                        onClick={handleCopyText}
                        title="Copy to clipboard"
                        aria-label="Copy output text"
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "0.58rem",
                          letterSpacing: "0.18em",
                          padding: "4px 8px",
                          background: copied ? "var(--acid)" : "transparent",
                          color: copied ? "var(--bg)" : "var(--acid)",
                          border: "1px solid rgba(198,245,31,0.55)",
                          cursor: "pointer",
                          textTransform: "uppercase",
                          transition: "background 160ms ease, color 160ms ease"
                        }}
                      >
                        {copied ? "✓ COPIED" : "⎘ COPY"}
                      </button>
                      {/* One-click publish — opens Twitter's official intent
                          composer with the post + #Muse hashtag pre-filled.
                          User reviews and posts from their own account; we
                          don't store or proxy any tweet content. */}
                      <button
                        type="button"
                        onClick={handlePublishToTwitter}
                        title="Publish to Twitter with #Muse"
                        aria-label="Publish to Twitter"
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "0.58rem",
                          letterSpacing: "0.18em",
                          padding: "4px 8px",
                          background: "transparent",
                          color: "#5FA8FF",
                          border: "1px solid rgba(95,168,255,0.55)",
                          cursor: "pointer",
                          textTransform: "uppercase",
                          transition: "background 160ms ease, color 160ms ease"
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "#5FA8FF"; e.currentTarget.style.color = "var(--bg)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#5FA8FF"; }}
                      >
                        ↗ PUBLISH · X
                      </button>
                    </div>
                    <div style={{ marginTop: 20 }}>
                      {typed || " "}
                      {typed && typed.length < (result.text || "").length && (
                        <span style={{ display: "inline-block", width: "0.5ch", background: "var(--acid)", marginLeft: 2, animation: "muse-caret-blink 800ms steps(2) infinite" }}>&nbsp;</span>
                      )}
                    </div>
                  </div>
                )}
                {/* URL scheme allowlist before render — blocks `javascript:`,
                    `file://`, `data:` other than images, and any other scheme
                    that browsers would treat as a script execution context.
                    The agent stack should only ever produce https/data:image/*
                    URLs, so anything else is either a misbehaving model or
                    a poisoned response we don't want to render. */}
                {result.imageUrl && /^(https?:\/\/|data:image\/)/i.test(String(result.imageUrl)) && (
                  <div style={{ display: "block", border: "1px solid rgba(255,255,255,0.1)", background: "#0A0A0A", overflow: "hidden", aspectRatio: "1.5", position: "relative" }}>
                    <a
                      href={result.imageUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="Open banner in new tab"
                      style={{ display: "block", width: "100%", height: "100%" }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={result.imageUrl} alt="Generated banner" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    </a>
                    <span style={{ position: "absolute", top: 8, left: 10, fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.2em", color: "var(--acid)", background: "rgba(10,10,10,0.6)", padding: "2px 6px" }}>
                      BANNER · FLUX
                    </span>
                    <button
                      type="button"
                      onClick={handleDownloadImage}
                      disabled={downloading}
                      title="Download banner"
                      aria-label="Download banner"
                      style={{
                        position: "absolute",
                        top: 8,
                        right: 8,
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.58rem",
                        letterSpacing: "0.18em",
                        padding: "4px 8px",
                        background: "rgba(10,10,10,0.75)",
                        color: "var(--acid)",
                        border: "1px solid rgba(198,245,31,0.55)",
                        cursor: downloading ? "wait" : "pointer",
                        textTransform: "uppercase",
                        transition: "background 160ms ease, color 160ms ease"
                      }}
                      onMouseEnter={(e) => { if (!downloading) { e.currentTarget.style.background = "var(--acid)"; e.currentTarget.style.color = "var(--bg)"; } }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(10,10,10,0.75)"; e.currentTarget.style.color = "var(--acid)"; }}
                    >
                      {downloading ? "…" : "⭳ DOWNLOAD"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT RAIL */}
        <aside style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <Panel label="DNA BUILD">
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text-dim)" }}>
              {live.dna.fileName || "(pending)"}
            </div>
            <div style={{ marginTop: "0.4rem", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
              {strategyBuilt} / {strategyBlocks || (plan?.dnaBlocksTotal || 24)} blocks minted
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 3, marginTop: "0.6rem" }}>
              {Array.from({ length: Math.max(strategyBlocks, plan?.dnaBlocksTotal || 24) }).map((_, i) => (
                <span
                  key={i}
                  style={{
                    height: 10,
                    background: i < strategyBuilt ? "var(--acid)" : "rgba(255,255,255,0.06)",
                    boxShadow: i < strategyBuilt ? "0 0 8px var(--acid-glow)" : "none",
                    transition: "background 300ms ease"
                  }}
                />
              ))}
            </div>
          </Panel>

          <Panel label="CYCLE RECEIPT">
            <Row label="Blueprint units" value={String(plan?.totalUnits || totalUnits)} />
            <Row label="Paid this run" value={String(completedCount)} accent />
            <Row label="Reused from DNA" value={String(reusedCount)} />
            <Row label="Failed" value={String(failedCount)} tone={failedCount > 0 ? "danger" : undefined} />
            <hr style={{ border: "none", borderTop: "1px dashed rgba(255,255,255,0.15)", margin: "0.5rem 0" }} />
            <Row label="Estimated" value={`$${Number(plan?.estimatedCost || 0).toFixed(4)}`} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.4rem" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", letterSpacing: "0.15em", color: "var(--text-dim)" }}>TOTAL SPENT</span>
              <span style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "1.2rem", background: "var(--acid)", color: "var(--bg)", padding: "0.1rem 0.4rem" }}>
                ${totalSpent.toFixed(4)}
              </span>
            </div>
          </Panel>

          {/* MARGIN PROOF — the math judges care about. $0.005/action × N
              vs ETH gas $2.50/tx × N = ~500× margin via Arc batch settle. */}
          <Panel label="MARGIN PROOF">
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text)", lineHeight: 1.7 }}>
              <span style={{ color: "var(--acid)" }}>$0.005</span>/action × {totalUnits} = <span style={{ color: "var(--acid)" }}>${(0.005 * totalUnits).toFixed(3)}</span>
              <br />
              ETH gas: <span style={{ color: "var(--red)" }}>$2.50</span>/tx × {totalUnits} = <span style={{ color: "var(--red)" }}>${(2.5 * totalUnits).toFixed(0)}</span>
              <div style={{ marginTop: "0.5rem", fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "1rem", color: "var(--acid)", letterSpacing: "-0.02em" }}>
                500× MARGIN
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--text-dim)", marginTop: 4 }}>
                amortized via arc batch settle.
              </div>
            </div>
          </Panel>

          <Panel label="EVENT STREAM" style={{ flex: 1 }}>
            <div style={{ maxHeight: 280, overflowY: "auto", fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}>
              {events.length === 0 && <div style={{ color: "var(--text-dim)" }}>// awaiting orchestrator events…</div>}
              {events.slice(-40).reverse().map((e) => (
                <div key={e.id} style={{
                  padding: "0.3rem 0",
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                  color:
                    e.tone === "success" ? "var(--acid)" :
                    e.tone === "warning" ? "var(--yellow)" :
                    e.tone === "danger" ? "var(--red)" : "var(--text)"
                }}>
                  <span style={{ color: "var(--text-dim)", marginRight: "0.4rem" }}>
                    {new Date(e.at).toISOString().slice(11, 19)}
                  </span>
                  <strong style={{ marginRight: 4 }}>{e.title}</strong>
                  {e.message}
                  {e.arcUrl && (
                    <>
                      {" "}
                      <a href={e.arcUrl} target="_blank" rel="noreferrer" style={{ color: "var(--acid)", textDecoration: "underline" }}>arc↗</a>
                    </>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        </aside>
      </section>
        </main>
      </div>

      <KeyboardHUD />

      <div style={{ position: "fixed", bottom: 14, left: 14, zIndex: 30, padding: "0.55rem 0.75rem", background: "rgba(5,5,8,0.92)", border: "1px solid rgba(255,255,255,0.1)" }}>
        <CostSparkline spentUsdc={totalSpent} width={200} height={40} />
      </div>

      <DnaChainStrip />
      <BottomBar />

      <style jsx global>{`
        @keyframes muse-confetti-fly {
          from { transform: translate(-50%, -50%) scale(0.4); opacity: 1; }
          to   { transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(1); opacity: 0; }
        }
        @keyframes muse-caret-blink {
          50% { opacity: 0; }
        }
        @media (max-width: 900px) {
          .muse-task-grid {
            grid-template-columns: minmax(0, 1fr) !important;
          }
        }
      `}</style>
    </div>
  );
}

function StatChip({ label, value, accent = false, tone }: { label: string; value: string; accent?: boolean; tone?: "danger" }) {
  const color = tone === "danger" ? "var(--red)" : accent ? "var(--acid)" : "var(--text)";
  return (
    <div style={{
      border: `1px solid ${tone === "danger" ? "var(--red)" : "rgba(255,255,255,0.12)"}`,
      background: tone === "danger" ? "rgba(255,53,87,0.1)" : "rgba(255,255,255,0.03)",
      padding: "0.4rem 0.7rem"
    }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.2em", color: "var(--text-dim)" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color, fontSize: "0.85rem" }}>{value}</div>
    </div>
  );
}

function Row({ label, value, accent = false, tone }: { label: string; value: string; accent?: boolean; tone?: "danger" }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0", fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={{ color: tone === "danger" ? "var(--red)" : accent ? "var(--acid)" : "var(--text)", fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

function Panel({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      padding: "0.9rem 1rem",
      background: "#07090c",
      border: "1px solid rgba(255,255,255,0.08)",
      ...style
    }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.25em", color: "var(--text-dim)", marginBottom: "0.5rem" }}>
        {label}
      </div>
      {children}
    </div>
  );
}
