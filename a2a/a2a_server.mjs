/**
 * a2a_server.mjs — a real A2A (Agent-to-Agent) endpoint, not a bespoke mailbox.
 *
 * Implements the pieces of A2A v0.3 that matter for delegation:
 *   GET  /.well-known/agent-card.json   discovery (public, no auth)
 *   GET  /.well-known/agent.json        same card (legacy alias)
 *   POST /a2a                           JSON-RPC 2.0
 *       message/send   -> create or continue a Task
 *       tasks/get      -> read a Task's state + artifacts
 *       tasks/cancel   -> cancel a non-terminal Task
 *
 * Task lifecycle: submitted -> working -> (input-required <-> working) -> completed|failed|canceled
 * Messages are the conversation; artifacts are the deliverables.
 *
 * This replaces the hand-rolled log.jsonl/q.sh protocol as the *inter-agent* surface:
 * peers now delegate via a standard they already speak. The mailbox stays as the
 * human-readable record.
 *
 * Run: PUBLIC_URL=https://<host> node a2a_server.mjs
 */
import express from "express";
import { paymentMiddleware } from "x402-express";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4025;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const TREASURY = process.env.TREASURY || "0x56D390539A0227C3a418D1e7f06f446b2EE2e351";
const INTERAGENT = process.env.INTERAGENT_DIR || "/home/thom/.hermes/01_executive_brain/interagent";

const DATA = JSON.parse(readFileSync(join(__dir, "..", "signals.json"), "utf8"));

// ---- agent card ------------------------------------------------------------
const card = JSON.parse(
  readFileSync(join(__dir, "agent-card.template.json"), "utf8"),
);
card.url = `${PUBLIC_URL}/a2a`;
for (const s of card.skills) {
  if (s.x402?.resource) s.x402.resource = `${PUBLIC_URL}/signal/{topic}`;
}

// ---- task store (in-memory; A2A tasks are short-lived by design) ------------
const tasks = new Map();
const TTL_MS = 60 * 60 * 1000; // 1h, matches the reference implementations

function newTask(contextId) {
  const now = new Date().toISOString();
  const t = {
    id: randomUUID(),
    contextId: contextId || randomUUID(),
    status: { state: "submitted", timestamp: now },
    history: [],
    artifacts: [],
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(t.id, t);
  return t;
}
function touch(t) {
  t.updatedAt = new Date().toISOString();
  t.status.timestamp = t.updatedAt;
}
function sweep() {
  const cut = Date.now() - TTL_MS;
  for (const [id, t] of tasks) if (Date.parse(t.updatedAt) < cut) tasks.delete(id);
}

// ---- skills ----------------------------------------------------------------
const FREE_SKILLS = new Set(["list-topics", "verify-repo-state", "agent-identity"]);

function runVerify() {
  return new Promise((resolve) => {
    const script = join(INTERAGENT, "verify.sh");
    if (!existsSync(script)) {
      return resolve({ ran: false, reason: "verify.sh not present" });
    }
    execFile("bash", [script], { timeout: 120000 }, (err, stdout) => {
      const out = String(stdout || "");
      resolve({
        ran: true,
        all_checks_pass: /ALL CHECKS PASS/.test(out),
        head: (out.match(/HEAD=([0-9a-f]+)/) || [])[1] || null,
        summary: out.split("\n").filter((l) => /✓|✗|SUMMARY|ALL CHECKS/.test(l)).slice(0, 12),
      });
    });
  });
}

async function handleSkill(skill, input) {
  switch (skill) {
    case "list-topics":
      return {
        available_topics: Object.keys(DATA.topics),
        price_per_topic: "0.005 USDC",
        dataset_version: DATA.meta.version,
        note: "Call agent-commerce-signals with {topic} and settle 0.005 USDC over x402.",
      };

    case "verify-repo-state":
      return await runVerify();

    case "agent-identity":
      return {
        name: card.name,
        erc8004_agent_id: 9620,
        erc8004_network: "base-sepolia",
        identity_registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
        payment_rail: "x402 / USDC on Base",
        treasury: TREASURY,
        inbox: "(own inbox, not a human mailbox)",
        honest_limits: [
          "mainnet endpoint serves 402 challenges; it has never settled",
          "revenue to date: $0.00 — no external buyer has purchased",
          "x402 seller economy is thin: median seller ~$0.06/month",
        ],
      };

    case "agent-commerce-signals": {
      const topic = input?.topic;
      const t = DATA.topics[topic];
      if (!t) {
        // input-required is the right A2A response here, not a failure.
        return {
          __inputRequired: true,
          message: `Unknown topic '${topic}'.`,
          available_topics: Object.keys(DATA.topics),
        };
      }
      return {
        topic,
        dataset: DATA.meta.dataset,
        version: DATA.meta.version,
        summary: t.summary,
        metrics: t.metrics,
        interpretation: t.interpretation,
        confidence: t.confidence,
        disclaimer: DATA.meta.disclaimer,
        payment_note: "PAID skill — in production this requires an x402 settlement first.",
      };
    }

    default:
      return { __failed: true, reason: `unknown skill '${skill}'` };
  }
}

// ---- JSON-RPC --------------------------------------------------------------
const RPC_ERRORS = {
  PARSE: { code: -32700, message: "Parse error" },
  METHOD: { code: -32601, message: "Method not found" },
  PARAMS: { code: -32602, message: "Invalid params" },
  INTERNAL: { code: -32603, message: "Internal error" },
  TASK_NOT_FOUND: { code: -32001, message: "Task not found" },
  NOT_CANCELABLE: { code: -32002, message: "Task not cancelable" },
};

function rpcError(id, e, data) {
  return { jsonrpc: "2.0", id: id ?? null, error: { ...e, ...(data ? { data } : {}) } };
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

// ---- inbound access log -----------------------------------------------------
// Added after a third party called a DEAD endpoint and the attempt left no trace.
// Every inbound request is now recorded with enough context to reply to the caller.
const ACCESS_LOG = join(__dir, "..", "a2a-access.jsonl");
app.use((req, res, next) => {
  const started = Date.now();
  const rec = {
    ts: new Date().toISOString(),
    method: req.method,
    path: req.path,
    ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
    ua: req.headers["user-agent"] || null,
    referer: req.headers["referer"] || null,
    origin: req.headers["origin"] || null,
  };
  res.on("finish", () => {
    const line = JSON.stringify({ ...rec, status: res.statusCode, ms: Date.now() - started });
    try {
      appendFileSync(ACCESS_LOG, line + "\n");
    } catch {}
    // Only log non-noise to stdout so the process log stays readable.
    if (!["/health", "/.well-known/agent-card.json", "/.well-known/agent.json"].includes(req.path)) {
      console.log(`[hit] ${rec.method} ${rec.path} -> ${res.statusCode} ip=${rec.ip} ua=${(rec.ua || "").slice(0, 60)}`);
    }
  });
  next();
});

app.use((_q, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});
app.options(/.*/, (_q, res) => res.sendStatus(204));

// ---- x402 paid surface -----------------------------------------------------
// Served from THIS process so the agent card's `x402.resource` (/signal/{topic})
// is actually reachable on the same origin the card advertises. Previously the
// card pointed at a route that lived on a separate, orphaned server.
const X402_NETWORK = process.env.X402_NETWORK || "base-sepolia";
app.use(
  paymentMiddleware(
    TREASURY,
    {
      "GET /signal/*": {
        price: "$0.005",
        network: X402_NETWORK,
        config: { description: "Sourced agent-commerce economy signals, each metric with source + as_of" },
      },
      "GET /report": {
        price: "$0.01",
        network: X402_NETWORK,
        config: { description: "Full agent-commerce landscape digest" },
      },
    },
    { url: process.env.FACILITATOR_URL || "https://facilitator.payai.network" },
  ),
);

app.get("/signal/:topic", (q, res) => {
  const t = DATA.topics[q.params.topic];
  if (!t) {
    return res.status(404).json({
      ok: false,
      error: "unknown_topic",
      requested: q.params.topic,
      available_topics: Object.keys(DATA.topics),
    });
  }
  res.json({
    ok: true,
    topic: q.params.topic,
    dataset: DATA.meta.dataset,
    version: DATA.meta.version,
    summary: t.summary,
    metrics: t.metrics,
    interpretation: t.interpretation,
    confidence: t.confidence,
    disclaimer: DATA.meta.disclaimer,
    served_at: new Date().toISOString(),
  });
});

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
  res.json({ ok: true, available_topics: Object.keys(DATA.topics), price: "0.005 USDC per topic" }),
);

// ---- discovery -------------------------------------------------------------
// The card's `url` MUST match wherever the caller actually reached us. Pinning a
// tunnel URL goes stale the moment the tunnel rotates (it did, repeatedly). So we
// derive it from the request's Host header, falling back to PUBLIC_URL only for
// local/non-proxied calls.
function baseFor(req) {
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  const proto = req.headers["x-forwarded-proto"] || (host?.includes("localhost") ? "http" : "https");
  if (host && !/^(localhost|127\.0\.0\.1)/.test(host)) return `${proto}://${host}`;
  return PUBLIC_URL;
}

function serveCard(req, res) {
  const base = baseFor(req);
  const c = structuredClone(card);
  c.url = `${base}/a2a`;
  for (const s of c.skills) {
    if (s.x402?.resource) s.x402.resource = `${base}/signal/{topic}`;
    // The card MUST advertise the network we actually settle on. It previously
    // hardcoded "base" while the server ran base-sepolia, so a paying agent would
    // have tried mainnet and failed.
    if (s.x402) s.x402.network = X402_NETWORK;
  }
  res.set("Cache-Control", "no-store"); // never let a stale card be cached
  res.type("application/json").send(JSON.stringify(c, null, 2));
}
app.get("/.well-known/agent-card.json", serveCard);
app.get("/.well-known/agent.json", serveCard);
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    protocol: "a2a/0.3.0",
    endpoint: `${baseFor(req)}/a2a`,
    skills: card.skills.length,
  }),
);

// ---- JSON-RPC endpoint -----------------------------------------------------
app.post("/a2a", async (req, res) => {
  sweep();
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== "2.0" || typeof method !== "string") {
    return res.status(400).json(rpcError(id, RPC_ERRORS.PARAMS, "need jsonrpc:'2.0' and method"));
  }

  if (method === "tasks/get") {
    const t = tasks.get(params?.id);
    if (!t) return res.json(rpcError(id, RPC_ERRORS.TASK_NOT_FOUND, params?.id));
    const { historyLength } = params || {};
    const out = { ...t };
    if (historyLength === 0) delete out.history;
    else if (typeof historyLength === "number") out.history = out.history.slice(-historyLength);
    return res.json({ jsonrpc: "2.0", id, result: out });
  }

  if (method === "tasks/cancel") {
    const t = tasks.get(params?.id);
    if (!t) return res.json(rpcError(id, RPC_ERRORS.TASK_NOT_FOUND, params?.id));
    if (["completed", "failed", "canceled"].includes(t.status.state)) {
      return res.json(rpcError(id, RPC_ERRORS.NOT_CANCELABLE, t.status.state));
    }
    t.status = { state: "canceled", timestamp: new Date().toISOString() };
    touch(t);
    return res.json({ jsonrpc: "2.0", id, result: t });
  }

  if (method !== "message/send") {
    return res.json(rpcError(id, RPC_ERRORS.METHOD, method));
  }

  // --- message/send ---
  const msg = params?.message;
  if (!msg || !Array.isArray(msg.parts)) {
    return res.json(rpcError(id, RPC_ERRORS.PARAMS, "message.parts required"));
  }

  // Continue an existing task, or open a new one.
  let task = params?.taskId ? tasks.get(params.taskId) : null;
  if (params?.taskId && !task) return res.json(rpcError(id, RPC_ERRORS.TASK_NOT_FOUND, params.taskId));
  if (task && ["completed", "failed", "canceled"].includes(task.status.state)) {
    return res.json(rpcError(id, RPC_ERRORS.NOT_CANCELABLE, `task is ${task.status.state}`));
  }
  if (!task) task = newTask(msg.contextId || params?.contextId);

  task.history.push({ role: msg.role || "user", parts: msg.parts, messageId: msg.messageId });
  task.status = { state: "working", timestamp: new Date().toISOString() };
  touch(task);

  // Extract the skill request: prefer a data part, fall back to text.
  const dataPart = msg.parts.find((p) => p.kind === "data")?.data;
  let skill = dataPart?.skill;
  if (!skill) {
    const text = msg.parts.find((p) => p.kind === "text")?.text || "";
    try { skill = JSON.parse(text)?.skill; } catch { skill = text.trim() || undefined; }
  }
  if (!skill) {
    task.status = {
      state: "input-required",
      timestamp: new Date().toISOString(),
      message: {
        role: "agent",
        parts: [{ kind: "text", text: "Which skill? See the agent card." }],
        metadata: { available_skills: card.skills.map((s) => s.id) },
      },
    };
    touch(task);
    return res.json({ jsonrpc: "2.0", id, result: task });
  }

  const known = card.skills.some((s) => s.id === skill);
  if (!known) {
    task.status = {
      state: "failed",
      timestamp: new Date().toISOString(),
      message: { role: "agent", parts: [{ kind: "text", text: `unknown skill '${skill}'` }] },
    };
    touch(task);
    return res.json({ jsonrpc: "2.0", id, result: task });
  }

  const result = await handleSkill(skill, dataPart || {});

  if (result.__inputRequired) {
    task.status = {
      state: "input-required",
      timestamp: new Date().toISOString(),
      message: {
        role: "agent",
        parts: [{ kind: "text", text: result.message }],
        metadata: { available_topics: result.available_topics },
      },
    };
    touch(task);
    return res.json({ jsonrpc: "2.0", id, result: task });
  }
  if (result.__failed) {
    task.status = {
      state: "failed",
      timestamp: new Date().toISOString(),
      message: { role: "agent", parts: [{ kind: "text", text: result.reason }] },
    };
    touch(task);
    return res.json({ jsonrpc: "2.0", id, result: task });
  }

  task.artifacts.push({
    artifactId: randomUUID(),
    name: `${skill}-result`,
    parts: [{ kind: "data", data: result }],
  });
  task.status = {
    state: "completed",
    timestamp: new Date().toISOString(),
    message: {
      role: "agent",
      parts: [{ kind: "text", text: `${skill} completed.` }],
      metadata: { x402: { required: !FREE_SKILLS.has(skill), note: FREE_SKILLS.has(skill) ? "free skill" : "paid skill — x402 settlement required in production" } },
    },
  };
  touch(task);
  return res.json({ jsonrpc: "2.0", id, result: task });
});

app.listen(PORT, () => {
  console.log(`A2A server on :${PORT}`);
  console.log(`  card    : ${PUBLIC_URL}/.well-known/agent-card.json`);
  console.log(`  rpc     : ${PUBLIC_URL}/a2a   (message/send, tasks/get, tasks/cancel)`);
  console.log(`  skills  : ${card.skills.map((s) => s.id).join(", ")}`);
});
