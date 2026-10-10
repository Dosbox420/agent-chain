/**
 * mainnet_server.mjs — x402 resource server on Base MAINNET.
 *
 * Difference from server.mjs: network is `base` (mainnet), not `base-sepolia`.
 * The 402 challenge needs no funds and works immediately; real settlement
 * requires the buyer to hold USDC on Base and the seller to have a payTo.
 *
 * The seller does NOT need gas — x402 settlement is done by the facilitator
 * (EIP-3009 transferWithAuthorization), the merchant only receives.
 *
 * Run:  TREASURY=0x... node mainnet_server.mjs
 */
import express from "express";
import { paymentMiddleware } from "x402-express";

const PAY_TO = process.env.TREASURY || process.env.PAY_TO;
const NETWORK = "base";                 // mainnet
const PORT = process.env.PORT || 4021;

if (!PAY_TO || /^0x0{40}$/.test(PAY_TO)) {
  console.error("Set TREASURY to a real address (got:", PAY_TO, ")");
  process.exit(1);
}

const app = express();

app.use(
  paymentMiddleware(
    PAY_TO,
    {
      "GET /signal/*": {
        price: "$0.005",
        network: NETWORK,
        config: { description: "Machine-readable market signal for agents" },
      },
      "GET /report": {
        price: "$0.01",
        network: NETWORK,
        config: { description: "Agent-generated market trend report" },
      },
    },
  )
);

function signal(topic) {
  return {
    topic,
    generated_at: new Date().toISOString(),
    source: "agent-chain",
    signals: [
      { key: "x402_median_seller_usd_month", value: 0.06 },
      { key: "x402_sellers_earning_zero_pct", value: 38 },
      { key: "erc8004_identity_status", value: "identity+reputation shipped; validation draft" },
    ],
    confidence: 0.55,
    disclaimer: "Not financial advice. Data as-is.",
  };
}

app.get("/report", (_q, res) => res.json(signal("general")));
app.get("/signal/:topic", (q, res) => res.json(signal(q.params.topic)));
app.get("/health", (_q, res) => res.json({
  ok: true, payTo: PAY_TO, network: NETWORK,
  rails: "x402 / USDC on Base",
  agent: "ERC-8004 agentId 9620",
}));

app.listen(PORT, () => {
  console.log(`x402 MAINNET server on :${PORT}`);
  console.log(`  network: ${NETWORK}`);
  console.log(`  payTo:   ${PAY_TO}`);
  console.log(`  paid:    GET /signal/* ($0.005)   GET /report ($0.01)`);
  console.log(`  free:    GET /health`);
});
