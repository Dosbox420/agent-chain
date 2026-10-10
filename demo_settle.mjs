/**
 * demo_settle.mjs — THE full x402 flow, live, with real on-chain settlement.
 *
 * This is what the grant asks for: an agent USING the service, not a description.
 *
 *   1. agent probes the paid endpoint        -> HTTP 402 + challenge
 *   2. agent signs EIP-3009 authorisation    -> X-PAYMENT header
 *   3. facilitator verifies + settles        -> real USDC moves on Base Sepolia
 *   4. resource released                     -> 200 + settlement receipt
 *   5. we prove it                            -> tx hash + balance deltas
 *
 * Run: node demo_settle.mjs
 */
import express from "express";
import { paymentMiddleware } from "x402-express";
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, erc20Abi } from "viem";
import { baseSepolia } from "viem/chains";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RPC = "https://sepolia.base.org";
const PORT = 4022;

// merchant = anvil #0 (receives), payer = anvil #1 (pays). Both public test keys.
const MERCHANT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const PAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n\x1b[1;36m${t}\x1b[0m`);

// ---------- 1. stand up the paid service ----------
const app = express();
app.use(
  paymentMiddleware(MERCHANT, {
    "GET /signal/seller-economics": {
      price: "$0.005",
      network: "base-sepolia",
      config: { description: "Sourced agent-commerce seller economics" },
    },
  }),
);
app.get("/signal/seller-economics", (_q, res) =>
  res.json({
    ok: true,
    topic: "seller-economics",
    metrics: [
      { key: "median_seller_monthly_revenue_usd", value: 0.06, source: "claudevsite.uk", as_of: "2026-09-11" },
      { key: "sellers_earning_zero_share", value: 0.38, source: "claudevsite.uk", as_of: "2026-09-11" },
      { key: "top10_seller_volume_share", value: 0.985, source: "claudevsite.uk", as_of: "2026-09-11" },
    ],
    served_at: new Date().toISOString(),
  }),
);

const server = app.listen(PORT, async () => {
  const URL = `http://localhost:${PORT}/signal/seller-economics`;
  const account = privateKeyToAccount(PAYER_KEY);
  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const bal = async (a) =>
    await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });

  hr("x402 — a paid agent service, settled on-chain");
  log(`  service   : GET /signal/seller-economics   ($0.005 USDC)`);
  log(`  merchant  : ${MERCHANT}`);
  log(`  payer     : ${account.address}`);
  log(`  network   : base-sepolia (real USDC, real settlement)`);

  // ---------- 2. probe ----------
  hr("[1] agent probes the endpoint WITHOUT paying");
  const probe = await fetch(URL);
  log(`    HTTP ${probe.status} ${probe.status === 402 ? "Payment Required — correct" : "UNEXPECTED"}`);
  const ch = (await probe.json()).accepts?.[0];
  if (ch) {
    log(`    scheme   : ${ch.scheme}`);
    log(`    network  : ${ch.network}`);
    log(`    amount   : ${Number(ch.maxAmountRequired) / 1e6} USDC`);
    log(`    asset    : ${ch.asset}`);
    log(`    payTo    : ${ch.payTo}`);
  }

  // ---------- 3. pay ----------
  const payerBefore = await bal(account.address);
  const merchBefore = await bal(MERCHANT);
  log(`\n    balances before:`);
  log(`      payer    ${Number(payerBefore) / 1e6} USDC`);
  log(`      merchant ${Number(merchBefore) / 1e6} USDC`);

  hr("[2] agent signs EIP-3009 authorisation and retries with X-PAYMENT");
  const paidFetch = wrapFetchWithPayment(fetch, account);
  let txHash = null;
  try {
    const res = await paidFetch(URL);
    if (res.ok) {
      log(`    HTTP ${res.status} — RESOURCE RELEASED`);
      const raw = res.headers.get("x-payment-response");
      if (raw) {
        try {
          const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
          txHash = decoded.transaction || decoded.txHash;
          log(`    settlement receipt: ${JSON.stringify(decoded).slice(0, 220)}`);
        } catch {
          log(`    settlement header: ${raw.slice(0, 160)}`);
        }
      }
      const data = await res.json();
      log(`\n    payload received:`);
      log(`      ${JSON.stringify(data.metrics[0])}`);
    } else {
      log(`    HTTP ${res.status} — not released`);
      log(`    ${(await res.text()).slice(0, 300)}`);
    }
  } catch (e) {
    log(`    flow error: ${String(e.message).slice(0, 250)}`);
  }

  // ---------- 4. prove ----------
  hr("[3] on-chain proof");
  // The settlement tx is mined by the facilitator; poll until the balance actually
  // moves rather than reading once (a single read races the block and shows a false 0).
  const waitForChange = async (addr, before, secs = 30) => {
    for (let i = 0; i < secs; i++) {
      const now = await bal(addr);
      if (now !== before) return now;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return await bal(addr);
  };
  const payerAfter = await waitForChange(account.address, payerBefore);
  const merchAfter = await waitForChange(MERCHANT, merchBefore);
  log(`    balances after:`);
  log(`      payer    ${Number(payerAfter) / 1e6} USDC   (delta ${(Number(payerAfter) - Number(payerBefore)) / 1e6})`);
  log(`      merchant ${Number(merchAfter) / 1e6} USDC   (delta ${(Number(merchAfter) - Number(merchBefore)) / 1e6})`);
  if (txHash) log(`    tx: ${txHash}`);
  log(
    `\n    ${Number(merchAfter) > Number(merchBefore) ? "\x1b[1;32m✓ USDC MOVED. The rail works end to end.\x1b[0m" : "\x1b[1;33m— no balance delta observed\x1b[0m"}`,
  );

  server.close();
  process.exit(0);
});
