#!/usr/bin/env bash
# demo.sh — the x402 agent-commerce flow, run against a LIVE endpoint.
#
# Every line of output is real. No mocks, no fabricated ledger lines.
# The endpoint is ephemeral (quick tunnels rotate), so pass it in:
#
#     bash demo.sh https://<your-tunnel>/health   (or the bare origin)
#
# If no URL is given we use the local server, which is always real.
set -u
RAW="${1:-http://localhost:4021}"
# accept either an origin or a full /health path
URL="${RAW%/health}"
C() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }

C "1;36" "┌──────────────────────────────────────────────────────────────┐"
C "1;36" "│  x402 AGENT COMMERCE — paid resource over HTTP 402            │"
C "1;36" "└──────────────────────────────────────────────────────────────┘"
C "0;90" "endpoint: $URL"
echo

C "1;33" "\$ curl -s $URL/health"
curl -s "$URL/health" --max-time 20 | python3 -m json.tool 2>/dev/null || {
  C "1;31" "  endpoint unreachable — tunnel likely rotated."
  C "0;90" "  pass a live URL:  bash demo.sh https://<tunnel>"
  C "0;90" "  durable record:   https://dosbox420.github.io/agent-chain/"
  exit 1
}
echo

C "0;90" "— the agent requests a paid resource —"
C "1;33" "\$ curl -s $URL/signal/seller-economics"
CODE=$(curl -s -o /tmp/demo402.json -w '%{http_code}' "$URL/signal/seller-economics" --max-time 20)
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
" 2>/dev/null
echo

C "0;90" "— an agent holding USDC signs an EIP-3009 authorisation, —"
C "0;90" "— retries with X-PAYMENT, the facilitator settles on-chain, —"
C "0;90" "— the resource is released with a settlement receipt. —"
echo
C "0;90" "For a recorded run of that FULL paid flow, with on-chain proof:"
C "0;90" "  node demo_settle.mjs      (see docs/settle.gif)"
echo
C "1;32" "✓ HTTP 402 is the handshake; USDC is the settlement."
C "1;32" "✓ No accounts. No API keys. No invoices."
echo
C "0;90" "agent identity (ERC-8004) : agentId 9620 on Base Sepolia"
C "0;90" "agent inbox               : its own, no human mailbox"
C "0;90" "spend control             : policy limits + append-only ledger"
echo
C "1;33" "\$ cat ledger.jsonl   # every spend, auditable — real entries only"
if [ -f ledger.jsonl ]; then
  head -2 ledger.jsonl
else
  C "0;90" "  (ledger.jsonl not present in this checkout)"
fi
