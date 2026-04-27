// scripts/debug-v3.js
// Reproduce batchClaimRank as a static call so we get the real revert reason.
//
// Run: MANAGER_ADDRESS=0x80cBa50Fe0Efe7Fd98CbDe0a290A6651fAD0bDAF node scripts/debug-v3.js

require("dotenv").config();
const { ethers } = require("ethers");

const RPC = process.env.RPC_URL || "https://rpc.pulsechain.com";
const ADDR = process.env.MANAGER_ADDRESS;

const ABI = [
  "function batchClaimRank(uint256 count, uint256 term) external",
  "function proxyImplementation() view returns (address)",
  "function owner() view returns (address)",
  "function proxyCount() view returns (uint256)",
];

async function main() {
  if (!ADDR) {
    console.error("Set MANAGER_ADDRESS env var");
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const mgr = new ethers.Contract(ADDR, ABI, wallet);

  console.log("Manager:           ", ADDR);
  console.log("Owner on chain:    ", await mgr.owner());
  console.log("Caller (PRIV_KEY): ", wallet.address);
  console.log("Impl on chain:     ", await mgr.proxyImplementation());
  console.log("Proxy count:       ", (await mgr.proxyCount()).toString());
  console.log();

  console.log("Static-calling batchClaimRank(1, 100)...");
  try {
    await mgr.batchClaimRank.staticCall(1, 100, { from: wallet.address });
    console.log("  ✓ Would succeed (no revert)");
  } catch (e) {
    console.log("  ✗ Reverted");
    console.log("  reason :", e.reason);
    console.log("  short  :", e.shortMessage);
    console.log("  data   :", e.data);
    if (e.info?.error) console.log("  info   :", e.info.error);
  }

  // Also try directly calling XEN.claimRank from a fresh contract perspective
  console.log("\nChecking XEN current max term...");
  const xen = new ethers.Contract(
    "0x8a7FDcA264e87b6da72D000f22186B4403081A2a",
    [
      "function getCurrentMaxTerm() view returns (uint256)",
      "function MIN_TERM() view returns (uint256)",
    ],
    provider
  );
  try {
    const maxTermSec = await xen.getCurrentMaxTerm();
    const minTermSec = await xen.MIN_TERM();
    const maxDays = Number(maxTermSec) / 86400;
    const minDays = Number(minTermSec) / 86400;
    console.log(`  MIN_TERM:          ${minTermSec}s  (~${minDays.toFixed(2)} days)`);
    console.log(`  getCurrentMaxTerm: ${maxTermSec}s  (~${maxDays.toFixed(2)} days)`);
    console.log(`  100 days valid?    ${100 > minDays && 100 < maxDays}`);
  } catch (e) {
    console.log("  Could not read XEN term limits:", e.shortMessage || e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
