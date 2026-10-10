// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILendingPool {
    function deposit() external payable;
    function borrow(uint256 amount) external;
    function borrow(uint256 amount, uint256 tenureDays) external;
    function repay() external payable;
    function withdraw(uint256 glpAmount) external;
    function markDefault(address borrower) external;
    function settleWrittenOffDebt() external payable;
}
