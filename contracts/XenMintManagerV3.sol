// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  XenMintManagerV3
 * @notice V2 + EIP-1167 minimal proxy clones.
 *
 *   ✅ ERC-4337 Session Keys
 *   ✅ EIP-3074 Delegation
 *   ✅ EIP-7702 Atomic claim+stake+restart
 *   ✅ EIP-1167 Minimal proxies   ← NEW
 *
 * V2 deployed a full XenProxyV2 contract per slot. V3 deploys the proxy
 * implementation once, then deploys 45-byte clones that DELEGATECALL into
 * it. For 500 proxies this drops batchClaimRank gas by roughly 70-85%.
 *
 * PulseChain XEN: 0x8a7FDcA264e87b6da72D000f22186B4403081A2a
 * Chain ID:       369
 */

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

struct SessionKey {
    address key;
    uint256 validUntil;
    uint256 maxGasPerTx;
    bool    canRestake;
    bool    active;
}

// ─────────────────────────────────────────────────────────────
// XenProxyV3 — implementation contract (deployed ONCE)
//
// Constructor is replaced by initialize() because EIP-1167 clones
// DELEGATECALL into this code; they never run our constructor.
// XEN address is a constant (PulseChain XEN never changes), so we
// don't need to store it per-clone.
// ─────────────────────────────────────────────────────────────
contract XenProxyV3 {
    address public constant XEN = 0x8a7FDcA264e87b6da72D000f22186B4403081A2a;

    address public manager;
    bool    private initialized;

    function initialize(address _manager) external {
        require(!initialized,           "Proxy: already initialized");
        require(_manager != address(0), "Proxy: zero manager");
        manager     = _manager;
        initialized = true;
    }

    modifier onlyManager() {
        require(msg.sender == manager, "Proxy: not manager");
        _;
    }

    function claimRank(uint256 term) external onlyManager {
        IXENCrypto(XEN).claimRank(term);
    }

    function claimAndForward() external onlyManager {
        IXENCrypto(XEN).claimMintReward();
        _forwardAll();
    }

    function claimStakeAndRestart(
        uint256 stakePct,
        uint256 stakeTerm,
        uint256 newMintTerm
    ) external onlyManager {
        IXENCrypto(XEN).claimMintRewardAndStake(stakePct, stakeTerm);
        _forwardAll();
        if (newMintTerm > 0) {
            IXENCrypto(XEN).claimRank(newMintTerm);
        }
    }

    function maturityTs() external view returns (uint256) {
        return IXENCrypto(XEN).getUserMint().maturityTs;
    }

    function _forwardAll() internal {
        uint256 bal = IXENCrypto(XEN).balanceOf(address(this));
        if (bal > 0) IXENCrypto(XEN).transfer(manager, bal);
    }
}

// ─────────────────────────────────────────────────────────────
// XenMintManagerV3
// ─────────────────────────────────────────────────────────────
contract XenMintManagerV3 {

    address public constant XEN_PULSECHAIN =
        0x8a7FDcA264e87b6da72D000f22186B4403081A2a;

    // EIP-1167: deployed once in the constructor; every proxy is a 45-byte
    // clone that delegatecalls here.
    address public immutable proxyImplementation;

    address public owner;
    XenProxyV3[] public proxies;

    mapping(address => SessionKey) public sessionKeys;
    address[] public sessionKeyList;

    address public delegatedRelayer;
    uint256 public relayerValidUntil;

    uint256 public defaultRestakePct  = 50;
    uint256 public defaultStakeTerm   = 180;
    uint256 public defaultMintTerm    = 100;

    event ProxiesDeployed(uint256 count, uint256 term);
    event BatchClaimed(uint256 count, uint256 totalXen, bool restarted);
    event SessionKeyAdded(address key, uint256 validUntil);
    event SessionKeyRevoked(address key);
    event RelayerDelegated(address relayer, uint256 validUntil);
    event RelayerRevoked();
    event DefaultsUpdated(uint256 restakePct, uint256 stakeTerm, uint256 mintTerm);
    event ImplementationDeployed(address impl);

    modifier onlyOwner() {
        require(msg.sender == owner, "V3: not owner");
        _;
    }

    modifier onlyAuthorized() {
        if (msg.sender != owner) {
            SessionKey memory sk = sessionKeys[msg.sender];
            require(sk.active,                        "V3: not authorized");
            require(block.timestamp <= sk.validUntil, "V3: session key expired");
        }
        _;
    }

    modifier onlyOwnerOrRelayer() {
        if (msg.sender != owner) {
            require(msg.sender == delegatedRelayer,        "V3: not relayer");
            require(block.timestamp <= relayerValidUntil,  "V3: relayer expired");
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        XenProxyV3 impl = new XenProxyV3();
        proxyImplementation = address(impl);
        emit ImplementationDeployed(address(impl));
    }

    // ═════════════════════════════════════════════════════════
    // STEP 1 — Start batch minting (now via EIP-1167 clones)
    // ═════════════════════════════════════════════════════════
    function batchClaimRank(uint256 count, uint256 term)
        external
        onlyOwner
    {
        require(count > 0 && count <= 500, "V3: 1-500 proxies");
        require(term >= 1,                 "V3: term >= 1 day");

        address impl = proxyImplementation;
        for (uint256 i = 0; i < count; i++) {
            address clone = _cloneEIP1167(impl);
            XenProxyV3(clone).initialize(address(this));
            XenProxyV3(clone).claimRank(term);
            proxies.push(XenProxyV3(clone));
        }

        emit ProxiesDeployed(count, term);
    }

    // ═════════════════════════════════════════════════════════
    // STEP 2a — Simple batch claim
    // ═════════════════════════════════════════════════════════
    function batchClaim(uint256 startIdx, uint256 endIdx)
        external
        onlyAuthorized
    {
        require(endIdx <= proxies.length, "V3: out of bounds");

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
    function batchClaimStakeAndRestart(
        uint256 startIdx,
        uint256 endIdx,
        bool    autoRestart
    )
        external
        onlyOwnerOrRelayer
    {
        require(endIdx <= proxies.length, "V3: out of bounds");

        uint256 newTerm = autoRestart ? defaultMintTerm : 0;
        uint256 before  = IXENCrypto(XEN_PULSECHAIN).balanceOf(owner);

        for (uint256 i = startIdx; i < endIdx; i++) {
            XenProxyV3 proxy = proxies[i];
            if (block.timestamp >= proxy.maturityTs()) {
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
    // EIP-1167 — Minimal proxy clone
    //
    // 55-byte creation code: 10-byte init + 45-byte runtime that
    // forwards every call to `impl` via DELEGATECALL.
    // Equivalent to OpenZeppelin's Clones.clone().
    // ═════════════════════════════════════════════════════════
    function _cloneEIP1167(address impl) internal returns (address instance) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, impl))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        require(instance != address(0), "V3: clone failed");
    }

    // ═════════════════════════════════════════════════════════
    // ERC-4337 SESSION KEY MANAGEMENT
    // ═════════════════════════════════════════════════════════
    function addSessionKey(
        address key,
        uint256 validUntil,
        uint256 maxGasPerTx,
        bool    canRestake
    ) external onlyOwner {
        require(key != address(0),              "V3: zero address");
        require(validUntil > block.timestamp,   "V3: already expired");

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

    function revokeSessionKey(address key) external onlyOwner {
        sessionKeys[key].active = false;
        emit SessionKeyRevoked(key);
    }

    function isSessionKeyValid(address key) external view returns (bool) {
        SessionKey memory sk = sessionKeys[key];
        return sk.active && block.timestamp <= sk.validUntil;
    }

    // ═════════════════════════════════════════════════════════
    // EIP-3074 RELAYER DELEGATION
    // ═════════════════════════════════════════════════════════
    function delegateToRelayer(address relayer, uint256 validUntil)
        external
        onlyOwner
    {
        require(relayer != address(0),           "V3: zero address");
        require(validUntil > block.timestamp,    "V3: already expired");

        delegatedRelayer    = relayer;
        relayerValidUntil   = validUntil;

        emit RelayerDelegated(relayer, validUntil);
    }

    function revokeRelayer() external onlyOwner {
        delegatedRelayer  = address(0);
        relayerValidUntil = 0;
        emit RelayerRevoked();
    }

    // ═════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═════════════════════════════════════════════════════════
    function setDefaults(
        uint256 restakePct,
        uint256 stakeTerm,
        uint256 mintTerm
    ) external onlyOwner {
        require(restakePct > 0 && restakePct <= 100, "V3: pct 1-100");
        require(stakeTerm >= 1,                       "V3: stake term >= 1");
        require(mintTerm  >= 1,                       "V3: mint term >= 1");

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
        require(newOwner != address(0), "V3: zero address");
        owner = newOwner;
    }
}
