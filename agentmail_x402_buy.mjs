/**
 * agentmail_x402_buy.mjs — the agent buys its OWN inbox with USDC.
 *
 * No API key. No OAuth. No human email. No console. The agent pays 2.00 USDC
 * over x402 (HTTP 402) and receives a provisioned inbox.
 *
 * This is the fully-autonomous identity path: an agent that can acquire its own
 * infrastructure with money it earned.
 *
 * Uses the v2 x402 stack (@x402/fetch + @x402/evm), which is what AgentMail's
 * x402 integration expects — distinct from the v1 unscoped packages
 * (x402-express / x402-fetch) used by the resource server.
 *
 * Requires: a wallet holding >= 2.00 USDC on Base MAINNET (chain 8453).
 *
 * Usage:
 *   PAYER_PRIVATE_KEY=0x... node agentmail_x402_buy.mjs [username]
 */
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { AgentMailClient } from "agentmail";

const PK = process.env.PAYER_PRIVATE_KEY;
const USERNAME = process.argv[2] || `mda-${Date.now().toString(36)}`;

if (!PK) {
  console.error("PAYER_PRIVATE_KEY required (wallet with >= 2.00 USDC on Base).");
  process.exit(1);
}

const signer = privateKeyToAccount(PK);
console.log("payer:", signer.address);

// ---- x402 client ----
const x402 = new x402Client();
x402.register("eip155:*", new ExactEvmScheme(signer));

// inbox creation is priced at $2.00, above the client's $1 default cap
x402.setSpendControls({ maxAmountPerPayment: "$2" });
console.log("spend control raised to $2 (inbox = $2.00 USDC)");

// ---- step 1: probe the challenge WITHOUT paying ----
console.log("\n[1] probing x402.api.agentmail.to for the price...");
try {
  const probe = await fetch("https://x402.api.agentmail.to/v0/inboxes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME }),
  });
  console.log("    status:", probe.status, probe.status === 402 ? "(payment required - correct)" : "");
  if (probe.status === 402) {
    const body = await probe.json();
    for (const opt of body.accepts ?? []) {
      console.log(`      ${opt.network.padEnd(34)} ${Number(opt.amount) / 1e6} USDC  -> ${opt.payTo}`);
    }
  }
} catch (e) {
  console.log("    probe error:", e.message);
}

// ---- step 2: attempt the paid purchase ----
console.log("\n[2] attempting paid inbox creation...");
const client = new AgentMailClient({ x402 });

try {
  const inbox = await client.inboxes.create({ username: USERNAME });
  console.log("    INBOX CREATED");
  console.log("      id:      ", inbox.inboxId ?? inbox.inbox_id);
  console.log("      email:   ", inbox.email);
} catch (e) {
  const msg = e.body?.message ?? e.message ?? String(e);
  console.log("    failed:", msg.slice(0, 300));
  if (/insufficient|balance|funds|402|payment/i.test(msg)) {
    console.log("\n    -> payer needs >= 2.00 USDC on Base MAINNET (chain 8453).");
    console.log("       This wallet holds testnet funds only, so the purchase cannot settle.");
  }
}
