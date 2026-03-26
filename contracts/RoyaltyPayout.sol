// RoyaltyPayout.sol (extended with configurable splits)
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/IERC721Enumerable.sol"; // Updated import for IERC721Enumerable

contract RoyaltyPayout is Ownable {
    struct SplitConfig {
        uint256 artistShare; // bp, default 8000
        uint256 mspShare; // bp, default 200
        uint256 holderShare; // bp, default 1000 (pro-rata among holders)
        uint256 curatorShare; // bp, default 800 (to playlist DJ if applicable)
        address artistWallet;
        address mspWallet; // Fixed MSP wallet for its share
    }

    mapping(string => SplitConfig) public splitsByCid; // cid -> config
    mapping(string => address) public nftContractByCid; // cid -> NFTMetadataContract address for holder queries

    event SplitsUpdated(string cid, uint256 artistShare, uint256 mspShare, uint256 holderShare, uint256 curatorShare);
    event PayoutExecuted(bytes32 indexed playId, uint256 amount, address token);

    constructor(address mspWallet_) Ownable(msg.sender) {}

    // Artist sets initial/configures splits (called during/after mint, verify caller owns NFT via NFTMetadataContract)
    function setSplits(string calldata cid, uint256 artistShare, uint256 mspShare, uint256 holderShare, uint256 curatorShare, address artistWallet, address nftContract) external {
        require(artistShare + mspShare + holderShare + curatorShare == 10000, "Splits must sum to 10000 bp");
        // Verify caller is artist (e.g., owns the NFT or via metadata)
        IERC721 nft = IERC721(nftContract);
        require(nft.ownerOf(1) == msg.sender, "Only artist can set splits"); // Assume tokenId 1 for simplicity; adjust for multi
        splitsByCid[cid] = SplitConfig(artistShare, mspShare, holderShare, curatorShare, artistWallet, owner());
        nftContractByCid[cid] = nftContract;
        emit SplitsUpdated(cid, artistShare, mspShare, holderShare, curatorShare);
    }

    // Off-chain indexer calls this with computed amounts (artist bulk, MSP fixed, holders pro-rata, curator if playlist)
    function executePayoutEther(bytes32 playId, address payable[] calldata wallets, uint256[] calldata amounts) external payable onlyOwner {
        require(wallets.length == amounts.length, "len");
        uint256 total;
        for (uint i = 0; i < amounts.length; i++) total += amounts[i];
        require(msg.value == total, "msg.value mismatch");
        for (uint i = 0; i < wallets.length; i++) wallets[i].transfer(amounts[i]);
        emit PayoutExecuted(playId, total, address(0));
    }

    function executePayoutERC20(bytes32 playId, address token, address[] calldata wallets, uint256[] calldata amounts) external onlyOwner {
        require(wallets.length == amounts.length, "len");
        IERC20 erc = IERC20(token);
        uint256 total;
        for (uint i = 0; i < amounts.length; i++) total += amounts[i];
        // Must have transferred `total` to this contract beforehand or have allowance flow
        for (uint i = 0; i < wallets.length; i++) {
            require(erc.transfer(wallets[i], amounts[i]));
        }
        emit PayoutExecuted(playId, total, token);
    }

    // Helper: Get pro-rata holder amounts (off-chain preferred, but on-chain for transparency if needed)
    function getHolderWallets(string calldata cid) public view returns (address[] memory) {
        IERC721Enumerable nft = IERC721Enumerable(nftContractByCid[cid]);
        uint256 supply = nft.totalSupply();
        address[] memory holders = new address[](supply);
        for (uint i = 0; i < supply; i++) holders[i] = nft.ownerOf(i + 1); // Assuming tokenIds start from 1
        return holders;
    }
}