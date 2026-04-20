// relayer-v2.js — Enhanced relayer with full XENFT auto-claim
// Handles: proxy claims + XENT (OG) claims + pXENT (Native) claims
//
// Setup: requires .env with PRIVATE_KEY (owner) and RELAYER_PRIVATE_KEY
// Run:   node relayer-v2.js
//        pm2 start relayer-v2.js --name xen-relayer-v2

require('dotenv').config();
const { ethers } = require('ethers');

// ═══════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════
const RPC            = 'https://rpc.pulsechain.com';
const CHECK_INTERVAL = 10 * 60 * 1000;  // 10 minutes

const MANAGER    = process.env.MANAGER_ADDRESS || '0xYOUR_MANAGER_ADDRESS_HERE';
const XENT       = '0x0a252663DBCc0b073063D6420a40319e438Cfa59';  // OG XENFT
const PXENT      = '0xfEa13BF27493f04DEac94f67a46441a68EfD32F8';  // Native XENFT
const PXEN_TOKEN = '0x8a7FDcA264e87b6da72D000f22186B4403081A2a';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Track addresses to monitor (owner + relayer, both hold XENFTs)
const MONITOR_ADDRESSES = [
  process.env.OWNER_ADDRESS || '0xYOUR_OWNER_ADDRESS_HERE',
  process.env.RELAYER_ADDRESS || '0xYOUR_RELAYER_ADDRESS_HERE',
];

// ═══════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════
const provider = new ethers.JsonRpcProvider(RPC);
const relayerWallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
const ownerWallet = process.env.PRIVATE_KEY ? new ethers.Wallet(process.env.PRIVATE_KEY, provider) : null;

const managerAbi = [
  'function proxyCount() view returns (uint256)',
  'function maturedCount() view returns (uint256)',
  'function maturingSoon(uint256) view returns (uint256)',
  'function batchClaimStakeAndRestart(uint256,uint256,bool)',
  'function defaultRestakePct() view returns (uint256)',
  'function defaultStakeTerm() view returns (uint256)',
  'function defaultMintTerm() view returns (uint256)',
];

const xenftAbi = [
  'function balanceOf(address) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function vmuCount(uint256) view returns (uint256)',
  'function mintInfo(uint256) view returns (uint256)',
  'function bulkClaimMintReward(uint256)',
];

const tokenAbi = [
  'function balanceOf(address) view returns (uint256)',
];

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
const now = () => new Date().toLocaleTimeString();
const log = (msg) => console.log(`[${now()}] ${msg}`);

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function findOwnedXenfts(xenftAddr, ownerAddr) {
  // Get Transfer events where `to = ownerAddr`
  const padded = '0x000000000000000000000000' + ownerAddr.slice(2).toLowerCase();
  const currentBlock = await provider.getBlockNumber();
  const CHUNK = 500000;
  const ownedIds = new Set();

  for (let from = 0; from < currentBlock; from += CHUNK) {
    const to = Math.min(from + CHUNK, currentBlock);
    try {
      const logs = await provider.getLogs({
        address: xenftAddr,
        topics: [TRANSFER_TOPIC, null, padded],
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        ownedIds.add(BigInt(log.topics[3]).toString());
      }
    } catch (err) {
      console.error(`  Log query error ${from}-${to}:`, err.message);
    }
  }

  // Verify current ownership
  const xenft = new ethers.Contract(xenftAddr, xenftAbi, provider);
  const current = [];
  for (const tokenId of ownedIds) {
    try {
      const owner = await xenft.ownerOf(tokenId);
      if (owner.toLowerCase() === ownerAddr.toLowerCase()) {
        current.push(tokenId);
      }
    } catch {}
  }
  return current;
}

async function getXenftData(xenftAddr, tokenId) {
  const xenft = new ethers.Contract(xenftAddr, xenftAbi, provider);
  try {
    const [vmus, info] = await Promise.all([
      xenft.vmuCount(tokenId),
      xenft.mintInfo(tokenId),
    ]);
    const term = Number((info >> 240n) & 0xFFFFn);
    const mintTs = Number((info >> 176n) & 0xFFFFFFFFn);
    const maturityTs = mintTs + term * 86400;
    return {
      vmus: Number(vmus),
      term,
      maturityTs,
      matured: Math.floor(Date.now() / 1000) >= maturityTs && maturityTs > 0,
    };
  } catch {
    return { vmus: 0, term: 0, maturityTs: 0, matured: false };
  }
}

// ═══════════════════════════════════════════════════════════
// CLAIM FUNCTIONS
// ═══════════════════════════════════════════════════════════
async function claimProxies(manager) {
  const matured = Number(await manager.maturedCount());
  if (matured === 0) return;

  const total = Number(await manager.proxyCount());
  log(`⚡ PROXY: ${matured} matured — firing batchClaimStakeAndRestart(0, ${total}, true)`);

  try {
    const tx = await manager.batchClaimStakeAndRestart(0, total, true, { gasLimit: 30_000_000n });
    log(`   tx: ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt.status === 1) {
      log(`   ✅ PROXY claim confirmed, gas: ${receipt.gasUsed.toString()}`);
    } else {
      log(`   ❌ PROXY claim REVERTED`);
    }
  } catch (err) {
    log(`   ❌ PROXY claim error: ${err.message || err.shortMessage}`);
  }
}

async function claimXenfts(xenftAddr, label, forWallet) {
  // Find matured XENFTs for the given wallet
  const owned = await findOwnedXenfts(xenftAddr, forWallet.address);
  if (owned.length === 0) return;

  const matured = [];
  for (const tokenId of owned) {
    const data = await getXenftData(xenftAddr, tokenId);
    if (data.matured && data.vmus > 0) {
      matured.push({ tokenId, ...data });
    }
  }

  if (matured.length === 0) {
    log(`   ${label}: ${owned.length} owned, 0 matured`);
    return;
  }

  log(`⚡ ${label}: ${matured.length} matured — claiming from ${forWallet.address.slice(0, 10)}...`);

  const xenft = new ethers.Contract(xenftAddr, xenftAbi, forWallet);

  for (const nft of matured) {
    try {
      log(`   Claiming #${nft.tokenId} (${nft.vmus} VMUs)...`);
      const tx = await xenft.bulkClaimMintReward(nft.tokenId, { gasLimit: 8_000_000n });
      log(`   tx: ${tx.hash}`);
      const receipt = await tx.wait();
      if (receipt.status === 1) {
        log(`   ✅ #${nft.tokenId} claimed — gas: ${receipt.gasUsed.toString()}`);
      } else {
        log(`   ❌ #${nft.tokenId} REVERTED`);
      }
      await sleep(2000);
    } catch (err) {
      log(`   ❌ #${nft.tokenId} failed: ${err.message || err.shortMessage}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════
async function status(manager) {
  const [total, matured, soon] = await Promise.all([
    manager.proxyCount(),
    manager.maturedCount(),
    manager.maturingSoon(3),
  ]);

  const pxenToken = new ethers.Contract(PXEN_TOKEN, tokenAbi, provider);
  const ownerBalance = ownerWallet
    ? ethers.formatUnits(await pxenToken.balanceOf(ownerWallet.address), 18)
    : 'n/a';

  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`📊 Proxies:   ${total} total, ${matured} matured, ${soon} maturing soon`);
  log(`💎 pXEN:      ${parseFloat(ownerBalance).toLocaleString()} (owner wallet)`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ═══════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════
async function checkAll() {
  const manager = new ethers.Contract(MANAGER, managerAbi, relayerWallet);

  try {
    await status(manager);

    // 1. Proxy wallets (via manager contract, called by relayer)
    await claimProxies(manager);

    // 2. OG XENT XENFTs for each wallet we control
    if (ownerWallet) {
      await claimXenfts(XENT, 'XENT (owner)', ownerWallet);
    }
    await claimXenfts(XENT, 'XENT (relayer)', relayerWallet);

    // 3. Native pXENT XENFTs for each wallet we control
    if (ownerWallet) {
      await claimXenfts(PXENT, 'pXENT (owner)', ownerWallet);
    }
    await claimXenfts(PXENT, 'pXENT (relayer)', relayerWallet);

    log(`✓ Check complete — next in ${CHECK_INTERVAL / 60000} minutes`);
  } catch (err) {
    log(`⚠ Check error: ${err.message}`);
  }
}

async function main() {
  log('🤖 XEN Relayer v2 starting...');
  log(`   Manager:  ${MANAGER}`);
  log(`   Relayer:  ${relayerWallet.address}`);
  if (ownerWallet) {
    log(`   Owner:    ${ownerWallet.address}`);
  } else {
    log(`   Owner:    NOT CONFIGURED (add PRIVATE_KEY to .env for owner XENFT claims)`);
  }
  log(`   XENT:     ${XENT}`);
  log(`   pXENT:    ${PXENT}`);
  log(`   Interval: every ${CHECK_INTERVAL / 60000} minutes`);
  log('');

  // Run immediately
  await checkAll();

  // Then on interval
  setInterval(checkAll, CHECK_INTERVAL);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
