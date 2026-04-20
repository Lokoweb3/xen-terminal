// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ERC-8004 Reputation Registry
 * @notice Minimal reference implementation for posting and reading
 *         agent feedback signals as specified in ERC-8004.
 *
 * @dev Specification: https://eips.ethereum.org/EIPS/eip-8004
 */

interface IIdentityRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

contract ReputationRegistry {
    struct Feedback {
        int128 value;
        uint8  valueDecimals;
        string tag1;
        string tag2;
        bool   isRevoked;
    }

    address private _identityRegistry;
    bool    private _initialized;

    // agentId => clientAddress => feedbackIndex => Feedback
    mapping(uint256 => mapping(address => mapping(uint64 => Feedback))) private _feedback;

    // agentId => clientAddress => next index (1-based per client per agent)
    mapping(uint256 => mapping(address => uint64)) private _nextIndex;

    // agentId => list of unique clients (for enumeration)
    mapping(uint256 => address[]) private _agentClients;
    mapping(uint256 => mapping(address => bool)) private _isClientOf;

    // ═══ Events ══════════════════════════════════════════════
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    event FeedbackRevoked(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 indexed feedbackIndex
    );

    event ResponseAppended(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        address indexed responder,
        string responseURI,
        bytes32 responseHash
    );

    // ═══ Errors ══════════════════════════════════════════════
    error AlreadyInitialized();
    error NotInitialized();
    error AgentOwnerCannotReview();
    error InvalidValueDecimals(uint8 decimals);
    error FeedbackNotFound(uint256 agentId, address client, uint64 index);

    // ═══ Initialization ══════════════════════════════════════

    function initialize(address identityRegistry_) external {
        if (_initialized) revert AlreadyInitialized();
        _identityRegistry = identityRegistry_;
        _initialized = true;
    }

    function getIdentityRegistry() external view returns (address) {
        return _identityRegistry;
    }

    // ═══ Feedback submission ═════════════════════════════════

    /**
     * @notice Post feedback about an agent
     * @dev Agent owner/operators cannot review their own agent
     */
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        if (!_initialized) revert NotInitialized();
        if (valueDecimals > 18) revert InvalidValueDecimals(valueDecimals);

        _checkNotAgentOwner(agentId);
        uint64 idx = _storeFeedback(agentId, value, valueDecimals, tag1, tag2);

        emit NewFeedback(
            agentId,
            msg.sender,
            idx,
            value,
            valueDecimals,
            tag1,
            tag1,
            tag2,
            endpoint,
            feedbackURI,
            feedbackHash
        );
    }

    /// @dev Reverts if msg.sender is the agent owner or an approved operator
    function _checkNotAgentOwner(uint256 agentId) internal view {
        IIdentityRegistry reg = IIdentityRegistry(_identityRegistry);
        address owner = reg.ownerOf(agentId);
        if (msg.sender == owner || reg.isApprovedForAll(owner, msg.sender)) {
            revert AgentOwnerCannotReview();
        }
    }

    /// @dev Writes feedback to storage and returns the assigned index
    function _storeFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2
    ) internal returns (uint64 idx) {
        idx = _nextIndex[agentId][msg.sender] + 1;
        _nextIndex[agentId][msg.sender] = idx;

        _feedback[agentId][msg.sender][idx] = Feedback({
            value: value,
            valueDecimals: valueDecimals,
            tag1: tag1,
            tag2: tag2,
            isRevoked: false
        });

        if (!_isClientOf[agentId][msg.sender]) {
            _isClientOf[agentId][msg.sender] = true;
            _agentClients[agentId].push(msg.sender);
        }
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        Feedback storage fb = _feedback[agentId][msg.sender][feedbackIndex];
        if (fb.valueDecimals == 0 && fb.value == 0 && bytes(fb.tag1).length == 0 && bytes(fb.tag2).length == 0 && !fb.isRevoked && feedbackIndex > _nextIndex[agentId][msg.sender]) {
            revert FeedbackNotFound(agentId, msg.sender, feedbackIndex);
        }
        if (feedbackIndex == 0 || feedbackIndex > _nextIndex[agentId][msg.sender]) {
            revert FeedbackNotFound(agentId, msg.sender, feedbackIndex);
        }
        fb.isRevoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    function appendResponse(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external {
        // Anyone can append a response — spec allows it
        if (feedbackIndex == 0 || feedbackIndex > _nextIndex[agentId][clientAddress]) {
            revert FeedbackNotFound(agentId, clientAddress, feedbackIndex);
        }
        emit ResponseAppended(agentId, clientAddress, feedbackIndex, msg.sender, responseURI, responseHash);
    }

    // ═══ Read functions ══════════════════════════════════════

    /**
     * @notice Aggregate feedback across specified clients with optional tag filters.
     * @dev Caller must provide clientAddresses (non-empty) to mitigate Sybil attacks.
     */
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) {
        require(clientAddresses.length > 0, "Reputation: clients required");

        bool filterTag1 = bytes(tag1).length > 0;
        bool filterTag2 = bytes(tag2).length > 0;
        bytes32 tag1Hash = keccak256(bytes(tag1));
        bytes32 tag2Hash = keccak256(bytes(tag2));

        int256 acc = 0;
        uint8  maxDec = 0;

        for (uint256 i = 0; i < clientAddresses.length; i++) {
            address client = clientAddresses[i];
            uint64 upper = _nextIndex[agentId][client];
            for (uint64 idx = 1; idx <= upper; idx++) {
                Feedback memory fb = _feedback[agentId][client][idx];
                if (fb.isRevoked) continue;
                if (filterTag1 && keccak256(bytes(fb.tag1)) != tag1Hash) continue;
                if (filterTag2 && keccak256(bytes(fb.tag2)) != tag2Hash) continue;

                // Normalize to the larger decimals to keep precision
                if (fb.valueDecimals > maxDec) {
                    acc = acc * int256(10 ** uint256(fb.valueDecimals - maxDec));
                    maxDec = fb.valueDecimals;
                    acc += int256(fb.value);
                } else if (fb.valueDecimals < maxDec) {
                    acc += int256(fb.value) * int256(10 ** uint256(maxDec - fb.valueDecimals));
                } else {
                    acc += int256(fb.value);
                }
                count++;
            }
        }

        if (count > 0) {
            summaryValue = int128(acc / int256(uint256(count)));
            summaryValueDecimals = maxDec;
        }
    }

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        Feedback memory fb = _feedback[agentId][clientAddress][feedbackIndex];
        return (fb.value, fb.valueDecimals, fb.tag1, fb.tag2, fb.isRevoked);
    }

    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _agentClients[agentId];
    }

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return _nextIndex[agentId][clientAddress];
    }
}
