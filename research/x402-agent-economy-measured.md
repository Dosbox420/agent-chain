# The x402 Agent Economy: A Measured Study

**Date:** 2026-10-11
**Method:** Full enumeration of facilitator discovery catalogues, deduplicated.
**Sample:** 2,393 unique paid resources across 397 sellers and 531 hosts,
pulled live from PayAI (`facilitator.payai.network`) and Coinbase CDP
(`api.cdp.coinbase.com/platform/v2/x402`).

This is a measurement, not an estimate. Every number below is computed from the
raw catalogue data, which is saved alongside this file.

---

## 1. What is actually listed

| Metric | Value |
|---|---|
| Unique paid resources | **2,393** |
| Distinct sellers (payTo address) | **397** |
| Distinct hosts | **531** |
| Distinct service names | 880 |
| Networks | Base 1,917 · Base-Sepolia 213 · Solana 212 · others 51 |

**Base mainnet dominates at 80%.** Base Sepolia (213 listings) is testnet traffic
sitting in the same production catalogue — worth noting for anyone treating
listing counts as a demand signal.

---

## 2. Price distribution — the market is not priced

| Band | Listings | Share |
|---|---|---|
| FREE | 29 | 1.2% |
| < $0.001 | 210 | 9.0% |
| $0.001–0.005 | 431 | 18.4% |
| **$0.005–0.01** | **1,375** | **58.6%** |
| $0.01–0.05 | 257 | 11.0% |
| $0.05–0.25 | 26 | 1.1% |
| $0.25–1 | 12 | 0.5% |
| > $1 | 6 | 0.3% |

- **Median: $0.010000** — exactly one cent
- **56.1% of all listings sit at precisely $0.01**

That is not price discovery. It is the default value from the SDK examples. The
distribution is a spike, not a curve. In a functioning market, sellers who
underprice attract volume and prices migrate; here nothing has moved off the
sample value.

**Implication for anyone building here:** $0.01 is not a market-clearing price,
it is a placeholder. A seller who actually prices on value has no competition
signal to work from.

---

## 3. Catalogue concentration

- **53% of sellers (210 of 397) have exactly one listing.**
- **Top 1% of sellers hold 41.7% of all listings.**
- A single seller (`0xFC24…eBB3`) holds **870 listings — 36% of the entire catalogue**
- That seller operates `intel.rallylive.ca` and subdomains (dns./library./email./site.), 819 listings, all at $0.01

| Host | Listings |
|---|---|
| dns.intel.rallylive.ca | 228 |
| intel.rallylive.ca | 220 |
| library.intel.rallylive.ca | 205 |
| email.intel.rallylive.ca | 126 |
| saylorinnovations.com | 90 |
| site.intel.rallylive.ca | 40 |

**The catalogue is one operator's bulk-generated DNS/email intelligence lookup
table, plus a long tail of single-listing experiments.** Any statistic of the form
"the x402 economy has N listings" is really measuring one person's route generator.

---

## 4. A real pricing bug — and a correction

Scanning for mispriced listings surfaced a genuine defect:

**`pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest` is listed at
`10000000000000000` raw units — $10,000,000,000.00 per call.**

Verified live: the endpoint returns HTTP 402 advertising exactly that amount on
BNB chain (`eip155:56`), asset `0xcE24439F2D9C6a2289F741120FE202248B666666`. This
is almost certainly a decimal-scaling error, but it is live in the production
discovery catalogue.

### Correction to an earlier over-claim

My first read of this was that "an agent would attempt a ten-billion-dollar
payment." **That is wrong, and I checked it rather than shipping it.** Both
clients ship sane default spend caps:

| Client | Default cap | Source |
|---|---|---|
| `x402-fetch` (v1) | **$0.10** | `maxValue = BigInt(0.1 * 10 ** 6)` |
| `@x402/core` (v2) | **$1.00** | `DEFAULT_MAX_AMOUNT_PER_PAYMENT = "$1"` |

So the default configuration would refuse the $10bn listing. The real finding is
narrower and more precise — **the cap is conditional, and two ordinary configs
disable it entirely:**

```javascript
// @x402/core/dist/cjs/client/index.js
function resolveAtomicSpendCap(controls, requirement, defaultAsset) {
  if (controls === false) return void 0;                    // (1) explicit opt-out
  ...
  if (!defaultAsset || controls.maxAmountPerPayment === false)
    return void 0;                                          // (2) no defaultAsset -> NO CAP
  const usdLimit = controls.maxAmountPerPayment ?? DEFAULT_MAX_AMOUNT_PER_PAYMENT;
  return convertToTokenAmount(parseMoney(usdLimit).amount, defaultAsset.decimals);
}
```

- If the integrator sets `spendControls: false` → uncapped, by design.
- If no `defaultAsset` is configured → the cap resolves to `undefined` → **uncapped**.
- The cap is also expressed in USD and converted per-asset, so an unrecognised
  asset with no `defaultAsset` falls through to the uncapped branch.

**So: the protocol has no price ceiling, the SDKs default to a sane one, and
there are two configuration paths where the ceiling silently disappears.** An
agent operator who does not know which branch they are on cannot tell whether
they are protected. That is the actionable finding — not that agents are
defenceless, but that the defence is easy to lose without noticing.

---

## 5. What is being sold

Top tags across the catalogue:

| Tag | Count |
|---|---|
| free | 298 |
| subject | 262 |
| public-domain | 199 |
| books | 189 |
| email | 139 |
| domain | 122 |
| registry | 121 |
| tld | 119 |
| iana | 119 |
| hosting | 114 |
| audiobooks | 100 |
| librivox | 100 |

**Dominant categories: static reference data (DNS, domain, TLD, email-auth
records) and public-domain content (Project Gutenberg books, LibriVox
audiobooks).**

These are the categories that get listed because they are *trivially
automatable* — the content already exists, the endpoint is a lookup. They are
also the categories with the least willingness-to-pay, since the same data is
free elsewhere. The listings that exist are the ones easiest to create, not the
ones anyone needs.

---

## 7. Competitive intelligence: who actually sells "agent readiness"

The security/audit category has **35 live listings** at $0.005–$0.08. The
closest real competitor to what I built:

**`agent-ready.dev/api/x402/scan`** — "Pay-per-scan AI agent-readability scan.
POST with an X-PAYMENT header, no account or subscription. Two tiers: $0.02 (25
pages) and $0.25 (250 pages), USDC on Base."

What makes it the reference example of a *serious* x402 seller, in contrast to
the bulk-generated majority:

| Signal | agent-ready.dev | typical catalogue listing |
|---|---|---|
| Description | Full sentence, states the product | absent or one word |
| Pricing | **Tiered** ($0.02 / $0.25) | flat $0.01 default |
| Discovery | `bazaar` extension registered | bare listing |
| Positioning | "no account or subscription" | none |
| Verdict | gated 402, real terms | often 404 / free |

Every serious seller in the catalogue shares those traits. Every unserious one
is a single route at the default cent with no description.

**The differentiator is not the protocol work. It is the product definition,
the pricing, and the discovery registration** — the three things the
bulk-generated 56% skip entirely.

---

## 8. The structural read

Putting the four measurements together:

1. **Supply is bulk-generated, not demand-driven.** 36% of the catalogue is one
   operator's generated route table; 53% of sellers tried once and listed one thing.
2. **Prices are unset.** 56% at the default cent; no evidence of price movement.
3. **The listed products are commodities with free substitutes.** DNS records,
   SPDX facts, Gutenberg texts.
4. **There is no price ceiling**, and the catalogue contains a $10bn listing.

The consistent explanation: **listing is nearly free and buying is not.** A
seller can enumerate a thousand routes at zero marginal cost, so the catalogue
fills with whatever is cheapest to produce. A buyer must fund a wallet, discover
a service, price-check it, and pay — real friction at every step. Supply floods
in; demand does not follow.

This matches the previously measured revenue data (median seller ~$0.06/month).
The catalogue size is a measure of *how cheap it is to list*, not of economic
activity.

---

## 9. What this means for building an agent business here

- **Do not compete on catalogue breadth.** Listing more is free for everyone and
  buys nothing.
- **Do not price at $0.01** unless the product is genuinely a commodity. The
  default is a placeholder, and the market has not discovered anything better.
- **Implement price sanity bounds.** The $10bn listing is proof that discovery
  data cannot be trusted; a client without an upper bound is a liability.
- **Sell what cannot be bulk-generated.** Everything dominating this catalogue is
  either public-domain content or a lookup against a public registry — the two
  things a buyer can most easily self-serve.
- **The bottleneck is demand, and demand is a distribution problem**, not a
  technical one. No amount of protocol work fixes a catalogue nobody is shopping in.

---

## Reproduce

```bash
cd ~/.hermes/cache/scratch/econ_study
# catalogue was pulled with:
curl -s "https://facilitator.payai.network/discovery/resources?limit=200&offset=N"
curl -s "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=200&offset=N"
# raw data: all_resources.jsonl (2,400 records)
```

## Files

- `~/.hermes/cache/scratch/econ_study/all_resources.jsonl` — raw catalogue
- `~/.hermes/01_executive_brain/security/x402-ecosystem-conformance-scan.md` — the gating scan
