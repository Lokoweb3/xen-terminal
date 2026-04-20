// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title XenftBulkMinter
 * @notice Mint multiple XENFTs in a single transaction.
 *         Saves UX friction — 1 MetaMask approval instead of N.
 *
 * USAGE:
 *   bulkMint(XENFT_CONTRACT, 3, 128, 100)
 *   → mints 3 XENFTs, each with 128 VMUs for 100 days
 *   → all 3 NFTs arrive in caller's wallet
 *
 * GAS: ~3.5M gas × count (same as direct, no magic savings)
 *      Just fewer MetaMask clicks.
 */

interface IXENFT {
    function bulkClaimRank(uint256 count, uint256 term) external returns (uint256);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract XenftBulkMinter {
    event BulkMinted(address indexed user, address indexed xenft, uint256 count);

    /**
     * @notice Mint multiple XENFTs in one tx.
     * @param xenft  Address of XENT or pXENT contract
     * @param count  Number of XENFTs to mint
     * @param vmus   VMUs per XENFT (1-128)
     * @param term   Days to mint for (1-550)
     */
    function bulkMint(
        address xenft,
        uint256 count,
        uint256 vmus,
        uint256 term
    ) external {
        require(count > 0 && count <= 20, "bad count");
        require(vmus > 0 && vmus <= 128, "bad vmus");
        require(term > 0 && term <= 550, "bad term");

        IXENFT target = IXENFT(xenft);

        for (uint256 i = 0; i < count; i++) {
            // Mints XENFT to THIS contract
            uint256 tokenId = target.bulkClaimRank(vmus, term);

            // Transfer immediately to the caller
            target.transferFrom(address(this), msg.sender, tokenId);
        }

        emit BulkMinted(msg.sender, xenft, count);
    }

    /**
     * @notice In case any NFT gets stuck, owner can rescue
     * @dev No onlyOwner — anyone can rescue to themselves if they know the tokenId
     */
    function rescueXenft(address xenft, uint256 tokenId) external {
        IXENFT target = IXENFT(xenft);
        require(target.ownerOf(tokenId) == address(this), "not owned by contract");
        target.transferFrom(address(this), msg.sender, tokenId);
    }

    // Accept NFTs (required for ERC721 transfers)
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return 0x150b7a02;
    }
}
