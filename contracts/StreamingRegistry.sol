// StreamingRegistry.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/access/Ownable.sol";
contract StreamingRegistry is Ownable {
    // A play event - minimal onchain
    event PlayLogged(
        bytes32 indexed playId,
        string indexed cid,
        address indexed listener,
        uint256 timestamp,
        bool live, // live vs on_demand
        bytes32 metadataHash // keccak of full play details stored offchain
    );
    constructor() Ownable(msg.sender) {}
    // owner can write if you want only relayer to log; or make public
    function logPlay(bytes32 playId, string calldata cid, address listener, bool live, bytes32 metadataHash) external onlyOwner {
        emit PlayLogged(playId, cid, listener, block.timestamp, live, metadataHash);
    }
}