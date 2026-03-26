// Escrow.sol (for payments, updated for DOGE/SOL events)
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Escrow is Ownable {
    address public royaltyPayoutAddress;

    mapping(address => uint256) public subscriptionExpiryByUser;

    event DepositForPlay(address indexed user, string cid, uint256 amount);
    event Subscription(address indexed user, uint256 expiry);
    event DogePaymentLogged(address indexed user, string cid, uint256 amountEthEquivalent);
    event SolPaymentLogged(address indexed user, string cid, uint256 amountEthEquivalent);
    event DogeSubscriptionLogged(address indexed user, uint256 amountEthEquivalent);
    event SolSubscriptionLogged(address indexed user, uint256 amountEthEquivalent);

    constructor(address royaltyPayoutAddress_) Ownable(msg.sender) {
        royaltyPayoutAddress = royaltyPayoutAddress_;
    }

    function depositForPlay(string calldata cid) external payable {
        require(msg.value > 0, "Amount must be greater than 0");
        payable(royaltyPayoutAddress).transfer(msg.value);
        emit DepositForPlay(msg.sender, cid, msg.value);
    }

    function subscribe() external payable {
        require(msg.value > 0, "Amount must be greater than 0");
        subscriptionExpiryByUser[msg.sender] = block.timestamp + 30 days;
        payable(royaltyPayoutAddress).transfer(msg.value);
        emit Subscription(msg.sender, subscriptionExpiryByUser[msg.sender]);
    }

    function isSubscribed(address user) external view returns (bool) {
        return subscriptionExpiryByUser[user] > block.timestamp;
    }

    function logDogePayment(string calldata cid, address user, uint256 amountEthEquivalent) external onlyOwner {
        emit DogePaymentLogged(user, cid, amountEthEquivalent);
    }

    function logSolPayment(string calldata cid, address user, uint256 amountEthEquivalent) external onlyOwner {
        emit SolPaymentLogged(user, cid, amountEthEquivalent);
    }

    function logDogeSubscription(address user, uint256 amountEthEquivalent) external onlyOwner {
        subscriptionExpiryByUser[user] = block.timestamp + 30 days;
        emit DogeSubscriptionLogged(user, amountEthEquivalent);
        emit Subscription(user, subscriptionExpiryByUser[user]);
    }

    function logSolSubscription(address user, uint256 amountEthEquivalent) external onlyOwner {
        subscriptionExpiryByUser[user] = block.timestamp + 30 days;
        emit SolSubscriptionLogged(user, amountEthEquivalent);
        emit Subscription(user, subscriptionExpiryByUser[user]);
    }
}