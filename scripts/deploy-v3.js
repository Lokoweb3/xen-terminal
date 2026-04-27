// scripts/deploy-v3.js
//
// Deploys XenMintManagerV3 (EIP-1167 clones). The XenProxyV3
// implementation is auto-deployed inside the V3 constructor.
//
// Run with:  node scripts/deploy-v3.js
// (Make sure to run `npx hardhat compile` first so artifacts exist.)

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
    __dirname,
    "..",
    "artifacts",
    "contracts",
    "XenMintManagerV3.sol",
    "XenMintManagerV3.json"
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

  console.log("📦 Deploying XenMintManagerV3 (with EIP-1167 clones)...");
  const Factory = new ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    wallet
  );
  const contract = await Factory.deploy();
  console.log("⏳ Tx sent:", contract.deploymentTransaction().hash);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const implAddr = await contract.proxyImplementation();

  console.log("\n✅ XenMintManagerV3 deployed to:", address);
  console.log("✅ XenProxyV3 implementation:   ", implAddr);
  console.log("\n─────────────────────────────────────────");
  console.log("👉 Add this to your .env:");
  console.log(`   MANAGER_ADDRESS_V3=${address}`);
  console.log("─────────────────────────────────────────");
  console.log("\n📋 Next steps:");
  console.log("   1. Open the dashboard, paste the new V3 address into the");
  console.log("      contract input — it persists in localStorage.");
  console.log("   2. Re-run setup-v2.js (or equivalent) against V3 to add a");
  console.log("      session key and delegate the relayer.");
  console.log("   3. Point the relayer's MANAGER_ADDRESS at the V3 address");
  console.log("      when you want it to operate on the new contract.");
  console.log(`\n🔍 View on PulseScan:`);
  console.log(`   https://scan.pulsechain.com/address/${address}`);
  console.log(`   https://scan.pulsechain.com/address/${implAddr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
