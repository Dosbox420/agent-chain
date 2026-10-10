/**
 * mainnet_server.mjs — x402 resource server on Base MAINNET.
 *
 * Sells real, sourced data (signals.json) rather than a hardcoded stub.
 * Every metric carries its source and as-of date so a buyer can audit it.
 *
 * The 402 challenge needs no funds. Settlement requires the buyer to hold
 * USDC on Base; the seller needs no gas (facilitator settles via EIP-3009).
 *
 * Run:  TREASURY=0x... node mainnet_server.mjs
 */
import express from "express";
import { paymentMiddleware } from "x402-express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(readFileSync(join(__dir, "signals.json"), "utf8"));

const PAY_TO = process.env.TREASURY || process.env.PAY_TO;
const NETWORK = "base"; // mainnet
const PORT = process.env.PORT || 4021;

if (!PAY_TO || /^0x0{40}$/.test(PAY_TO)) {
  console.error("Set TREASURY to a real address (got:", PAY_TO, ")");
  process.exit(1);
}

const app = express();
app.set("trust proxy", true);

app.use(
  paymentMiddleware(PAY_TO, {
    "GET /signal/*": {
      price: "$0.005",
      network: NETWORK,
      config: { description: "Machine-readable agent-commerce economy signals, sourced" },
    },
    "GET /report": {
      price: "$0.01",
      network: NETWORK,
      config: { description: "Full agent-commerce landscape digest" },
    },
  }),
);

/** Serve a topic from the real dataset. Unknown topics get the topic list, not invented data. */
function signalFor(topic) {
  const t = DATA.topics[topic];
  if (!t) {
    return {
      ok: false,
      error: "unknown_topic",
      requested: topic,
      available_topics: DATA.unknown_topics.available_topics,
      hint: "GET /topics for the free list",
    };
  }
  return {
    ok: true,
    topic,
    dataset: DATA.meta.dataset,
    version: DATA.meta.version,
    summary: t.summary,
    metrics: t.metrics,
    interpretation: t.interpretation,
    confidence: t.confidence,
    disclaimer: DATA.meta.disclaimer,
    served_at: new Date().toISOString(),
  };
}

app.get("/signal/:topic", (q, res) => res.json(signalFor(q.params.topic)));

app.get("/report", (_q, res) =>
  res.json({
    ok: true,
    dataset: DATA.meta.dataset,
    version: DATA.meta.version,
    description: DATA.meta.description,
    compiled_by: DATA.meta.compiled_by,
    topics: Object.entries(DATA.topics).map(([k, v]) => ({
      topic: k,
      summary: v.summary,
      confidence: v.confidence,
      metric_count: v.metrics.length,
    })),
    disclaimer: DATA.meta.disclaimer,
    served_at: new Date().toISOString(),
  }),
);

app.get("/topics", (_q, res) =>
  res.json({
    ok: true,
    available_topics: DATA.unknown_topics.available_topics,
    price: "0.005 USDC per topic",
  }),
);

app.get("/health", (_q, res) =>
  res.json({
    ok: true,
    payTo: PAY_TO,
    network: NETWORK,
    rails: "x402 / USDC on Base",
    agent: "ERC-8004 agentId 9620",
    dataset_version: DATA.meta.version,
    topics: Object.keys(DATA.topics).length,
  }),
);

app.listen(PORT, () => {
  console.log(`x402 MAINNET server on :${PORT}`);
  console.log(`  network: ${NETWORK}   payTo: ${PAY_TO}`);
  console.log(
    `  dataset: ${DATA.meta.dataset} ${DATA.meta.version} (${Object.keys(DATA.topics).length} topics)`,
  );
  console.log(`  paid:    GET /signal/* ($0.005)   GET /report ($0.01)`);
  console.log(`  free:    GET /health   GET /topics`);
});
