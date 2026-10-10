// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract CreditScore is Ownable {
    struct UserStats {
        uint256 repaymentsCount;
        uint256 totalAmountRepaid;
        uint256 joinedAt;
        uint256 simulatedIncome;
    }

    mapping(address => UserStats) public stats;
    mapping(address => uint256) public defaultsCount;
    mapping(address => uint256) public lateCount;
    mapping(address => uint256) public rehabilitationCooldownUntil;

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

    function initUser(address user) external {
        if (stats[user].joinedAt == 0) {
            stats[user].joinedAt = block.timestamp;
            stats[user].simulatedIncome = 1000;
        }
    }

    function updateRepayment(address user, uint256 amount) external onlyLendingPool {
        if (stats[user].joinedAt == 0) {
            stats[user].joinedAt = block.timestamp;
            stats[user].simulatedIncome = 1000;
        }
        stats[user].repaymentsCount += 1;
        stats[user].totalAmountRepaid += amount;
    }

    function penalizeDefault(address user) external onlyLendingPool {
        defaultsCount[user] += 1;
        if (stats[user].repaymentsCount > 0) {
            stats[user].repaymentsCount -= 1;
        }
        rehabilitationCooldownUntil[user] = block.timestamp + 14 days;
    }

    function recordLateRepayment(address user) external onlyLendingPool {
        lateCount[user] += 1;
    }

    // Dynamic Credit Score Calculation (10 - 100)
    function getScore(address user) public view returns (uint256) {
        uint256 baseScore = 50;

        // Repayment count score: +10 per successful repayment (max 30 pts)
        uint256 repayScore = stats[user].repaymentsCount * 10;
        if (repayScore > 30) repayScore = 30;

        // Amount repaid score: up to 20 pts (scaled with ETH repaid)
        uint256 amountScore = (stats[user].totalAmountRepaid * 20) / 1 ether;
        if (amountScore > 20) amountScore = 20;

        uint256 totalPositive = baseScore + repayScore + amountScore;
        uint256 penalties = (defaultsCount[user] * 25) + (lateCount[user] * 10);

        if (penalties >= totalPositive) {
            return 10;
        }

        uint256 finalScore = totalPositive - penalties;
        if (finalScore < 10) return 10;
        if (finalScore > 100) return 100;

        return finalScore;
    }

    // Dynamic Borrow Limits based on Credit Score Tier:
    function getBorrowLimit(address user) external view returns (uint256) {
        if (block.timestamp < rehabilitationCooldownUntil[user]) {
            return 0.2 ether; // Clamped to base rehabilitation tier during cooldown
        }

        uint256 score = getScore(user);
        if (score <= 40) return 0.2 ether;
        if (score <= 60) return 0.5 ether;   // First-time borrower limit
        if (score <= 75) return 1.5 ether;   // After 1 repayment
        if (score <= 90) return 3.0 ether;   // After 2+ repayments
        return 5.0 ether;                   // Elite tier
    }
}
