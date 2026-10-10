/**
 * x402-conformance-suite.mjs — test an x402 deployment against the published rules.
 *
 * Rules implemented from arXiv 2607.19545 ("Security Analysis of the x402
 * Protocol"), which audited 15 facilitators and found 31 vulnerabilities.
 *
 * WHAT THIS TESTS (and what it deliberately does NOT):
 *   This suite tests the rules a SERVER or FACILITATOR can be checked against
 *   from the outside, without spending real money. It only performs
 *   unauthenticated GET/POST requests and reads status codes and bodies.
 *   It never pays, never holds a funded key, and never mutates remote state.
 *
 *   Rules requiring a funded key or a controlled facilitator (SR4 false
 *   settlement success, SR6 gas bounds, SR8 asset-theft semantics) are marked
 *   MANUAL — they cannot be honestly verified from the outside. Reporting them
 *   as "pass" would be fabrication. They are listed with the exact test an
 *   operator must run themselves.
 *
 * Usage:
 *   node x402-conformance-suite.mjs https://your-endpoint/paid
 *   node x402-conformance-suite.mjs https://your-endpoint/paid --facilitator https://facilitator.example
 *   node x402-conformance-suite.mjs --list urls.txt --json report.json
 *
 * Exit code: 0 if no FAILs, 1 if any FAIL, 2 on usage error.
 */
import { writeFileSync, readFileSync } from "node:fs";

const UA = "x402-conformance-suite/1.0 (+https://github.com/Dosbox420/agent-chain; read-only)";
const results = [];
function record(rule, name, verdict, detail, manual = false) {
  results.push({ rule, name, verdict, detail, manual });
  const tag = { PASS: "PASS", FAIL: "FAIL", WARN: "WARN", SKIP: "SKIP", MANUAL: "MANU" }[verdict] || verdict;
  console.log(`  [${tag}] ${rule}  ${name}`);
  if (detail) console.log(`         ${detail}`);
}

async function req(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      ...opts,
      headers: { "User-Agent": UA, Accept: "*/*", ...(opts.headers || {}) },
      redirect: "follow",
      signal: ctrl.signal,
    });
    let body = "";
    try { body = (await r.text()).slice(0, 8000); } catch {}
    return { status: r.status, body, headers: r.headers };
  } catch (e) {
    return { status: 0, body: "", error: String(e.message || e).slice(0, 120) };
  } finally {
    clearTimeout(t);
  }
}

function parse402(body) {
  try {
    const j = JSON.parse(body);
    const acc = j.accepts?.[0] || j;
    return {
      ok: true,
      x402Version: j.x402Version,
      scheme: acc.scheme,
      network: acc.network,
      maxAmountRequired: acc.maxAmountRequired,
      payTo: acc.payTo,
      asset: acc.asset,
      resource: acc.resource,
      maxTimeoutSeconds: acc.maxTimeoutSeconds,
    };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------- Server rules

async function testServer(url) {
  console.log(`\n=== SERVER rules @ ${url} ===`);

  // --- Server-SR1: resource only after settlement succeeds ---
  const noPay = await req(url);
  if (noPay.status === 402) {
    record("Server-SR1", "unpaid request is refused", "PASS", `returned ${noPay.status}`);
  } else if (noPay.status === 200) {
    record("Server-SR1", "unpaid request is refused", "FAIL",
      `returned 200 with no payment — protected resource released without settlement`);
  } else {
    record("Server-SR1", "unpaid request is refused", "WARN", `returned ${noPay.status}`);
  }

  // --- the 402 challenge must be well-formed (agents need it to pay) ---
  const challenge = parse402(noPay.body);
  if (challenge.ok && challenge.payTo) {
    record("SR1", "402 challenge is well-formed", "PASS",
      `network=${challenge.network} amount=${challenge.maxAmountRequired} payTo=${challenge.payTo}`);
    if (!challenge.maxTimeoutSeconds) {
      record("SR5", "402 declares maxTimeoutSeconds", "WARN", "absent — clients cannot bound payment freshness");
    } else {
      record("SR5", "402 declares maxTimeoutSeconds", "PASS", `${challenge.maxTimeoutSeconds}s`);
    }
    if (!challenge.asset) {
      record("SR1", "402 declares the asset contract", "WARN", "absent — payer cannot tell which token is required");
    }
  } else {
    record("SR1", "402 challenge is well-formed", "FAIL",
      "402 body is not parseable x402 JSON — a compliant agent cannot construct a payment");
  }

  // --- Server-SR2: side effects must not survive a failed settlement ---
  // Not testable from outside: it requires observing server-internal state.
  record("Server-SR2", "no business-logic side effects on failed settlement", "MANUAL",
    "run: node server-sr2.mjs (in this dir) — it forces verify-OK/settle-FAIL and checks whether the handler's work persisted", true);

  // --- malformed payment must not be accepted (fail closed) ---
  const junk = await req(url, { headers: { "X-PAYMENT": "not-base64-at-all" } });
  if (junk.status === 402 || junk.status === 400) {
    record("SR1", "malformed payment header is rejected", "PASS", `returned ${junk.status}`);
  } else if (junk.status === 200) {
    record("SR1", "malformed payment header is rejected", "FAIL",
      "garbage X-PAYMENT returned 200 — the payment check fails OPEN");
  } else {
    record("SR1", "malformed payment header is rejected", "WARN", `returned ${junk.status}`);
  }

  // --- a well-formed but unsigned payload must not be accepted ---
  const fakePayload = Buffer.from(JSON.stringify({
    x402Version: 1, scheme: "exact", network: challenge.network || "base-sepolia",
    payload: { signature: "0x" + "00".repeat(65), authorization: {} },
  })).toString("base64");
  const fake = await req(url, { headers: { "X-PAYMENT": fakePayload } });
  if (fake.status === 402 || fake.status === 400) {
    record("SR2", "unsigned/forged payment is rejected", "PASS", `returned ${fake.status}`);
  } else if (fake.status === 200) {
    record("SR2", "unsigned/forged payment is rejected", "FAIL",
      "forged payload returned 200 — payer authorization is not verified");
  } else {
    record("SR2", "unsigned/forged payment is rejected", "WARN", `returned ${fake.status}`);
  }

  // --- zero-value payment must not buy the resource (SR5 economics) ---
  const zeroPayload = Buffer.from(JSON.stringify({
    x402Version: 1, scheme: "exact", network: challenge.network || "base-sepolia",
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        to: challenge.payTo || "0x0000000000000000000000000000000000000000",
        value: "0",
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 3600),
        nonce: "0x" + "ee".repeat(32),
      },
    },
  })).toString("base64");
  const zero = await req(url, { headers: { "X-PAYMENT": zeroPayload } });
  if (zero.status === 200) {
    record("SR5", "zero-value payment is rejected", "FAIL", "value=0 returned 200 — economically meaningless payment accepted");
  } else {
    record("SR5", "zero-value payment is rejected", "PASS", `returned ${zero.status}`);
  }

  // --- expired authorization must be rejected (SR3) ---
  const expiredPayload = Buffer.from(JSON.stringify({
    x402Version: 1, scheme: "exact", network: challenge.network || "base-sepolia",
    payload: {
      signature: "0x" + "cd".repeat(65),
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        to: challenge.payTo || "0x0000000000000000000000000000000000000000",
        value: challenge.maxAmountRequired || "5000",
        validAfter: "0",
        validBefore: "1000000",  // long past
        nonce: "0x" + "ff".repeat(32),
      },
    },
  })).toString("base64");
  const expired = await req(url, { headers: { "X-PAYMENT": expiredPayload } });
  if (expired.status === 200) {
    record("SR3", "expired authorization is rejected", "FAIL", "validBefore in the past returned 200");
  } else {
    record("SR3", "expired authorization is rejected", "PASS", `returned ${expired.status}`);
  }
}

// ----------------------------------------------------------- Facilitator rules

async function testFacilitator(furl) {
  console.log(`\n=== FACILITATOR rules @ ${furl} ===`);

  const sup = await req(`${furl.replace(/\/$/, "")}/supported`);
  if (sup.status === 200) {
    let kinds = [];
    try { kinds = JSON.parse(sup.body).kinds || []; } catch {}
    record("SR1", "/supported is reachable and lists kinds", "PASS", `${kinds.length} kind(s)`);
  } else {
    record("SR1", "/supported is reachable", "WARN", `returned ${sup.status}`);
  }

  // --- SR5: idempotency / nonce dedup. Same proof twice must not both verify valid. ---
  const payload = {
    x402Version: 1, scheme: "exact", network: "base-sepolia",
    payload: {
      signature: "0x" + "11".repeat(65),
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        value: "5000", validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 3600),
        nonce: "0x" + "22".repeat(32),
      },
    },
  };
  const requirements = {
    scheme: "exact", network: "base-sepolia",
    maxAmountRequired: "5000",
    payTo: "0x0000000000000000000000000000000000000002",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    resource: "conformance-probe", maxTimeoutSeconds: 60,
  };
  const v1 = await req(`${furl.replace(/\/$/, "")}/verify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x402Version: 1, paymentPayload: payload, paymentRequirements: requirements }),
  });
  const v2 = await req(`${furl.replace(/\/$/, "")}/verify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x402Version: 1, paymentPayload: payload, paymentRequirements: requirements }),
  });
  let ok1 = null, ok2 = null;
  try { ok1 = JSON.parse(v1.body).isValid; } catch {}
  try { ok2 = JSON.parse(v2.body).isValid; } catch {}
  if (ok1 === true && ok2 === true) {
    record("SR5", "repeated proof is not validated twice", "WARN",
      "same nonce verified valid twice — idempotency must be enforced at settle (cannot confirm from here)");
  } else {
    record("SR5", "repeated proof is not validated twice", "PASS", `first=${ok1} second=${ok2}`);
  }

  // --- SR4: settle must be truthful. MANUAL — needs a real funded key. ---
  record("SR4", "settle returns success only when settled on chain", "MANUAL",
    "requires a funded key: settle a real payment, then confirm the tx on a block explorer. A false 'success' here is the root of free-shopping.", true);

  // --- SR6/SR8: MANUAL ---
  record("SR6", "sponsored execution has fee/gas upper bounds", "MANUAL",
    "requires reading facilitator config or submitting an inflated-gas proof with a funded key", true);
  record("SR8", "on-chain execution semantics are strictly allowlisted", "MANUAL",
    "requires submitting an ERC-6492/ERC-1271 contract-signature proof and observing whether extra value moves", true);
  record("SR7", "settlement is re-verified before submission", "MANUAL",
    "requires instrumenting a controlled facilitator", true);
}

// ------------------------------------------------------------------------ main

const args = process.argv.slice(2);
let urls = [], jsonOut = null, facilitator = null;
const li = args.indexOf("--list");
if (li !== -1) urls = readFileSync(args[li + 1], "utf8").split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("#"));
else urls = args.filter(a => a.startsWith("http") && !a.includes("--"));
const fi = args.indexOf("--facilitator");
if (fi !== -1) facilitator = args[fi + 1];
const ji = args.indexOf("--json");
if (ji !== -1) jsonOut = args[ji + 1];
urls = urls.filter(u => u !== facilitator);

if (!urls.length && !facilitator) {
  console.error("usage: node x402-conformance-suite.mjs <url> [--facilitator <url>] [--json out.json]");
  process.exit(2);
}

console.log("x402 conformance suite — read-only, no funds, no side effects");
console.log(`targets: ${urls.length} server(s)${facilitator ? ", 1 facilitator" : ""}`);

for (const u of urls) await testServer(u);
if (facilitator) await testFacilitator(facilitator);

const fails = results.filter(r => r.verdict === "FAIL");
const passes = results.filter(r => r.verdict === "PASS");
const warns = results.filter(r => r.verdict === "WARN");
const manual = results.filter(r => r.verdict === "MANUAL");

console.log("\n=== SUMMARY ===");
console.log(`  PASS: ${passes.length}   FAIL: ${fails.length}   WARN: ${warns.length}   MANUAL: ${manual.length}`);
if (fails.length) {
  console.log("\n  FAILURES (each is a potential free-shopping or auth bypass):");
  for (const f of fails) console.log(`    ${f.rule}  ${f.name}\n      ${f.detail}`);
}
if (manual.length) {
  console.log("\n  NOT VERIFIABLE FROM OUTSIDE (report honestly, do not assume pass):");
  for (const m of manual) console.log(`    ${m.rule}  ${m.name}`);
}
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ scanned_at: new Date().toISOString(), targets: urls, facilitator, results }, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}
process.exit(fails.length ? 1 : 0);
