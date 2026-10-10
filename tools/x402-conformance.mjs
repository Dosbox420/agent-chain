/**
 * x402-conformance.mjs — does an x402 endpoint ACTUALLY charge?
 *
 * Built after finding a fail-open bypass in x402's own route matcher: a route
 * declared with Express `:param` syntax is never matched by the payment
 * middleware, so the paid resource is served free — silently, no 402, no error,
 * no log. Every x402 seller is exposed to this class of bug and most have no way
 * to notice: they see traffic, and no revenue, with nothing to explain it.
 *
 * This scanner asks the one question that matters: with NO payment header,
 * does the endpoint refuse? It must return 402. A 200 means the resource leaked.
 *
 * Usage:
 *   node x402-conformance.mjs https://merchant.example/api/paid
 *   node x402-conformance.mjs --list hosts.txt        # one URL per line
 *   node x402-conformance.mjs --list hosts.txt --json out.json
 *
 * Safety: this only performs UNAUTHENTICATED GETs and reads status codes. It
 * never pays, never sends a payment header, never mutates state. It is the same
 * request any agent makes before paying. Read-only, no side effects.
 */
import { writeFileSync } from "node:fs";

const UA = "x402-conformance/1.0 (+https://github.com/Dosbox420/agent-chain; read-only status check)";

function classify(status, bodyText) {
  // 402 = correctly gated. Anything 2xx = the paid resource was served free.
  if (status === 402) return { verdict: "GATED", note: "correctly requires payment" };
  if (status === 200) {
    const hasPaymentTerms = /accepts|maxAmountRequired|payTo|x402Version|PAYMENT-REQUIRED/i.test(bodyText || "");
    if (hasPaymentTerms) return { verdict: "OK_402_IN_BODY", note: "200 but body carries x402 terms" };
    return { verdict: "LEAK", note: "served 200 with no payment terms — resource may be free" };
  }
  if (status === 401 || status === 403) return { verdict: "AUTH_WALL", note: "auth-gated, not x402" };
  if (status === 404) return { verdict: "NO_ROUTE", note: "path not found" };
  if (status === 405) return { verdict: "METHOD", note: "GET not allowed" };
  if (status >= 500) return { verdict: "ERROR", note: "server error" };
  return { verdict: "OTHER", note: `unexpected ${status}` };
}

async function probe(url, timeoutMs = 12000) {
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": UA, Accept: "*/*" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(t);
    let body = "";
    try { body = (await r.text()).slice(0, 4000); } catch {}
    const c = classify(r.status, body);
    return {
      url, status: r.status, ...c,
      ms: Date.now() - started,
      // x402 challenge details if present
      network: (body.match(/"network"\s*:\s*"([^"]+)"/) || [])[1] || null,
      payTo: (body.match(/"payTo"\s*:\s*"([^"]+)"/) || [])[1] || null,
      amount: (body.match(/"maxAmountRequired"\s*:\s*"([^"]+)"/) || [])[1] || null,
    };
  } catch (e) {
    return { url, status: 0, verdict: "UNREACHABLE", note: String(e.message || e).slice(0, 80), ms: Date.now() - started };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

const args = process.argv.slice(2);
let urls = [];
let jsonOut = null;
const listIdx = args.indexOf("--list");
if (listIdx !== -1) {
  const { readFileSync } = await import("node:fs");
  urls = readFileSync(args[listIdx + 1], "utf8")
    .split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
} else {
  urls = args.filter((a) => a.startsWith("http"));
}
const jIdx = args.indexOf("--json");
if (jIdx !== -1) jsonOut = args[jIdx + 1];

if (!urls.length) {
  console.error("usage: node x402-conformance.mjs <url> | --list <file> [--json out.json]");
  process.exit(2);
}

console.log(`x402 conformance scan — ${urls.length} endpoint(s), unauthenticated GET only\n`);
const results = await mapLimit(urls, 8, probe);

const buckets = {};
for (const r of results) buckets[r.verdict] = (buckets[r.verdict] || 0) + 1;

for (const r of results) {
  const mark = r.verdict === "GATED" ? "OK  " : r.verdict === "LEAK" ? "LEAK" : "?   ";
  console.log(`${mark} ${String(r.status).padStart(3)}  ${r.url.slice(0, 78)}`);
  if (r.verdict !== "GATED") console.log(`         ${r.verdict}: ${r.note}`);
  if (r.network || r.amount) console.log(`         x402: network=${r.network} amount=${r.amount} payTo=${r.payTo}`);
}

console.log("\n=== summary ===");
for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
const leaks = results.filter((r) => r.verdict === "LEAK");
if (leaks.length) {
  console.log(`\n*** ${leaks.length} endpoint(s) returned 200 with no payment terms ***`);
  console.log("    These may be serving paid resources free. Verify by hand before reporting.");
}
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ scanned_at: new Date().toISOString(), results, buckets }, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}
