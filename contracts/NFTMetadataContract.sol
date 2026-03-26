// NFTMetadataContract.sol (primary NFT contract)
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract NFTMetadataContract is ERC721, Ownable {
    struct NFTData {
        string title;
        string artist;
        uint256 year;
        string metadataUrl;
    }

    mapping(uint256 => NFTData) public musicNFTs;
    uint256 public totalSupply;
    address public immutable mspAdmin;

    constructor(string memory name_, string memory symbol_, address mspAdmin_) ERC721(name_, symbol_) Ownable(msg.sender) {
        mspAdmin = mspAdmin_;
    }

    function mintNFT(string memory title, string memory artist, uint256 year, string memory metadataUrl) public onlyOwner returns (uint256) {
        totalSupply++;
        _safeMint(owner(), totalSupply);
        musicNFTs[totalSupply] = NFTData(title, artist, year, metadataUrl);
        return totalSupply;
    }

    function emergencyTransferOwnership(address newOwner) public {
        require(msg.sender == mspAdmin, "Only MSP admin can call this");
        _transferOwnership(newOwner);
    }

    function tokenURI(uint256 tokenId) public view virtual override returns (string memory) {
        _requireOwned(tokenId);
        return musicNFTs[tokenId].metadataUrl;
    }
}