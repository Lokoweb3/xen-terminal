// setup-v2.js
// Run this ONCE after deploying XenMintManagerV2
// It wires up the session key + EIP-3074 relayer delegation
//
// node setup-v2.js
//
// .env:
//   PRIVATE_KEY=owner_wallet_key
//   MANAGER_ADDRESS=deployed_v2_address
//   RELAYER_ADDRESS=your_relayer_bot_wallet_address
//   SESSION_KEY_ADDRESS=same_as_relayer_or_different
//   WALLET_COUNT=50
//   MINT_TERM_DAYS=100

require("dotenv").config();
const { ethers } = require("ethers");

const PULSECHAIN_RPC = "https://rpc.pulsechain.com";
const CHAIN_ID = 369;

const MANAGER_ABI = [
  "function batchClaimRank(uint256 count, uint256 term) external",
  "function addSessionKey(address key, uint256 validUntil, uint256 maxGasPerTx, bool canRestake) external",
  "function delegateToRelayer(address relayer, uint256 validUntil) external",
  "function setDefaults(uint256 restakePct, uint256 stakeTerm, uint256 mintTerm) external",
  "function isSessionKeyValid(address key) view returns (bool)",
  "function delegatedRelayer() view returns (address)",
  "function proxyCount() view returns (uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(PULSECHAIN_RPC, {
    chainId: CHAIN_ID,
    name: "pulsechain",
  });

  const owner   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const manager = new ethers.Contract(process.env.MANAGER_ADDRESS, MANAGER_ABI, owner);

  const relayerAddr    = process.env.RELAYER_ADDRESS;
  const sessionKeyAddr = process.env.SESSION_KEY_ADDRESS || relayerAddr;
  const walletCount    = parseInt(process.env.WALLET_COUNT    || "50");
  const mintTerm       = parseInt(process.env.MINT_TERM_DAYS  || "100");

  // Delegation duration: 1 year
  const oneYear = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

  console.log("🔧 Setting up XenMintManagerV2...\n");
  console.log("👛 Owner:       ", owner.address);
  console.log("🤖 Relayer:     ", relayerAddr);
  console.log("🔑 Session key: ", sessionKeyAddr);
  console.log("📦 Proxies:     ", walletCount);
  console.log("⏱️  Mint term:   ", mintTerm, "days\n");

  // ── 1. Set defaults ────────────────────────────────────────
  console.log("1️⃣  Setting defaults (50% restake, 180-day stake, auto-restart)...");
  const tx1 = await manager.setDefaults(50, 180, mintTerm);
  await tx1.wait();
  console.log("   ✅ Done\n");

  // ── 2. Add session key (ERC-4337) ─────────────────────────
  console.log("2️⃣  Adding session key (ERC-4337)...");
  const tx2 = await manager.addSessionKey(
    sessionKeyAddr,
    oneYear,    // valid for 1 year
    0,          // no gas limit per tx
    true        // can restake
  );
  await tx2.wait();
  const keyValid = await manager.isSessionKeyValid(sessionKeyAddr);
  console.log("   ✅ Session key active:", keyValid, "\n");

  // ── 3. Delegate to relayer (EIP-3074) ─────────────────────
  console.log("3️⃣  Delegating to relayer (EIP-3074)...");
  const tx3 = await manager.delegateToRelayer(relayerAddr, oneYear);
  await tx3.wait();
  const delegated = await manager.delegatedRelayer();
  console.log("   ✅ Relayer delegated:", delegated, "\n");

  // ── 4. Start batch minting ─────────────────────────────────
  console.log(`4️⃣  Starting batch mint: ${walletCount} wallets, ${mintTerm}-day term...`);
  const tx4 = await manager.batchClaimRank(walletCount, mintTerm, {
    gasLimit: 200_000 * walletCount,
  });
  console.log("   ⏳ Tx:", tx4.hash);
  await tx4.wait();

  const count = await manager.proxyCount();
  console.log(`   ✅ ${count} proxy wallets minting!\n`);

  // ── Summary ────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════");
  console.log("🎉 XenMintManagerV2 fully configured!\n");
  console.log("What happens next:");
  console.log(`  • ${count} wallets are minting pXEN`);
  console.log(`  • In ${mintTerm} days they mature`);
  console.log("  • Your relayer bot will auto-claim them");
  console.log("  • 50% auto-staked, 50% sent to your wallet");
  console.log("  • New mints auto-restart immediately\n");
  console.log("Start your relayer bot now:");
  console.log("  node relayer.js");
  console.log("═══════════════════════════════════════════");
}

main().catch(console.error);
