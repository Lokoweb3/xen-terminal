// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  XenMintManagerV4
 * @notice V3 + audit fixes from two independent reviews:
 *   • V-01: proxies forward harvested pXEN DIRECTLY to the current `owner`.
 *           The destination is passed in as a parameter on every call, so
 *           owner changes (via two-step transfer) take effect immediately.
 *   • V-02: harvest accounting reads owner balance before/after with an
 *           underflow guard.
 *   • V-03: maxGasPerTx and canRestake on SessionKey are now ENFORCED,
 *           not dead fields.
 *   • V-04: bare implementation is locked in the constructor.
 *   • V-05: two-step ownership transfer (propose + accept).
 *   • H3:   nonReentrant guard on every batch entry point.
 *   • L2:   pause mechanism (whenNotPaused on user-facing batch ops).
 *   • Pagination on view helpers for large proxies[] arrays.
 *
 * NOTE on standards: this contract uses *patterns* inspired by ERC-4337
 * session keys, plus a homegrown relayer allowlist and a Solidity-level
 * batch pattern. It does NOT use the AUTH/AUTHCALL opcodes from EIP-3074
 * nor the EOA-delegation mechanism from EIP-7702 — those are
 * protocol-level features that operate outside this contract. EIP-1167
 * minimal proxies ARE used (see _cloneEIP1167).
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

// V-03: every field is now actually enforced somewhere in the contract.
struct SessionKey {
    address key;
    uint256 validUntil;
    uint256 maxGasPerTx;   // enforced in respectsSessionGasLimit modifier
    bool    canRestake;    // enforced in _checkRestakeAuth
    bool    active;
}

// ─────────────────────────────────────────────────────────────
// XenProxyV4 — implementation contract (deployed once, cloned via EIP-1167)
//
// V-01 fix: claimAndForward / claimStakeAndRestart take a `dst` parameter
// from the manager. Harvested pXEN flows DIRECTLY from proxy → dst (the
// manager passes the current `owner`). pXEN never sits in the manager.
// ─────────────────────────────────────────────────────────────
contract XenProxyV4 {
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

    function claimAndForward(address dst) external onlyManager {
        IXENCrypto(XEN).claimMintReward();
        _forwardTo(dst);
    }

    function claimStakeAndRestart(
        uint256 stakePct,
        uint256 stakeTerm,
        uint256 newMintTerm,
        address dst
    ) external onlyManager {
        IXENCrypto(XEN).claimMintRewardAndStake(stakePct, stakeTerm);
        _forwardTo(dst);
        if (newMintTerm > 0) {
            IXENCrypto(XEN).claimRank(newMintTerm);
        }
    }

    function maturityTs() external view returns (uint256) {
        return IXENCrypto(XEN).getUserMint().maturityTs;
    }

    function _forwardTo(address dst) internal {
        require(dst != address(0), "Proxy: zero dst");
        uint256 bal = IXENCrypto(XEN).balanceOf(address(this));
        if (bal > 0) IXENCrypto(XEN).transfer(dst, bal);
    }
}

// ─────────────────────────────────────────────────────────────
// XenMintManagerV4
// ─────────────────────────────────────────────────────────────
contract XenMintManagerV4 {

    address public constant XEN_PULSECHAIN =
        0x8a7FDcA264e87b6da72D000f22186B4403081A2a;

    address public immutable proxyImplementation;

    address public owner;
    address public pendingOwner;
    XenProxyV4[] public proxies;

    mapping(address => SessionKey) public sessionKeys;
    address[] public sessionKeyList;

    address public delegatedRelayer;
    uint256 public relayerValidUntil;

    uint256 public defaultRestakePct  = 50;
    uint256 public defaultStakeTerm   = 180;
    uint256 public defaultMintTerm    = 100;

    bool public paused;
    uint256 private _reentrancyLock = 1;  // 1 = unlocked, 2 = locked

    event ProxiesDeployed(uint256 count, uint256 term);
    event BatchClaimed(uint256 count, uint256 harvested, bool restarted);
    event SessionKeyAdded(address indexed key, uint256 validUntil, uint256 maxGasPerTx, bool canRestake);
    event SessionKeyRevoked(address indexed key);
    event RelayerDelegated(address indexed relayer, uint256 validUntil);
    event RelayerRevoked();
    event DefaultsUpdated(uint256 restakePct, uint256 stakeTerm, uint256 mintTerm);
    event ImplementationDeployed(address impl);
    event OwnershipTransferProposed(address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    modifier onlyOwner() {
        require(msg.sender == owner, "V4: not owner");
        _;
    }

    // V-03: maxGasPerTx is enforced when a session key calls in.
    // gasleft() at function entry is roughly the gas the caller supplied
    // minus stipend. If maxGasPerTx is 0 we treat it as "no limit".
    modifier respectsSessionGasLimit() {
        if (msg.sender != owner && msg.sender != delegatedRelayer) {
            SessionKey memory sk = sessionKeys[msg.sender];
            if (sk.maxGasPerTx > 0) {
                require(gasleft() <= sk.maxGasPerTx, "V4: session gas limit");
            }
        }
        _;
    }

    modifier onlyAuthorized() {
        if (msg.sender != owner) {
            SessionKey memory sk = sessionKeys[msg.sender];
            require(sk.active,                        "V4: not authorized");
            require(block.timestamp <= sk.validUntil, "V4: session key expired");
        }
        _;
    }

    // V-03: batchClaimStakeAndRestart used to gate at owner|relayer only —
    // canRestake on session keys was meaningless. Now session keys with
    // canRestake=true CAN call this, and canRestake=false keys cannot.
    modifier onlyOwnerRelayerOrRestakeKey() {
        _checkRestakeAuth();
        _;
    }

    function _checkRestakeAuth() internal view {
        if (msg.sender == owner) return;
        if (msg.sender == delegatedRelayer) {
            require(block.timestamp <= relayerValidUntil, "V4: relayer expired");
            return;
        }
        SessionKey memory sk = sessionKeys[msg.sender];
        require(sk.active,                        "V4: not authorized");
        require(block.timestamp <= sk.validUntil, "V4: session key expired");
        require(sk.canRestake,                    "V4: restake not permitted");
    }

    modifier nonReentrant() {
        require(_reentrancyLock == 1, "V4: reentrant");
        _reentrancyLock = 2;
        _;
        _reentrancyLock = 1;
    }

    modifier whenNotPaused() {
        require(!paused, "V4: paused");
        _;
    }

    constructor() {
        owner = msg.sender;
        XenProxyV4 impl = new XenProxyV4();
        proxyImplementation = address(impl);
        // V-04: lock the bare implementation. Any subsequent call to
        // impl.initialize(...) will revert. Clones each have independent
        // storage so this does not affect them.
        impl.initialize(address(1));
        emit ImplementationDeployed(address(impl));
    }

    // ═════════════════════════════════════════════════════════
    // STEP 1 — Start batch minting (EIP-1167 clones)
    // ═════════════════════════════════════════════════════════
    function batchClaimRank(uint256 count, uint256 term)
        external
        onlyOwner
        nonReentrant
        whenNotPaused
    {
        require(count > 0 && count <= 500, "V4: 1-500 proxies");
        require(term >= 1,                 "V4: term >= 1 day");

        address impl = proxyImplementation;
        for (uint256 i = 0; i < count; i++) {
            address clone = _cloneEIP1167(impl);
            XenProxyV4(clone).initialize(address(this));
            XenProxyV4(clone).claimRank(term);
            proxies.push(XenProxyV4(clone));
        }

        emit ProxiesDeployed(count, term);
    }

    // ═════════════════════════════════════════════════════════
    // STEP 2a — Simple batch claim
    // ═════════════════════════════════════════════════════════
    // V-01 fix: proxies forward DIRECTLY to `dst` (the current owner).
    // V-02 fix: harvest is the actual delta on the owner EOA, with an
    //           underflow guard if the owner balance somehow decreased.
    function batchClaim(uint256 startIdx, uint256 endIdx)
        external
        onlyAuthorized
        respectsSessionGasLimit
        nonReentrant
        whenNotPaused
    {
        require(endIdx <= proxies.length, "V4: out of bounds");

        address dst = owner;
        uint256 before = IXENCrypto(XEN_PULSECHAIN).balanceOf(dst);

        for (uint256 i = startIdx; i < endIdx; i++) {
            if (block.timestamp >= proxies[i].maturityTs()) {
                proxies[i].claimAndForward(dst);
            }
        }

        uint256 nowBal = IXENCrypto(XEN_PULSECHAIN).balanceOf(dst);
        uint256 harvested = nowBal > before ? nowBal - before : 0;
        emit BatchClaimed(endIdx - startIdx, harvested, false);
    }

    // ═════════════════════════════════════════════════════════
    // STEP 2b — Atomic claim + stake + restart
    // ═════════════════════════════════════════════════════════
    function batchClaimStakeAndRestart(
        uint256 startIdx,
        uint256 endIdx,
        bool    autoRestart
    )
        external
        onlyOwnerRelayerOrRestakeKey
        respectsSessionGasLimit
        nonReentrant
        whenNotPaused
    {
        require(endIdx <= proxies.length, "V4: out of bounds");

        uint256 newTerm = autoRestart ? defaultMintTerm : 0;
        address dst = owner;
        uint256 before = IXENCrypto(XEN_PULSECHAIN).balanceOf(dst);

        for (uint256 i = startIdx; i < endIdx; i++) {
            XenProxyV4 proxy = proxies[i];
            if (block.timestamp >= proxy.maturityTs()) {
                proxy.claimStakeAndRestart(
                    defaultRestakePct,
                    defaultStakeTerm,
                    newTerm,
                    dst
                );
            }
        }

        uint256 nowBal = IXENCrypto(XEN_PULSECHAIN).balanceOf(dst);
        uint256 harvested = nowBal > before ? nowBal - before : 0;
        emit BatchClaimed(endIdx - startIdx, harvested, autoRestart);
    }

    // ═════════════════════════════════════════════════════════
    // EIP-1167 clone deploy
    // ═════════════════════════════════════════════════════════
    function _cloneEIP1167(address impl) internal returns (address instance) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, impl))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        require(instance != address(0), "V4: clone failed");
    }

    // ═════════════════════════════════════════════════════════
    // SESSION KEY MANAGEMENT
    // V-03: maxGasPerTx and canRestake are written here AND enforced
    //       elsewhere — no longer dead fields.
    // ═════════════════════════════════════════════════════════
    function addSessionKey(
        address key,
        uint256 validUntil,
        uint256 maxGasPerTx,
        bool    canRestake
    ) external onlyOwner {
        require(key != address(0),              "V4: zero address");
        require(validUntil > block.timestamp,   "V4: already expired");

        sessionKeys[key] = SessionKey({
            key:         key,
            validUntil:  validUntil,
            maxGasPerTx: maxGasPerTx,
            canRestake:  canRestake,
            active:      true
        });

        sessionKeyList.push(key);
        emit SessionKeyAdded(key, validUntil, maxGasPerTx, canRestake);
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
    // RELAYER DELEGATION
    // ═════════════════════════════════════════════════════════
    function delegateToRelayer(address relayer, uint256 validUntil)
        external
        onlyOwner
    {
        require(relayer != address(0),          "V4: zero address");
        require(validUntil > block.timestamp,   "V4: already expired");

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
        require(restakePct > 0 && restakePct <= 100, "V4: pct 1-100");
        require(stakeTerm >= 1,                       "V4: stake term >= 1");
        require(mintTerm  >= 1,                       "V4: mint term >= 1");

        defaultRestakePct = restakePct;
        defaultStakeTerm  = stakeTerm;
        defaultMintTerm   = mintTerm;

        emit DefaultsUpdated(restakePct, stakeTerm, mintTerm);
    }

    // ═════════════════════════════════════════════════════════
    // PAUSE — emergency stop for user-facing batch operations
    // ═════════════════════════════════════════════════════════
    function pause() external onlyOwner {
        require(!paused, "V4: already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        require(paused, "V4: not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ═════════════════════════════════════════════════════════
    // VIEW HELPERS — paginated variants for large proxies[] arrays
    // ═════════════════════════════════════════════════════════
    function proxyCount() external view returns (uint256) {
        return proxies.length;
    }

    function getMaturity(uint256 idx) external view returns (uint256) {
        return proxies[idx].maturityTs();
    }

    function maturedCount() external view returns (uint256) {
        return _maturedCount(0, proxies.length);
    }

    function maturedCountRange(uint256 startIdx, uint256 endIdx)
        external
        view
        returns (uint256)
    {
        require(endIdx <= proxies.length, "V4: out of bounds");
        return _maturedCount(startIdx, endIdx);
    }

    function _maturedCount(uint256 startIdx, uint256 endIdx)
        internal
        view
        returns (uint256 count)
    {
        for (uint256 i = startIdx; i < endIdx; i++) {
            if (block.timestamp >= proxies[i].maturityTs()) count++;
        }
    }

    function maturingSoon(uint256 withinDays) external view returns (uint256) {
        return _maturingSoon(withinDays, 0, proxies.length);
    }

    function maturingSoonRange(
        uint256 withinDays,
        uint256 startIdx,
        uint256 endIdx
    )
        external
        view
        returns (uint256)
    {
        require(endIdx <= proxies.length, "V4: out of bounds");
        return _maturingSoon(withinDays, startIdx, endIdx);
    }

    function _maturingSoon(uint256 withinDays, uint256 startIdx, uint256 endIdx)
        internal
        view
        returns (uint256 count)
    {
        uint256 deadline = block.timestamp + (withinDays * 1 days);
        for (uint256 i = startIdx; i < endIdx; i++) {
            uint256 ts = proxies[i].maturityTs();
            if (ts > 0 && ts <= deadline) count++;
        }
    }

    function getProxies(uint256 startIdx, uint256 endIdx)
        external
        view
        returns (address[] memory addrs)
    {
        require(endIdx <= proxies.length, "V4: out of bounds");
        addrs = new address[](endIdx - startIdx);
        for (uint256 i = startIdx; i < endIdx; i++) {
            addrs[i - startIdx] = address(proxies[i]);
        }
    }

    // ═════════════════════════════════════════════════════════
    // OWNERSHIP — V-05: two-step transfer
    // ═════════════════════════════════════════════════════════
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "V4: zero address");
        pendingOwner = newOwner;
        emit OwnershipTransferProposed(newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "V4: not pending owner");
        address previous = owner;
        owner            = pendingOwner;
        pendingOwner     = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    function cancelOwnershipTransfer() external onlyOwner {
        pendingOwner = address(0);
    }
}
