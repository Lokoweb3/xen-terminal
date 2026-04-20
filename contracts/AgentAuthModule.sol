// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AgentAuthModule
 * @notice ERC-8004 integration layer for XenMintManagerV2.
 *
 *         Allows the relayer bot to prove its identity as an ERC-8004
 *         registered agent instead of (or in addition to) relying on
 *         the ad-hoc sessionKeys mapping in the manager.
 *
 *         This is an additive, opt-in module:
 *         - Existing session-key flow continues to work unchanged.
 *         - Agents with a registered ERC-8004 identity can authenticate
 *           via getAgentWallet() instead of being pre-registered.
 *
 * @dev    Spec: https://eips.ethereum.org/EIPS/eip-8004
 */

interface IIdentityRegistry8004 {
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
}

abstract contract AgentAuthModule {
    IIdentityRegistry8004 public identityRegistry;
    uint256 public agentId;

    event AgentIdentityLinked(address indexed identityRegistry, uint256 indexed agentId);

    /**
     * @notice Link this manager to an ERC-8004 agent identity
     * @dev Caller must be the owner of the manager (enforced by inheriting contract)
     */
    function _linkAgentIdentity(address registry_, uint256 agentId_) internal {
        identityRegistry = IIdentityRegistry8004(registry_);
        agentId = agentId_;
        emit AgentIdentityLinked(registry_, agentId_);
    }

    /**
     * @notice Returns true if `caller` is authorized to act as this agent
     * @dev Authorized if they are the agent NFT owner OR the agentWallet
     */
    function _isAuthorizedAgent(address caller) internal view returns (bool) {
        if (address(identityRegistry) == address(0) || agentId == 0) return false;

        // Query owner (NFT holder) — reverts if agent doesn't exist, catch it
        try identityRegistry.ownerOf(agentId) returns (address owner) {
            if (owner == caller) return true;
        } catch {
            return false;
        }

        // Check the agentWallet metadata
        try identityRegistry.getAgentWallet(agentId) returns (address wallet) {
            if (wallet == caller && wallet != address(0)) return true;
        } catch {
            return false;
        }

        return false;
    }
}
