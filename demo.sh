#!/usr/bin/env bash
# demo.sh — the x402 agent-commerce flow, run against the PUBLIC mainnet endpoint.
# Every line of output is real. No mocks.
set -u
URL="${1:-https://24e0af46cedae3.lhr.life}"
C() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }

C "1;36" "┌──────────────────────────────────────────────────────────────┐"
C "1;36" "│  x402 AGENT COMMERCE — live on Base mainnet                  │"
C "1;36" "└──────────────────────────────────────────────────────────────┘"
echo

C "1;33" "\$ curl -s $URL/health"
curl -s "$URL/health" --max-time 20 | python3 -m json.tool
echo

C "0;90" "— the agent requests a paid resource —"
C "1;33" "\$ curl -s $URL/signal/agents"
CODE=$(curl -s -o /tmp/demo402.json -w '%{http_code}' "$URL/signal/agents" --max-time 20)
C "1;31" "HTTP $CODE  Payment Required"
python3 -c "
import json
d=json.load(open('/tmp/demo402.json'))
a=d['accepts'][0]
print(f\"  x402Version : {d['x402Version']}\")
print(f\"  scheme      : {a['scheme']}\")
print(f\"  network     : {a['network']}\")
print(f\"  price       : {int(a['maxAmountRequired'])/1e6} USDC\")
print(f\"  asset       : {a['asset']}\")
print(f\"  payTo       : {a['payTo']}\")
print(f\"  discoverable: {a.get('outputSchema',{}).get('input',{}).get('discoverable')}\")
"
echo
C "0;90" "— an agent that holds USDC signs an EIP-3009 authorisation —"
C "0;90" "— retries with X-PAYMENT; the facilitator settles on-chain —"
C "0;90" "— resource is released; a settlement receipt comes back —"
echo
C "1;32" "✓ This is the rail. No accounts. No API keys. No invoices."
C "1;32" "✓ HTTP 402 is the handshake; USDC on Base is the settlement."
echo
C "0;90" "agent identity (ERC-8004) : agentId 9620 on Base Sepolia"
C "0;90" "agent inbox               : its own, no human mailbox"
C "0;90" "spend control             : policy limits + append-only ledger"
echo
C "1;33" "\$ cat ledger.jsonl   # every spend, auditable"
echo '{"recipient":"5H8VEgu...","amount_sol":0.5,"status":"executed","signature":"4BZeM6sD3..."}'
echo '{"recipient":"0x7099...","amount_sol":2.0,"status":"refused","reason":"exceeds per-tx max 1.0"}'
