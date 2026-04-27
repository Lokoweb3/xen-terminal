// scripts/setup-v4.js
//
// Config-only setup for XenMintManagerV4: session key + relayer delegation
// + defaults. Does NOT mint — use mint-v3.js (with V4 address) or the
// dashboard for that.
//
// Run:
//   MANAGER_ADDRESS=0x<V4 addr> node scripts/setup-v4.js

require("dotenv").config();
const { ethers } = require("ethers");

const RPC = process.env.RPC_URL || "https://rpc.pulsechain.com";

const ABI = [
  "function addSessionKey(address key, uint256 validUntil, uint256 maxGasPerTx, bool canRestake) external",
  "function delegateToRelayer(address relayer, uint256 validUntil) external",
  "function setDefaults(uint256 restakePct, uint256 stakeTerm, uint256 mintTerm) external",
  "function isSessionKeyValid(address key) view returns (bool)",
  "function delegatedRelayer() view returns (address)",
  "function owner() view returns (address)",
];

async function main() {
  if (!process.env.PRIVATE_KEY)     { console.error("Set PRIVATE_KEY"); process.exit(1); }
  if (!process.env.MANAGER_ADDRESS) { console.error("Set MANAGER_ADDRESS"); process.exit(1); }
  if (!process.env.RELAYER_ADDRESS) { console.error("Set RELAYER_ADDRESS"); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const owner    = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const manager  = new ethers.Contract(process.env.MANAGER_ADDRESS, ABI, owner);

  const relayerAddr    = process.env.RELAYER_ADDRESS;
  const sessionKeyAddr = process.env.SESSION_KEY_ADDRESS || relayerAddr;
  const mintTerm       = parseInt(process.env.MINT_TERM_DAYS || "100");

  const oneYear = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

  console.log("🔧 Setting up XenMintManagerV4 (config only)\n");
  console.log("👛 Owner:       ", owner.address);
  console.log("📋 Manager:     ", process.env.MANAGER_ADDRESS);
  console.log("🤖 Relayer:     ", relayerAddr);
  console.log("🔑 Session key: ", sessionKeyAddr);
  console.log();

  const onChainOwner = await manager.owner();
  if (onChainOwner.toLowerCase() !== owner.address.toLowerCase()) {
    console.error(`❌ Caller (${owner.address}) is not the manager owner (${onChainOwner})`);
    process.exit(1);
  }

  console.log("1️⃣  Setting defaults (50% restake, 180-day stake, "+mintTerm+"-day mint)...");
  const tx1 = await manager.setDefaults(50, 180, mintTerm);
  await tx1.wait();
  console.log("   ✅ Done\n");

  console.log("2️⃣  Adding session key (V4: key, validUntil, maxGasPerTx=0, canRestake=true)...");
  // maxGasPerTx=0 means no per-tx gas cap. canRestake=true allows the key
  // to call batchClaimStakeAndRestart.
  const tx2 = await manager.addSessionKey(sessionKeyAddr, oneYear, 0, true);
  await tx2.wait();
  const keyValid = await manager.isSessionKeyValid(sessionKeyAddr);
  console.log("   ✅ Session key active:", keyValid, "\n");

  console.log("3️⃣  Delegating to relayer...");
  const tx3 = await manager.delegateToRelayer(relayerAddr, oneYear);
  await tx3.wait();
  const delegated = await manager.delegatedRelayer();
  console.log("   ✅ Relayer delegated:", delegated, "\n");

  console.log("═══════════════════════════════════════════");
  console.log("🎉 V4 configured. Ready to mint via dashboard or:");
  console.log(`   MANAGER_ADDRESS=${process.env.MANAGER_ADDRESS} \\`);
  console.log(`   WALLET_COUNT=1 \\`);
  console.log("   node scripts/mint-v3.js   # works for V4 too (same ABI)");
  console.log("═══════════════════════════════════════════");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
