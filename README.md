# Muse DNA

AI marketing agency on **Arc Testnet**. One prompt fans out into 50+ specialized
sub-agents, each paid in real-time **USDC sub-cent micropayments** via
**Circle Gateway × x402**. Brand DNA accumulates across runs — second task for
the same brand reuses up to 80% of strategy work and runs at a fraction of the
cost.

Hackathon track: **Agent-to-Agent Payment Loop** (Circle / Arc — Agentic
Economy on Arc).

---

## Stack

- **Settlement** — Arc Testnet (chainId `5042002`), USDC as native gas (18 dec)
- **Payment rail** — `@circle-fin/x402-batching` (Circle Gateway) + EIP-3009 sigs
- **Trust layer** — `MuseAgentRegistry.vy` (ERC-8004-inspired, on-chain identity + reputation)
- **Cross-chain** — Circle CCTP v2 for dividend withdrawal
- **Orchestration** — Hermes planner with Gemini 3.1 Function Calling
- **LLM cascade** — Gemini → AIMLAPI → Featherless → Fireworks (5-key rotation)
- **Frontend** — Next.js 15 App Router + wagmi/viem + Socket.io live ledger
- **Backend** — Node 20 / Express / Postgres (memory fallback)
- **Image generation** — AIMLAPI / fal.ai / Fireworks Flux-Schnell

---

## Run locally

```bash
# 1. Clone + install
git clone <this-repo>
cd muse
npm ci

# 2. Configure secrets
cp .env.example .env
# Fill in: GEMINI_API_KEY, AIMLAPI_API_KEY, FEATHERLESS_API_KEY,
#         FIREWORKS_API_KEYS, MUSE_BUYER_PRIVATE_KEY (Arc Testnet test wallet)

# 3. Start everything (frontend + backend + 4 agent servers)
npm run dev:full
```

Open <http://localhost:3000>. Connect MetaMask (Arc Testnet, USDC native gas),
deploy your orchestrator, fund it from MetaMask, type a task, watch 50+ paid
micropayments stream live in the wallet ledger.

---

## Hackathon proof

The mandatory ≤ $0.01-per-action / 50+ on-chain transactions / margin-vs-gas
proof is verifiable end-to-end:

```bash
node scripts/live-hackathon-proof.mjs
```

Produces `artifacts/hackathon-live/latest.json` with 52 real Arc Testnet tx
hashes. Audit the artifact against Arc RPC:

```bash
node scripts/_audit-wallets.mjs
```

Expected output: `52/52 mined, $0.248 = $0.248, 15 unique recipient wallets,
0 reverts`.

**Margin math:** $0.005/action × 52 = $0.260 USDC on Arc, vs $2.50 gas/tx ×
52 = $130 on Ethereum L1 — a **500× margin restoration** that makes
agent-to-agent commerce economically viable for the first time.

---

## Architecture

```
┌──────────────┐   socket   ┌──────────────────┐  x402 + Gateway
│   Next.js    │◀──────────▶│   Hermes / Arc   │◀──────────────────┐
│  (Vercel)    │   /api     │   orchestrator   │                   │
└──────────────┘            └──────────────────┘                   │
                                     │                             │
                                     ▼                             │
                       ┌────────────────────────────┐              │
                       │   4 agent services         │              │
                       │  strategy │ search │       │──────────────┘
                       │  copy     │ image          │   per-call
                       └────────────────────────────┘   USDC settle
                                     │
                                     ▼
                              Arc Testnet  ←  ERC-8004 registry
```

---

## Deploy

- `frontend/` → Vercel (set `BACKEND_INTERNAL_URL` to backend public URL)
- Everything else → Railway / Render / Fly.io (`docker-compose.yml` ships
  six services and a Postgres add-on)

See `docker-compose.yml`, `vercel.json`, and `render.yaml` for reference
configurations.

---

## License

MIT
