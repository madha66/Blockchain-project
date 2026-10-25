// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/LoanTypes.sol";

/**
 * @notice Minimal cross-contract interfaces. Contracts reference each other only through
 *         these, with addresses set once at deploy.
 */
interface ILendingPoolV3 {
    function freeCash() external view returns (uint256);
    function poolValue() external view returns (uint256);
    function disburse(address to, uint256 amount) external;
    function onCashIn() external;
    function transferToReserve(uint256 amount) external;
    function burnStake(address account, uint256 maxShares, uint256 valueWei, uint256 excludedCarry)
        external
        returns (uint256 sharesBurned, uint256 valueCovered);
    function sharesForValue(uint256 valueWei) external view returns (uint256);
    function valueOfShares(uint256 shares) external view returns (uint256);
}

interface ILoanManager {
    function getLoan(uint256 loanId) external view returns (LoanTypes.Loan memory);
    function stageOf(uint256 loanId) external view returns (LoanTypes.Stage);
    function carriedOf(uint256 loanId) external view returns (uint256);
    function carriedValue() external view returns (uint256);
    function totalOutstanding() external view returns (uint256);
    function hasOpenLoan(uint256 memberId) external view returns (bool);
    function openLoanOf(uint256 memberId) external view returns (uint256);
    function closeDefaulted(uint256 loanId) external returns (LoanTypes.Loan memory);
    function setDefaultInfo(uint256 loanId, LoanTypes.DefaultType dtype, uint64 classifiedAt, bool appealOpen) external;
    function accrueLate(uint256 loanId) external;
}

interface IDefaultManager {
    function claimOf(uint256 memberId) external view returns (uint256);
    function applyRecovery(uint256 memberId) external payable;
    function markDefaultFor(uint256 loanId, address caller) external;
}

interface ICreditScore {
    function getScore(uint256 memberId) external view returns (uint256);
    function recordInstallment(uint256 memberId, uint256 weightBps) external;
    function recordLoanCompleted(uint256 memberId) external;
    function recordLateMark(uint256 memberId) external;
    function recordRestructure(uint256 memberId) external;
    function addScar(uint256 memberId, LoanTypes.DefaultType dtype) external;
    function shrinkScar(uint256 memberId, uint256 keepBps, bytes32 reason) external;
    function resizeScar(uint256 memberId, LoanTypes.DefaultType dtype) external;
}

interface ISafeRepayVault {
    function pull(address borrower, uint256 amount) external returns (uint256 pulled);
    function setupFor(address borrower, uint256 maxPull, uint64 expiry) external;
    function depositFor(address borrower) external payable;
    function available(address borrower) external view returns (uint256);
}

interface IReserveFund {
    function cover(address to, uint256 amount) external returns (uint256 covered);
    function payBounty(address to, uint256 amount) external returns (uint256 paid);
}

interface IPayoutRouter {
    function inflowSince(address worker, uint256 since) external view returns (uint256);
    function lastPayouts(address worker) external view returns (uint256 latest, uint256 previous);
}

interface IRiskEngine {
    function quote(uint256 memberId, LoanTypes.LoanKind kind, uint256 amount, uint16 nInstallments)
        external
        view
        returns (uint256 rateBps, uint256 totalInterest, uint256 installment);
}
