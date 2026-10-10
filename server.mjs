/**
 * x402 paid resource server — agent-commerce endpoint.
 *
 * Exposes a paid data service ("trend report") that any AI agent can buy
 * machine-to-machine with USDC over HTTP 402. No accounts, no API keys,
 * no invoices. This is the M2M micropayment rail the Agent Economy paper
 * describes (§3.3).
 *
 * Run:  node server.mjs
 * Test: curl -i http://localhost:4021/report      -> expect HTTP 402 + JSON challenge
 */
import express from "express";
import { paymentMiddleware } from "x402-express";

const PAY_TO = process.env.PAY_TO || "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NETWORK = process.env.X402_NETWORK || "base-sepolia";
const PORT = process.env.PORT || 4021;

const app = express();

// ---- the paid rail -------------------------------------------------------
// Everything matching these routes requires payment before the handler runs.
app.use(
  paymentMiddleware(
    PAY_TO,
    {
      "GET /report": {
        price: "$0.01",              // 1 cent USDC per call
        network: NETWORK,
        config: { description: "Agent-generated market trend report" },
      },
      "GET /signal/:topic": {
        price: "$0.005",
        network: NETWORK,
        config: { description: "Per-topic signal lookup" },
      },
    },
    // defaults to https://x402.org/facilitator on testnet
  )
);

// ---- the actual product --------------------------------------------------
// Deterministic, self-contained so the demo has no external dependencies.
function trendReport(topic = "agents") {
  return {
    topic,
    generated_at: new Date().toISOString(),
    source: "local-model",
    signals: [
      { key: "x402_tx_growth", value: 0.0, note: "plateaued after Q1 2026 speculative spike" },
      { key: "agent_identity_adoption", value: 0.0, note: "ERC-8004 identity+reputation shipped; validation draft" },
      { key: "avg_payment_size_usd", value: 0.24, note: "low value per tx = real commerce is still thin" },
    ],
    confidence: 0.55,
    disclaimer: "Not financial advice. Data provided as-is.",
  };
}

app.get("/report", (req, res) => {
  res.json(trendReport("general"));
});

app.get("/signal/:topic", (req, res) => {
  res.json(trendReport(req.params.topic));
});

// free health endpoint (proves the server is up without paying)
app.get("/health", (_req, res) => res.json({ ok: true, payTo: PAY_TO, network: NETWORK }));

app.listen(PORT, () => {
  console.log(`x402 resource server on http://localhost:${PORT}`);
  console.log(`  payTo:   ${PAY_TO}`);
  console.log(`  network: ${NETWORK}`);
  console.log(`  paid:    GET /report ($0.01)   GET /signal/:topic ($0.005)`);
  console.log(`  free:    GET /health`);
});
