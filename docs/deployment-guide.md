# Deployment Guide

Step-by-step setup for running your own XEN Terminal instance.

> ⚠️ **This is an educational reference.** Do not redeploy to mainnet without understanding the code and accepting the risks.

## Prerequisites

- Node.js 20+ (tested on v22)
- A funded PulseChain wallet (~2,000 PLS minimum for deployment + first mints)
- Basic familiarity with Ethereum tooling (ethers.js, private keys, gas)

## Step 1 — Clone and install

```bash
git clone https://github.com/Lokoweb3/xen-terminal
cd xen-terminal

# Install root, relayer, and dashboard dependencies
npm install
cd relayer && npm install && cd ..
cd dashboard && npm install && cd ..
```

## Step 2 — Create wallets

Generate TWO fresh wallets — never reuse an existing wallet.

```bash
# Owner wallet (deploys contract, receives rewards)
node -e "const w = require('ethers').Wallet.createRandom(); console.log('Owner:', w.address, w.privateKey);"

# Relayer wallet (runs the bot)
node -e "const w = require('ethers').Wallet.createRandom(); console.log('Relayer:', w.address, w.privateKey);"
```

Save both outputs securely. Never commit private keys.

## Step 3 — Fund the wallets

Send PLS to both:

| Wallet | Recommended amount | Purpose |
|---|---|---|
| Owner | ~2,000 PLS | Contract deployment, proxy mints |
| Relayer | ~1,000 PLS | Gas for 12+ months of claims |

Buy PLS on PulseX or bridge from Ethereum.

## Step 4 — Configure .env

```bash
cp .env.example .env
nano .env
```

Fill in:
```env
PRIVATE_KEY=0x...        # Owner private key
OWNER_ADDRESS=0x...      # Owner address
RELAYER_PRIVATE_KEY=0x... # Relayer private key
RELAYER_ADDRESS=0x...    # Relayer address
```

Leave `MANAGER_ADDRESS` blank for now.

## Step 5 — Deploy the manager contract

```bash
node scripts/deploy.js
```

Output will include the deployed address:
```
✅ Deployed XenMintManagerV2 at 0xABC123...
```

Copy that address into `.env`:
```env
MANAGER_ADDRESS=0xABC123...
```

## Step 6 — Authorize the relayer

```bash
node scripts/setup-v2.js
```

This calls:
1. `addSessionKey(relayer, 364 days, 1000000 gas, canRestake=true)`
2. `delegateToRelayer(relayer, 364 days)`

Verify:
```bash
node -e "
const {ethers} = require('ethers');
require('dotenv').config();
const p = new ethers.JsonRpcProvider('https://rpc.pulsechain.com');
const c = new ethers.Contract(process.env.MANAGER_ADDRESS, [
  'function sessionKeys(address) view returns (uint256,uint256,bool)'
], p);
c.sessionKeys(process.env.RELAYER_ADDRESS).then(console.log);
"
```

Should show a non-zero `validUntil` timestamp.

## Step 7 — Mint your first proxies

Via the dashboard (see Step 8) or directly:

```bash
node -e "
const {ethers} = require('ethers');
require('dotenv').config();
const p = new ethers.JsonRpcProvider('https://rpc.pulsechain.com');
const w = new ethers.Wallet(process.env.PRIVATE_KEY, p);
const c = new ethers.Contract(process.env.MANAGER_ADDRESS, [
  'function batchClaimRank(uint256,uint256)'
], w);
c.batchClaimRank(10, 100).then(tx => tx.wait()).then(() => console.log('✓ Minted 10 proxies for 100 days'));
"
```

## Step 8 — Start the dashboard

```bash
cd dashboard
npm start
```

Opens at http://localhost:3000. Connect the owner wallet via MetaMask/Rabby and paste the manager address when prompted.

## Step 9 — Start the relayer bot

```bash
cd relayer

# Option A: Simple nohup
nohup node relayer-v2.js > relayer.log 2>&1 &

# Option B: PM2 (recommended — survives reboots)
npm install -g pm2
pm2 start relayer-v2.js --name xen-relayer
pm2 save
pm2 startup  # run the command it prints with sudo
```

Verify it's running:
```bash
pm2 logs xen-relayer
```

Should see:
```
🤖 XEN Relayer v2 starting...
✓ Manager: 0xABC123...
📊 Proxies: 10 total, 0 matured, 0 maturing soon
```

## Step 10 — Verify and monitor

Check the dashboard Overview tab. You should see:
- Total Proxies: matches the count you minted
- PLS Reserve: your current balance
- P&L card with live prices

Leave everything running. The bot polls every 10 minutes and auto-claims when proxies mature.

## Common issues

**Deployment fails with "insufficient funds"**
Need more PLS. Contract deployment costs ~50 PLS, each proxy mint ~5 PLS.

**Relayer logs show "V2: not owner"**
The relayer isn't authorized. Re-run `scripts/setup-v2.js`.

**Dashboard shows "0 proxies" despite minting**
The dashboard reads from your connected wallet. Make sure it's the owner wallet.

**Transactions stuck with "queued sub-pool is full"**
PulseChain RPC congestion. Switch RPC endpoint in Rabby settings:
- `https://rpc-pulsechain.g4mm4.io`
- `https://pulsechain.publicnode.com`

**XENFT mints revert with "Error while claiming rank"**
Your term is higher than the current max. The XEN protocol's max term grows over time; use ≤515 days today.

## Cost estimate

One-time costs:
- Contract deployment: ~50 PLS
- Session key setup: ~2 PLS
- Relayer delegation: ~2 PLS

Per-proxy costs:
- Mint: ~5 PLS
- Claim + stake + restart (per batch of 50): ~10 PLS

For 50 proxies over one year:
- Initial setup: ~305 PLS
- ~3-4 claim cycles: ~30-40 PLS
- Total: ~340 PLS (~$0.003 at current prices)

## Next steps

- Read [architecture.md](architecture.md) to understand what's happening under the hood
- Read [eips-explained.md](eips-explained.md) to learn the account abstraction patterns
- Experiment: change `defaultRestakePct`, try different mint terms, analyze gas costs
