// ContentCA.sol (updated for verifiable signatures)
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract ContentCA is Ownable, EIP712 {
    using ECDSA for bytes32;

    address public immutable caSigner;

    // Record per content CID
    struct Certificate {
        string cid; // ipfs cid (metadata json)
        address signer; // address that signed (CA)
        uint256 timestamp;
        string contentType; // "music"|"podcast"|"art"
    }

    mapping(bytes32 => Certificate) public certificates; // key = keccak256(cid, signer)

    event CertificateRegistered(bytes32 indexed key, string cid, address indexed signer, string contentType, uint256 timestamp);

    constructor(address caSigner_) Ownable(msg.sender) EIP712("ContentCA", "1") {
        caSigner = caSigner_;
    }

    function registerCertificate(string calldata cid, string calldata contentType, bytes calldata signature) external {
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Certificate(string cid,string contentType)"),
            keccak256(bytes(cid)),
            keccak256(bytes(contentType))
        ));
        bytes32 hash = _hashTypedDataV4(structHash);
        address recovered = hash.recover(signature);
        require(recovered == caSigner, "Invalid CA signature");

        bytes32 key = keccak256(abi.encodePacked(cid, recovered));
        require(certificates[key].timestamp == 0, "Certificate already exists");

        certificates[key] = Certificate({cid: cid, signer: recovered, timestamp: block.timestamp, contentType: contentType});
        emit CertificateRegistered(key, cid, recovered, contentType, block.timestamp);
    }

    function getCertificateKey(string calldata cid, address signer) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(cid, signer));
    }

    function certificateExists(string calldata cid, address signer) external view returns (bool) {
        bytes32 key = keccak256(abi.encodePacked(cid, signer));
        return certificates[key].timestamp != 0;
    }
}