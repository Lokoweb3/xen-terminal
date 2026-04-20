# Architecture

## Problem

XEN is a "proof-of-participation" token where each address can mine by:
1. Calling `claimRank(term)` — starts a time-locked mint
2. Waiting N days
3. Calling `claimMintReward()` — receives XEN

**Constraint:** each wallet can only have one active mint at a time. To scale, participants use hundreds of wallets in parallel — unmanageable by hand.

## Solution

A single smart contract that manages N proxy wallets, plus an off-chain bot with scoped permissions that handles the operational workload.

## Components

### 1. XenMintManagerV2 (Solidity)

Lives at a single address on PulseChain. Owns and orchestrates N proxy wallets.

```solidity
contract XenMintManagerV2 {
    address public owner;
    XenProxyV2[] public proxies;
    mapping(address => SessionKey) public sessionKeys;
    
    uint256 public defaultRestakePct = 50;
    uint256 public defaultStakeTerm  = 180;
    uint256 public defaultMintTerm   = 100;
    
    function batchClaimRank(uint256 count, uint256 term) external onlyOwner;
    function batchClaimStakeAndRestart(uint256 start, uint256 end, bool restart) external onlyOwnerOrRelayer;
    function addSessionKey(address key, uint256 validUntil, uint256 maxGas, bool canRestake) external onlyOwner;
}
```

### 2. XenProxyV2 (Solidity, mini)

Tiny single-purpose contract deployed via `CREATE2`. Each one:
- Has its own Ethereum address
- Can call `claimRank()`, `claimMintReward()`, and `stake()` on XEN
- Cannot do anything else
- Is controlled only by the manager that deployed it

Gas cost per proxy deployment: ~200k.

### 3. Relayer Bot (Node.js)

Polls the manager contract every 10 minutes and fires batch operations when proxies mature.

```javascript
async function main() {
  while (true) {
    const matured = await manager.maturedCount();
    if (matured > 0) {
      await manager.batchClaimStakeAndRestart(0, totalProxies, true);
    }
    await sleep(10 * 60 * 1000);
  }
}
```

### 4. Dashboard (React)

Reads blockchain state directly via JSON-RPC. No backend, no database. All state derived from on-chain data.

## Data flow

### Minting
```
User → Dashboard → "Start New Mint" → sendTransaction →
  Manager.batchClaimRank(50, 100)
    ├─ Loop 50 times:
    │   ├─ CREATE2 new XenProxyV2
    │   ├─ proxies.push(newProxy)
    │   └─ newProxy.claimRank(100)
    └─ emit BatchMinted(50, 100)
```

### Claiming
```
Relayer Bot (every 10 min):
  ├─ manager.maturedCount() → returns N
  ├─ if N > 0:
  │   └─ manager.batchClaimStakeAndRestart(0, totalProxies, true)
  │         ├─ for each matured proxy:
  │         │   ├─ proxy.claimMintReward() → pXEN to manager
  │         │   ├─ stake X% of harvest
  │         │   ├─ transfer (100-X)% to owner
  │         │   └─ proxy.claimRank(100) // restart
  │         └─ emit BatchClaimed(N, harvested, true)
  └─ sleep 10 min
```

## Scaling characteristics

| Proxies | Mint gas | Claim gas | Claim time |
|---|---|---|---|
| 10 | ~2.5M | ~1.8M | ~5 sec |
| 50 | ~12M | ~9M | ~15 sec |
| 200 | ~48M | ~36M | needs splitting |
| 500 | too large | too large | use multiple batches |

The `batchClaimStakeAndRestart(startIdx, endIdx, ...)` function accepts a range, so large deployments can be claimed in chunks.

## Security boundaries

### Owner EOA
- Full control: deploys, mints, claims, changes config, revokes session keys
- Private key must be kept offline or in a hardware wallet

### Relayer Session Key
- Scoped to: `batchClaim`, `batchClaimStakeAndRestart`
- Cannot withdraw funds, cannot mint new proxies, cannot change settings
- Time-limited (e.g., 364 days)
- Can be revoked instantly by the owner

### Proxy Wallets
- Each has its own address but no private key
- Can only be called by the parent manager contract
- Hold tiny amounts of ETH (for gas) that get swept on claim

## Alternatives considered

**Why not one big wallet?** XEN's `claimRank` allows only one active mint per address. Single wallet = one mint at a time.

**Why not use XENFTs directly?** XENFTs bundle N "VMUs" (virtual minting units) into one NFT, which works well. But our approach composes — you can combine proxy minting with XENFT minting, and both feed the same manager.

**Why not ERC-4337 smart accounts?** Heavier deployment cost and more complexity. The minimal proxy pattern is sufficient.
