// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract CreditScore is Ownable {
    struct UserStats {
        uint256 repaymentsCount;
        uint256 totalAmountRepaid;
        uint256 joinedAt;
        uint256 simulatedIncome; // Mocked for Review 2
    }

    mapping(address => UserStats) public stats;
    address public lendingPool;

    constructor() Ownable(msg.sender) {}

    function setLendingPool(address _lendingPool) external onlyOwner {
        require(lendingPool == address(0), "Lending pool already set");
        lendingPool = _lendingPool;
    }

    modifier onlyLendingPool() {
        require(msg.sender == lendingPool, "Only LendingPool can call");
        _;
    }

    // Call this when user first interacts
    function initUser(address user) external {
        if (stats[user].joinedAt == 0) {
            stats[user].joinedAt = block.timestamp;
            stats[user].simulatedIncome = 1000; // Simulated $1000/mo income for now
        }
    }

    function updateRepayment(address user, uint256 amount) external onlyLendingPool {
        stats[user].repaymentsCount += 1;
        stats[user].totalAmountRepaid += amount;
    }

    function penalizeDefault(address user) external onlyLendingPool {
        if (stats[user].repaymentsCount > 0) {
            stats[user].repaymentsCount -= 1;
        }
    }

    // Simplified scoring logic returning 0-100
    // Real implementation would scale to decimals, keeping it simple for Review 2
    function getScore(address user) public view returns (uint256) {
        if (stats[user].joinedAt == 0) return 0; // Not initialized or new

        // Repayments weight (max 40): Cap at 10 repayments for max score here
        uint256 repayScore = stats[user].repaymentsCount * 4; 
        if (repayScore > 40) repayScore = 40;

        // Amount repaid weight (max 30): Cap at 1 ETH (1e18) for max score
        uint256 amountScore = (stats[user].totalAmountRepaid * 30) / 1 ether;
        if (amountScore > 30) amountScore = 30;

        // Income weight (max 20): Using mock income
        uint256 incomeScore = (stats[user].simulatedIncome * 20) / 2000; // $2000 max income
        if (incomeScore > 20) incomeScore = 20;

        // Duration weight (max 10): 30 days for max score
        uint256 daysJoined = (block.timestamp - stats[user].joinedAt) / 1 days;
        uint256 durationScore = (daysJoined * 10) / 30;
        if (durationScore > 10) durationScore = 10;

        // Base score for simply joining to allow first loan
        uint256 totalScore = 45 + repayScore + amountScore + incomeScore + durationScore;
        if (totalScore > 100) totalScore = 100;

        return totalScore;
    }

    function getBorrowLimit(address user) external view returns (uint256) {
        uint256 score = getScore(user);
        if (score <= 40) return 0;
        if (score <= 60) return 0.05 ether;
        if (score <= 80) return 0.1 ether;
        return 0.2 ether;
    }
}
