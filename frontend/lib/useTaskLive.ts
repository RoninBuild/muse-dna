"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getMuseSocket } from "./socket";

export type LiveUnitStatus = "pending" | "requesting" | "paying" | "validated" | "reused" | "failed";

export type LiveUnit = {
  service: "strategy" | "search" | "copy" | "image";
  unit: string;
  label: string;
  price: number;
  dnaKey?: string | null;
  status: LiveUnitStatus;
  amountUsdc?: number;
  txHash?: string | null;
  arcUrl?: string | null;
  network?: string | null;
  note?: string | null;
  finishedAt?: string | null;
  // Address of the fresh agent wallet that earned this micro-payment.
  // Set by the orchestrator at plan time (round-robin within service)
  // and propagated through every `unit:*` socket event so the per-wallet
  // ledger card knows which actions belong under which wallet.
  walletAddress?: string | null;
  walletIndex?: number | null;
};

export type LiveEvent = {
  id: string;
  at: string;
  tone: "info" | "success" | "warning" | "danger";
  title: string;
  message: string;
  arcUrl?: string | null;
};

export type LivePlan = {
  brandName?: string;
  dnaExists?: boolean;
  dnaFile?: string | null;
  tier?: string;
  tierMeta?: { label?: string; subtitle?: string } | null;
  microPlan?: Array<{ service: string; unit: string; price: number; dnaKey?: string | null; label?: string }>;
  estimatedCost?: number;
  investmentCost?: number;
  savings?: number;
  totalUnits?: number;
  payableUnits?: number;
  reusedUnits?: number;
  dnaBlocksTotal?: number;
} | null;

export type LiveTaskState = {
  taskId: string;
  connected: boolean;
  phase: "idle" | "planning" | "executing" | "dna" | "completed" | "failed";
  plan: LivePlan;
  units: LiveUnit[];
  events: LiveEvent[];
  dna: { completed: number; total: number; fileName: string | null };
  totalSpent: number;
  savings: number;
  transactions: Array<{ txHash: string; amountUsdc: number; arcUrl: string | null; label: string; service: string }>;
  result: { text: string | null; imageUrl: string | null } | null;
  errorMessage: string | null;
  agentWallets: Array<{ service: string; index: number; address: string }> | null;
  agentWalletsPerService: Record<string, number> | null;
};

const INITIAL_STATE: LiveTaskState = {
  taskId: "",
  connected: false,
  phase: "idle",
  plan: null,
  units: [],
  events: [],
  dna: { completed: 0, total: 0, fileName: null },
  totalSpent: 0,
  savings: 0,
  transactions: [],
  result: null,
  agentWallets: null,
  agentWalletsPerService: null,
  errorMessage: null
};

function pushEvent(state: LiveTaskState, evt: Omit<LiveEvent, "id" | "at">): LiveTaskState {
  return {
    ...state,
    events: [
      ...state.events.slice(-200),
      { ...evt, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString() }
    ]
  };
}

function upsertUnit(state: LiveTaskState, incoming: Partial<LiveUnit> & { service: string; unit: string }): LiveTaskState {
  const idx = state.units.findIndex((u) => u.service === incoming.service && u.unit === incoming.unit);
  if (idx < 0) {
    const defaults: LiveUnit = {
      service: incoming.service as LiveUnit["service"],
      unit: incoming.unit,
      label: incoming.label || `${incoming.service} · ${incoming.unit}`,
      price: incoming.price ?? 0,
      status: incoming.status ?? "pending",
      amountUsdc: incoming.amountUsdc,
      txHash: incoming.txHash ?? null,
      arcUrl: incoming.arcUrl ?? null,
      dnaKey: incoming.dnaKey ?? null,
      network: incoming.network ?? null,
      note: incoming.note ?? null,
      finishedAt: incoming.finishedAt ?? null,
      walletAddress: incoming.walletAddress ?? null,
      walletIndex: incoming.walletIndex ?? null
    };
    return { ...state, units: [...state.units, defaults] };
  }
  const prev = state.units[idx];
  // Do not overwrite already-settled receipt fields with null/undefined that
  // come from a late REST snapshot or a second `task:snapshot` emit. Those
  // payloads can drop fields that only live in the socket `unit:validated`
  // event (txHash, arcUrl, amountUsdc, network) and a naive spread would
  // erase the real receipt we already rendered.
  const preserveIfEmpty = (incomingValue: unknown, prevValue: unknown) =>
    incomingValue === null || incomingValue === undefined ? prevValue : incomingValue;

  const next: LiveUnit = {
    ...prev,
    ...incoming,
    label: incoming.label || prev.label,
    price: incoming.price ?? prev.price,
    status: (incoming.status ?? prev.status) as LiveUnitStatus,
    txHash: preserveIfEmpty(incoming.txHash, prev.txHash) as LiveUnit["txHash"],
    arcUrl: preserveIfEmpty(incoming.arcUrl, prev.arcUrl) as LiveUnit["arcUrl"],
    network: preserveIfEmpty(incoming.network, prev.network) as LiveUnit["network"],
    // Previous implementation treated amountUsdc === 0 as "preserve prev",
    // which wrongly hid the legitimate 0 cost of `reused` units. Only
    // preserve when the field is actually missing (null/undefined).
    amountUsdc:
      incoming.amountUsdc === undefined || incoming.amountUsdc === null
        ? prev.amountUsdc
        : incoming.amountUsdc,
    finishedAt: preserveIfEmpty(incoming.finishedAt, prev.finishedAt) as LiveUnit["finishedAt"],
    walletAddress: preserveIfEmpty(incoming.walletAddress, prev.walletAddress) as LiveUnit["walletAddress"],
    walletIndex: preserveIfEmpty(incoming.walletIndex, prev.walletIndex) as LiveUnit["walletIndex"]
  } as LiveUnit;
  const units = [...state.units];
  units[idx] = next;
  return { ...state, units };
}

/**
 * Subscribe to a backend task (real UUID) over Socket.IO and fold every
 * orchestrator event into a single coherent reactive state. Also pulls a
 * one-shot REST snapshot so the UI can render something even before the
 * first socket frame arrives.
 */
export function useTaskLive(taskId: string | undefined, options: { onToast?: (evt: LiveEvent) => void } = {}): LiveTaskState {
  const [state, setState] = useState<LiveTaskState>(INITIAL_STATE);
  const onToast = options.onToast;
  const onToastRef = useRef(onToast);
  useEffect(() => { onToastRef.current = onToast; }, [onToast]);

  const isSimulation = !taskId || taskId.startsWith("sim-");

  const fireToast = useCallback((evt: Omit<LiveEvent, "id" | "at">) => {
    if (!onToastRef.current) return;
    onToastRef.current({ ...evt, id: "", at: new Date().toISOString() });
  }, []);

  // Snapshot over REST so we have something to render immediately.
  useEffect(() => {
    let cancelled = false;
    if (!taskId || isSimulation) return;
    (async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setState((prev) => {
          let next = { ...prev, taskId };
          for (const step of data.steps || []) {
            next = upsertUnit(next, {
              service: step.service_name,
              unit: step.unit_name,
              label: step.unit_name,
              price: Number(step.cost_usdc || 0),
              status: step.status === "completed" ? "validated" : step.status === "reused" ? "reused" : step.status === "failed" ? "failed" : "pending",
              amountUsdc: Number(step.cost_usdc || 0),
              txHash: step.tx_hash,
              arcUrl: step.arc_url,
              dnaKey: step.dna_section_key,
              network: step.payment_network,
              finishedAt: step.completed_at
            });
          }
          if (data.task?.status === "completed") next.phase = "completed";
          else if (data.task?.status === "failed") next.phase = "failed";
          else next.phase = "executing";
          next.totalSpent = Number(data.task?.total_spent_usdc || 0);
          next.savings = Number(data.task?.savings_usdc || 0);
          next.result = data.task?.result
            ? { text: data.task.result.text || null, imageUrl: data.task.result.imageUrl || null }
            : prev.result;
          return next;
        });
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [taskId, isSimulation]);

  useEffect(() => {
    if (!taskId || isSimulation) return;
    const socket = getMuseSocket();

    const onConnect = () => {
      setState((s) => ({ ...s, connected: true, taskId }));
      socket.emit("task:subscribe", taskId);
    };
    const onDisconnect = () => setState((s) => ({ ...s, connected: false }));

    const onSnapshot = (payload: any) => {
      setState((s) => {
        let next = { ...s };
        for (const step of payload.steps || []) {
          next = upsertUnit(next, {
            service: step.service_name,
            unit: step.unit_name,
            label: step.unit_name,
            price: Number(step.cost_usdc || 0),
            status: step.status === "completed" ? "validated" : step.status === "reused" ? "reused" : step.status === "failed" ? "failed" : "pending",
            amountUsdc: Number(step.cost_usdc || 0),
            txHash: step.tx_hash,
            arcUrl: step.arc_url,
            dnaKey: step.dna_section_key,
            network: step.payment_network
          });
        }
        return next;
      });
    };

    const onPlanning = () => setState((s) => pushEvent({ ...s, phase: "planning" }, { tone: "info", title: "Hermes thinking", message: "Pricing the task into micro-units…" }));

    const onPlanReady = (payload: any) => {
      setState((s) => {
        let next: LiveTaskState = {
          ...s,
          phase: "executing",
          plan: {
            brandName: payload.brandName,
            dnaExists: payload.dnaExists,
            dnaFile: payload.dnaFile,
            tier: payload.tier,
            tierMeta: payload.tierMeta,
            microPlan: payload.microPlan,
            estimatedCost: payload.estimatedCost,
            investmentCost: payload.investmentCost,
            savings: payload.savings,
            totalUnits: payload.totalUnits,
            payableUnits: payload.payableUnits,
            reusedUnits: payload.reusedUnits,
            dnaBlocksTotal: payload.dnaBlocksTotal
          },
          dna: { ...s.dna, total: payload.dnaBlocksTotal ?? s.dna.total }
        };
        for (const unit of payload.microPlan || []) {
          next = upsertUnit(next, {
            service: unit.service,
            unit: unit.unit,
            label: unit.label || unit.unit,
            price: unit.price,
            dnaKey: unit.dnaKey,
            status: "pending"
          });
        }
        next = pushEvent(next, { tone: "info", title: "Plan ready", message: `${payload.payableUnits} payable units · $${Number(payload.estimatedCost || 0).toFixed(4)} USDC` });
        return next;
      });
    };

    const onUnitRequesting = (p: any) => setState((s) => upsertUnit(s, { ...p, status: "requesting", label: p.label || p.unit }));
    const onUnitPaying = (p: any) => {
      setState((s) => {
        const nextState = upsertUnit(s, { ...p, status: "paying", label: p.label || p.unit });
        return pushEvent(nextState, { tone: "warning", title: "Signing x402", message: `${p.label || p.unit} — ${p.status || "signing micro-check"}` });
      });
    };
    const onUnitValidated = (p: any) => {
      setState((s) => {
        let next = upsertUnit(s, {
          ...p,
          status: "validated",
          txHash: p.txHash,
          arcUrl: p.arcUrl,
          amountUsdc: p.amountUsdc,
          network: p.network,
          finishedAt: new Date().toISOString()
        });
        next = pushEvent(next, {
          tone: "success",
          title: "Settled",
          message: `${p.label || p.unit} · $${Number(p.amountUsdc || 0).toFixed(4)} USDC`,
          arcUrl: p.arcUrl || null
        });
        next.totalSpent = Number((next.totalSpent + Number(p.amountUsdc || 0)).toFixed(6));
        if (p.txHash) {
          next.transactions = [
            ...next.transactions,
            {
              txHash: p.txHash,
              amountUsdc: Number(p.amountUsdc || 0),
              arcUrl: p.arcUrl || null,
              label: p.label || p.unit,
              service: p.service
            }
          ];
        }
        return next;
      });
      // Toast lives outside the setState updater — calling a parent's
      // setState during our own state-updater is a render-time side effect
      // that React 19 strict mode flags as "Cannot update a component while
      // rendering a different component."
      fireToast({ tone: "success", title: "Micro-tx settled", message: `${p.label || p.unit} · ${p.txHash?.slice?.(0, 14) || ""}…`, arcUrl: p.arcUrl || null });
    };
    const onUnitReused = (p: any) => {
      setState((s) => {
        let next = upsertUnit(s, { ...p, status: "reused" });
        next = pushEvent(next, { tone: "info", title: "DNA reused", message: `${p.label || p.unit} — Hermes memory skipped payment` });
        return next;
      });
    };
    const onUnitFailed = (p: any) => {
      setState((s) => {
        let next = upsertUnit(s, { ...p, status: "failed" });
        next = pushEvent(next, { tone: "danger", title: "Unit failed", message: `${p.label || p.unit} · ${p.error || ""}` });
        return next;
      });
    };
    const onDnaProgress = (p: any) => setState((s) => ({ ...s, dna: { completed: p.completed ?? s.dna.completed, total: p.total ?? s.dna.total, fileName: s.dna.fileName } }));
    const onDnaBuilding = () => setState((s) => pushEvent({ ...s, phase: "dna" }, { tone: "info", title: "DNA compile", message: "Hermes is compiling completed DNA blocks…" }));
    const onDnaCreated = (p: any) => {
      setState((s) => {
        const next = { ...s, dna: { ...s.dna, fileName: p.fileName, completed: p.completed ?? s.dna.completed, total: p.total ?? s.dna.total }, phase: "executing" as const };
        return pushEvent(next, { tone: "success", title: "DNA minted", message: p.message || `Saved ${p.fileName}` });
      });
      fireToast({ tone: "success", title: "DNA minted", message: p.fileName || "Brand DNA saved to Hermes" });
    };
    const onTaskCompleted = (p: any) => {
      let toastTxCount = 0;
      setState((s) => {
        const nextResult = p.result ? { text: p.result.text || null, imageUrl: p.result.imageUrl || null } : s.result;
        let next: LiveTaskState = {
          ...s,
          phase: "completed",
          totalSpent: Number(p.totalSpent ?? s.totalSpent),
          savings: Number(p.savings ?? s.savings),
          result: nextResult,
          transactions: Array.isArray(p.transactions) && p.transactions.length ? p.transactions.map((t: any) => ({
            txHash: t.txHash,
            amountUsdc: Number(t.amountUsdc || 0),
            arcUrl: t.arcUrl || null,
            label: t.label,
            service: t.service
          })) : s.transactions
        };
        toastTxCount = p.metrics?.paidMicroPayments ?? next.transactions.length;
        next = pushEvent(next, { tone: "success", title: "Task completed", message: `Spent $${Number(p.totalSpent || 0).toFixed(4)} over ${p.metrics?.paidMicroPayments ?? next.transactions.length} authorizations.` });
        return next;
      });
      fireToast({ tone: "success", title: "Task completed", message: `${toastTxCount} tx · $${Number(p.totalSpent || 0).toFixed(4)} USDC` });
    };
    const onTaskError = (p: any) => {
      setState((s) =>
        pushEvent({ ...s, phase: "failed", errorMessage: p.message || null }, { tone: "danger", title: "Task error", message: p.message || "orchestrator failed" })
      );
      fireToast({ tone: "danger", title: "Task error", message: p.message || "orchestrator failed" });
    };
    const onTaskWarning = (p: any) => {
      setState((s) => pushEvent(s, { tone: "warning", title: "Partial failure", message: p.message || `${p.count || "some"} units failed` }));
    };
    const onWalletsDeployed = (p: any) => {
      // New shape: flat array of { service, index, address } + perService
      // counts. Still accepts the old object shape as a fallback.
      const wallets: Array<{ service: string; index: number; address: string }> =
        Array.isArray(p?.wallets)
          ? p.wallets.filter((w: any) => w && typeof w.address === "string")
          : p?.wallets && typeof p.wallets === "object"
            ? Object.entries(p.wallets)
                .map(([service, v]: [string, any], i) => ({
                  service,
                  index: i,
                  address: v?.address
                }))
                .filter((w) => typeof w.address === "string")
            : [];
      if (wallets.length === 0) return;
      setState((s) => ({
        ...pushEvent(s, {
          tone: "info",
          title: "Agent swarm deployed",
          message: `${wallets.length} fresh EVM wallets ready to receive micro-payments (${Object.entries(p?.perService || {}).map(([k, v]) => `${v} ${k}`).join(" · ")})`
        }),
        agentWallets: wallets,
        agentWalletsPerService: p?.perService || null
      }));
      fireToast({
        tone: "info",
        title: "Agent swarm deployed",
        message: `${wallets.length} fresh EVM wallets on Arc Testnet`
      });
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("task:snapshot", onSnapshot);
    socket.on("task:planning", onPlanning);
    socket.on("task:plan_ready", onPlanReady);
    socket.on("unit:requesting", onUnitRequesting);
    socket.on("unit:paying", onUnitPaying);
    socket.on("unit:validated", onUnitValidated);
    socket.on("unit:reused", onUnitReused);
    socket.on("unit:failed", onUnitFailed);
    socket.on("dna:progress", onDnaProgress);
    socket.on("dna:building", onDnaBuilding);
    socket.on("dna:created", onDnaCreated);
    socket.on("task:completed", onTaskCompleted);
    socket.on("task:error", onTaskError);
    socket.on("task:warning", onTaskWarning);
    socket.on("task:wallets_deployed", onWalletsDeployed);

    if (socket.connected) onConnect();
    else socket.connect();

    return () => {
      socket.emit("task:unsubscribe", taskId);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("task:snapshot", onSnapshot);
      socket.off("task:planning", onPlanning);
      socket.off("task:plan_ready", onPlanReady);
      socket.off("unit:requesting", onUnitRequesting);
      socket.off("unit:paying", onUnitPaying);
      socket.off("unit:validated", onUnitValidated);
      socket.off("unit:reused", onUnitReused);
      socket.off("unit:failed", onUnitFailed);
      socket.off("dna:progress", onDnaProgress);
      socket.off("dna:building", onDnaBuilding);
      socket.off("dna:created", onDnaCreated);
      socket.off("task:completed", onTaskCompleted);
      socket.off("task:error", onTaskError);
      socket.off("task:warning", onTaskWarning);
      socket.off("task:wallets_deployed", onWalletsDeployed);
    };
  }, [taskId, isSimulation, fireToast]);

  // Watchdog: if the orchestrator crashes after some units settle but
  // before `task:completed`/`task:error` fires, the UI would sit in
  // "executing" forever. Kick the phase to "failed" with an explanatory
  // message if nothing progresses for the timeout window.
  //
  // We track the latest known `finishedAt` in a ref so unrelated re-renders
  // (e.g. event log updates) don't reset the 5-min timer back to full.
  const watchdogBaseRef = useRef<number>(0);
  const latestFinishedAt = useMemo(
    () =>
      state.units.reduce((acc, u) => {
        const ts = u.finishedAt ? Date.parse(u.finishedAt) : 0;
        return Number.isFinite(ts) && ts > acc ? ts : acc;
      }, 0),
    [state.units]
  );
  useEffect(() => {
    if (!taskId || isSimulation) return;
    if (state.phase === "completed" || state.phase === "failed") {
      watchdogBaseRef.current = 0;
      return;
    }
    const WATCHDOG_MS = 5 * 60 * 1000;
    // Rebase ONLY when real progress advances or we haven't armed yet.
    if (latestFinishedAt > watchdogBaseRef.current) {
      watchdogBaseRef.current = latestFinishedAt;
    } else if (watchdogBaseRef.current === 0) {
      watchdogBaseRef.current = Date.now();
    }
    const remaining = Math.max(0, WATCHDOG_MS - (Date.now() - watchdogBaseRef.current));
    const timer = setTimeout(() => {
      let didFail = false;
      setState((s) => {
        if (s.phase === "completed" || s.phase === "failed") return s;
        didFail = true;
        return pushEvent(
          { ...s, phase: "failed", errorMessage: "Task stalled — no orchestrator progress within 5 minutes." },
          { tone: "danger", title: "Task stalled", message: "No orchestrator progress for 5 minutes." }
        );
      });
      if (didFail) {
        fireToast({
          tone: "danger",
          title: "Task stalled",
          message: "No progress for 5 minutes — backend may have crashed. Refresh to retry."
        });
      }
    }, remaining);
    return () => clearTimeout(timer);
  }, [taskId, isSimulation, state.phase, latestFinishedAt, fireToast]);

  return useMemo(() => ({ ...state, taskId: taskId || state.taskId }), [state, taskId]);
}
