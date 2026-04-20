// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ERC-8004 Validation Registry
 * @notice Records requests and responses for agent validation work.
 *
 * @dev Specification: https://eips.ethereum.org/EIPS/eip-8004
 *      Validation incentives and slashing are handled by the specific
 *      validation protocol — not by this registry.
 */

interface IIdentityRegistryMinimal {
    function ownerOf(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function getApproved(uint256 tokenId) external view returns (address);
}

contract ValidationRegistry {
    struct ValidationRecord {
        address validatorAddress;
        uint256 agentId;
        uint8   response;           // 0-100
        bytes32 responseHash;
        string  tag;
        uint256 lastUpdate;
        bool    exists;
    }

    address private _identityRegistry;
    bool    private _initialized;

    // requestHash => ValidationRecord
    mapping(bytes32 => ValidationRecord) private _validations;

    // agentId => list of request hashes
    mapping(uint256 => bytes32[]) private _agentValidations;

    // validatorAddress => list of request hashes
    mapping(address => bytes32[]) private _validatorRequests;

    // ═══ Events ══════════════════════════════════════════════
    event ValidationRequest(
        address indexed validatorAddress,
        uint256 indexed agentId,
        string requestURI,
        bytes32 indexed requestHash
    );

    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    // ═══ Errors ══════════════════════════════════════════════
    error AlreadyInitialized();
    error NotInitialized();
    error NotAgentOwner();
    error RequestExists(bytes32 requestHash);
    error RequestNotFound(bytes32 requestHash);
    error WrongValidator(address expected, address actual);
    error InvalidResponse(uint8 response);

    // ═══ Init ═══════════════════════════════════════════════

    function initialize(address identityRegistry_) external {
        if (_initialized) revert AlreadyInitialized();
        _identityRegistry = identityRegistry_;
        _initialized = true;
    }

    function getIdentityRegistry() external view returns (address) {
        return _identityRegistry;
    }

    // ═══ Validation request ══════════════════════════════════

    /**
     * @notice Agent owner/operator asks a validator to verify some work
     */
    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external {
        if (!_initialized) revert NotInitialized();

        IIdentityRegistryMinimal reg = IIdentityRegistryMinimal(_identityRegistry);
        address owner = reg.ownerOf(agentId);
        if (
            msg.sender != owner &&
            !reg.isApprovedForAll(owner, msg.sender) &&
            reg.getApproved(agentId) != msg.sender
        ) revert NotAgentOwner();

        if (_validations[requestHash].exists) revert RequestExists(requestHash);

        _validations[requestHash] = ValidationRecord({
            validatorAddress: validatorAddress,
            agentId: agentId,
            response: 0,
            responseHash: bytes32(0),
            tag: "",
            lastUpdate: 0,
            exists: true
        });

        _agentValidations[agentId].push(requestHash);
        _validatorRequests[validatorAddress].push(requestHash);

        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    // ═══ Validation response ═════════════════════════════════

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        ValidationRecord storage rec = _validations[requestHash];
        if (!rec.exists) revert RequestNotFound(requestHash);
        if (rec.validatorAddress != msg.sender) {
            revert WrongValidator(rec.validatorAddress, msg.sender);
        }
        if (response > 100) revert InvalidResponse(response);

        rec.response = response;
        rec.responseHash = responseHash;
        rec.tag = tag;
        rec.lastUpdate = block.timestamp;

        emit ValidationResponse(
            msg.sender,
            rec.agentId,
            requestHash,
            response,
            responseURI,
            responseHash,
            tag
        );
    }

    // ═══ Read functions ══════════════════════════════════════

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        )
    {
        ValidationRecord memory rec = _validations[requestHash];
        return (rec.validatorAddress, rec.agentId, rec.response, rec.responseHash, rec.tag, rec.lastUpdate);
    }

    /**
     * @notice Aggregate validation responses for an agent with optional filters
     */
    function getSummary(
        uint256 agentId,
        address[] calldata validatorAddresses,
        string calldata tag
    ) external view returns (uint64 count, uint8 averageResponse) {
        bytes32[] memory requests = _agentValidations[agentId];
        if (requests.length == 0) return (0, 0);

        bool filterValidators = validatorAddresses.length > 0;
        bool filterTag = bytes(tag).length > 0;
        bytes32 tagHash = keccak256(bytes(tag));

        uint256 sum = 0;

        for (uint256 i = 0; i < requests.length; i++) {
            ValidationRecord memory rec = _validations[requests[i]];
            if (rec.lastUpdate == 0) continue; // no response yet

            if (filterValidators) {
                bool matched = false;
                for (uint256 j = 0; j < validatorAddresses.length; j++) {
                    if (validatorAddresses[j] == rec.validatorAddress) { matched = true; break; }
                }
                if (!matched) continue;
            }

            if (filterTag && keccak256(bytes(rec.tag)) != tagHash) continue;

            sum += uint256(rec.response);
            count++;
        }

        if (count > 0) averageResponse = uint8(sum / uint256(count));
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory) {
        return _validatorRequests[validatorAddress];
    }
}
