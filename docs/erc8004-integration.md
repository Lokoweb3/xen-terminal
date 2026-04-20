# ERC-8004 Integration

XEN Terminal implements [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004) — Ethereum's emerging identity and reputation standard for autonomous AI agents.

> ⚠️ **Draft standard.** ERC-8004 was created August 13, 2025 by Marco De Rossi (MetaMask), Davide Crapis (Ethereum Foundation), Jordan Ellis (Google), and Erik Reppel (Coinbase). It went live on Ethereum mainnet January 29, 2026. Specs may evolve.

## What ERC-8004 adds to XEN Terminal

Before ERC-8004, the XEN Terminal relayer bot was "authorized" via an ad-hoc `sessionKeys` mapping inside `XenMintManagerV2.sol`. This works, but it's an internal convention — no other contract or external system can verify that this address is a legitimate automation agent.

ERC-8004 replaces that ad-hoc approach with a standard, discoverable identity:

| Before | After |
|---|---|
| Relayer address is "trusted because owner added it" | Relayer address is a registered ERC-8004 agent with on-chain metadata |
| No discoverability — other systems have no way to verify the agent | Any contract can `getAgentWallet(agentId)` to verify authorization |
| No reputation tracking | Clients can post feedback via `ReputationRegistry.giveFeedback()` |
| No validation hooks | Third parties can validate agent work via `ValidationRegistry.validationRequest()` |

## The three registries

### 1. Identity Registry ([IdentityRegistry.sol](../contracts/IdentityRegistry.sol))

ERC-721 based — each agent is an NFT. The NFT URI points to an `agent-card.json` file describing what the agent does.

**Key functions:**
```solidity
function register(string calldata agentURI) external returns (uint256 agentId);
function setAgentWallet(uint256 agentId, address newWallet) external;
function getAgentWallet(uint256 agentId) external view returns (address);
function getMetadata(uint256 agentId, string memory key) external view returns (bytes memory);
```

**Key design decisions in our impl:**
- `agentWallet` is reserved — cannot be set via generic `setMetadata()`
- On NFT transfer, `agentWallet` is cleared (must be re-set by new owner)
- We simplified the EIP-712/ERC-1271 signature verification required by the full spec; for a single-tenant system, owner-only authorization is sufficient

### 2. Reputation Registry ([ReputationRegistry.sol](../contracts/ReputationRegistry.sol))

Anyone (except the agent owner) can post a feedback entry for an agent:

```solidity
function giveFeedback(
    uint256 agentId,
    int128 value,            // e.g., 87 for "87/100"
    uint8 valueDecimals,     // e.g., 0 for integers, 2 for percentages
    string calldata tag1,    // e.g., "starred", "responseTime", "uptime"
    string calldata tag2,    // e.g., "week", "month"
    string calldata endpoint,
    string calldata feedbackURI,
    bytes32 feedbackHash
) external;
```

The XEN Terminal dashboard could expose a "Rate this agent" button where users can score the relayer on reliability, claim cadence, etc.

**Sybil mitigation:** `getSummary()` requires the caller to specify which client addresses to include in the aggregate, so reputation consumers must filter by trusted reviewers themselves.

### 3. Validation Registry ([ValidationRegistry.sol](../contracts/ValidationRegistry.sol))

Records requests for third-party validation of agent work:

```solidity
// Agent owner asks a validator to check some work
function validationRequest(
    address validator,
    uint256 agentId,
    string calldata requestURI,
    bytes32 requestHash
) external;

// Validator responds (0-100 score)
function validationResponse(
    bytes32 requestHash,
    uint8 response,
    string calldata responseURI,
    bytes32 responseHash,
    string calldata tag
) external;
```

For XEN Terminal: a validator could verify that the relayer's claim + stake + restart cycles match what the dashboard P&L reports.

## Integration with XenMintManagerV2

The manager contract now exposes an optional ERC-8004 authentication path via `AgentAuthModule.sol`:

```solidity
// In XenMintManagerV2 (after integration):
modifier onlyOwnerOrAuthorizedAgent() {
    require(
        msg.sender == owner ||
        _isAuthorizedAgent(msg.sender) ||   // NEW: via ERC-8004
        sessionKeys[msg.sender].validUntil > block.timestamp, // legacy
        "unauthorized"
    );
    _;
}
```

Two layers of authorization now work side-by-side:

1. **Legacy session keys** — existing owners keep working without any changes
2. **ERC-8004 agent auth** — new owners can point to a registered agent instead

## Agent card JSON

The `agent-card.json` (see [../agent-card.example.json](../agent-card.example.json)) is the public face of your agent. It describes:

- **Name & description** — human-readable identity
- **Services** — endpoints (web, A2A, MCP, ENS, DID, email)
- **Capabilities** — what the agent can do
- **Security** — what permissions it has / doesn't have
- **Supported trust models** — reputation, validation, TEE, etc.

Host the file at a stable URL:
- ✅ IPFS (content-addressed, no rot)
- ✅ GitHub raw URL (stable, free)
- ✅ Your own server
- ❌ ephemeral services like pastebin

## Deployment

```bash
# 1. Install dependencies
npm install

# 2. Host your agent-card.json somewhere
# (update agent-card.example.json and publish to IPFS / GitHub / etc.)

# 3. Set AGENT_URI in .env
echo "AGENT_URI=https://raw.githubusercontent.com/Lokoweb3/xen-terminal/main/agent-card.json" >> .env

# 4. Deploy the registries + register your agent
node scripts/deploy-erc8004.js
```

Output:
```
IdentityRegistry:    0xABC...
ReputationRegistry:  0xDEF...
ValidationRegistry:  0xGHI...
Agent ID:            1
Agent Wallet:        0xRELAYER...
```

## Why this matters for portfolio

As of early 2026, ERC-8004 adoption is in its infancy. Implementing it for a real autonomous system (not just the reference/demo) signals:

1. **Awareness of cutting-edge standards** — most devs haven't heard of it yet
2. **Engineering judgment** — you deployed it because it fit, not just to have it
3. **Ability to read raw specifications** — this isn't a well-trodden path with copy-paste templates
4. **Understanding of autonomous agents** — one of 2026's hottest areas

## Known limitations of this implementation

These are deliberate simplifications for the XEN Terminal use case. A production multi-tenant registry should address them:

1. **No EIP-712 signature verification for `setAgentWallet()`** — spec requires proof of new wallet's control via signature. We rely on owner authorization.
2. **No ERC-1271 support** — smart contract wallets can't register as the owner. Would require adding signature validation.
3. **Single agent per deployment** — the design scales to N agents, but we only register one.
4. **Reputation aggregation is naive** — mean aggregation only. Real systems use weighted/filtered aggregation.

## References

- [ERC-8004 spec](https://eips.ethereum.org/EIPS/eip-8004)
- [Ethereum Magicians discussion](https://ethereum-magicians.org/t/erc-8004-trustless-agents/25098)
- [QuickNode developer guide](https://blog.quicknode.com/erc-8004-a-developers-guide-to-trustless-ai-agent-identity/)
- [awesome-erc8004 repo](https://github.com/sudeepb02/awesome-erc8004)
