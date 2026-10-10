/**
 * list_on_bazaar.mjs — get our resource CATALOGUED in the x402 Bazaar, at $0.
 *
 * Discovery is not funding-gated the way we assumed. PayAI's facilitator
 * catalogs resources from /verify requests, and /verify does NOT move funds.
 * We have a funded testnet payer, so we can submit a GENUINE signed payload
 * (passes verification) rather than a fake one.
 *
 * Run: node list_on_bazaar.mjs
 */
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const FACILITATOR = "https://facilitator.payai.network";
const PUBLIC_URL = process.env.PUBLIC_URL;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1
const PAY_TO = process.env.TREASURY || "0x56D390539A0227C3a418D1e7f06f446b2EE2e351";

if (!PUBLIC_URL) {
  console.error("Set PUBLIC_URL (the public origin, no trailing slash)");
  process.exit(1);
}

const log = (...a) => console.log(...a);
const account = privateKeyToAccount(PAYER_KEY);
const client = createPublicClient({ chain: baseSepolia, transport: http() });

// --- 1. pull the live challenge from our own public endpoint ---
log(`[1] fetching the live 402 from ${PUBLIC_URL}/signal/seller-economics`);
const res = await fetch(`${PUBLIC_URL}/signal/seller-economics`);
log(`    HTTP ${res.status}`);
if (res.status !== 402) {
  log("    expected 402 — is the listed_server running behind that URL?");
  process.exit(1);
}
const challenge = await res.json();
const req = challenge.accepts[0];
log(`    network=${req.network} price=${Number(req.maxAmountRequired) / 1e6} USDC`);
log(`    resource=${req.resource}`);

// --- 2. sign a REAL EIP-3009 authorization (this is the part that passes verify) ---
log(`\n[2] signing a real EIP-3009 transferWithAuthorization as ${account.address}`);
const now = Math.floor(Date.now() / 1000);
const auth = {
  from: account.address,
  to: req.payTo,
  value: req.maxAmountRequired,
  validAfter: String(now - 60),
  validBefore: String(now + (req.maxTimeoutSeconds || 600)),
  nonce:
    "0x" +
    [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
};
const domain = {
  name: "USDC",
  version: "2",
  chainId: baseSepolia.id,
  verifyingContract: USDC,
};
const types = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
const signature = await account.signTypedData({
  domain,
  types,
  primaryType: "TransferWithAuthorization",
  message: {
    from: auth.from,
    to: auth.to,
    value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce,
  },
});
log(`    signed. signature=${signature.slice(0, 22)}…`);

const paymentPayload = {
  x402Version: 1,
  scheme: "exact",
  network: req.network,
  payload: { signature, authorization: auth },
};

// --- 3. submit to /verify (moves NO funds) ---
log(`\n[3] POST ${FACILITATOR}/verify  (verification only — no funds move)`);
const body = { x402Version: 1, paymentPayload, paymentRequirements: req };
const vres = await fetch(`${FACILITATOR}/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const vjson = await vres.json();
log(`    HTTP ${vres.status}`);
log(`    ${JSON.stringify(vjson).slice(0, 400)}`);

// --- 4. is our resource now in the catalog? ---
log(`\n[4] checking the Bazaar catalog for our resource`);
await new Promise((r) => setTimeout(r, 3000));
let found = null;
for (let page = 0; page < 6 && !found; page++) {
  const cres = await fetch(
    `${FACILITATOR}/discovery/resources?limit=100&offset=${page * 100}`,
  );
  const cjson = await cres.json();
  const items = cjson.items || [];
  if (!items.length) break;
  found = items.find((i) =>
    JSON.stringify(i).includes(req.payTo.toLowerCase().slice(2, 10)),
  );
  if (!found) log(`    page ${page + 1}: ${items.length} items, ours not yet present`);
}
if (found) {
  log(`    ✓ FOUND in catalog:`);
  log(`      ${JSON.stringify(found).slice(0, 400)}`);
} else {
  log(`    not found in the first 600 catalog entries.`);
  log(`    NOTE: cataloging may require a SUCCESSFUL /settle, not just /verify.`);
  log(`    Verify result above tells us which.`);
}

// --- 5. also try CDP's catalog ---
log(`\n[5] checking the CDP catalog for the same resource`);
try {
  const cd = await fetch(
    "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=200",
  );
  const cdj = await cd.json();
  const items = cdj.items || cdj.resources || [];
  const hit = items.find((i) =>
    JSON.stringify(i).includes(req.payTo.toLowerCase().slice(2, 10)),
  );
  log(`    ${items.length} items; ours: ${hit ? "FOUND" : "not present"}`);
} catch (e) {
  log(`    CDP lookup failed: ${String(e.message).slice(0, 120)}`);
}
