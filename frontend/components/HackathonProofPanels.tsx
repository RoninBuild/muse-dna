"use client";

import { useEffect, useState } from "react";

/**
 * Consolidated "hackathon proof" panels shown at the bottom of the landing
 * page. Exists so judges can verify three things at a glance without us
 * having to weave them into the main funnel:
 *
 *   1. Margin math — why x402+Arc is viable at per-action pricing and why
 *      the same workload on vanilla Ethereum L1 would not be.
 *   2. Agent registry — ERC-8004-shaped trust layer: every sub-agent has
 *      an on-chain identity, a wallet, and a running reputation counter.
 *   3. CCTP v2 bridge — dividends earned in USDC on Arc can be routed to
 *      Base/Ethereum/Polygon/Optimism via Circle's cross-chain transfer.
 *
 * All three are collapsed by default. Opening is purely local UI state;
 * no fetch happens until the panel is opened.
 */

const ACID = "#C6F51F";

const SERVICE_META: Record<string, { label: string; color: string }> = {
  strategy: { label: "Strategy DNA", color: "#66F1D0" },
  search:   { label: "Fast Search",  color: "#5FA8FF" },
  copy:     { label: "Copy Pulse",   color: "#FFD21A" },
  image:    { label: "Visual Frame", color: "#FF6B9D" }
};

type Agent = {
  agent: string;
  service?: string;
  label?: string;
  metadata_uri?: string | null;
  tx_count?: number;
  total_settled_micro?: string;
  registered_at?: number;
};

function short(addr?: string | null) {
  if (!addr) return "—";
  return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function Section({
  open,
  onToggle,
  label,
  tag,
  children
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  tag: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: "100%",
          background: "transparent",
          border: "none",
          padding: "0.9rem 1.1rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          cursor: "pointer",
          color: "var(--text)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          letterSpacing: "0.22em",
          textTransform: "uppercase"
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.6rem" }}>
          <span style={{ color: ACID, fontWeight: 800 }}>{tag}</span>
          <span style={{ color: "var(--text)" }}>{label}</span>
        </span>
        <span style={{ color: ACID, fontFamily: "var(--font-mono)", fontSize: "0.85rem", transition: "transform 180ms ease", display: "inline-block", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>
          ▸
        </span>
      </button>
      {open && (
        <div style={{ padding: "0.4rem 1.1rem 1.3rem" }}>{children}</div>
      )}
    </div>
  );
}

function MarginMath() {
  const units = 52;
  const perAction = 0.005;
  const totalMoved = units * perAction;
  const ethGasPerTx = 2.5; // conservative
  const ethTotal = units * ethGasPerTx;
  const arcBatchCost = 0.01; // flat-ish
  const perPaymentArc = arcBatchCost / units;
  return (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text)", lineHeight: 1.55 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.5rem", marginBottom: "0.8rem" }}>
        <Cell label="Authorizations" value={String(units)} />
        <Cell label="Per-action" value={`$${perAction.toFixed(4)}`} />
        <Cell label="Value moved" value={`$${totalMoved.toFixed(3)}`} accent />
        <Cell label="Batch fee (Arc)" value={`$${arcBatchCost.toFixed(4)}`} accent />
      </div>
      <p style={{ color: "var(--text-dim)", margin: 0 }}>
        Same workload on Ethereum L1 at ~$2.50 gas/tx ={" "}
        <b style={{ color: "#FF4D6A" }}>${ethTotal.toFixed(2)}</b> — <b>{Math.round(ethTotal / totalMoved)}×</b> the value actually moved. Arc + Circle Gateway batches the 52 authorizations into one on-chain settle for ~${arcBatchCost.toFixed(2)}, which amortizes to{" "}
        <b style={{ color: ACID }}>${perPaymentArc.toFixed(6)}/payment</b>. This is the only stack where an AI sub-agent can charge per action and still keep a profit.
      </p>
    </div>
  );
}

function Cell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.08)", padding: "0.55rem 0.7rem", background: "rgba(255,255,255,0.02)" }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.2em", color: "var(--text-dim)" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: "1.05rem", marginTop: 3, color: accent ? ACID : "var(--text)" }}>{value}</div>
    </div>
  );
}

function AgentRegistry({ load }: { load: boolean }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [mode, setMode] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/registry", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setMode(data.mode || "");
        setAgents(Array.isArray(data.agents) ? data.agents : []);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || "Registry offline");
      }
    })();
    return () => { cancelled = true; };
  }, [load]);

  return (
    <div>
      <p style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "0.7rem", margin: "0 0 0.6rem" }}>
        ERC-8004-inspired identity + reputation · mode: <b style={{ color: ACID }}>{mode || "…"}</b> · <a href="/api/registry" target="_blank" rel="noreferrer" style={{ color: ACID }}>raw ↗</a>
      </p>
      {error && <p style={{ color: "var(--red, #FF4D6A)", fontSize: "0.72rem" }}>⚠ {error}</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.55rem" }}>
        {agents.length === 0 && !error && (
          <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "0.72rem", padding: "0.6rem" }}>Loading agents…</div>
        )}
        {agents.map((a, i) => {
          const meta = SERVICE_META[a.service || ""] || { label: a.label || "Agent", color: "#fff" };
          const settledUsd = (Number(a.total_settled_micro || 0) / 1_000_000).toFixed(4);
          // `a.agent` can repeat across services when the same wallet is
          // registered for two of them (or be undefined during an interim
          // fetch). Combine with service + index so the key stays unique.
          const rowKey = `${a.agent || "anon"}-${a.service || i}-${i}`;
          return (
            <div key={rowKey} style={{ border: `1px solid ${meta.color}33`, background: `${meta.color}08`, padding: "0.65rem 0.75rem" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.22em", color: meta.color, fontWeight: 800, textTransform: "uppercase" }}>
                {a.service} · ACTIVE
              </div>
              <div style={{ fontFamily: "var(--font-display)", fontSize: "0.92rem", marginTop: 4, color: "var(--text)" }}>
                {meta.label}
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.64rem", color: "var(--text-dim)", marginTop: 2 }}>
                {short(a.agent)}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginTop: 6 }}>
                <div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.5rem", letterSpacing: "0.2em", color: "var(--text-dim)" }}>TX</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: "0.85rem", color: meta.color }}>{a.tx_count ?? 0}</div>
                </div>
                <div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.5rem", letterSpacing: "0.2em", color: "var(--text-dim)" }}>USDC</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: "0.85rem", color: "var(--text)" }}>{settledUsd}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const CCTP_CHAINS = [
  { id: 84532,    label: "Base Sepolia" },
  { id: 11155111, label: "Ethereum Sepolia" },
  { id: 80002,    label: "Polygon Amoy" },
  { id: 11155420, label: "Optimism Sepolia" }
];

function BridgeWithdraw() {
  const [amount, setAmount] = useState("0.05");
  const [destChain, setDestChain] = useState<number>(CCTP_CHAINS[0].id);
  const [destAddress, setDestAddress] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPreview() {
    setError(null);
    setPreview(null);
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return setError("Enter a positive USDC amount");
    if (!/^0x[a-fA-F0-9]{40}$/.test(destAddress.trim())) return setError("Enter a valid destination 0x address");
    setLoading(true);
    try {
      const res = await fetch("/api/bridge/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountUsdc: n, destinationChainId: destChain, destinationAddress: destAddress.trim() })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error || `HTTP ${res.status}`); return; }
      setPreview(data);
    } catch (err: any) {
      setError(err?.message || "Network error");
    } finally { setLoading(false); }
  }

  return (
    <div>
      <p style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "0.7rem", margin: "0 0 0.7rem" }}>
        CCTP v2 · SOURCE <b style={{ color: ACID }}>Arc Testnet (5042002)</b> · route dividends to any EVM destination Circle supports.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 1fr auto", gap: "0.5rem", alignItems: "end" }}>
        <Field label="AMOUNT USDC">
          <input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="input" style={{ width: "100%" }} />
        </Field>
        <Field label="DESTINATION CHAIN">
          <select value={destChain} onChange={(e) => setDestChain(Number(e.target.value))} className="select" style={{ width: "100%" }}>
            {CCTP_CHAINS.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.id})</option>)}
          </select>
        </Field>
        <Field label="DESTINATION ADDRESS">
          <input type="text" placeholder="0x…" value={destAddress} onChange={(e) => setDestAddress(e.target.value)} className="input" style={{ width: "100%" }} />
        </Field>
        <button
          type="button"
          onClick={onPreview}
          disabled={loading}
          style={{
            background: loading ? "rgba(198,245,31,0.35)" : ACID,
            color: "#0a0a0a",
            border: "none",
            padding: "0.6rem 1rem",
            fontFamily: "var(--font-display-brand, var(--font-display))",
            fontSize: "0.78rem",
            letterSpacing: "0.12em",
            fontWeight: 800,
            cursor: loading ? "wait" : "pointer"
          }}
        >
          {loading ? "…" : "▶ PREVIEW"}
        </button>
      </div>
      {error && <p style={{ color: "var(--red, #FF4D6A)", fontSize: "0.72rem", marginTop: "0.5rem" }}>⚠ {error}</p>}
      {preview && (
        <div style={{ marginTop: "0.7rem", border: `1px solid ${ACID}40`, background: `${ACID}08`, padding: "0.6rem 0.8rem" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", letterSpacing: "0.18em", color: ACID, marginBottom: 4 }}>PREVIEW</div>
          <pre style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text)", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {JSON.stringify(preview, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", letterSpacing: "0.22em", color: "var(--text-dim)", marginBottom: 3 }}>{label}</div>
      {children}
    </div>
  );
}

export default function HackathonProofPanels() {
  const [open, setOpen] = useState<{ econ: boolean; reg: boolean; bridge: boolean }>({ econ: false, reg: false, bridge: false });
  return (
    <section
      className="container"
      style={{
        maxWidth: 1140,
        margin: "2.5rem auto 3rem",
        padding: "0 1rem"
      }}
    >
      <div style={{
        background: "#07090c",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "4px 4px 0 rgba(198,245,31,0.14)"
      }}>
        <div style={{ padding: "0.85rem 1.1rem", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", letterSpacing: "0.28em", color: "var(--text-dim)" }}>
            HACKATHON · PROOF PANELS
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.58rem", letterSpacing: "0.2em", color: ACID }}>
            CLICK TO EXPAND
          </span>
        </div>
        <Section
          open={open.econ}
          onToggle={() => setOpen((o) => ({ ...o, econ: !o.econ }))}
          tag="01"
          label="Margin math — why x402 + Arc is viable"
        >
          <MarginMath />
        </Section>
        <Section
          open={open.reg}
          onToggle={() => setOpen((o) => ({ ...o, reg: !o.reg }))}
          tag="02"
          label="Agent registry — ERC-8004 trust layer"
        >
          <AgentRegistry load={open.reg} />
        </Section>
        <Section
          open={open.bridge}
          onToggle={() => setOpen((o) => ({ ...o, bridge: !o.bridge }))}
          tag="03"
          label="CCTP v2 bridge — withdraw dividends cross-chain"
        >
          <BridgeWithdraw />
        </Section>
      </div>
    </section>
  );
}
