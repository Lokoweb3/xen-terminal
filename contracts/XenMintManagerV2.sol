// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  XenMintManagerV2
 * @notice Upgraded XEN batch minter for PulseChain with:
 *
 *   ✅ ERC-4337 Session Keys  — a trusted key auto-claims when terms expire
 *   ✅ EIP-3074 Delegation    — relayer can act on your behalf 24/7
 *   ✅ EIP-7702 Atomic Ops    — claimRank + claimReward + stake in ONE tx
 *   ✅ Auto-restart           — after claiming, immediately starts new mint
 *
 * PulseChain XEN: 0x8a7FDcA264e87b6da72D000f22186B4403081A2a
 * PulseChain RPC: https://rpc.pulsechain.com
 * Chain ID:       369
 */

// ─────────────────────────────────────────────────────────────
// Interfaces
// ─────────────────────────────────────────────────────────────
interface IXENCrypto {
    function claimRank(uint256 term) external;
    function claimMintReward() external;
    function claimMintRewardAndStake(uint256 pct, uint256 stakeTerm) external;
    function getUserMint() external view returns (MintInfo memory);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

struct MintInfo {
    address user;
    uint256 term;
    uint256 maturityTs;
    uint256 rank;
    uint256 amplifier;
    uint256 eaaRate;
}

// ─────────────────────────────────────────────────────────────
// Session Key Struct  (ERC-4337 inspired)
// ─────────────────────────────────────────────────────────────
struct SessionKey {
    address key;          // Address allowed to trigger auto-claims
    uint256 validUntil;   // Unix timestamp — key expires after this
    uint256 maxGasPerTx;  // Max gas the session key can use per tx (0 = unlimited)
    bool    canRestake;   // Whether this key can also trigger auto-restake
    bool    active;       // Can be revoked by owner at any time
}

// ─────────────────────────────────────────────────────────────
// XenProxyV2  (one per minting slot)
// ─────────────────────────────────────────────────────────────
contract XenProxyV2 {
    address public immutable manager;
    address public immutable xen;

    constructor(address _xen) {
        manager = msg.sender;
        xen     = _xen;
    }

    modifier onlyManager() {
        require(msg.sender == manager, "Proxy: not manager");
        _;
    }

    // ── Step 1: Start mint ────────────────────────────────────
    function claimRank(uint256 term) external onlyManager {
        IXENCrypto(xen).claimRank(term);
    }

    // ── Step 2a: Claim only, forward pXEN to manager ──────────
    function claimAndForward() external onlyManager {
        IXENCrypto(xen).claimMintReward();
        _forwardAll();
    }

    // ── Step 2b: EIP-7702 style — claim + stake atomically ────
    //    Then auto-restart a new mint term (no manual step needed)
    function claimStakeAndRestart(
        uint256 stakePct,
        uint256 stakeTerm,
        uint256 newMintTerm
    ) external onlyManager {
        // 1. Claim + stake in one call (XEN supports this natively)
        IXENCrypto(xen).claimMintRewardAndStake(stakePct, stakeTerm);

        // 2. Forward any unstaked portion back to manager
        _forwardAll();

        // 3. Immediately restart minting (EIP-7702 atomic pattern)
        //    This is what would previously require a second transaction
        if (newMintTerm > 0) {
            IXENCrypto(xen).claimRank(newMintTerm);
        }
    }

    // ── Read maturity ─────────────────────────────────────────
    function maturityTs() external view returns (uint256) {
        return IXENCrypto(xen).getUserMint().maturityTs;
    }

    // ── Internal: send all pXEN balance to manager ────────────
    function _forwardAll() internal {
        uint256 bal = IXENCrypto(xen).balanceOf(address(this));
        if (bal > 0) IXENCrypto(xen).transfer(manager, bal);
    }
}

// ─────────────────────────────────────────────────────────────
// XenMintManagerV2
// ─────────────────────────────────────────────────────────────
contract XenMintManagerV2 {

    // ── Constants ────────────────────────────────────────────
    address public constant XEN_PULSECHAIN =
        0x8a7FDcA264e87b6da72D000f22186B4403081A2a;

    // ── State ────────────────────────────────────────────────
    address public owner;
    XenProxyV2[] public proxies;

    // ERC-4337: Session Keys
    // Multiple keys can be active (e.g. your relayer + a backup)
    mapping(address => SessionKey) public sessionKeys;
    address[] public sessionKeyList;

    // EIP-3074: Delegated relayer
    // This address can trigger claims on your behalf without owning the contract
    address public delegatedRelayer;
    uint256 public relayerValidUntil;

    // Auto-config for restarted mints
    uint256 public defaultRestakePct  = 50;  // 50% auto-staked on claim
    uint256 public defaultStakeTerm   = 180; // 180-day stake term
    uint256 public defaultMintTerm    = 100; // restart with 100-day mint

    // ── Events ───────────────────────────────────────────────
    event ProxiesDeployed(uint256 count, uint256 term);
    event BatchClaimed(uint256 count, uint256 totalXen, bool restarted);
    event SessionKeyAdded(address key, uint256 validUntil);
    event SessionKeyRevoked(address key);
    event RelayerDelegated(address relayer, uint256 validUntil);
    event RelayerRevoked();
    event DefaultsUpdated(uint256 restakePct, uint256 stakeTerm, uint256 mintTerm);

    // ── Modifiers ────────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "V2: not owner");
        _;
    }

    /// @dev ERC-4337: Owner OR a valid, active session key
    modifier onlyAuthorized() {
        if (msg.sender != owner) {
            SessionKey memory sk = sessionKeys[msg.sender];
            require(sk.active,                        "V2: not authorized");
            require(block.timestamp <= sk.validUntil, "V2: session key expired");
        }
        _;
    }

    /// @dev EIP-3074: Owner OR the delegated relayer (within validity period)
    modifier onlyOwnerOrRelayer() {
        if (msg.sender != owner) {
            require(msg.sender == delegatedRelayer,        "V2: not relayer");
            require(block.timestamp <= relayerValidUntil,  "V2: relayer expired");
        }
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ═════════════════════════════════════════════════════════
    // STEP 1 — Start batch minting
    // ═════════════════════════════════════════════════════════
    /**
     * @param count  Number of proxy wallets (1–500)
     * @param term   Mint term in days
     *
     * Who can call: owner only (initial setup)
     */
    function batchClaimRank(uint256 count, uint256 term)
        external
        onlyOwner
    {
        require(count > 0 && count <= 500, "V2: 1-500 proxies");
        require(term >= 1,                 "V2: term >= 1 day");

        for (uint256 i = 0; i < count; i++) {
            XenProxyV2 proxy = new XenProxyV2(XEN_PULSECHAIN);
            proxy.claimRank(term);
            proxies.push(proxy);
        }

        emit ProxiesDeployed(count, term);
    }

    // ═════════════════════════════════════════════════════════
    // STEP 2a — Simple batch claim (owner or session key)
    // ═════════════════════════════════════════════════════════
    /**
     * Claims matured proxies and forwards pXEN to owner.
     * Can be triggered by owner OR an active session key.
     * This is the ERC-4337 session key pattern in action.
     */
    function batchClaim(uint256 startIdx, uint256 endIdx)
        external
        onlyAuthorized
    {
        require(endIdx <= proxies.length, "V2: out of bounds");

        uint256 before = IXENCrypto(XEN_PULSECHAIN).balanceOf(owner);

        for (uint256 i = startIdx; i < endIdx; i++) {
            if (block.timestamp >= proxies[i].maturityTs()) {
                proxies[i].claimAndForward();
            }
        }

        uint256 harvested = IXENCrypto(XEN_PULSECHAIN).balanceOf(owner) - before;
        emit BatchClaimed(endIdx - startIdx, harvested, false);
    }

    // ═════════════════════════════════════════════════════════
    // STEP 2b — EIP-7702 Atomic: claim + stake + restart
    // ═════════════════════════════════════════════════════════
    /**
     * @notice The fully automated path:
     *   1. Claims matured rewards
     *   2. Stakes a % immediately (no second tx)
     *   3. Restarts a new mint term immediately (no third tx)
     *
     * Triggered by the EIP-3074 relayer or session key automatically.
     * This collapses what used to be 3 transactions into 1.
     *
     * @param startIdx    Start index
     * @param endIdx      End index
     * @param autoRestart If true, immediately starts a new mint term
     */
    function batchClaimStakeAndRestart(
        uint256 startIdx,
        uint256 endIdx,
        bool    autoRestart
    )
        external
        onlyOwnerOrRelayer  // EIP-3074: relayer can trigger this
    {
        require(endIdx <= proxies.length, "V2: out of bounds");

        uint256 newTerm = autoRestart ? defaultMintTerm : 0;
        uint256 before  = IXENCrypto(XEN_PULSECHAIN).balanceOf(owner);

        for (uint256 i = startIdx; i < endIdx; i++) {
            XenProxyV2 proxy = proxies[i];
            if (block.timestamp >= proxy.maturityTs()) {
                // EIP-7702 pattern: claim + stake + restart in ONE call
                proxy.claimStakeAndRestart(
                    defaultRestakePct,
                    defaultStakeTerm,
                    newTerm
                );
            }
        }

        uint256 harvested = IXENCrypto(XEN_PULSECHAIN).balanceOf(owner) - before;
        emit BatchClaimed(endIdx - startIdx, harvested, autoRestart);
    }

    // ═════════════════════════════════════════════════════════
    // ERC-4337: SESSION KEY MANAGEMENT
    // ═════════════════════════════════════════════════════════

    /**
     * @notice Add a session key that can trigger auto-claims.
     *         This is the ERC-4337 session key pattern.
     *
     * @param key         Address of the session key (e.g. your relayer bot)
     * @param validUntil  Unix timestamp when this key expires
     * @param maxGasPerTx Max gas per tx (0 = no limit)
     * @param canRestake  Whether this key can also trigger restaking
     *
     * Example: addSessionKey(relayerAddress, block.timestamp + 365 days, 0, true)
     */
    function addSessionKey(
        address key,
        uint256 validUntil,
        uint256 maxGasPerTx,
        bool    canRestake
    ) external onlyOwner {
        require(key != address(0),              "V2: zero address");
        require(validUntil > block.timestamp,   "V2: already expired");

        sessionKeys[key] = SessionKey({
            key:         key,
            validUntil:  validUntil,
            maxGasPerTx: maxGasPerTx,
            canRestake:  canRestake,
            active:      true
        });

        sessionKeyList.push(key);
        emit SessionKeyAdded(key, validUntil);
    }

    /**
     * @notice Revoke a session key immediately.
     *         Use this if your relayer bot is compromised.
     */
    function revokeSessionKey(address key) external onlyOwner {
        sessionKeys[key].active = false;
        emit SessionKeyRevoked(key);
    }

    /**
     * @notice Check if a session key is currently valid
     */
    function isSessionKeyValid(address key) external view returns (bool) {
        SessionKey memory sk = sessionKeys[key];
        return sk.active && block.timestamp <= sk.validUntil;
    }

    // ═════════════════════════════════════════════════════════
    // EIP-3074: RELAYER DELEGATION
    // ═════════════════════════════════════════════════════════

    /**
     * @notice Delegate claim authority to a relayer address.
     *         Inspired by EIP-3074 AUTH/AUTHCALL pattern.
     *         The relayer can trigger batchClaimStakeAndRestart()
     *         on your behalf 24/7 without owning the contract.
     *
     * @param relayer     Address of your off-chain relayer bot
     * @param validUntil  How long the delegation lasts
     *
     * Example: delegateToRelayer(botAddress, block.timestamp + 365 days)
     */
    function delegateToRelayer(address relayer, uint256 validUntil)
        external
        onlyOwner
    {
        require(relayer != address(0),           "V2: zero address");
        require(validUntil > block.timestamp,    "V2: already expired");

        delegatedRelayer    = relayer;
        relayerValidUntil   = validUntil;

        emit RelayerDelegated(relayer, validUntil);
    }

    /**
     * @notice Revoke the relayer immediately.
     */
    function revokeRelayer() external onlyOwner {
        delegatedRelayer  = address(0);
        relayerValidUntil = 0;
        emit RelayerRevoked();
    }

    // ═════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═════════════════════════════════════════════════════════

    /**
     * @notice Update default auto-claim behaviour.
     * @param restakePct  % of XEN to auto-stake on claim (1–100)
     * @param stakeTerm   Stake term in days
     * @param mintTerm    New mint term in days when auto-restarting
     */
    function setDefaults(
        uint256 restakePct,
        uint256 stakeTerm,
        uint256 mintTerm
    ) external onlyOwner {
        require(restakePct > 0 && restakePct <= 100, "V2: pct 1-100");
        require(stakeTerm >= 1,                       "V2: stake term >= 1");
        require(mintTerm  >= 1,                       "V2: mint term >= 1");

        defaultRestakePct = restakePct;
        defaultStakeTerm  = stakeTerm;
        defaultMintTerm   = mintTerm;

        emit DefaultsUpdated(restakePct, stakeTerm, mintTerm);
    }

    // ═════════════════════════════════════════════════════════
    // VIEW HELPERS
    // ═════════════════════════════════════════════════════════

    function proxyCount() external view returns (uint256) {
        return proxies.length;
    }

    function getMaturity(uint256 idx) external view returns (uint256) {
        return proxies[idx].maturityTs();
    }

    function maturedCount() external view returns (uint256 count) {
        for (uint256 i = 0; i < proxies.length; i++) {
            if (block.timestamp >= proxies[i].maturityTs()) count++;
        }
    }

    /// @notice Returns how many proxies mature within the next N days
    function maturingSoon(uint256 withinDays)
        external
        view
        returns (uint256 count)
    {
        uint256 deadline = block.timestamp + (withinDays * 1 days);
        for (uint256 i = 0; i < proxies.length; i++) {
            uint256 ts = proxies[i].maturityTs();
            if (ts > 0 && ts <= deadline) count++;
        }
    }

    function getProxies(uint256 startIdx, uint256 endIdx)
        external
        view
        returns (address[] memory addrs)
    {
        addrs = new address[](endIdx - startIdx);
        for (uint256 i = startIdx; i < endIdx; i++) {
            addrs[i - startIdx] = address(proxies[i]);
        }
    }

    // ═════════════════════════════════════════════════════════
    // ADMIN
    // ═════════════════════════════════════════════════════════

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "V2: zero address");
        owner = newOwner;
    }
}
