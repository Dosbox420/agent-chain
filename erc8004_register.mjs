/**
 * erc8004_register.mjs — register this agent's identity on Base Sepolia.
 *
 * ERC-8004 Identity Registry: 0x8004A818BFB912233c491871b3d84c89A494BD9e
 * The agent gets an ERC-721 token whose tokenURI is an agent card describing
 * what it does and how to reach it (including its x402 endpoint and inbox).
 */
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const PK = process.env.PAYER_PRIVATE_KEY
  || "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const RPC = "https://sepolia.base.org";
const IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

const IDENTITY_ABI = [
  { type: "function", name: "register", stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }] },
  { type: "function", name: "ownerOf", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "tokenURI", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }] },
  { type: "event", name: "Registered", inputs: [
    { name: "agentId", type: "uint256", indexed: true },
    { name: "agentURI", type: "string", indexed: false },
    { name: "owner", type: "address", indexed: true } ] },
];

const account = privateKeyToAccount(PK);
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });

// The agent card: what this agent is, what it sells, how to pay it.
const agentCard = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "MDA Agent Commerce Node",
  description:
    "Autonomous agent selling machine-readable market signals over x402 " +
    "(USDC, HTTP 402). Policy-gated treasury; every spend logged.",
  services: [
    { name: "x402", endpoint: "http://localhost:4021/signal/{topic}",
      version: "1", pricing: "$0.005 USDC per call" },
    { name: "email", endpoint: "your-inbox@agentmail.to" },
  ],
  x402Support: true,
  active: true,
  supportedTrust: ["reputation"],
};

async function main() {
  console.log("account:", account.address);
  const bal = await pub.getBalance({ address: account.address });
  console.log("gas balance:", Number(bal) / 1e18, "ETH");
  if (bal === 0n) throw new Error("no gas");

  const uri = "data:application/json;base64," +
    Buffer.from(JSON.stringify(agentCard)).toString("base64");
  console.log("agent card bytes:", uri.length);

  console.log("\nregistering...");
  const hash = await wallet.writeContract({
    address: IDENTITY, abi: IDENTITY_ABI, functionName: "register", args: [uri],
  });
  console.log("tx:", hash);

  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log("status:", receipt.status, "| block:", receipt.blockNumber);

  // parse agentId from logs
  let agentId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = await pub.getTransactionReceipt({ hash });
    } catch {}
  }
  // decode via topic: Registered(uint256 indexed agentId,...) -> topic[1]
  for (const log of receipt.logs) {
    if (log.topics.length >= 2 && log.address.toLowerCase() === IDENTITY.toLowerCase()) {
      agentId = BigInt(log.topics[1]);
      break;
    }
  }
  console.log("AGENT ID:", agentId?.toString() ?? "(not found)");

  if (agentId !== null) {
    const owner = await pub.readContract({
      address: IDENTITY, abi: IDENTITY_ABI, functionName: "ownerOf", args: [agentId] });
    const gotUri = await pub.readContract({
      address: IDENTITY, abi: IDENTITY_ABI, functionName: "tokenURI", args: [agentId] });
    console.log("owner:", owner);
    console.log("tokenURI length:", gotUri.length);
    console.log("\nVERIFIED on Base Sepolia. agentId =", agentId.toString());
    console.log("Explorer: https://sepolia.basescan.org/tx/" + hash);
  }
}

main().catch(e => { console.error("ERROR:", e.shortMessage ?? e.message); process.exit(1); });
