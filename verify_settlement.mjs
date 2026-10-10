/**
 * verify_settlement.mjs — run one paid call and PROVE the settlement.
 * Captures the full X-PAYMENT-RESPONSE header, decodes it, and reports
 * exact balance deltas on Base Sepolia.
 */
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MERCHANT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const URL_TO_BUY = process.argv[2] || "http://localhost:4021/report";

const account = privateKeyToAccount(
  process.env.PAYER_PRIVATE_KEY ||
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
);

const pc = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const bal = (who) => pc.readContract({ address: USDC, abi, functionName: "balanceOf", args: [who] });

const before = { payer: await bal(account.address), merchant: await bal(MERCHANT) };
console.log("BEFORE:");
console.log("  payer:   ", Number(before.payer) / 1e6, "USDC");
console.log("  merchant:", Number(before.merchant) / 1e6, "USDC");

const paidFetch = wrapFetchWithPayment(fetch, account);
const res = await paidFetch(URL_TO_BUY);

console.log("\nRESPONSE status:", res.status);
const raw = res.headers.get("x-payment-response");
console.log("X-PAYMENT-RESPONSE (full, len=" + (raw?.length || 0) + "):");
console.log(raw);

if (raw) {
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    console.log("\nDECODED RECEIPT:", JSON.stringify(decoded, null, 2));
    if (decoded.transaction) {
      console.log("\nTX HASH:", decoded.transaction);
      const receipt = await pc.getTransactionReceipt({ hash: decoded.transaction });
      console.log("  on-chain status:", receipt.status, "| block:", receipt.blockNumber);
      console.log("  from:", receipt.from);
      console.log("  to:  ", receipt.to);
      console.log("  logs:", receipt.logs.length);
    }
  } catch (e) {
    console.log("decode error:", e.message);
  }
}

await new Promise(r => setTimeout(r, 4000));
const after = { payer: await bal(account.address), merchant: await bal(MERCHANT) };
console.log("\nAFTER:");
console.log("  payer:   ", Number(after.payer) / 1e6, "USDC");
console.log("  merchant:", Number(after.merchant) / 1e6, "USDC");
console.log("\nDELTA:");
console.log("  payer:   ", (Number(after.payer) - Number(before.payer)) / 1e6, "USDC");
console.log("  merchant:", (Number(after.merchant) - Number(before.merchant)) / 1e6, "USDC");
