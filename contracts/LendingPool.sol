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

    // When user deposits ETH, if they have an active loan, the deposit first pays down the loan + interest.
    // Any remaining deposited ETH mints GLP tokens.
    function deposit() external payable override {
        require(msg.value > 0, "Amount must be greater than 0");

        if (activeLoans[msg.sender] > 0) {
            uint256 totalDue = getRepaymentAmount(msg.sender);

            if (msg.value < totalDue) {
                // Partial repayment from deposit
                uint256 principalPaid = (msg.value * 100) / (100 + INTEREST_RATE);
                if (principalPaid > activeLoans[msg.sender]) {
                    principalPaid = activeLoans[msg.sender];
                }
                activeLoans[msg.sender] -= principalPaid;
                totalActiveLoans -= principalPaid;

                creditScore.updateRepayment(msg.sender, msg.value);
                emit Repaid(msg.sender, msg.value);
            } else {
                // Full repayment from deposit
                uint256 principal = activeLoans[msg.sender];
                activeLoans[msg.sender] = 0;
                totalActiveLoans -= principal;

                creditScore.updateRepayment(msg.sender, totalDue);
                emit Repaid(msg.sender, totalDue);

                // Mint GLP for any excess ETH above the loan repayment
                uint256 excess = msg.value - totalDue;
                if (excess > 0) {
                    glpToken.mint(msg.sender, excess);
                    emit Deposited(msg.sender, excess);
                }
            }
        } else {
            // Standard deposit — mint GLP 1:1 with ETH
            glpToken.mint(msg.sender, msg.value);
            emit Deposited(msg.sender, msg.value);
        }
    }

    function borrow(uint256 amount) external override {
        require(amount > 0, "Amount must be greater than 0");
        require(activeLoans[msg.sender] == 0, "Existing loan must be repaid");
        require(glpToken.balanceOf(msg.sender) > 0, "Must deposit in pool before borrowing");
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

    // Allows full or partial repayments
    function repay() external payable override {
        require(activeLoans[msg.sender] > 0, "No active loan");
        require(msg.value > 0, "Repayment amount must be greater than 0");

        uint256 totalDue = getRepaymentAmount(msg.sender);

        if (msg.value < totalDue) {
            // Partial repayment
            uint256 principalPaid = (msg.value * 100) / (100 + INTEREST_RATE);
            if (principalPaid > activeLoans[msg.sender]) {
                principalPaid = activeLoans[msg.sender];
            }
            activeLoans[msg.sender] -= principalPaid;
            totalActiveLoans -= principalPaid;

            creditScore.updateRepayment(msg.sender, msg.value);
            emit Repaid(msg.sender, msg.value);
        } else {
            // Full repayment
            uint256 principal = activeLoans[msg.sender];
            activeLoans[msg.sender] = 0;
            totalActiveLoans -= principal;

            creditScore.updateRepayment(msg.sender, totalDue);
            emit Repaid(msg.sender, totalDue);

            // Refund excess if user sent more than totalDue
            if (msg.value > totalDue) {
                (bool success, ) = msg.sender.call{value: msg.value - totalDue}("");
                require(success, "Refund failed");
            }
        }
    }

    function withdraw(uint256 glpAmount) external override {
        require(glpAmount > 0, "Amount must be greater than 0");
        require(glpToken.balanceOf(msg.sender) >= glpAmount, "Insufficient GLP balance");
        
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
