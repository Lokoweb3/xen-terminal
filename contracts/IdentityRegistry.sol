// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ERC-8004 Identity Registry
 * @notice Minimal reference implementation of the ERC-8004 Identity Registry
 *         (Trustless Agents) for the XEN Terminal relayer agent.
 *
 * @dev This is a compact, single-file reference implementation intended for
 *      the XEN Terminal project. For production multi-tenant agent economies,
 *      use the canonical reference at github.com/ethereum/ERCs.
 *
 *      Specification: https://eips.ethereum.org/EIPS/eip-8004
 *      Authors of the spec: Marco De Rossi (MetaMask), Davide Crapis (EF),
 *                          Jordan Ellis (Google), Erik Reppel (Coinbase)
 */

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IERC721 is IERC165 {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function balanceOf(address owner) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function approve(address to, uint256 tokenId) external;
    function setApprovalForAll(address operator, bool approved) external;
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

interface IERC721Metadata is IERC721 {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function tokenURI(uint256 tokenId) external view returns (string memory);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

/// @title ERC-8004 Identity Registry with URI storage + custom metadata
contract IdentityRegistry is IERC721Metadata {
    // ═══ ERC-721 state ═══════════════════════════════════════
    string private constant _NAME = "ERC-8004 Identity";
    string private constant _SYMBOL = "AGENT";

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    mapping(uint256 => string) private _tokenURIs;

    uint256 private _nextAgentId = 1;

    // ═══ ERC-8004 state ══════════════════════════════════════
    /// @dev Reserved metadata key for the agent's payment wallet
    bytes32 private constant AGENT_WALLET_KEY = keccak256("agentWallet");

    /// @dev agentId => keccak(metadataKey) => value
    mapping(uint256 => mapping(bytes32 => bytes)) private _metadata;

    /// @dev Original string form of keys (for emission in events)
    mapping(uint256 => mapping(bytes32 => string)) private _keyStrings;

    // ═══ Events ══════════════════════════════════════════════
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataSet(
        uint256 indexed agentId,
        string indexed indexedMetadataKey,
        string metadataKey,
        bytes metadataValue
    );

    // ═══ Structs ══════════════════════════════════════════════
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    // ═══ Errors ══════════════════════════════════════════════
    error AgentNotFound(uint256 agentId);
    error NotAuthorized(address caller, uint256 agentId);
    error ReservedKey(string key);
    error InvalidWallet(address wallet);

    // ═══ Registration ════════════════════════════════════════

    /**
     * @notice Mint a new agent identity NFT
     * @param agentURI The URI pointing to the agent registration file
     * @return agentId The newly assigned agent ID
     */
    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _register(msg.sender, agentURI);
    }

    /**
     * @notice Mint a new agent identity NFT with initial metadata
     * @param agentURI The URI pointing to the agent registration file
     * @param metadata Array of (key, value) metadata entries
     * @return agentId The newly assigned agent ID
     */
    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external
        returns (uint256 agentId)
    {
        agentId = _register(msg.sender, agentURI);

        // Apply optional metadata (spec says agentWallet cannot be set via this path)
        for (uint256 i = 0; i < metadata.length; i++) {
            bytes32 keyHash = keccak256(bytes(metadata[i].metadataKey));
            if (keyHash == AGENT_WALLET_KEY) revert ReservedKey(metadata[i].metadataKey);
            _setMetadata(agentId, metadata[i].metadataKey, keyHash, metadata[i].metadataValue);
        }
    }

    /**
     * @notice Mint without URI — can be set later via setAgentURI()
     */
    function registerEmpty() external returns (uint256 agentId) {
        agentId = _register(msg.sender, "");
    }

    function _register(address owner, string memory uri) internal returns (uint256 agentId) {
        agentId = _nextAgentId++;

        _owners[agentId] = owner;
        _balances[owner] += 1;
        _tokenURIs[agentId] = uri;

        // Reserved agentWallet defaults to owner address
        bytes memory walletBytes = abi.encode(owner);
        _metadata[agentId][AGENT_WALLET_KEY] = walletBytes;
        _keyStrings[agentId][AGENT_WALLET_KEY] = "agentWallet";

        emit Transfer(address(0), owner, agentId);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", walletBytes);
        emit Registered(agentId, uri, owner);
    }

    /// @notice Update the agent registration URI
    function setAgentURI(uint256 agentId, string calldata newURI) external {
        _requireAuthorized(agentId);
        _tokenURIs[agentId] = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    // ═══ Metadata (ERC-8004) ═════════════════════════════════

    function getMetadata(uint256 agentId, string calldata metadataKey)
        external
        view
        returns (bytes memory)
    {
        if (_owners[agentId] == address(0)) revert AgentNotFound(agentId);
        return _metadata[agentId][keccak256(bytes(metadataKey))];
    }

    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue)
        external
    {
        _requireAuthorized(agentId);
        bytes32 keyHash = keccak256(bytes(metadataKey));
        if (keyHash == AGENT_WALLET_KEY) revert ReservedKey(metadataKey);
        _setMetadata(agentId, metadataKey, keyHash, metadataValue);
    }

    function _setMetadata(uint256 agentId, string memory key, bytes32 keyHash, bytes memory value)
        internal
    {
        _metadata[agentId][keyHash] = value;
        _keyStrings[agentId][keyHash] = key;
        emit MetadataSet(agentId, key, key, value);
    }

    // ═══ Agent Wallet (reserved, requires signed proof) ═════
    // NOTE: Simplified implementation. The full spec requires EIP-712 signature
    //       or ERC-1271 verification. For the XEN Terminal single-agent use
    //       case, we restrict to agent owner only.

    function setAgentWallet(uint256 agentId, address newWallet) external {
        _requireAuthorized(agentId);
        if (newWallet == address(0)) revert InvalidWallet(newWallet);
        bytes memory walletBytes = abi.encode(newWallet);
        _metadata[agentId][AGENT_WALLET_KEY] = walletBytes;
        emit MetadataSet(agentId, "agentWallet", "agentWallet", walletBytes);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        if (_owners[agentId] == address(0)) revert AgentNotFound(agentId);
        bytes memory walletBytes = _metadata[agentId][AGENT_WALLET_KEY];
        if (walletBytes.length == 0) return address(0);
        return abi.decode(walletBytes, (address));
    }

    function unsetAgentWallet(uint256 agentId) external {
        _requireAuthorized(agentId);
        delete _metadata[agentId][AGENT_WALLET_KEY];
        emit MetadataSet(agentId, "agentWallet", "agentWallet", "");
    }

    // ═══ ERC-721 core ════════════════════════════════════════

    function name() external pure returns (string memory) { return _NAME; }
    function symbol() external pure returns (string memory) { return _SYMBOL; }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert AgentNotFound(tokenId);
        return _tokenURIs[tokenId];
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _owners[tokenId];
        if (owner == address(0)) revert AgentNotFound(tokenId);
        return owner;
    }

    function approve(address to, uint256 tokenId) external {
        address owner = _owners[tokenId];
        require(msg.sender == owner || _operatorApprovals[owner][msg.sender], "ERC721: not authorized");
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        if (_owners[tokenId] == address(0)) revert AgentNotFound(tokenId);
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        _transfer(from, to, tokenId);
        _checkOnERC721Received(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external {
        _transfer(from, to, tokenId);
        _checkOnERC721Received(from, to, tokenId, data);
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        address owner = _owners[tokenId];
        require(owner == from, "ERC721: wrong from");
        require(
            msg.sender == owner ||
            _tokenApprovals[tokenId] == msg.sender ||
            _operatorApprovals[owner][msg.sender],
            "ERC721: not authorized"
        );
        require(to != address(0), "ERC721: transfer to zero");

        delete _tokenApprovals[tokenId];
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;

        // Per spec: on transfer, agentWallet resets
        delete _metadata[tokenId][AGENT_WALLET_KEY];

        emit Transfer(from, to, tokenId);
    }

    /// @dev Checks receiver contract implements onERC721Received
    function _checkOnERC721Received(address from, address to, uint256 tokenId, bytes memory data) internal {
        if (to.code.length == 0) return; // EOAs don't need the check

        try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 retval) {
            require(retval == IERC721Receiver.onERC721Received.selector, "ERC721: receiver rejected");
        } catch {
            revert("ERC721: transfer to non-receiver");
        }
    }

    // ═══ Internal helpers ════════════════════════════════════

    function _requireAuthorized(uint256 agentId) internal view {
        address owner = _owners[agentId];
        if (owner == address(0)) revert AgentNotFound(agentId);
        if (
            msg.sender != owner &&
            _tokenApprovals[agentId] != msg.sender &&
            !_operatorApprovals[owner][msg.sender]
        ) revert NotAuthorized(msg.sender, agentId);
    }

    // ═══ ERC-165 ═════════════════════════════════════════════

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IERC165).interfaceId ||
            interfaceId == type(IERC721).interfaceId ||
            interfaceId == type(IERC721Metadata).interfaceId;
    }

    // ═══ Convenience ═════════════════════════════════════════

    function totalAgents() external view returns (uint256) {
        return _nextAgentId - 1;
    }
}
