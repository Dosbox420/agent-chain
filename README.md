# agent-chain

Building blocks for an **autonomous agent that can hold, spend, and earn money
under policy** — machine-to-machine, no human in the loop for the routine path.

This repo is the working artifact: a policy-gated treasury, an x402 payment rail
(HTTP 402 / USDC), an on-chain agent identity, and an agent-owned inbox. Every
component below is **verified, not described** — each row links to a real
on-chain transaction, agent ID, or live response.

> **The honest finding that shaped this repo.** The agent-commerce *infrastructure*
> is real and working. The seller *economy* is not, yet. Median x402 seller
> revenue is ~$0.06/month; 38% earn nothing; the top 10 sellers take ~98.5% of
> volume. So the x402 rail here is treated as a **capability**, not a business
> model. Real revenue comes from B2B services and grants while the rails mature.
> See [`docs/landscape.md`](docs/landscape.md).

---

## What's in here

| Component | What it does | Proof |
|---|---|---|
| **Policy-gated treasury** (`treasury.py`) | Every spend checked against a declarative policy: per-tx / daily / hard ceilings, human-approval threshold, append-only ledger. Refuses over-limit spends. | Test transfer settled: `4BZeM6sD3eAo91cvw1VARwFdPPyr6H6K3yR2x3PxoPcH88Ag4oDb73iRYV73Dtmya5T5ytTSbmXrMv66bF4wEC42` |
| **x402 paid rail** (`server.mjs`, `funding_server.mjs`) | Sells a machine-readable service per call in USDC over HTTP 402 — no accounts, no API keys, no invoices. | Settled on Base Sepolia: tx `0xe08ff2a7d3021f0135ce74cd1e108193d000de91306c4fe00569f570742c5181` |
| **x402 paying client** (`client.mjs`, `verify_settlement.mjs`) | The agent side: probes the 402 challenge, signs an EIP-3009 authorisation, retries, proves on-chain balance deltas. | Balance-delta proof in `verify_settlement.mjs` output |
| **On-chain identity** (`erc8004_register.mjs`) | Registers the agent in the ERC-8004 Identity Registry; token URI is a live agent card (services, pricing, contact). | **agentId 9620** on Base Sepolia |
| **Agent-owned inbox** (`agent_mail.mjs`) | The agent's own address (`bongs@agentmail.to`) — send/receive, no human mailbox. | Live |
| **Self-provisioning** (`agentmail_x402_buy.mjs`) | The agent buys its *own* infrastructure: pays 2.00 USDC over x402 to provision an inbox. Closes the loop at exactly one boundary — having real funds. | Runs to funding boundary |
| **Funding page** (`fund.html`) | Patronage rail — pay for software, get a receipt. No token, no equity, no return (deliberate). | Served by `funding_server.mjs` |

---

## Architecture

```
                    ┌──────────────────────────────┐
                    │  ERC-8004 identity (9620)     │  who the agent is,
                    │  agent card: services+pricing │  discoverable on-chain
                    └──────────────────────────────┘
                                  │
     buyer (human or agent)       │
        │                         ▼
        │  GET /signal/:topic  ──► 402 Payment Required  (+ accepts[])
        │  GET … + X-PAYMENT   ──► verify → settle on-chain → 200 OK + receipt
        ▼
   ┌─────────────────┐   spend request   ┌──────────────────────┐
   │  x402 rail      │ ────────────────► │ policy-gated treasury │
   │ (server.mjs)    │                   │  limits · allowlist   │
   └─────────────────┘                   │  human threshold      │
                                         │  append-only ledger   │
                                         └──────────────────────┘
```

The treasury is the safety layer: an agent with an unrestricted key is both
drainable **and** destroys human oversight. Bounding autonomy — with limits,
logging, and a human threshold — is the point.

---

## Quickstart

```sh
npm install
cp .env.example .env          # then fill in your own keys

# 1. Run the paid resource server (x402)
node server.mjs               # http://localhost:4021/report  -> 402

# 2. Probe + buy from the agent side
node client.mjs               # sees the 402 challenge, then pays
node verify_settlement.mjs    # prints exact on-chain balance deltas

# 3. Treasury state + audit trail
python3 treasury.py
cat ledger.jsonl              # every spend, append-only
```

`agent_mail.mjs` and `erc8004_register.mjs` need `AGENTMAIL_API_KEY` and a funded
`PAYER_PRIVATE_KEY` respectively (both read from the environment — never committed).

---

## Security model

- **No secrets in the tree.** `.env`, key files, ledgers, and vendor state are
  git-ignored. The only private key in the repo is the well-known public Anvil
  test key (`#1`) used as a fallback for local demos.
- **Least authority for the agent.** Spend limits and a human-approval threshold
  are enforced *before* signing, not documented after.
- **Append-only ledger.** Every executed or refused spend is logged.
- **Testnet only.** All proofs here are on Base Sepolia / a local validator.
  The treasury key used during development was rotated and is not funded.

## Hard lines

- No token marketed to third parties with profit promises — that is an
  unregistered securities offering in both AU and US.
- Testnet until there is real revenue and a legal entity.
- Every agent action auditable.

## Status

Working testnet deployment. Next: public host + demo, grant applications,
and a B2B service engagement as the first real revenue (the rails are already
built for it).

## License

MIT — see [`LICENSE`](LICENSE).
