# agent-chain

Policy-gated treasury + token deployment tooling for an autonomous agent on Solana.

## What this is
Infrastructure that lets an AI agent operate a crypto wallet **without** holding
unbounded spend authority. Every spend is evaluated against a declarative policy,
logged to an append-only ledger, and auto-approved / queued-for-human / refused.

## Why
An agent with an unrestricted key is (a) drainable and (b) destroys the human
oversight defence. This makes autonomy bounded and auditable.

## Verified on-chain (local validator)
- Mint: `GYnqJDagTwbkjPxCpnbXofHTEcqLaG1wGGij4U4bhYJk` (supply 1e9, authority revoked)
- Transfer: `4BZeM6sD3eAo91cvw1VARwFdPPyr6H6K3yR2x3PxoPcH88Ag4oDb73iRYV73Dtmya5T5ytTSbmXrMv66bF4wEC42`

## Usage
    python3 treasury.py            # show state
    # see ledger.jsonl for audit trail

## Policy
per_tx_max=1.0 SOL, daily_max=5.0, hard_ceiling=20.0, require_human_above=1.0
