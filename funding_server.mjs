/**
 * funding_server.mjs — the "funded by other AIs" patronage rail.
 *
 * Three things served:
 *   1. /                 -> the funding page (fund.html)
 *   2. /stats, /qr.png   -> free: treasury info + QR code
 *   3. /report, /signal, /patron -> PAID via x402 (USDC on Base Sepolia)
 *
 * The /patron endpoint is the crowdsource rail: any agent or human can pay
 * USDC to the treasury and receives a signed receipt. This is PATRONAGE —
 * no token, no equity, no return. Software + receipt only.
 *
 * Run:  node funding_server.mjs
 */
import express from "express";
import { paymentMiddleware } from "x402-express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const TREASURY = process.env.TREASURY || "0xC9F0144a8dF4Eb3c97d276C7d768eF372970D1c4";
const NETWORK = process.env.X402_NETWORK || "base-sepolia";
const PORT = process.env.PORT || 4021;
const LEDGER = path.join(process.cwd(), "patrons.jsonl");

const app = express();
app.use(express.json());

// ---------- PAID RAIL (x402) ----------
app.use(
  paymentMiddleware(
    TREASURY,
    {
      "GET /report":     { price: "$0.01",  network: NETWORK, config: { description: "Agent market trend report" } },
      "GET /signal/*":   { price: "$0.005", network: NETWORK, config: { description: "Per-topic signal lookup" } },
      "POST /patron":       { price: "$1.00",  network: NETWORK, config: { description: "Patronage: support open agent-commerce tooling" } },
      "GET /patron":        { price: "$1.00",  network: NETWORK, config: { description: "Patronage: support open agent-commerce tooling" } },
    },
  )
);

// ---------- THE PRODUCT ----------
function trendReport(topic = "agents") {
  return {
    topic, generated_at: new Date().toISOString(), source: "local-model",
    signals: [
      { key: "x402_tx_volume", value: 178700000, note: "cumulative; but only ~$42.4M total value" },
      { key: "avg_payment_usd", value: 0.24, note: "thin real commerce per tx" },
      { key: "erc8004_status", value: "identity+reputation shipped; validation draft" },
    ],
    confidence: 0.55, disclaimer: "Not financial advice. Data as-is.",
  };
}
app.get("/report", (_q, res) => res.json(trendReport("general")));
app.get("/signal/:topic", (q, res) => res.json(trendReport(q.params.topic)));

// ---------- PATRONAGE ----------
app.get("/patron", (q, res) => res.json(patronReceipt(q)));
app.post("/patron", (q, res) => res.json(patronReceipt(q)));

function patronReceipt(req) {
  const rec = {
    ts: new Date().toISOString(),
    patron: req.headers["x-payment"] ? "paid-via-x402" : "unverified",
    amount_usdc: 1.0,
    treasury: TREASURY,
    receipt_id: crypto.randomUUID(),
    message: "Thank you. This is patronage: you receive software and a receipt, no token and no return.",
  };
  fs.appendFileSync(LEDGER, JSON.stringify(rec) + "\n");
  return rec;
}

// ---------- FREE ----------
function stats() {
  let patrons = 0, total = 0;
  if (fs.existsSync(LEDGER)) {
    for (const line of fs.readFileSync(LEDGER, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      patrons += 1; total += Number(r.amount_usdc || 0);
    }
  }
  return {
    treasury: TREASURY, network: NETWORK,
    asset: "USDC", asset_address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    patron_count: patrons, total_received_usdc: total,
    paid_endpoints: [
      { path: "/report", price: "$0.01", desc: "market trend report" },
      { path: "/signal/:topic", price: "$0.005", desc: "per-topic signal" },
      { path: "/patron", price: "$1.00", desc: "patronage" },
    ],
    model: "patronage — no token, no equity, no return",
  };
}
app.get("/stats", (_q, res) => res.json(stats()));
app.get("/qr.png", (_q, res) => {
  const p = path.join(process.cwd(), "treasury_qr.png");
  if (fs.existsSync(p)) res.sendFile(p); else res.status(404).send("no qr");
});
app.get("/", (_q, res) => res.sendFile(path.join(process.cwd(), "fund.html")));

app.listen(PORT, () => {
  console.log(`funding server on http://localhost:${PORT}`);
  console.log(`  treasury: ${TREASURY} (${NETWORK})`);
  console.log(`  page:     http://localhost:${PORT}/`);
  console.log(`  stats:    http://localhost:${PORT}/stats`);
});
