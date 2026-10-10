/**
 * settle_and_list.mjs — settle 0.005 testnet USDC via PayAI to get CATALOGUED.
 *
 * /verify passed (isValid:true) but the catalog needs a successful /settle.
 * Testnet USDC is free, so this costs nothing real and makes our resource
 * discoverable to agents in the x402 Bazaar — the thing we wrongly believed
 * was blocked on mainnet funding.
 *
 * Run: PUBLIC_URL=https://<tunnel> node settle_and_list.mjs
 */
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const FACILITATOR = "https://facilitator.payai.network";
const PUBLIC_URL = process.env.PUBLIC_URL;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(PAYER_KEY);
const log = (...a) => console.log(...a);

if (!PUBLIC_URL) { console.error("set PUBLIC_URL"); process.exit(1); }

// 1. live challenge
const res = await fetch(`${PUBLIC_URL}/signal/seller-economics`);
const challenge = await res.json();
const req = challenge.accepts[0];
log(`[1] challenge: network=${req.network} price=${Number(req.maxAmountRequired)/1e6} USDC`);

// 2. sign
const now = Math.floor(Date.now() / 1000);
const auth = {
  from: account.address,
  to: req.payTo,
  value: req.maxAmountRequired,
  validAfter: String(now - 60),
  validBefore: String(now + (req.maxTimeoutSeconds || 600)),
  nonce: "0x" + [...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,"0")).join(""),
};
const signature = await account.signTypedData({
  domain: { name: "USDC", version: "2", chainId: baseSepolia.id, verifyingContract: USDC },
  types: { TransferWithAuthorization: [
    { name:"from",type:"address"},{name:"to",type:"address"},{name:"value",type:"uint256"},
    { name:"validAfter",type:"uint256"},{name:"validBefore",type:"uint256"},{name:"nonce",type:"bytes32"}]},
  primaryType: "TransferWithAuthorization",
  message: { from: auth.from, to: auth.to, value: BigInt(auth.value),
             validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
});
log(`[2] signed as ${account.address}`);

const paymentPayload = { x402Version: 1, scheme: "exact", network: req.network,
                         payload: { signature, authorization: auth } };
const body = { x402Version: 1, paymentPayload, paymentRequirements: req };

// 3. SETTLE (testnet funds — costs nothing real)
log(`\n[3] POST ${FACILITATOR}/settle`);
const sres = await fetch(`${FACILITATOR}/settle`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const sjson = await sres.json();
log(`    HTTP ${sres.status}`);
log(`    ${JSON.stringify(sjson).slice(0, 500)}`);

// 4. catalog check
if (sjson.success || sjson.transaction) {
  log(`\n[4] settled — tx ${sjson.transaction || "(none)"}`);
  log(`    waiting for catalog...`);
  await new Promise(r=>setTimeout(r,8000));
  for (let page=0; page<8; page++) {
    const cres = await fetch(`${FACILITATOR}/discovery/resources?limit=100&offset=${page*100}`);
    const items = (await cres.json()).items || [];
    if (!items.length) break;
    const hit = items.find(i => JSON.stringify(i).includes(req.payTo.toLowerCase().slice(2,10)));
    if (hit) {
      log(`    ✓ FOUND on page ${page+1} — WE ARE LISTED:`);
      log(`      ${JSON.stringify(hit).slice(0,500)}`);
      process.exit(0);
    }
  }
  log(`    still not in the first 800 entries. Cataloging may be batched/cron'd server-side.`);
  log(`    The settle DID succeed, so re-check /discovery/resources later.`);
} else {
  log(`\n[4] settle did not succeed — see response above.`);
}
