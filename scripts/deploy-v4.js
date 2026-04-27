// scripts/deploy-v4.js
//
// Deploys XenMintManagerV4 (audit fixes for V-01 through V-05).
// The XenProxyV4 implementation is auto-deployed AND auto-locked
// inside the V4 constructor.
//
// Run:
//   npx hardhat compile
//   node scripts/deploy-v4.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = process.env.RPC_URL || "https://rpc.pulsechain.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

async function main() {
  if (!PRIVATE_KEY) {
    console.error("❌ PRIVATE_KEY missing from .env");
    process.exit(1);
  }

  const artifactPath = path.join(
    __dirname, "..", "artifacts", "contracts",
    "XenMintManagerV4.sol", "XenMintManagerV4.json"
  );
  if (!fs.existsSync(artifactPath)) {
    console.error("❌ Artifact not found. Run: npx hardhat compile");
    process.exit(1);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log("─────────────────────────────────────────");
  console.log("👛 Deploying from:", wallet.address);

  const balance = await provider.getBalance(wallet.address);
  console.log("💰 PLS Balance:   ", ethers.formatEther(balance), "PLS");
  console.log("─────────────────────────────────────────\n");

  if (balance === 0n) {
    console.error("❌ No PLS in wallet — add PLS before deploying");
    process.exit(1);
  }

  console.log("📦 Deploying XenMintManagerV4 (audit-fixed, EIP-1167 clones)...");
  const Factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await Factory.deploy();
  console.log("⏳ Tx sent:", contract.deploymentTransaction().hash);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const implAddr = await contract.proxyImplementation();

  console.log("\n✅ XenMintManagerV4 deployed to:", address);
  console.log("✅ XenProxyV4 implementation:   ", implAddr, "(LOCKED)");
  console.log("\n─────────────────────────────────────────");
  console.log("👉 Add this to your .env / dashboard / relayer:");
  console.log(`   MANAGER_ADDRESS_V4=${address}`);
  console.log("─────────────────────────────────────────");
  console.log("\n📋 Next steps:");
  console.log("   1. Add V4 to KNOWN_CONTRACTS in dashboard (auto-default).");
  console.log("   2. Run setup-v2.js with MANAGER_ADDRESS=<V4 addr> WALLET_COUNT=0");
  console.log("      (skip mint, just configure session key + relayer).");
  console.log("      OR call addSessionKey + delegateToRelayer manually,");
  console.log("      since setup-v2.js mints by default.");
  console.log("   3. Mint via dashboard or scripts/mint-v3.js (set MANAGER_ADDRESS to V4).");
  console.log("   4. Update relayer/.env to point at V4 and `pm2 restart xen-relayer`.");
  console.log(`\n🔍 View on PulseScan:`);
  console.log(`   https://scan.pulsechain.com/address/${address}`);
  console.log(`   https://scan.pulsechain.com/address/${implAddr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
