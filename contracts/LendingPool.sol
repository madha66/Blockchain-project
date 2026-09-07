// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./GLPToken.sol";
import "./CreditScore.sol";
import "./interfaces/ILendingPool.sol";

contract LendingPool is ILendingPool {
    GLPToken public glpToken;
    CreditScore public creditScore;

    uint256 public totalActiveLoans;
    uint256 public constant INTEREST_RATE = 5; // 5% flat interest

    mapping(address => uint256) public activeLoans;

    event Deposited(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    constructor(address _glpToken, address _creditScore) {
        glpToken = GLPToken(_glpToken);
        creditScore = CreditScore(_creditScore);
    }

    function deposit() external payable override {
        require(msg.value > 0, "Amount must be greater than 0");
        // Mint GLP 1:1 with ETH for simplicity
        glpToken.mint(msg.sender, msg.value);
        emit Deposited(msg.sender, msg.value);
    }

    function borrow(uint256 amount) external override {
        require(amount > 0, "Amount must be greater than 0");
        require(activeLoans[msg.sender] == 0, "Existing loan must be repaid");
        require(address(this).balance >= amount, "Insufficient pool liquidity");

        // Initialize user if they are new
        creditScore.initUser(msg.sender);

        uint256 limit = creditScore.getBorrowLimit(msg.sender);
        require(amount <= limit, "Borrow amount exceeds credit limit");

        activeLoans[msg.sender] = amount;
        totalActiveLoans += amount;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");

        emit Borrowed(msg.sender, amount);
    }

    function getRepaymentAmount(address user) public view returns (uint256) {
        uint256 principal = activeLoans[user];
        if (principal == 0) return 0;
        return principal + ((principal * INTEREST_RATE) / 100);
    }

    function repay() external payable override {
        require(activeLoans[msg.sender] > 0, "No active loan");
        uint256 totalDue = getRepaymentAmount(msg.sender);
        require(msg.value >= totalDue, "Insufficient repayment amount");

        uint256 principal = activeLoans[msg.sender];
        activeLoans[msg.sender] = 0;
        totalActiveLoans -= principal;

        // Refund excess
        if (msg.value > totalDue) {
            (bool success, ) = msg.sender.call{value: msg.value - totalDue}("");
            require(success, "Refund failed");
        }

        creditScore.updateRepayment(msg.sender, totalDue);

        emit Repaid(msg.sender, totalDue);
    }

    function withdraw(uint256 glpAmount) external override {
        require(glpAmount > 0, "Amount must be greater than 0");
        require(glpToken.balanceOf(msg.sender) >= glpAmount, "Insufficient GLP balance");
        
        // Calculate pool share value (simplified: assume 1:1 + interest distributed evenly)
        // For Review 2: 1 GLP = 1 ETH (pool value doesn't strictly grow per share here without complex math)
        // In a real scenario, ETH returned = glpAmount * (total ETH in pool / total GLP supply)
        // But let's do exactly that.
        uint256 totalEth = address(this).balance + totalActiveLoans;
        uint256 totalGlp = glpToken.totalSupply();
        uint256 ethToReturn = (glpAmount * totalEth) / totalGlp;

        require(address(this).balance >= ethToReturn, "Insufficient liquidity to withdraw");

        glpToken.burnFrom(msg.sender, glpAmount);

        (bool success, ) = msg.sender.call{value: ethToReturn}("");
        require(success, "Transfer failed");

        emit Withdrawn(msg.sender, ethToReturn);
    }
    
    // Allow the contract to receive ETH (e.g. direct transfers)
    receive() external payable {}
}
