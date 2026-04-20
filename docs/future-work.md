# Future Work

This project demonstrates four Ethereum standards (ERC-4337 session keys, EIP-3074 AUTHCALL, EIP-7702 atomic batching, and ERC-8004 Trustless Agents). Several other emerging 2026 EIPs could extend the system further.

## Evaluated Standards

### ERC-8211 — Smart Batching (Biconomy × EF, April 2026)

**[Official spec](https://www.erc8211.com/)**

A declarative batch format where each parameter declares how to obtain its value at execution time, with inline predicate checks. Brilliant for DeFi flows with dynamic outputs (swaps, bridges, lending withdrawals).

**Fit for XEN Terminal:** Low priority. XEN rewards are deterministic — the amount claimed from each proxy is predictable given block timestamp and term. Static parameters work fine for our batched `claim → stake → restart` operation.

**Would become relevant if we added:**
- Auto-selling harvested pXEN on PulseX (swap with slippage protection)
- Dynamic term selection based on current XEN global max
- Oracle-gated stake decisions (stake more when price is high)
- Cross-chain operations (bridging pXEN to Ethereum)

---

### ERC-8126 — AI Agent Registration and Verification

Extends ERC-8004 with five specialized verification types: Ethereum Token Verification, Media Content Verification, Solidity Code Verification, Web Application Verification, and Wallet Verification. Uses zero-knowledge proofs.

**Fit for XEN Terminal:** Natural extension of our existing ERC-8004 implementation. Would enable third-party ZK attestations of the agent's smart contract security (SCV) and operational integrity (WV).

**Implementation estimate:** ~3-5 days. Requires coordination with a verification provider. More useful once the ERC-8004 ecosystem matures.

---

### ERC-8199 — Sandboxed Smart Wallet

Formalizes the concept of a wallet with restricted call permissions.

**Fit for XEN Terminal:** Our `XenProxyV2` mini-contracts are already effectively sandboxed — they can only call XEN functions, nothing else. Adding ERC-8199 compliance would be mostly documentation.

---

### ERC-8191 — Onchain Recurring Payments

Defines a standard for repeating on-chain operations.

**Fit for XEN Terminal:** Thematic fit — our 100-day mint cycles are inherently recurring. But this EIP is more oriented toward subscriptions/payments than mining cycles.

---

### ERC-8187 — Token Puller

Standardizes how contracts pull tokens from other contracts via a signed permit.

**Fit for XEN Terminal:** Not immediately relevant. We don't pull tokens from external contracts.

---

## Deliberate non-additions

### Why not integrate every new EIP?

- **Moving target:** Many EIPs in the 8000 range are in `Draft` status. Specs change during review.
- **Complexity cost:** Each added standard = more code to maintain, more surface for bugs.
- **Over-engineering:** Adding standards without a use case is solution-shopping.

### What we'd add if project scope expanded

1. **ERC-8126** (agent verification) — first priority, once the ERC-8004 ecosystem has active verifiers
2. **ERC-8211** (smart batching) — second, if we add DeFi composition like auto-selling pXEN
3. **ERC-8199** (sandboxed wallet) — third, for cleaner proxy interfaces

---

## Current architecture is minimal by design

**Use the fewest standards that solve the actual problem:**

- ERC-4337 — bot needs scoped permissions
- EIP-3074 — bot needs to act on owner's behalf without per-tx signature
- EIP-7702 — multiple actions should be atomic
- ERC-8004 — bot needs a verifiable, discoverable identity

That's the minimum stack for a production-grade autonomous agent. If the project scope changes (cross-chain, DeFi integrations, validator networks), revisit this document.
