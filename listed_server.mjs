/**
 * listed_server.mjs — x402 server pointed at a BAZAAR-ENABLED facilitator.
 *
 * Why this exists: the CDP discovery list contains eip155:84532 (Base Sepolia),
 * and the PayAI facilitator catalogs resources on /verify — which moves NO funds.
 * So an endpoint can be DISCOVERABLE without any money. This is the $0 path to
 * being listed, which we previously (wrongly) believed was funding-gated.
 *
 * What is needed to be listed:
 *   1. the 402 carries the v1 discovery declaration  (accepts[0].outputSchema.input.discoverable)
 *   2. verify/settle point at a bazaar-enabled facilitator
 *   3. a PUBLIC resource URL (not localhost) — pass PUBLIC_URL
 *
 * Run:  TREASURY=0x... PUBLIC_URL=https://<tunnel> node listed_server.mjs
 */
import express from "express";
import { paymentMiddleware } from "x402-express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(readFileSync(join(__dir, "signals.json"), "utf8"));

const PAY_TO = process.env.TREASURY || process.env.PAY_TO;
const NETWORK = process.env.X402_NETWORK || "base-sepolia"; // testnet: listable at $0
const PORT = process.env.PORT || 4023;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const FACILITATOR =
  process.env.FACILITATOR_URL || "https://facilitator.payai.network";

if (!PAY_TO || /^0x0{40}$/.test(PAY_TO)) {
  console.error("Set TREASURY to a real address");
  process.exit(1);
}

const app = express();
app.set("trust proxy", true);

// If PUBLIC_URL is set, advertise the public resource string rather than localhost —
// a localhost resource string is useless to a discovery crawler.
if (PUBLIC_URL) {
  app.use((req, _res, next) => {
    req.headers["x-forwarded-host"] = new URL(PUBLIC_URL).host;
    req.headers["x-forwarded-proto"] = new URL(PUBLIC_URL).protocol.replace(":", "");
    next();
  });
}

app.use(
  paymentMiddleware(
    PAY_TO,
    {
      "GET /signal/*": {
        price: "$0.005",
        network: NETWORK,
        config: {
          description:
            "Sourced agent-commerce economy signals (4 topics, 30 metrics, each with source + as_of)",
        },
      },
      "GET /report": {
        price: "$0.01",
        network: NETWORK,
        config: { description: "Full agent-commerce landscape digest" },
      },
    },
    { url: FACILITATOR },
  ),
);

function signalFor(topic) {
  const t = DATA.topics[topic];
  if (!t)
    return {
      ok: false,
      error: "unknown_topic",
      requested: topic,
      available_topics: DATA.unknown_topics.available_topics,
    };
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
    topics: Object.entries(DATA.topics).map(([k, v]) => ({
      topic: k,
      confidence: v.confidence,
      metric_count: v.metrics.length,
    })),
  }),
);
app.get("/topics", (_q, res) =>
  res.json({ ok: true, available_topics: DATA.unknown_topics.available_topics }),
);
app.get("/health", (_q, res) =>
  res.json({
    ok: true,
    payTo: PAY_TO,
    network: NETWORK,
    facilitator: FACILITATOR,
    public_url: PUBLIC_URL || "(unset — resource will read as localhost)",
    agent: "ERC-8004 agentId 9620",
    topics: Object.keys(DATA.topics).length,
  }),
);

app.listen(PORT, () => {
  console.log(`x402 listed-server on :${PORT}`);
  console.log(`  network     : ${NETWORK}`);
  console.log(`  payTo       : ${PAY_TO}`);
  console.log(`  facilitator : ${FACILITATOR}`);
  console.log(`  public url  : ${PUBLIC_URL || "(unset!)"}`);
  console.log(`  paid        : GET /signal/* ($0.005)   GET /report ($0.01)`);
});
