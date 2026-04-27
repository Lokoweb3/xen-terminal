// scripts/mint-v3.js
// Mint proxies on V3 using estimateGas + 30% buffer (no hardcoded cap).
//
// Run:
//   MANAGER_ADDRESS=0x80cBa... WALLET_COUNT=1 MINT_TERM_DAYS=100 node scripts/mint-v3.js

require("dotenv").config();
const { ethers } = require("ethers");

const RPC  = process.env.RPC_URL || "https://rpc.pulsechain.com";
const ADDR = process.env.MANAGER_ADDRESS;
const COUNT = parseInt(process.env.WALLET_COUNT || "1");
const TERM  = parseInt(process.env.MINT_TERM_DAYS || "100");

const ABI = [
  "function batchClaimRank(uint256 count, uint256 term) external",
  "function proxyCount() view returns (uint256)",
];

async function main() {
  if (!ADDR)              { console.error("Set MANAGER_ADDRESS"); process.exit(1); }
  if (!process.env.PRIVATE_KEY) { console.error("Set PRIVATE_KEY"); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const mgr      = new ethers.Contract(ADDR, ABI, wallet);

  console.log(`Minting ${COUNT} proxy wallet(s), ${TERM}-day term...`);

  const estimate = await mgr.batchClaimRank.estimateGas(COUNT, TERM);
  const gasLimit = (estimate * 130n) / 100n; // +30% buffer
  console.log(`  estimated: ${estimate}  →  gasLimit: ${gasLimit}`);

  const tx = await mgr.batchClaimRank(COUNT, TERM, { gasLimit });
  console.log(`  ⏳ tx: ${tx.hash}`);
  const r = await tx.wait();
  console.log(`  ✓ status: ${r.status}  gasUsed: ${r.gasUsed}  block: ${r.blockNumber}`);
  console.log(`  proxyCount: ${(await mgr.proxyCount()).toString()}`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message || e);
  process.exit(1);
});
