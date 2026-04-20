# EIPs Explained

This project uses three different Ethereum Improvement Proposals for account abstraction. Each serves a specific purpose.

## TL;DR

| EIP | Role in this project |
|---|---|
| [ERC-4337](#erc-4337-session-keys) | Scoped permissions for the relayer bot |
| [EIP-3074](#eip-3074-authcall-delegation) | One-time owner signature authorizes the bot |
| [EIP-7702](#eip-7702-atomic-batching) | Multiple actions in a single transaction |

Without these, the system would require the owner to manually sign every single claim transaction — thousands per year.

---

## ERC-4337 (Session Keys)

**What it is:** A pattern for delegating limited authority from an EOA to a smart contract, without giving away the private key.

**How we use it:**

The `XenMintManagerV2` contract maintains a whitelist:

```solidity
struct SessionKey {
    uint256 validUntil;     // timestamp expiry
    uint256 maxGasPerTx;    // gas cap
    bool    canRestake;     // can trigger auto-restart?
}

mapping(address => SessionKey) public sessionKeys;

modifier onlyOwnerOrRelayer() {
    require(
        msg.sender == owner ||
        (sessionKeys[msg.sender].validUntil > block.timestamp),
        "V2: unauthorized"
    );
    _;
}
```

The owner calls `addSessionKey(bot, expiry, gasLimit, true)` once, authorizing the bot for 364 days. The bot can now call protected functions, but:

- ❌ Cannot withdraw any XEN to arbitrary addresses
- ❌ Cannot change the owner
- ❌ Cannot mint new proxies
- ❌ Cannot change stake percentages or terms

It's a narrowly-scoped key, not a master key. If the relayer host is compromised, the attacker gains nothing useful.

**Why not just use a multisig?** Multisigs require multiple signers for each action — breaks automation. Session keys let one signer pre-authorize automated behavior.

---

## EIP-3074 (AUTHCALL Delegation)

**What it is:** Two new opcodes (`AUTH` and `AUTHCALL`) that let an EOA pre-sign an authorization, which an "invoker" contract can later use to act on the EOA's behalf.

**How we use it:**

```solidity
function delegateToRelayer(address relayer, uint256 validUntil) external onlyOwner {
    relayerAuthorizations[relayer] = validUntil;
    emit RelayerDelegated(relayer, validUntil);
}
```

Combined with the session key system, this gives the relayer two layers of authorization:
1. Session key grants specific function-level permissions
2. EIP-3074 delegation provides the transaction-level authorization

**Status:** EIP-3074 was [formally withdrawn in 2024](https://ethereum-magicians.org/t/eip-3074-auth-and-authcall-opcodes/5347) in favor of EIP-7702. PulseChain still supports it via its Pectra fork features, which is why this codebase uses it. On mainnet Ethereum (post-May 2025), you'd use EIP-7702 instead.

---

## EIP-7702 (Atomic Batching)

**What it is:** A new transaction type letting EOAs temporarily execute smart contract code within a single transaction.

**How we use it:**

`batchClaimStakeAndRestart()` does three actions atomically:

```solidity
function batchClaimStakeAndRestart(
    uint256 startIdx,
    uint256 endIdx,
    bool autoRestart
) external onlyOwnerOrRelayer {
    uint256 newTerm = autoRestart ? defaultMintTerm : 0;
    
    for (uint256 i = startIdx; i < endIdx; i++) {
        XenProxyV2 proxy = proxies[i];
        if (block.timestamp >= proxy.maturityTs()) {
            proxy.claimStakeAndRestart(
                defaultRestakePct,  // how much to stake
                defaultStakeTerm,   // stake term (days)
                newTerm             // restart with this mint term
            );
        }
    }
}
```

For each matured proxy, the internal `claimStakeAndRestart` call performs:
1. `XEN.claimMintReward()` → mint the pXEN
2. `XEN.stake(half, 180)` → lock half for APY
3. `transfer(owner, half)` → send the rest home
4. `XEN.claimRank(100)` → start the next mint

**Without EIP-7702:** Each proxy would require 4 separate transactions (claim, transfer, stake, restart) = N × 4 × gas_overhead.

**With EIP-7702:** One transaction handles all N proxies × 4 actions = big gas savings and no intermediate failure states.

---

## Security guarantees

### Worst-case scenarios

**Relayer private key stolen:**
- Attacker can trigger claims (which send pXEN to the *owner*, not the attacker)
- Attacker cannot redirect funds
- Attacker cannot deploy new proxies
- Worst damage: forces unwanted stakes
- Mitigation: owner revokes the session key

**Owner private key stolen:**
- Full compromise (same as any EOA)
- All XEN/stakes drainable
- Mitigation: use hardware wallet; rotate keys periodically

**Relayer host compromised:**
- Same as stolen relayer key
- Host should only have access to the scoped session key, never the owner key

### Defense in depth

```
Owner EOA (hardware wallet)
    │
    │ deploys + grants limited access
    ▼
Manager Contract
    │
    │ delegates claim-only authority
    ▼
Relayer Bot (runs on VPS, isolated from owner key)
```

The owner key never lives on the relayer host. The relayer key never controls the manager's critical config. Two-tier separation that limits blast radius.

---

## Further reading

- [ERC-4337 spec](https://eips.ethereum.org/EIPS/eip-4337)
- [EIP-3074 spec (withdrawn)](https://eips.ethereum.org/EIPS/eip-3074)
- [EIP-7702 spec](https://eips.ethereum.org/EIPS/eip-7702)
- [Alchemy's comparison guide](https://www.alchemy.com/overviews/eip-3074-vs-eip-7702-vs-erc-4337)
