"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { DnaCursorTrail, DnaChainStrip } from "@/components/DnaCanvas";
import VariantSelector from "@/components/VariantSelector";
import HermesChat from "@/components/HermesChat";
import HackathonProofPanels from "@/components/HackathonProofPanels";
import { DnaHeadline, DnaHelix, DnaRailBackdrop, MuseMark } from "@/components/MuseMark";
import { BottomBar, CornerTick } from "@/components/BottomBar";
import ArcBlockTicker from "@/components/ArcBlockTicker";
import CostSparkline from "@/components/CostSparkline";
import KeyboardHUD from "@/components/KeyboardHUD";
import HistorySidebar from "@/components/HistorySidebar";
import type { CumulativeMetrics, VariantPlanResponse, VariantTier } from "@/lib/types";

const ARC_EXPLORER_BASE = process.env.NEXT_PUBLIC_ARC_EXPLORER_BASE || "https://testnet.arcscan.app";
const ARC_CHAIN_ID_DEC = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID || 5042002);
const ARC_CHAIN_ID_HEX = `0x${ARC_CHAIN_ID_DEC.toString(16)}`;
const ARC_RPC_URL = process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://rpc.testnet.arc.network";
function explorerAddress(addr: string) { return `${ARC_EXPLORER_BASE}/address/${addr}`; }
function explorerTx(hash: string) { return `${ARC_EXPLORER_BASE}/tx/${hash}`; }

const TASK_TYPES = [
  { value: "twitter_post", label: "TWITTER POST", units: 44, cost: 0.232 },
  { value: "email_campaign", label: "EMAIL CAMPAIGN", units: 52, cost: 0.274 },
  { value: "banner", label: "BANNER", units: 38, cost: 0.198 },
  { value: "full_kit", label: "FULL KIT", units: 68, cost: 0.356 },
];

// Lite-tier floor across the supported tiers. The hero EXECUTE button used
// to gate on the BALANCED-tier estimate (selectedTask.cost), which blocked
// users who only had enough USDC for `lite` (~$0.09). Hermes picks the
// actual tier on /api/tasks/plan; the rigorous pre-flight runs server-side
// when the user confirms the variant. So gating EXECUTE on the cheapest
// tier the orchestrator could possibly run is the right cut.
const MIN_TIER_COST_USDC = 0.09;

function short(a: string | null | undefined) {
  if (!a || typeof a !== "string" || a.length < 10) return "—";
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}
function mockTaskId() { return `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

export default function LandingPage() {
  const [mainWallet, setMainWallet] = useState<string | null>(null);
  const [mainBalance, setMainBalance] = useState("—");
  const [orchWallet, setOrchWallet] = useState<string | null>(null);
  const [orchBalance, setOrchBalance] = useState(0);
  const [orchMode, setOrchMode] = useState<"self-managed" | "circle" | "mock" | null>(null);
  const [orchWithdrawEnabled, setOrchWithdrawEnabled] = useState(false);
  const [orchDeployed, setOrchDeployed] = useState(false);
  const [deployingOrch, setDeployingOrch] = useState(false);
  const [lastFundTx, setLastFundTx] = useState<string | null>(null);
  const [lastWithdrawTx, setLastWithdrawTx] = useState<string | null>(null);
  // Short-lived "✓ SENT · VIEW TX" button flash right after a successful
  // transfer. Cleared on a timer so the action button returns to its normal
  // FUND / SEND state and the user can fire another transfer.
  const [fundFlashTx, setFundFlashTx] = useState<string | null>(null);
  const [withdrawFlashTx, setWithdrawFlashTx] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [fundingAmount, setFundingAmount] = useState("2.00");
  const [funding, setFunding] = useState(false);
  const [refreshingOrch, setRefreshingOrch] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawUseMax, setWithdrawUseMax] = useState(false);
  const [gasReserveEstimate, setGasReserveEstimate] = useState<number | null>(null);
  const [prompt, setPrompt] = useState("");
  const [brandName, setBrandName] = useState("");
  const [taskType, setTaskType] = useState("twitter_post");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [variantPlan, setVariantPlan] = useState<VariantPlanResponse | null>(null);
  const [pendingTier, setPendingTier] = useState<VariantTier | null>(null);
  const [metrics, setMetrics] = useState<CumulativeMetrics | null>(null);
  const [hermesOpen, setHermesOpen] = useState(false);
  const [orchWalletPopoverOpen, setOrchWalletPopoverOpen] = useState(false);
  const [thinkingStepIdx, setThinkingStepIdx] = useState(0);
  // Sidebar open/collapsed state — persisted in localStorage so the user's
  // preferred layout sticks across navigations and reloads.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("muse.sidebar.open");
      if (stored !== null) setSidebarOpen(stored === "1");
    } catch { /* storage disabled */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem("muse.sidebar.open", sidebarOpen ? "1" : "0"); } catch { /* ignore */ }
  }, [sidebarOpen]);

  // Persist the active wallet + orchestrator pair so downstream pages
  // (/task/[id], /history) can render the same topbar context without
  // triggering another MetaMask prompt.
  //
  // IMPORTANT: only WRITE on truthy values. Previously this effect removed
  // the cache whenever `mainWallet === null`, which included the very first
  // render on every page mount (useState default is null). That wiped the
  // stored address before the rehydrate-on-mount effect below could read
  // it, so navigating back to `/` always showed the "CONNECT WALLET" state.
  // Explicit removal now lives in `disconnectWallet` where it belongs.
  useEffect(() => {
    if (!mainWallet) return;
    try { window.localStorage.setItem("muse.main_wallet", mainWallet); } catch { /* ignore */ }
  }, [mainWallet]);
  useEffect(() => {
    if (!orchWallet) return;
    try { window.localStorage.setItem("muse.orch_wallet", orchWallet); } catch { /* ignore */ }
  }, [orchWallet]);

  const selectedTask = TASK_TYPES.find(t => t.value === taskType) || TASK_TYPES[0];
  // Compare in micro-USDC integer units so an on-chain balance that reads back
  // as 0.23199999 via JSON parse doesn't get rejected against a 0.232 task
  // cost. Before: `orchBalance >= selectedTask.cost` would occasionally fail
  // for a wallet that was funded to exactly the right penny.
  const toMicroUsdc = (v: number) => Math.round(v * 1_000_000);
  // Gate on lite-tier floor, not on the BALANCED-tier estimate of the
  // currently-selected task type. Hermes will pick the actual tier in
  // /api/tasks/plan, and the server-side pre-flight inside `runTask`
  // catches insufficient balance with a precise top-up CTA — so the
  // hero button's job is just "do you have ENOUGH for the cheapest run?".
  const hasOrchFunds = toMicroUsdc(orchBalance) >= toMicroUsdc(MIN_TIER_COST_USDC);
  // Agents are no longer a separate "deploy" step — they spin up automatically
  // once the user picks a variant, streaming as nanopayments. So canExecute
  // only needs: connected wallet + funded orchestrator + non-empty prompt.
  const canExecute = mainWallet && hasOrchFunds && prompt.trim() && !submitting && !planning;

  // ⌘K → Hermes, Esc → close Hermes drawer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setHermesOpen((v) => !v);
      }
      if (e.key === "Escape") { setHermesOpen(false); setOrchWalletPopoverOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ChatGPT-style rotating status while Hermes plans. Cycles every 1.6s so the
  // user sees progress instead of a frozen button. Resets when planning ends.
  useEffect(() => {
    if (!planning) { setThinkingStepIdx(0); return; }
    const id = setInterval(() => setThinkingStepIdx((i) => i + 1), 1600);
    return () => clearInterval(id);
  }, [planning]);

  // Outside-click close for the orchestrator wallet popover. Without this the
  // popover stays open when the user clicks anywhere else on the page, which
  // looks broken on dense layouts where the popover overlaps other controls.
  const orchPopoverRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!orchWalletPopoverOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!orchPopoverRef.current) return;
      if (!orchPopoverRef.current.contains(e.target as Node)) {
        setOrchWalletPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [orchWalletPopoverOpen]);

  const THINKING_STEPS = [
    "Parsing the task",
    "Loading Hermes memory",
    "Scoring budget & risk",
    "Calling Gemini Deep Think",
    "Splitting into micro-payments",
    "Drafting LITE / BALANCED / DEEP variants"
  ];
  // After ~16s of thinking the planner is almost certainly waiting on a slow
  // Gemini response or an AIMLAPI fallback. Start cycling reassurance copy
  // so the user knows we're still alive instead of assuming it froze.
  const LONG_THINKING_STEPS = [
    "Gemini is deep-thinking — this may take up to 60s",
    "Trying AIMLAPI fallback",
    "Still working — Arc testnet latency is real",
    "Hermes is stitching variants together"
  ];
  const isLongThinking = planning && thinkingStepIdx >= THINKING_STEPS.length;
  const currentThinkingStep = isLongThinking
    ? LONG_THINKING_STEPS[(thinkingStepIdx - THINKING_STEPS.length) % LONG_THINKING_STEPS.length]
    : THINKING_STEPS[thinkingStepIdx % THINKING_STEPS.length];

  // Cumulative tx counter — fetched on mount and polled every 30s
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/history/metrics", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as CumulativeMetrics;
        if (!cancelled) setMetrics(data);
      } catch { /* backend offline — leave counter hidden */ }
    }
    load();
    const handle = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(handle); };
  }, []);

  // Pull the real USDC balance of an Arc Testnet address regardless of which
  // chain MetaMask is currently on. Backend proxies the RPC so the UI doesn't
  // have to care about CORS on the testnet RPC endpoint.
  const refreshMainBalance = useCallback(async (addr: string) => {
    try {
      const res = await fetch(`/api/wallet/native-balance?address=${addr}`, { cache: "no-store" });
      if (!res.ok) { setMainBalance("—"); return; }
      const data = await res.json();
      setMainBalance(`${Number(data.balanceUsdc || 0).toFixed(4)} USDC`);
    } catch { setMainBalance("—"); }
  }, []);

  async function ensureArcChain() {
    const eth = (window as any).ethereum;
    if (!eth) return false;
    try {
      const current = await eth.request({ method: "eth_chainId" });
      if (String(current).toLowerCase() === ARC_CHAIN_ID_HEX) return true;
    } catch { /* continue, try switch */ }
    try {
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ARC_CHAIN_ID_HEX }]
      });
      return true;
    } catch (err: any) {
      // 4902 → chain not in wallet, try to add it
      if (err?.code === 4902) {
        try {
          await eth.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: ARC_CHAIN_ID_HEX,
              chainName: "Arc Testnet",
              // Arc Testnet uses USDC as native gas, but the on-chain
              // representation is 18-decimal wei (standard EVM convention)
              // — NOT 6-decimal like ERC-20 USDC. MetaMask formats balances
              // using this `decimals` value, so 6 made the chip read 1e12×
              // too high (40 USDC shown as 40,000,000,000,000).
              nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
              rpcUrls: [ARC_RPC_URL],
              blockExplorerUrls: [ARC_EXPLORER_BASE]
            }]
          });
          return true;
        } catch { return false; }
      }
      return false;
    }
  }

  // Pull orchestrator balance from RPC — used after connect, after funding,
  // and whenever user hits REFRESH.
  const refreshOrchBalance = useCallback(async (addr: string) => {
    try {
      const res = await fetch(`/api/wallet/native-balance?address=${addr}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setOrchBalance(Number(data.balanceUsdc || 0));
    } catch { /* keep previous value */ }
  }, []);

  // Look up an already-deployed orchestrator WITHOUT minting one. Used on
  // connect to decide whether to show the ORCH chip or the DEPLOY button.
  const lookupExistingOrchestrator = useCallback(async (addr: string) => {
    // P2-2: capture the current generation so we can detect if a newer lookup
    // started while this one was awaiting the network response. If the user
    // switched accounts rapidly, generation will have advanced and we discard.
    const generation = ++lookupGenerationRef.current;
    try {
      const res = await fetch(`/api/wallet/orchestrator?mainWallet=${addr}`, { cache: "no-store" });
      if (generation !== lookupGenerationRef.current) return null; // stale
      if (!res.ok) return null;
      const data = await res.json();
      if (generation !== lookupGenerationRef.current) return null; // stale
      if (data?.address) {
        setOrchWallet(data.address);
        setOrchBalance(Number(data.balanceUsdc || 0));
        setOrchDeployed(true);
        // withdrawEnabled/mode aren't returned from the GET — refresh from POST
        // isn't worth it; we'll pick them up on the first action.
        setOrchWithdrawEnabled(true);
        setOrchMode("self-managed");
        return data.address as string;
      }
    } catch { /* backend offline — stay in "not deployed" state */ }
    return null;
  }, []);

  // Refs guard against rapid double-click races on async state-mutating
  // actions. setState-based disabled flags only block the UI re-render,
  // not the synchronous re-entry of the callback before React commits.
  const connectingRef = useRef(false);
  const deployingRef = useRef(false);
  // P2-2: generation counter — incremented every time a new lookup is started
  // (or the account changes). Any in-flight lookup from a previous generation
  // sees a stale generation and discards its result instead of writing it.
  const lookupGenerationRef = useRef(0);

  // Explicitly mint + persist a new self-managed orchestrator, then hydrate
  // the UI. Separate from connectWallet so the user sees deployment as its
  // own explicit step with its own topbar button.
  const deployOrchestrator = useCallback(async () => {
    if (deployingRef.current) return; // hard guard against double-click
    if (!mainWallet) return;
    deployingRef.current = true;
    setDeployingOrch(true); setError(null);
    try {
      const res = await fetch("/api/wallet/orchestrator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mainWallet })
      });
      if (!res.ok) throw new Error(`Orchestrator deploy failed (${res.status})`);
      const data = await res.json();
      setOrchWallet(data.address);
      setOrchMode(data.mode);
      setOrchWithdrawEnabled(Boolean(data.withdrawEnabled));
      setOrchDeployed(true);
      await refreshOrchBalance(data.address);
    } catch (err: any) {
      setError(err?.message || "Orchestrator deploy failed");
    } finally {
      deployingRef.current = false;
      setDeployingOrch(false);
    }
  }, [mainWallet, refreshOrchBalance]);

  const connectWallet = useCallback(async () => {
    if (connectingRef.current) return; // hard guard against double-click
    connectingRef.current = true;
    setConnecting(true); setError(null);
    try {
      const eth = (window as any).ethereum;
      if (!eth) {
        setError("MetaMask not detected. Install MetaMask to continue.");
        return;
      }
      const accounts = await eth.request({ method: "eth_requestAccounts" });
      if (!accounts?.[0]) {
        setError("No accounts returned from wallet");
        return;
      }
      const addr = accounts[0] as string;
      await ensureArcChain();
      // If this MetaMask has ever deployed an orchestrator before (even on
      // another session) the backend has it persisted — hydrate silently so
      // the user doesn't have to re-click DEPLOY every login.
      await lookupExistingOrchestrator(addr);
      setMainWallet(addr);
      await refreshMainBalance(addr);
    } catch (err: any) {
      // EIP-1193 4001 = user rejected the MetaMask popup. Show a friendly
      // "you can retry" message instead of the raw "User denied transaction
      // signature." which reads like a hard error to non-crypto users.
      if (err?.code === 4001 || /user (rejected|denied)/i.test(String(err?.message || ""))) {
        setError("Connection cancelled in MetaMask. Click CONNECT again to retry.");
      } else if (err?.code === -32002) {
        // Already a pending request — usually a previous popup the user
        // didn't see. Tell them where to look.
        setError("MetaMask already has a pending request — open the MetaMask extension to approve it.");
      } else {
        setError(err?.message || "Wallet connect failed");
      }
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  }, [refreshMainBalance, lookupExistingOrchestrator]);

  const disconnectWallet = useCallback(() => {
    setMainWallet(null);
    setMainBalance("—");
    setOrchWallet(null);
    setOrchBalance(0);
    setOrchMode(null);
    setOrchWithdrawEnabled(false);
    setLastFundTx(null);
    setLastWithdrawTx(null);
    setFundFlashTx(null);
    setWithdrawFlashTx(null);
    // Explicit cache wipe — we no longer do this in the persistence effect
    // because that fired on every mount and erased valid sessions.
    try {
      window.localStorage.removeItem("muse.main_wallet");
      window.localStorage.removeItem("muse.orch_wallet");
    } catch { /* ignore */ }
    setVariantPlan(null);
    setPendingTier(null);
    setError(null);
  }, []);

  const fundOrchestrator = useCallback(async () => {
    if (fundingRef.current) return; // hard guard against double-click
    if (!orchWallet || !mainWallet) return;
    const eth = (window as any).ethereum;
    if (!eth) { setError("MetaMask required to send on-chain funding"); return; }
    const amountNum = parseFloat(fundingAmount || "0");
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setError("Enter a positive USDC amount");
      return;
    }
    fundingRef.current = true;
    setFunding(true); setError(null);
    try {
      await ensureArcChain();
      // Arc Testnet native balance uses 18-decimal wei (standard EVM), even
      // though the gas token is labelled USDC. eth_sendTransaction.value must
      // therefore be amount * 10^18, not 10^6.
      const valueWei = BigInt(Math.round(amountNum * 1e6)) * 10n ** 12n;
      const valueHex = `0x${valueWei.toString(16)}`;
      const txHash = await eth.request({
        method: "eth_sendTransaction",
        params: [{ from: mainWallet, to: orchWallet, value: valueHex }]
      });
      if (typeof txHash === "string") {
        setLastFundTx(txHash);
        setFundFlashTx(txHash);
        window.setTimeout(() => setFundFlashTx(null), 8000);
      }
      // Wait briefly then refresh on-chain balances from RPC — no simulation.
      await new Promise((r) => setTimeout(r, 1500));
      await Promise.all([refreshOrchBalance(orchWallet), refreshMainBalance(mainWallet)]);
    } catch (err: any) {
      if (err?.code === 4001 || /user (rejected|denied)/i.test(String(err?.message || ""))) {
        setError("Funding cancelled in MetaMask.");
      } else {
        setError(err?.message || "Funding transaction failed");
      }
    } finally {
      fundingRef.current = false;
      setFunding(false);
    }
  }, [orchWallet, mainWallet, fundingAmount, refreshMainBalance, refreshOrchBalance]);

  const handleRefreshOrch = useCallback(async () => {
    if (!orchWallet) return;
    setRefreshingOrch(true);
    try { await refreshOrchBalance(orchWallet); }
    finally { setRefreshingOrch(false); }
  }, [orchWallet, refreshOrchBalance]);

  // Ask the backend to compute max withdrawable = balance - on-chain gas
  // reserve (3× priority-fee safety multiplier). Shows the user the rounded
  // number in the input, but we mark `withdrawUseMax=true` so the SEND
  // request passes the "max" sentinel instead of a rounded amount — that
  // avoids float-rounding races where the input value's wei representation
  // ends up slightly above the true max at SEND time.
  const handleFillMaxWithdraw = useCallback(async () => {
    if (!mainWallet) return;
    try {
      const res = await fetch(`/api/wallet/orchestrator/max-withdraw?mainWallet=${mainWallet}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setGasReserveEstimate(Number(data.gasReserveUsdc || 0));
      // Floor to 6 decimals for display — never round up (which would push
      // the typed wei over the true max).
      const maxUsdc = Math.floor(Number(data.maxWithdrawableUsdc || 0) * 1_000_000) / 1_000_000;
      setWithdrawAmount(maxUsdc.toFixed(6));
      setWithdrawUseMax(true);
    } catch { /* ignore — user can still type a custom amount */ }
  }, [mainWallet]);

  // Refs to defend against double-click races. `setWithdrawing(true)` only
  // re-renders the button state; the same callback can still enter the
  // try/await chain twice from rapid clicks before React commits the new
  // state. `withdrawingRef` is read synchronously inside the callback and
  // is updated alongside the React state for visual disable.
  const withdrawingRef = useRef(false);
  const fundingRef = useRef(false);

  const handleWithdraw = useCallback(async () => {
    if (withdrawingRef.current) return; // hard guard against double-click
    if (!mainWallet || !orchWallet || orchBalance <= 0) return;
    const trimmed = withdrawAmount.trim();
    if (!trimmed) {
      setError("Enter a USDC amount or click MAX.");
      return;
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num <= 0) {
      setError("Withdraw amount must be a positive number.");
      return;
    }
    withdrawingRef.current = true;
    setWithdrawing(true); setError(null);
    try {
      // If the user clicked MAX and didn't edit the field afterwards, pass
      // the "max" sentinel so the backend computes the exact wei amount at
      // tx time. Otherwise we'd hit rounding errors between display and wei.
      const body = withdrawUseMax
        ? { mainWallet, amountUsdc: "max" as const }
        : { mainWallet, amountUsdc: num };
      const res = await fetch("/api/wallet/orchestrator/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Withdraw failed (${res.status})`);
        return;
      }
      if (data.txHash) {
        setLastWithdrawTx(data.txHash);
        setWithdrawFlashTx(data.txHash);
        window.setTimeout(() => setWithdrawFlashTx(null), 8000);
      }
      if (typeof data.gasReserveUsdc === "number") setGasReserveEstimate(data.gasReserveUsdc);
      setWithdrawAmount("");
      setWithdrawUseMax(false);
      // Give the RPC a moment to reflect the new balances.
      await new Promise((r) => setTimeout(r, 1800));
      await Promise.all([refreshOrchBalance(orchWallet), refreshMainBalance(mainWallet)]);
    } catch (err: any) {
      setError(err?.message || "Withdraw request failed");
    } finally {
      withdrawingRef.current = false;
      setWithdrawing(false);
    }
  }, [mainWallet, orchWallet, orchBalance, withdrawAmount, withdrawUseMax, refreshOrchBalance, refreshMainBalance]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canExecute) return;
    setPlanning(true); setError(null);
    try {
      // Gemini with thinkingBudget + AIMLAPI fallback can take 50-70s on a
      // cold cache. 45s was too tight: the backend returned a valid 200
      // _after_ the frontend had already aborted and shown a fake "timeout"
      // error. Raise to 90s so the happy path survives the worst-case
      // fallback chain.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90_000);
      const res = await fetch("/api/tasks/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim(), taskType }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        const plan = (await res.json()) as VariantPlanResponse;
        setVariantPlan(plan);
        setPlanning(false);
        return;
      }
      // Surface the real backend reason. A plain "500" tells the user nothing —
      // Gemini quota hits, AIMLAPI timeouts, and missing skills all end up here.
      const detail = await res.json().catch(() => null);
      const reason = detail?.error || detail?.detail || detail?.message;
      setError(
        reason
          ? `Planner ${res.status}: ${reason}`
          : res.status === 500
            ? "Planner 500 — Gemini / AIMLAPI timed out. Retry in a couple of seconds."
            : `Planner returned ${res.status}`
      );
    } catch (err: any) {
      setError(
        err?.name === "AbortError"
          ? "Planner is still thinking after 90s. Gemini might be overloaded — retry in a moment."
          : (err?.message || "Planner failed")
      );
    }
    setPlanning(false);
  }, [canExecute, prompt, taskType]);

  const confirmVariant = useCallback(async (tier: VariantTier) => {
    if (!variantPlan) return;
    setSubmitting(true); setPendingTier(tier); setError(null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    let shouldFallbackToSim = false;
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          taskType,
          brandName: (brandName.trim() || variantPlan.brandName) || undefined,
          notes: notes.trim() || undefined,
          tier,
          // Required for real on-chain settlement: backend looks up the
          // orchestrator private key paired to this MetaMask and uses it
          // to broadcast an Arc Testnet transfer per unit. Without this,
          // only the Circle Gateway UUID receipt is stored and nothing is
          // visible on ArcScan.
          mainWallet
        }),
        signal: ctrl.signal
      });
      if (res.ok) {
        const d = await res.json();
        // Defense-in-depth: even though taskId comes from our own backend,
        // validate shape before baking it into a navigation URL. Strict
        // form: simulation prefix uses alphanumeric only (no path chars),
        // canonical UUIDs follow RFC 4122. Length-capped on both branches
        // so a compromised response can't smuggle `../` or oversized
        // garbage past the regex.
        if (d.taskId && /^(sim-[a-z0-9-]{6,32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(String(d.taskId))) {
          window.location.href = `/task/${d.taskId}`;
          return;
        }
        shouldFallbackToSim = true;
      } else {
        // Pre-flight gate from the backend (orchestrator missing or Gateway
        // balance short). Map the structured error onto a CTA the user can
        // act on without leaving this screen — open the topbar wallet
        // popover and pre-fill the suggested top-up amount.
        const detail = await res.json().catch(() => null);
        const code = detail?.error;
        if (code === "ORCHESTRATOR_NOT_DEPLOYED") {
          setError("Deploy your orchestrator first — see the [+ DEPLOY ORCHESTRATOR] button in the topbar.");
        } else if (code === "INSUFFICIENT_GATEWAY_BALANCE") {
          const need = Number(detail.requiredUsdc || 0).toFixed(2);
          setError(`Top up ${need} USDC from MetaMask, then click EXECUTE again.`);
          // Auto-open the orchestrator wallet popover and pre-fill the
          // exact amount the backend asked for so the user does not have
          // to do mental arithmetic.
          if (Number.isFinite(Number(detail.requiredUsdc))) {
            setFundingAmount(String(detail.requiredUsdc));
          }
          setOrchWalletPopoverOpen(true);
        } else {
          setError(detail?.message || detail?.error || detail?.detail || `Backend returned ${res.status}`);
        }
        setSubmitting(false); setPendingTier(null);
        return;
      }
    } catch (err: any) {
      // Only network-level failures (timeout, offline, DNS) fall through to
      // simulation. Everything else must surface to the operator.
      if (err?.name === "AbortError" || err?.code === "ECONNREFUSED" || /Failed to fetch|NetworkError/i.test(String(err?.message || ""))) {
        shouldFallbackToSim = true;
      } else {
        setError(err?.message || "Task submission failed.");
        setSubmitting(false); setPendingTier(null);
        return;
      }
    } finally {
      clearTimeout(timer);
    }
    if (!shouldFallbackToSim) {
      setSubmitting(false); setPendingTier(null);
      return;
    }
    const simId = mockTaskId();
    sessionStorage.setItem(`muse_sim_${simId}`, JSON.stringify({
      prompt: prompt.trim(),
      taskType,
      brandName: brandName.trim() || variantPlan.brandName || "AutoCRM",
      walletAddress: mainWallet,
      tier
    }));
    window.location.href = `/task/${simId}`;
    setSubmitting(false); setPendingTier(null);
  }, [variantPlan, prompt, taskType, brandName, notes, mainWallet]);

  // Rehydrate the wallet session from localStorage on mount so navigating
  // back from /task/[id] doesn't look like the user got disconnected.
  //
  // Strategy: trust the cached address as the source of truth for display.
  // Don't validate against `eth_accounts` on mount — MetaMask's provider
  // is often not injected yet on the first tick after a route change, and
  // an empty-array response there does NOT mean "revoked", it usually
  // means "ethereum not ready". The `accountsChanged` listener (installed
  // below) is the correct signal for real revocations.
  useEffect(() => {
    let cancelled = false;
    let stored: string | null = null;
    try { stored = window.localStorage.getItem("muse.main_wallet"); } catch { /* ignore */ }
    // Validate before using — a tainted localStorage (XSS, extension, old
    // format) could otherwise inject a non-EVM string into API calls and
    // explorer URL builders.
    if (!stored || !/^0x[a-fA-F0-9]{40}$/.test(stored)) {
      if (stored) {
        try { window.localStorage.removeItem("muse.main_wallet"); } catch { /* ignore */ }
      }
      return;
    }
    if (cancelled) return;
    setMainWallet(stored);
    refreshMainBalance(stored);
    lookupExistingOrchestrator(stored);
    return () => { cancelled = true; };
    // Intentionally run once on mount — rehydration is a boot-time concern,
    // later wallet changes are handled by the accountsChanged listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track MetaMask account / chain changes so the UI stays consistent when
  // the user switches active wallet or jumps to a non-Arc chain in the
  // extension. Without these listeners the topbar chip silently kept showing
  // the previous address and its orchestrator balance.
  useEffect(() => {
    const eth = typeof window !== "undefined" ? (window as any).ethereum : null;
    if (!eth?.on) return;
    const handleAccounts = (accounts: string[]) => {
      const next = accounts?.[0] || null;
      if (!next) {
        disconnectWallet();
        return;
      }
      // CLEAR the previous account's orchestrator state BEFORE looking up
      // the new one. Otherwise if account A had an orchestrator and the
      // user switches to account B that doesn't, the topbar chip keeps
      // showing A's orchestrator address — a topbar TOP UP click would
      // send funds from B's MetaMask to A's orchestrator (which only A
      // can withdraw from). Funds-routing footgun closed.
      setOrchWallet(null);
      setOrchBalance(0);
      setOrchDeployed(false);
      setOrchWithdrawEnabled(false);
      setOrchMode(null);
      setOrchWalletPopoverOpen(false);
      setMainWallet(next);
      refreshMainBalance(next);
      // P2-2: bump generation BEFORE starting the new lookup so any still-
      // in-flight lookup for the previous account discards its result.
      lookupGenerationRef.current += 1;
      lookupExistingOrchestrator(next);
    };
    const handleChain = () => {
      // Orchestrator addresses are chain-bound here, so a chain switch
      // invalidates cached balances — force a refresh.
      if (mainWallet) refreshMainBalance(mainWallet);
      if (orchWallet) refreshOrchBalance(orchWallet);
    };
    eth.on("accountsChanged", handleAccounts);
    eth.on("chainChanged", handleChain);
    return () => {
      eth.removeListener?.("accountsChanged", handleAccounts);
      eth.removeListener?.("chainChanged", handleChain);
    };
  }, [mainWallet, orchWallet, disconnectWallet, refreshMainBalance, refreshOrchBalance, lookupExistingOrchestrator]);

  // Sequential UI — 3 visible steps: connect → fund orchestrator → describe task.
  // Agents are no longer a user-triggered step; they are spawned automatically
  // by the orchestrator once the user picks a variant, and the payments stream
  // live on the /task/[id] detail page.
  const currentStep = !mainWallet ? 1 : !hasOrchFunds ? 2 : 3;

  return (
    <div className="page" style={{ position: "relative" }}>
      <DnaCursorTrail />

      {/* TOPBAR */}
      <header className="topbar" style={{ position: "relative", zIndex: 20, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.85rem 1.25rem", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div className="topbar-logo" style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <MuseMark variant="helix" fg="var(--acid)" bg="var(--bg)" size={32} />
          <span style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "1.2rem", letterSpacing: "-0.03em", textTransform: "uppercase", lineHeight: 1 }}>
            MUSE<span style={{ color: "var(--acid)" }}>.DNA</span>
          </span>
        </div>
        <nav className="topbar-nav" style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem" }}>
          {/* ARC block ticker — always visible in topbar so the live chain
              cursor never hides behind a dropdown. */}
          <div style={{ alignSelf: "center" }}>
            <ArcBlockTicker />
          </div>

          {!mainWallet ? (
            <>
              <button
                type="button"
                onClick={connectWallet}
                disabled={connecting}
                style={{
                  alignSelf: "center",
                  background: "var(--acid)",
                  color: "var(--bg)",
                  border: "none",
                  padding: "0.55rem 1rem",
                  fontFamily: "var(--font-display-brand, var(--font-display))",
                  fontSize: "0.78rem",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  cursor: connecting ? "wait" : "pointer",
                  boxShadow: "3px 3px 0 var(--bg)"
                }}
              >
                {connecting ? "CONNECTING…" : "[ CONNECT WALLET ]"}
              </button>
            </>
          ) : (
            <>
              {/* ORCHESTRATOR — either explicit DEPLOY button (before user
                  commits) or the live orchestrator chip (after deploy). */}
              {!orchDeployed ? (
                <button
                  type="button"
                  onClick={deployOrchestrator}
                  disabled={deployingOrch}
                  style={{
                    alignSelf: "center",
                    background: "transparent",
                    color: "var(--acid)",
                    border: "1px dashed rgba(198,245,31,0.6)",
                    padding: "0.45rem 0.8rem",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.72rem",
                    letterSpacing: "0.14em",
                    cursor: deployingOrch ? "wait" : "pointer"
                  }}
                >
                  {deployingOrch ? "DEPLOYING…" : "+ DEPLOY ORCHESTRATOR"}
                </button>
              ) : orchWallet && (
                <div ref={orchPopoverRef} style={{ alignSelf: "center", position: "relative" }}>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem", padding: "0.3rem 0.55rem", border: "1px solid rgba(198,245,31,0.28)", background: "rgba(198,245,31,0.04)" }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.22em", color: "var(--text-dim)" }}>ORCH</span>
                    <a
                      href={explorerAddress(orchWallet)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open orchestrator in ArcScan"
                      style={{ color: "var(--acid)", fontFamily: "var(--font-mono)", fontSize: "0.72rem", textDecoration: "none" }}
                    >
                      {short(orchWallet)} ↗
                    </a>
                    <span style={{ width: 1, height: 12, background: "rgba(255,255,255,0.14)" }} />
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text)", fontWeight: 700 }}>
                      ${orchBalance.toFixed(3)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setOrchWalletPopoverOpen((v) => !v)}
                      title="Top up or withdraw USDC"
                      aria-label="Orchestrator wallet actions"
                      style={{
                        marginLeft: 2,
                        background: orchWalletPopoverOpen ? "var(--acid)" : "transparent",
                        color: orchWalletPopoverOpen ? "var(--bg)" : "var(--acid)",
                        border: "1px solid rgba(198,245,31,0.55)",
                        width: 22, height: 22,
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        fontFamily: "var(--font-mono)", fontSize: "0.72rem", fontWeight: 800,
                        cursor: "pointer", padding: 0, lineHeight: 1
                      }}
                    >
                      {orchWalletPopoverOpen ? "×" : "⇅"}
                    </button>
                  </div>

                  {orchWalletPopoverOpen && (
                    <div
                      role="dialog"
                      aria-label="Orchestrator wallet actions"
                      style={{
                        position: "absolute",
                        top: "calc(100% + 8px)",
                        right: 0,
                        zIndex: 60,
                        width: 400,
                        background: "rgba(5,5,8,0.97)",
                        border: "1px solid rgba(198,245,31,0.35)",
                        boxShadow: "0 20px 40px -16px rgba(0,0,0,0.7), 0 0 28px -12px var(--acid)",
                        padding: "1rem",
                        fontFamily: "var(--font-mono)"
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                        <span style={{ fontSize: "0.58rem", letterSpacing: "0.22em", color: "var(--text-dim)" }}>ORCH BALANCE</span>
                        <span style={{ fontSize: "0.95rem", fontWeight: 700, color: "var(--acid)" }}>${orchBalance.toFixed(4)}</span>
                      </div>

                      <div style={{ borderTop: "1px dashed rgba(198,245,31,0.2)", paddingTop: 8 }}>
                        <div style={{ fontSize: "0.6rem", letterSpacing: "0.2em", color: "var(--acid)", marginBottom: 6, fontWeight: 700 }}>▲ TOP UP</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input
                            type="number" step="0.5" min="0.1"
                            value={fundingAmount}
                            onChange={(e) => setFundingAmount(e.target.value)}
                            style={{ flex: 1, background: "rgba(0,0,0,0.4)", border: "1px solid rgba(198,245,31,0.25)", color: "var(--text)", padding: "0.4rem 0.55rem", fontFamily: "var(--font-mono)", fontSize: "0.85rem", textAlign: "right", outline: "none" }}
                          />
                          <span style={{ fontSize: "0.65rem", color: "var(--text-dim)" }}>USDC</span>
                          {fundFlashTx ? (
                            <a
                              href={explorerTx(fundFlashTx)} target="_blank" rel="noopener noreferrer"
                              className="tx-success-flash popover-action popover-action--acid"
                              title="Open fund transaction in ArcScan"
                            >
                              ✓ VIEW TX ↗
                            </a>
                          ) : (
                            <button
                              type="button" onClick={fundOrchestrator} disabled={funding}
                              className="popover-action popover-action--acid"
                            >
                              {funding ? "SIGNING…" : "▲ FUND"}
                            </button>
                          )}
                        </div>
                      </div>

                      {orchWithdrawEnabled && (
                        <div style={{ borderTop: "1px dashed rgba(255,210,26,0.25)", marginTop: 10, paddingTop: 8 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                            <span style={{ fontSize: "0.6rem", letterSpacing: "0.2em", color: "var(--yellow, #ffd21a)", fontWeight: 700 }}>↙ WITHDRAW TO METAMASK</span>
                            <button
                              type="button" onClick={handleFillMaxWithdraw}
                              style={{ background: "transparent", border: "1px solid rgba(255,210,26,0.35)", color: "var(--yellow, #ffd21a)", padding: "0.12rem 0.4rem", fontFamily: "var(--font-mono)", fontSize: "0.56rem", letterSpacing: "0.15em", cursor: "pointer" }}
                            >MAX</button>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <input
                              type="number" step="0.0001" min="0" placeholder="0.00"
                              value={withdrawAmount}
                              onChange={(e) => { setWithdrawAmount(e.target.value); setWithdrawUseMax(false); }}
                              style={{ flex: 1, background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,210,26,0.3)", color: "var(--text)", padding: "0.4rem 0.55rem", fontFamily: "var(--font-mono)", fontSize: "0.85rem", textAlign: "right", outline: "none" }}
                            />
                            <span style={{ fontSize: "0.65rem", color: "var(--text-dim)" }}>USDC</span>
                            {withdrawFlashTx ? (
                              <a
                                href={explorerTx(withdrawFlashTx)} target="_blank" rel="noopener noreferrer"
                                className="tx-success-flash tx-success-flash--yellow popover-action popover-action--yellow"
                                title="Open withdraw transaction in ArcScan"
                              >
                                ✓ VIEW TX ↗
                              </a>
                            ) : (
                              <button
                                type="button" onClick={handleWithdraw} disabled={withdrawing || !withdrawAmount.trim()}
                                className="popover-action popover-action--yellow"
                              >
                                {withdrawing ? "SENDING…" : "↙ SEND"}
                              </button>
                            )}
                          </div>
                          {gasReserveEstimate != null && (
                            <p style={{ fontSize: "0.58rem", color: "var(--text-dim)", marginTop: 4, lineHeight: 1.4 }}>
                              Gas reserve: ~${gasReserveEstimate.toFixed(6)} USDC kept behind.
                            </p>
                          )}
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={handleRefreshOrch}
                        disabled={refreshingOrch}
                        style={{ marginTop: 10, width: "100%", background: "transparent", border: "1px solid rgba(198,245,31,0.25)", color: "var(--acid)", padding: "0.35rem", fontFamily: "var(--font-mono)", fontSize: "0.62rem", letterSpacing: "0.18em", cursor: refreshingOrch ? "wait" : "pointer" }}
                      >
                        {refreshingOrch ? "REFRESHING…" : "↻ REFRESH BALANCE"}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* MAIN WALLET chip — inline with ArcScan link and explicit
                  disconnect icon sitting just outside to the right. No
                  dropdown — everything the user needs is visible at a glance. */}
              <div style={{ alignSelf: "center", display: "inline-flex", alignItems: "center", gap: "0.45rem", padding: "0.3rem 0.6rem", border: "1px solid rgba(198,245,31,0.5)" }}>
                <span className="wallet-dot" />
                <span style={{ color: "var(--acid)", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
                  {short(mainWallet)}
                </span>
                <span style={{ width: 1, height: 12, background: "rgba(255,255,255,0.18)" }} />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text)", fontWeight: 700 }}>
                  {mainBalance}
                </span>
                <span style={{ width: 1, height: 12, background: "rgba(255,255,255,0.18)" }} />
                <a
                  href={explorerAddress(mainWallet)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open in ArcScan"
                  style={{ color: "var(--acid)", fontFamily: "var(--font-mono)", fontSize: "0.68rem", letterSpacing: "0.1em", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "0.15rem" }}
                >
                  ArcScan ↗
                </a>
              </div>
              {/* Disconnect — compact icon button, sits just outside the chip. */}
              <button
                type="button"
                onClick={disconnectWallet}
                title="Disconnect wallet"
                aria-label="Disconnect wallet"
                style={{
                  alignSelf: "center",
                  width: 28,
                  height: 28,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "transparent",
                  border: "1px solid rgba(255,90,90,0.45)",
                  color: "var(--red, #FF5A5A)",
                  fontSize: "0.85rem",
                  lineHeight: 1,
                  cursor: "pointer",
                  padding: 0
                }}
              >
                ⏻
              </button>
            </>
          )}
          {/* DNA tab — visible regardless of wallet state so judges can
              click straight to the brand-memory archive without going
              through a connect flow first. */}
          <Link
            href="/dna"
            className="topbar-link"
            style={{
              alignSelf: "center",
              fontFamily: "var(--font-mono)",
              fontSize: "0.72rem",
              letterSpacing: "0.18em",
              color: "var(--acid)",
              textDecoration: "none",
              padding: "0.4rem 0.65rem",
              border: "1px dashed rgba(198,245,31,0.45)"
            }}
          >
            DNA
          </Link>
        </nav>
      </header>

      <div style={{ display: "flex", alignItems: "stretch", position: "relative", zIndex: 1 }}>
        {/* Always mounted — visibility toggled by `mainWallet` so the
            sidebar slides in with an animation on first wallet connect
            instead of popping into the layout. */}
        <HistorySidebar
          open={sidebarOpen}
          onToggle={() => setSidebarOpen((v) => !v)}
          visible={Boolean(mainWallet)}
        />
        <main style={{ flex: 1, minWidth: 0, position: "relative" }}>
        {/* Side DNA pillars — landing-only ambient hero. Rotated via SVG
            phase animation (cheap; survives reduced-motion). Hidden on
            viewports under 1320px because the pillars at left:16, width:70
            collide with the .container content edge (also at x=16) when
            the container hasn't reached its max-width yet — the helix
            words bleed under the hero copy at 1101-1300px. */}
        <div className="helix-pillar muse-helix-pillar muse-helix-pillar--left" aria-hidden="true" style={{ left: 16, top: 96, width: 70, height: "calc(100vh - 200px)", maxHeight: 760, zIndex: 0 }}>
          <DnaHelix
            width={70}
            height={760}
            prominent
            rotate3d
            words={["x402", "ARC", "CIRCLE", "USDC", "GATEWAY", "HERMES", "CCTP", "DNA", "MUSE", "8004", "GEMINI", "ARC", "CIRCLE", "USDC"]}
          />
        </div>
        <div className="helix-pillar muse-helix-pillar muse-helix-pillar--right" aria-hidden="true" style={{ right: 16, top: 96, width: 70, height: "calc(100vh - 200px)", maxHeight: 760, zIndex: 0 }}>
          <DnaHelix
            width={70}
            height={760}
            prominent
            rotate3d
            words={["GEMINI", "8004", "SUB-CENT", "ARC", "CIRCLE", "ORACLE", "FEATHERLESS", "BATCH", "USDC", "x402", "HERMES", "ARC", "GEMINI", "8004"]}
          />
        </div>
        {/* ═══ HERO — 2-column matching design handoff ═══ */}
        <section className="container" style={{ position: "relative", paddingTop: "2.5rem", paddingBottom: "2.5rem", overflow: "visible", zIndex: 1 }}>
          <DnaRailBackdrop density={0.55} opacity={0.06} color="#C6F51F" />
          <div className="muse-hero-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr)", gap: "3rem", alignItems: "start", position: "relative", zIndex: 1 }}>
            {/* LEFT — copy + chips + inline steps */}
            <div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", letterSpacing: "0.3em", color: "var(--text-dim)", display: "flex", alignItems: "center", gap: "0.7rem", marginBottom: "1rem" }}>
                <span style={{ width: 24, height: 1, background: "var(--acid)" }} />
                READY · AGENTIC CREATIVE ENGINE · ARC TESTNET
              </div>
              <div style={{ display: "flex", flexDirection: "column", lineHeight: 0.92 }}>
                <span style={{
                  fontFamily: "var(--font-display-brand, var(--font-display))",
                  fontSize: "clamp(2.4rem, 5.4vw, 4.4rem)",
                  letterSpacing: "-0.04em",
                  color: "var(--text)",
                  textTransform: "uppercase"
                }}>
                  MUSE
                </span>
                {/* DNA flows L→R inside the green letterforms (SVG mask). */}
                <div style={{ marginTop: "-0.15em" }}>
                  <DnaHeadline text=".DNA" fontSize={88} color="var(--acid)" />
                </div>
              </div>
              <h1 style={{
                fontFamily: "var(--font-display-brand, var(--font-display))",
                fontSize: "clamp(1.3rem, 2.6vw, 1.9rem)",
                letterSpacing: "-0.04em",
                lineHeight: 1,
                margin: "0.7rem 0 0",
                textTransform: "uppercase"
              }}>
                MARKETING THAT<br />
                <span style={{ background: "var(--acid)", color: "var(--bg)", padding: "0 0.3rem" }}>LEARNS YOUR BRAND.</span>
              </h1>
              <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text-dim)", marginTop: "0.9rem", letterSpacing: "0.05em", maxWidth: 460, lineHeight: 1.7 }}>
                One prompt fans out into 50+ specialized AI agents. Each paid in real-time USDC sub-cent micropayments on Arc Testnet via Circle Gateway × x402.
              </p>
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "1.1rem" }}>
                {["ARC TESTNET", "CIRCLE GATEWAY", "x402", "GEMINI 3.1", "ERC-8004", "FEATHERLESS"].map((t) => (
                  <span key={t} style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", letterSpacing: "0.2em", color: "var(--text)", border: "1px solid rgba(255,255,255,0.18)", padding: "0.25rem 0.55rem", background: "rgba(255,255,255,0.02)" }}>
                    {t}
                  </span>
                ))}
              </div>
              {/* Inline 1·2·3 step indicators */}
              <div style={{ display: "flex", alignItems: "center", gap: 0, marginTop: "1.4rem", flexWrap: "wrap" }}>
                {([
                  [1, "CONNECT"],
                  [2, "FUND ORCHESTRATOR"],
                  [3, "DESCRIBE TASK"]
                ] as const).map(([n, label], idx, arr) => (
                  <div key={n} style={{ display: "flex", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span style={{
                        width: 22, height: 22, display: "grid", placeItems: "center",
                        background: n <= currentStep ? "var(--acid)" : "transparent",
                        color: n <= currentStep ? "var(--bg)" : "var(--text-dim)",
                        border: n <= currentStep ? "none" : "1px solid rgba(255,255,255,0.18)",
                        fontFamily: "var(--font-display)", fontSize: "0.7rem", fontWeight: 800
                      }}>{n}</span>
                      <span style={{
                        fontFamily: "var(--font-mono)", fontSize: "0.62rem",
                        letterSpacing: "0.2em", textTransform: "uppercase",
                        color: n === currentStep ? "var(--text)" : "var(--text-dim)"
                      }}>{label}</span>
                    </div>
                    {idx < arr.length - 1 && (
                      <span style={{ width: 28, height: 1, background: "rgba(255,255,255,0.18)", margin: "0 0.7rem" }} />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* RIGHT — NEW TASK card. id="task-flow" lives here so external
                "↗ START FROM THIS DNA" / "+ NEW TASK" anchors in HistorySidebar
                + /dna land directly on the form, not on the wallet/orch info
                section that USED to host the duplicate STEP 03 form. */}
            <form
              id="task-flow"
              onSubmit={handleSubmit}
              style={{
                scrollMarginTop: "5rem",
                position: "relative",
                background: "var(--bg)",
                border: "2px solid var(--acid)",
                boxShadow: "6px 6px 0 var(--acid)",
                padding: "1.1rem 1.1rem 1rem"
              }}
            >
              <CornerTick where="tl" />
              <CornerTick where="tr" />
              <CornerTick where="bl" />
              <CornerTick where="br" />
              {/* Watermark MuseMark in the bottom-right corner */}
              <div style={{ position: "absolute", right: 14, bottom: 14, opacity: 0.14, pointerEvents: "none" }} aria-hidden="true">
                <MuseMark size={56} variant="helix" fg="var(--acid)" bg="var(--bg)" spin />
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.8rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.55rem" }}>
                  <MuseMark size={20} variant="helix" fg="var(--acid)" bg="var(--bg)" spin />
                  <span style={{ fontFamily: "var(--font-display-brand, var(--font-display))", fontSize: "1.05rem", color: "var(--acid)", letterSpacing: "-0.01em", textTransform: "uppercase" }}>
                    NEW TASK ▸
                  </span>
                </div>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", letterSpacing: "0.22em", color: "var(--text-dim)" }}>
                  FORM 01 / NANOPAYMENT
                </span>
              </div>

              <div style={{ display: "grid", gap: "0.65rem" }}>
                <div>
                  <label className="label" style={{ fontSize: "0.62rem" }}>TYPE YOUR TASK</label>
                  <textarea
                    className="textarea"
                    rows={3}
                    placeholder="Create a Twitter campaign for AutoCRM. Bold tone, target small biz ops, push 14-day free trial."
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    id="task-prompt-input"
                    style={{ minHeight: "5.5rem", fontSize: "0.82rem", lineHeight: 1.55 }}
                  />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
                  <div>
                    <label className="label" style={{ fontSize: "0.62rem" }}>BRAND NAME</label>
                    <input
                      className="input"
                      placeholder="AutoCRM"
                      value={brandName}
                      onChange={(e) => setBrandName(e.target.value)}
                      id="brand-name-input"
                      style={{ fontSize: "0.82rem" }}
                    />
                  </div>
                  <div>
                    <label className="label" style={{ fontSize: "0.62rem" }}>CREATIVE TYPE</label>
                    <select
                      className="select"
                      value={taskType}
                      onChange={(e) => setTaskType(e.target.value)}
                      id="task-type-select"
                      style={{ fontSize: "0.82rem" }}
                    >
                      {TASK_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="label" style={{ fontSize: "0.62rem" }}>
                    ADDITIONAL NOTES <span style={{ color: "var(--text-dim)" }}>· OPTIONAL</span>
                  </label>
                  <input
                    className="input"
                    placeholder="No emojis. Reference x402 micropayments."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    id="notes-input"
                    style={{ fontSize: "0.82rem" }}
                  />
                </div>

                <button
                  type={canExecute ? "submit" : "button"}
                  className="btn btn-primary"
                  disabled={
                    !mainWallet
                      ? connecting
                      : !orchDeployed
                        ? deployingOrch
                        : !hasOrchFunds
                          ? false
                          : !prompt.trim() || submitting || planning
                  }
                  onClick={
                    !mainWallet
                      ? connectWallet
                      : !orchDeployed
                        ? deployOrchestrator
                        : !hasOrchFunds
                          ? () => setOrchWalletPopoverOpen(true)
                          : undefined
                  }
                  id="execute-btn"
                  style={{
                    justifyContent: "center",
                    marginTop: "0.3rem",
                    padding: "0.95rem 1.2rem",
                    fontSize: "0.9rem",
                    width: "100%",
                    letterSpacing: "0.1em"
                  }}
                >
                  {!mainWallet
                    ? (connecting ? "CONNECTING…" : "▶ CONNECT WALLET TO EXECUTE")
                    : !orchDeployed
                      ? (deployingOrch ? "DEPLOYING ORCHESTRATOR…" : "+ DEPLOY ORCHESTRATOR FIRST")
                      : !hasOrchFunds
                        ? "▲ FUND ORCHESTRATOR FIRST"
                        : !prompt.trim()
                          ? "TYPE YOUR TASK ABOVE"
                          : planning
                            ? <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                                <span className="hermes-think-dot" aria-hidden="true" />
                                <span>HERMES · {currentThinkingStep}<span className="hermes-think-ellipsis">…</span></span>
                              </span>
                            : submitting
                              ? "EXECUTING…"
                              : `▶ EXECUTE — ESTIMATED ~${selectedTask.units} MICRO-TXS`}
                </button>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.5rem", paddingTop: "0.6rem", borderTop: "1px dashed rgba(255,255,255,0.12)" }}>
                  <div>
                    <div className="label" style={{ fontSize: "0.55rem", margin: 0 }}>EST. COST</div>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: "1rem", color: "var(--acid)", fontWeight: 800, marginTop: 2 }}>
                      $0.09–${selectedTask.cost.toFixed(2)}
                    </div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.5rem", color: "var(--text-dim)", letterSpacing: "0.12em", marginTop: 1 }}>
                      LITE→DEEP · HERMES PICKS
                    </div>
                  </div>
                  <div>
                    <div className="label" style={{ fontSize: "0.55rem", margin: 0 }}>EST. AGENTS</div>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: "1rem", color: "var(--text)", fontWeight: 800, marginTop: 2 }}>
                      4–28
                    </div>
                  </div>
                  <div>
                    <div className="label" style={{ fontSize: "0.55rem", margin: 0 }}>EST. TIME</div>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: "1rem", color: "var(--text)", fontWeight: 800, marginTop: 2 }}>
                      ~12–94s
                    </div>
                  </div>
                </div>
              </div>
            </form>
          </div>
          <style jsx>{`
            @media (max-width: 1100px) {
              .muse-hero-grid {
                grid-template-columns: 1fr !important;
                gap: 1.8rem !important;
              }
            }
          `}</style>
        </section>

        {/* ═══ SEQUENTIAL FLOW ═══ */}
        {!mainWallet ? (
          /* ── STEP 01: CONNECT WALLET ── */
          <section className="container" style={{ maxWidth: 800, paddingBottom: "4rem" }}>
            <div className="step-card active" style={{ padding: "3rem 2rem", textAlign: "center" }}>
              <div className="step-num">01</div>
              <h2 className="section-title" style={{ marginBottom: "0.5rem" }}>
                <span className="num">STEP 01</span> CONNECT WALLET
              </h2>
              <p className="dim text-sm" style={{ marginBottom: "2rem", maxWidth: 400, margin: "0 auto 2rem" }}>
                Connect your MetaMask to ARC Testnet to begin. No real funds required.
              </p>
              <button className="btn btn-primary btn-lg w-full pulse" onClick={connectWallet} disabled={connecting} id="connect-wallet-btn" style={{ maxWidth: 400, margin: "0 auto", display: "block" }}>
                {connecting ? "CONNECTING..." : "[ CONNECT WALLET ]"}
              </button>
              {error && (
                <p style={{ color: "var(--red)", fontFamily: "var(--font-mono)", fontSize: "0.78rem", marginTop: "1rem" }}>⚠ {error}</p>
              )}
            </div>
          </section>
        ) : (
          <>
            {/* ── STEP FLOW: 2→3→4 ──
                Step indicator row was removed here — the same 1·CONNECT
                2·FUND 3·DESCRIBE strip already lives at the bottom of the
                hero left column. Showing it twice on the same scroll
                doubled visual density without adding info. */}
            <section className="container" style={{ maxWidth: 1140, paddingBottom: "3rem" }}>
              {/* Wallet + Orchestrator row — LARGER cards for readability */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.8rem" }}>
                {/* Main Wallet */}
                <div className="step-card completed" style={{ padding: "2rem 1.8rem" }}>
                  <div className="step-num" style={{ fontSize: "3.5rem", opacity: 0.25 }}>01</div>
                  <div className="flex justify-between items-center">
                    <span className="step-label" style={{ margin: 0, fontSize: "0.8rem" }}>YOUR WALLET</span>
                    <span className="badge badge-green">CONNECTED</span>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <a
                      href={explorerAddress(mainWallet)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mono acid"
                      style={{ fontSize: "0.95rem", textDecoration: "none", fontWeight: 600 }}
                      title="Open in ArcScan"
                    >
                      {short(mainWallet)} ↗
                    </a>
                  </div>
                  <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: "1.3rem", fontWeight: 700, color: "var(--text)" }}>
                    {mainBalance}
                  </div>
                  <p className="dim text-xs" style={{ marginTop: 6 }}>MetaMask · Arc Testnet native USDC</p>
                </div>

                {/* Orchestrator — always derived from main wallet */}
                <div className={`step-card ${currentStep === 2 ? "active" : "completed"}`} style={{ padding: "2rem 1.8rem" }}>
                  <div className="step-num" style={{ fontSize: "3.5rem", opacity: 0.25 }}>02</div>
                  <div className="flex justify-between items-center">
                    <span className="step-label" style={{ margin: 0, fontSize: "0.8rem" }}>ORCHESTRATOR</span>
                    <span className="badge badge-green">{orchWallet ? "PAIRED" : "PENDING"}</span>
                  </div>
                  <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <a
                      href={orchWallet ? explorerAddress(orchWallet) : "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-disabled={!orchWallet}
                      onClick={(e) => { if (!orchWallet) e.preventDefault(); }}
                      className="mono acid"
                      style={{ fontSize: "0.95rem", textDecoration: "none", fontWeight: 600, opacity: orchWallet ? 1 : 0.5 }}
                      title={orchWallet ? "Open in ArcScan" : "Deploy orchestrator first"}
                    >
                      {orchWallet ? `${short(orchWallet)} ↗` : "—"}
                    </a>
                    <button
                      type="button"
                      onClick={handleRefreshOrch}
                      disabled={refreshingOrch}
                      title="Refresh on-chain balance"
                      style={{
                        marginLeft: "auto",
                        background: "transparent",
                        border: "1px solid rgba(198,245,31,0.3)",
                        color: "var(--acid)",
                        padding: "0.2rem 0.55rem",
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.62rem",
                        letterSpacing: "0.14em",
                        cursor: refreshingOrch ? "wait" : "pointer"
                      }}
                    >
                      {refreshingOrch ? "..." : "↻ REFRESH"}
                    </button>
                  </div>
                  <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: "1.3rem", fontWeight: 700, color: orchBalance > 0 ? "var(--acid)" : "var(--text-dim)" }}>
                    ${orchBalance.toFixed(4)} USDC
                  </div>
                  <p className="dim text-xs" style={{ marginTop: 6 }}>
                    Pinned to your MetaMask — same address across every task. {orchMode === "self-managed" && <span style={{ color: "var(--acid)" }}>· Backend holds the signing key so withdraw is one click.</span>}
                  </p>

                  {orchBalance > 0 && orchWithdrawEnabled && (
                    <div style={{ marginTop: 10, padding: "0.55rem 0.6rem", background: "rgba(255,210,26,0.06)", border: "1px solid rgba(255,210,26,0.28)" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", letterSpacing: "0.2em", color: "var(--yellow, #ffd21a)", fontWeight: 700 }}>WITHDRAW TO METAMASK</span>
                        <button
                          type="button"
                          onClick={handleFillMaxWithdraw}
                          style={{
                            background: "transparent",
                            border: "1px solid rgba(255,210,26,0.35)",
                            color: "var(--yellow, #ffd21a)",
                            padding: "0.15rem 0.45rem",
                            fontFamily: "var(--font-mono)",
                            fontSize: "0.58rem",
                            letterSpacing: "0.15em",
                            cursor: "pointer"
                          }}
                        >
                          MAX
                        </button>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input
                          type="number"
                          step="0.0001"
                          min="0"
                          placeholder="0.00"
                          value={withdrawAmount}
                          onChange={(e) => { setWithdrawAmount(e.target.value); setWithdrawUseMax(false); }}
                          style={{
                            flex: 1,
                            background: "rgba(0,0,0,0.3)",
                            border: "1px solid rgba(255,210,26,0.3)",
                            color: "var(--text)",
                            padding: "0.4rem 0.55rem",
                            fontFamily: "var(--font-mono)",
                            fontSize: "0.85rem",
                            textAlign: "right",
                            outline: "none"
                          }}
                        />
                        <span className="mono text-xs" style={{ color: "var(--text-dim)" }}>USDC</span>
                        <button
                          type="button"
                          onClick={handleWithdraw}
                          disabled={withdrawing || !withdrawAmount.trim()}
                          style={{
                            background: withdrawing || !withdrawAmount.trim() ? "rgba(255,210,26,0.2)" : "var(--yellow, #ffd21a)",
                            color: "#0a0a0a",
                            border: "none",
                            padding: "0.45rem 0.8rem",
                            fontFamily: "var(--font-display-brand, var(--font-display))",
                            fontWeight: 700,
                            fontSize: "0.72rem",
                            letterSpacing: "0.1em",
                            cursor: withdrawing || !withdrawAmount.trim() ? "not-allowed" : "pointer"
                          }}
                        >
                          {withdrawing ? "..." : "↙ SEND"}
                        </button>
                      </div>
                      {gasReserveEstimate != null && (
                        <p className="dim text-xs" style={{ marginTop: 4, fontSize: "0.62rem" }}>
                          On-chain gas reserve: ~${gasReserveEstimate.toFixed(6)} USDC (kept behind so the tx never fails).
                        </p>
                      )}
                    </div>
                  )}
                  {(lastFundTx || lastWithdrawTx) && (
                    <div style={{ marginTop: 10, padding: "0.5rem 0.55rem 0", borderTop: "1px dashed rgba(198,245,31,0.25)", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                      {lastFundTx && (
                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                          <span className="dim text-xs" style={{ letterSpacing: "0.15em", minWidth: 70 }}>FUND TX</span>
                          <a
                            href={explorerTx(lastFundTx)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mono acid"
                            style={{ fontSize: "0.75rem", textDecoration: "none" }}
                            title="Open in ArcScan"
                          >
                            {lastFundTx.slice(0, 10)}…{lastFundTx.slice(-6)} ↗
                          </a>
                        </div>
                      )}
                      {lastWithdrawTx && (
                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                          <span className="dim text-xs" style={{ letterSpacing: "0.15em", minWidth: 70, color: "var(--yellow)" }}>WITHDRAW</span>
                          <a
                            href={explorerTx(lastWithdrawTx)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mono"
                            style={{ fontSize: "0.75rem", textDecoration: "none", color: "var(--yellow, #ffd21a)" }}
                            title="Open in ArcScan"
                          >
                            {lastWithdrawTx.slice(0, 10)}…{lastWithdrawTx.slice(-6)} ↗
                          </a>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Fund orchestrator — only shown while balance is low */}
              {!hasOrchFunds && (
                <div className="step-card" style={{ marginTop: "1.2rem", padding: "1.4rem", borderColor: "var(--acid)" }}>
                  <span className="step-label" style={{ margin: 0, fontSize: "0.78rem" }}>TOP UP ORCHESTRATOR</span>
                  <p className="dim text-xs" style={{ marginTop: 4, lineHeight: 1.5, maxWidth: 700 }}>
                    Real on-chain transfer from your MetaMask to the paired orchestrator wallet. Once funded, Hermes can settle every x402 micro-payment on Arc Testnet without asking for another signature.
                  </p>
                  <div className="flex gap-1 mt-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
                    <input className="input" type="number" step="0.5" min="0.1" value={fundingAmount} onChange={e => setFundingAmount(e.target.value)} style={{ width: 120, textAlign: "right" }} />
                    <span className="mono text-sm dim">USDC</span>
                    <button className="btn btn-primary" onClick={fundOrchestrator} disabled={funding} style={{ marginLeft: "auto" }}>
                      {funding ? "SIGNING..." : "▲ FUND ORCHESTRATOR"}
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* STEP 03 task form was removed — the hero NEW TASK card on
                the right column now drives the same `handleSubmit` flow.
                Surfacing the same form twice was redundant and pushed the
                proof panels below the fold for no reason. */}

            {error && (
              <section className="container" style={{ maxWidth: 1140, paddingBottom: "1.5rem" }}>
                <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)", padding: "0.75rem 1rem", fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
                  ⚠ {error}
                </div>
              </section>
            )}

            {!hasOrchFunds && orchBalance >= 0 && mainWallet && (
              <section className="container" style={{ maxWidth: 1140, paddingBottom: "1rem" }}>
                <div style={{ border: "1px solid rgba(255,210,26,0.35)", background: "rgba(255,210,26,0.05)", padding: "0.6rem 0.85rem", fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--yellow, #ffd21a)", letterSpacing: "0.06em" }}>
                  ⚠ Orchestrator needs ${Math.max(0.01, MIN_TIER_COST_USDC - orchBalance).toFixed(3)} more USDC for the cheapest (LITE) tier. Use the FUND ORCHESTRATOR card above before launching the task.
                </div>
              </section>
            )}
          </>
        )}

        {/* Hackathon proof panels — compact collapsible below the main
            funnel. Restores Economics / ERC-8004 Registry / CCTP bridge
            visibility for judging without cluttering the task flow. */}
        <HackathonProofPanels />
        </main>
      </div>

      {/* Variant picker modal — spawned by the Gemini planner */}
      {variantPlan && (
        <VariantSelector
          variants={variantPlan.variants}
          recommendedTier={variantPlan.recommendedTier}
          rationale={variantPlan.rationale}
          brandName={variantPlan.brandName}
          dnaExists={variantPlan.dnaExists}
          model={variantPlan.model}
          source={variantPlan.source}
          onPick={confirmVariant}
          onCancel={() => { setVariantPlan(null); setPendingTier(null); setSubmitting(false); }}
          submitting={submitting}
          pendingTier={pendingTier}
        />
      )}

      <KeyboardHUD />

      {/* Floating live sparkline — USDC spent over time */}
      {metrics && (
        <div style={{ position: "fixed", bottom: 14, left: 14, zIndex: 30, padding: "0.55rem 0.75rem", background: "rgba(5,5,8,0.92)", border: "1px solid rgba(255,255,255,0.1)" }}>
          <CostSparkline spentUsdc={metrics.totalSpentUsdc} width={200} height={40} />
        </div>
      )}

      {/* Cumulative on-chain counter — hackathon demo requires 50+ tx visibility */}
      {metrics && (
        <div
          style={{
            position: "fixed",
            // Sits just above the Hermes brain FAB (82px tall + 16px margin).
            // Together with the USDC sparkline on the left they form a clean
            // bottom-corner triplet that never encroaches on card UI.
            bottom: 112,
            right: 16,
            zIndex: 30,
            padding: "0.55rem 0.85rem",
            background: "rgba(5, 5, 8, 0.92)",
            border: `1px solid ${metrics.hackathonTargetReached ? "var(--acid)" : "rgba(255,255,255,0.14)"}`,
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            color: "var(--text)",
            boxShadow: metrics.hackathonTargetReached ? "0 0 28px -8px var(--acid)" : undefined
          }}
        >
          <div style={{ color: "var(--text-dim)", fontSize: "0.55rem", letterSpacing: "0.2em", marginBottom: 2 }}>
            ARC TESTNET · SETTLED
          </div>
          <div>
            <span style={{ color: metrics.hackathonTargetReached ? "var(--acid)" : "var(--text)", fontWeight: 700, fontSize: "1rem" }}>
              {metrics.totalMicroPayments}
            </span>
            <span style={{ color: "var(--text-dim)" }}> / {metrics.hackathonTarget}</span>
          </div>
          {metrics.hackathonTargetReached && (
            <div style={{ color: "var(--acid)", fontSize: "0.55rem", letterSpacing: "0.1em", marginTop: 2 }}>HACKATHON TARGET ✓</div>
          )}
        </div>
      )}

      {/* Hermes chat drawer — Gemini Function Calling */}
      <HermesChat open={hermesOpen} onClose={() => setHermesOpen(false)} mainWallet={mainWallet} />

      {/* Floating Hermes brain — bigger, brain-shaped, sits above the testnet
          counter (bottom:72) so it doesn't occlude the hackathon readout. */}
      {!hermesOpen && (
        <button
          type="button"
          onClick={() => setHermesOpen(true)}
          title="Ask Hermes (⌘K)"
          aria-label="Open Hermes chat"
          className="hermes-brain-btn"
          style={{
            position: "fixed",
            right: 16,
            bottom: 16,
            zIndex: 70,
            width: 90,
            height: 82,
            padding: 0,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 3,
            filter: "drop-shadow(0 10px 20px rgba(198,245,31,0.35))"
          }}
        >
          <svg width="70" height="64" viewBox="0 0 86 78" aria-hidden="true">
            <defs>
              <radialGradient id="brainFill" cx="50%" cy="45%" r="60%">
                <stop offset="0%" stopColor="#E8FF6A" />
                <stop offset="55%" stopColor="#C6F51F" />
                <stop offset="100%" stopColor="#7EA300" />
              </radialGradient>
            </defs>
            {/* Two brain hemispheres with gyri folds */}
            <path
              d="M40 12
                 C 30 4, 14 8, 10 22
                 C 2 26, 2 40, 10 46
                 C 8 56, 18 66, 30 62
                 C 34 70, 42 70, 42 62
                 L 42 12 Z"
              fill="url(#brainFill)"
              stroke="#0a0a0a"
              strokeWidth="2.2"
              strokeLinejoin="round"
            />
            <path
              d="M46 12
                 C 56 4, 72 8, 76 22
                 C 84 26, 84 40, 76 46
                 C 78 56, 68 66, 56 62
                 C 52 70, 44 70, 44 62
                 L 44 12 Z"
              fill="url(#brainFill)"
              stroke="#0a0a0a"
              strokeWidth="2.2"
              strokeLinejoin="round"
            />
            {/* Gyri — inner fold lines for the brain texture */}
            <path d="M20 22 C 22 28, 16 32, 20 38" fill="none" stroke="#0a0a0a" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M28 18 C 30 26, 24 32, 28 44 C 26 50, 32 56, 28 60" fill="none" stroke="#0a0a0a" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M36 14 C 36 28, 34 42, 36 60" fill="none" stroke="#0a0a0a" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M50 14 C 50 28, 52 42, 50 60" fill="none" stroke="#0a0a0a" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M58 18 C 56 26, 62 32, 58 44 C 60 50, 54 56, 58 60" fill="none" stroke="#0a0a0a" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M66 22 C 64 28, 70 32, 66 38" fill="none" stroke="#0a0a0a" strokeWidth="1.4" strokeLinecap="round" />
            {/* Central fissure */}
            <line x1="43" y1="10" x2="43" y2="66" stroke="#0a0a0a" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <span
            style={{
              fontFamily: "var(--font-display-brand, var(--font-display))",
              fontSize: "0.66rem",
              letterSpacing: "0.18em",
              fontWeight: 800,
              color: "var(--acid)",
              background: "rgba(10,10,10,0.85)",
              border: "1px solid rgba(198,245,31,0.55)",
              padding: "2px 8px",
              textTransform: "uppercase",
              lineHeight: 1,
              boxShadow: "0 2px 0 rgba(0,0,0,0.9)"
            }}
          >
            HERMES
          </span>
        </button>
      )}

      {/* DNA Chain Strip at Bottom — sits behind the marquee bar */}
      <DnaChainStrip />
      {/* Design-handoff marquee tx ticker + tag row */}
      <BottomBar />
    </div>
  );
}
