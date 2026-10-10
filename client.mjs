/**
 * x402 paying client — the agent side of machine-to-machine commerce.
 *
 * Demonstrates the full flow:
 *   1. GET a paid resource -> receive HTTP 402 + payment requirements
 *   2. Sign a USDC payment authorisation (EIP-3009 transferWithAuthorization)
 *   3. Retry with X-PAYMENT header
 *   4. Facilitator verifies + settles on-chain; resource is released
 *
 * Run:  node client.mjs [url]
 */
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const URL_TO_BUY = process.argv[2] || "http://localhost:4021/report";

// A payer key. On testnet this can be any throwaway key; it must hold
// testnet USDC on Base Sepolia to actually settle.
const PAYER_KEY = process.env.PAYER_PRIVATE_KEY
  || "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1 (public)

const account = privateKeyToAccount(PAYER_KEY);
console.log("payer address:", account.address);

const paidFetch = wrapFetchWithPayment(fetch, account);

// --- step 1: probe the endpoint WITHOUT paying (observe the 402 challenge) ---
console.log("\n[1] probing without payment...");
const probe = await fetch(URL_TO_BUY);
console.log("    status:", probe.status, probe.status === 402 ? "(payment required - correct)" : "");
if (probe.status === 402) {
  const body = await probe.json();
  const req = body.accepts?.[0];
  if (req) {
    console.log("    challenge:");
    console.log("      scheme:  ", req.scheme);
    console.log("      network: ", req.network);
    console.log("      amount:  ", req.maxAmountRequired, "(6dp -> USDC)");
    console.log("      asset:   ", req.asset);
    console.log("      payTo:   ", req.payTo);
  }
}

// --- step 2: attempt the paid call ---
console.log("\n[2] attempting paid call...");
try {
  const res = await paidFetch(URL_TO_BUY);
  if (res.ok) {
    const data = await res.json();
    console.log("    PAID OK - resource released");
    console.log("    settlement:", res.headers.get("x-payment-response")?.slice(0, 120) || "(none)");
    console.log("    data:", JSON.stringify(data).slice(0, 300));
  } else {
    const txt = await res.text();
    console.log("    not released. status:", res.status);
    console.log("    body:", txt.slice(0, 400));
    if (res.status === 402 || /insufficient|balance|funds/i.test(txt)) {
      console.log("\n    -> payer has no testnet USDC. Fund", account.address,
                  "with Base Sepolia USDC, then re-run.");
    }
  }
} catch (e) {
  console.log("    payment flow error:", e.message?.slice(0, 300));
}
