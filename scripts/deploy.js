// scripts/deploy.js
// Run with: npx hardhat run scripts/deploy.js --network pulsechain

const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("─────────────────────────────────────────");
  console.log("👛 Deploying from:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("💰 PLS Balance:   ", ethers.formatEther(balance), "PLS");
  console.log("─────────────────────────────────────────\n");

  if (balance === 0n) {
    console.error("❌ No PLS in wallet — add PLS before deploying");
    console.error("   Bridge ETH → PLS: https://bridge.pulsechain.com");
    process.exit(1);
  }

  console.log("📦 Deploying XenMintManagerV2...");
  const Factory = await ethers.getContractFactory("XenMintManagerV2");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("✅ XenMintManagerV2 deployed to:", address);
  console.log("\n─────────────────────────────────────────");
  console.log("👉 Add this to your .env:");
  console.log(`   MANAGER_ADDRESS=${address}`);
  console.log("─────────────────────────────────────────");
  console.log("\n📋 Next steps:");
  console.log("   1. Copy MANAGER_ADDRESS into .env");
  console.log("   2. Run: node scripts/setup-v2.js");
  console.log("   3. Run: node relayer.js");
  console.log(`\n🔍 View on PulseScan:`);
  console.log(`   https://scan.pulsechain.com/address/${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
