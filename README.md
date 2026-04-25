# Muse DNA

An AI marketing agency where every action — every Gemini call, every search
query, every banner render — costs a sub-cent USDC payment on Arc Testnet.
Fifty-plus paid micro-actions per task, all settled on-chain in real time.

The twist: **the agency learns your brand**. Run a task once for "AutoCRM"
and Muse mints an `autocrm.dna.md` brand-memory file. Run it again — Hermes
skips the strategy work it already did, reuses 21 out of 24 strategy blocks,
and the second run lands at roughly **80% less cost and 3× faster**. Brand
capital that compounds.

Track: **Agent-to-Agent Payment Loop**.

Live demo: <https://muse-dna.vercel.app>

---

## Why I built it this way

I tried building this on Ethereum L1 first. Fifty-two micro-actions cost
**$130 in gas alone** — to move twenty-six cents of actual value. Five-
hundred-times overhead. Every "AI agent that charges per call" idea I'd seen
was either subscription-based (boring) or settled in batches with no real
on-chain trace per action (not really agentic). The economics just didn't
work, and you could feel it.

Arc + Circle Gateway + x402 fix the math. USDC is native gas, Gateway batches
EIP-3009 signatures into one Arc settle, and the orchestrator also broadcasts
a per-action native USDC transfer so judges can click each transaction hash
on ArcScan. Per-action pricing finally has positive unit economics.

---

## The DNA layer (what makes this different)

Most submissions on this track ship a one-shot pipeline: prompt goes in,
output comes out, agents start from zero next time. Muse accumulates.

After the first task, Hermes synthesizes a markdown brand-DNA file containing:

- core promise · audience pains · tone do's & don'ts
- hook angles · channel briefs · KPI frames
- timeline of post-launch analytics (you paste them in the DNA tab and the
  next run uses them)

Next task on the same brand: the planner reads the DNA, marks 21/24 strategy
blocks as "already known", and only spawns paid agents for the tactical
layers it actually needs. The frontend tells you exactly:

> NEXT RUN ON AUTOCRM REUSES `21/24 BLOCKS` · ESTIMATED COST `$0.052`
> · SAVES `$0.196`

That's the only way I've seen agentic commerce stay economically viable past
the first run. Once-shot competitors keep paying 100% of the bill on every
repeat.

---

## Stack — every hackathon partner is wired in, not just claimed

**Payment / settlement (Circle)**

- Arc Testnet (chain `5042002`, USDC as native gas, 18 decimals)
- `@circle-fin/x402-batching` — Gateway batch settle
- x402 protocol — EIP-3009 signed authorizations per agent `/execute` call
- CCTP v2 — dividend withdrawal cross-chain (Base, Ethereum, etc.) from the
  `/wallet` route
- Per-user orchestrator wallets pinned 1:1 to MetaMask address — no custodial
  intermediary, judges bring their own wallet

**Trust layer**

- `MuseAgentRegistry.vy` deployed on Arc — ERC-8004-inspired identity + on-chain
  reputation
- Every settled action calls `record_payment(agent, amount_micro)` on-chain
- Reputation is readable by the planner — agents that misbehave get less work

**AI layer (4-provider cascade)**

- **Gemini 3 Pro** — Hermes orchestrator uses Function Calling to plan tiers
  (Lite / Balanced / Deep), pick brand names from prompts, and route tool calls
  to Circle / Arc APIs
- **AIMLAPI** — primary fallback for chat & image
- **Featherless** — secondary fallback for specialized OSS models
- **Fireworks** — tertiary image fallback, 5 rotation keys with a 5-minute
  quarantine on any 401/402/403/429

The whole cascade is wired with circuit breakers. If Gemini hits 429,
AIMLAPI picks up. If AIMLAPI runs out of credits, Featherless. If Featherless
can't do an image, Fireworks Flux-Schnell. If everything fails, the agent
emits a degraded receipt instead of pretending it succeeded. Most demos in
this space die the first time one provider's free tier runs out — Muse
shrugs and routes around it.

---

## Hackathon proof — verifiable by anyone with the repo

The mandatory boxes (≤ $0.01 per action, 50+ on-chain transactions, margin
explanation) are not in slide bullet points. They're in a JSON artifact you
can audit:

```bash
# end-to-end stress test against Arc Testnet — produces the proof artifact
node scripts/live-hackathon-proof.mjs

# audit every tx hash against Arc RPC (don't trust me — run this)
node scripts/_audit-wallets.mjs
```

Expected output:

```
mined OK:                52 / 52
reverted (status=0x0):     0
missing on-chain:          0
total on-chain USDC:      $0.248000
total claimed USDC:       $0.248
delta:                    $0.000000

15 unique recipient wallets:
  5× strategy ($0.120) · 2× search ($0.024) · 4× copy ($0.050) · 4× image ($0.054)
```

That's 52 distinct on-chain transfers, one buyer wallet, fifteen unique agent
wallets, every amount matching the artifact, every receipt confirmed by the
default Arc RPC.

**Margin math:**

```
$0.005/action × 52 = $0.260 USDC on Arc
$2.50 gas/tx × 52  = $130   on Ethereum L1
                   = 500× margin restoration via Arc batch settle
```

---

## Architecture

```
Judge's MetaMask ──signs──▶ per-user Orchestrator (on Arc)
                                    │
                                    ▼
                    Hermes Planner — Gemini Function Calling
                                    │
                              picks tier (lite/balanced/deep)
                                    │
                                    ▼
                  4 paid services × N fresh wallets per task
            ┌─────────────┬──────────────┬───────────┬───────────┐
            │  Strategy   │  Fast Search │  Copy     │  Image    │
            │   x5        │   x2         │   x4      │   x4      │
            └─────────────┴──────────────┴───────────┴───────────┘
                                    │
                            x402 EIP-3009 sig per call
                                    ▼
                Circle Gateway batch settle  ──▶  Arc Testnet receipt
                                                  ↓
                                          testnet.arcscan.app
```

Fifteen fresh worker wallets per task (the count varies with tier). Each
agent runs as its own Express server with its own x402 facilitator. The
orchestrator privkey is the only secret the backend holds — and it's pinned
to the connected MetaMask address so no two users share state.

---

## Run it locally

```bash
git clone https://github.com/RoninBuild/muse-dna.git
cd muse-dna
npm ci

cp .env.example .env
# Fill in: GEMINI_API_KEY, AIMLAPI_API_KEY, FEATHERLESS_API_KEY,
#         FIREWORKS_API_KEYS, MUSE_BUYER_PRIVATE_KEY (Arc Testnet wallet)

npm run dev:full
```

That spins up:

| port | what                               |
|------|------------------------------------|
| 3000 | Next.js frontend                   |
| 3001 | Express backend + Socket.io ledger |
| 3101 | Strategy DNA agent                 |
| 3102 | Fast Search agent                  |
| 3103 | Copy Pulse agent                   |
| 3104 | Visual Frame (image) agent         |

Open <http://localhost:3000>. Connect MetaMask (Arc Testnet, USDC as native
gas), deploy your orchestrator, fund it with about $0.30 from MetaMask, type
a task. Hermes plans three tiers, you pick one, fifteen fresh wallets spawn
and start streaming x402 micropayments. Every transaction hash in the live
ledger is clickable — opens straight to ArcScan.

---

## What's shipped vs what's next

**Shipped:**

- x402 micropayments on Arc Testnet, audit-verified at 52/52
- Circle Gateway batch settle with auto-deposit preflight (no half-broken runs)
- ERC-8004 registry contract on Arc, agent reputation tracked on-chain
- Brand-memory DNA — persisted markdown + analytics composer + reuse on next run
- Hermes orchestrator on Gemini 3 Pro with Function Calling (Deep Think for
  tier selection)
- 4-provider LLM cascade with circuit breakers and per-key quarantine
- Live ledger UI: per-wallet 3×5 grid, scanline on in-flight, bloom on settled,
  margin proof panel
- Audit script anyone can run against public Arc RPC

**Roadmap (post-hackathon):**

- SIWE per-task signing — backend middleware is already wired, frontend
  signing flow is the next merge
- KMS / argon2-derived encryption for orchestrator keys at rest (today they
  live in a gitignored JSON file, fine for testnet, not for mainnet)
- One-click CCTP dividend withdrawal directly from `/wallet`
- Hermes auto-tune from the analytics composer — paste your post-launch
  numbers and the next run's tone shifts toward what worked
- Mainnet deploy when Arc ships production

---

## Deploy

- `frontend/` → Vercel. Root Directory `frontend`. Set `BACKEND_INTERNAL_URL`
  + `NEXT_PUBLIC_BACKEND_URL` to your backend URL — `next.config.mjs` rewrites
  `/api/*` and `/socket.io/*` so the frontend never has to know about CORS.
- backend + 4 agents + Postgres → Render / Railway / Fly. `render.yaml` and
  `docker-compose.yml` ship a six-service blueprint that deploys end-to-end.

The live demo runs Vercel + Render with the Postgres add-on. Cold start on
free tiers takes ~20 seconds — wake the backend with one request before the
demo if you're presenting.

---

## License

MIT
