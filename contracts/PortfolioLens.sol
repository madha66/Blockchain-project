// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IGigLend.sol";
import "./libraries/LoanTypes.sol";

interface ILoanList {
    function activeLoanIds() external view returns (uint256[] memory);
}

interface ILossStats {
    function totalLenderLoss() external view returns (uint256);
    function totalReserveUsed() external view returns (uint256);
    function totalRecovered() external view returns (uint256);
    function realisedLossByMonth(uint256 month) external view returns (uint256);
}

interface IConfigView {
    function secondsPerDay() external view returns (uint256);
}

/**
 * @title PortfolioLens
 * @notice Read-only disclosures for the Pool page: non-performing loans by stage, arrears
 *         reported twice (with and without restructured loans, so restructuring cannot hide
 *         stress), realised losses by month and the reserve. The reserve is a loss buffer funded
 *         by borrower interest, not a guarantee; returns are never guaranteed.
 */
contract PortfolioLens {
    ILoanManager public immutable loanManager;
    ILossStats public immutable defaults;
    ILendingPoolV3 public immutable pool;
    address public immutable reserve;

    struct Portfolio {
        uint256 poolValue;
        uint256 freeCash;
        uint256 totalOutstanding;
        uint256 carriedValue;
        uint256 provisions;            // outstanding − carried
        uint256 reserveBalance;
        uint256 activeLoans;
        uint256[5] countByStage;       // Active, Grace, Onset, Significant, DefaultEligible
        uint256[5] outstandingByStage;
        uint256 arrearsAll;            // outstanding of loans past due (Grace and later)
        uint256 arrearsExRestructured; // same, excluding restructured loans
        uint256 restructuredLoans;
        uint256 totalLenderLoss;
        uint256 totalReserveUsed;
        uint256 totalRecovered;
    }

    constructor(address _loanManager, address _defaults, address _pool, address _reserve) {
        loanManager = ILoanManager(_loanManager);
        defaults = ILossStats(_defaults);
        pool = ILendingPoolV3(_pool);
        reserve = _reserve;
    }

    function portfolio() external view returns (Portfolio memory p) {
        p.poolValue = pool.poolValue();
        p.freeCash = pool.freeCash();
        p.totalOutstanding = loanManager.totalOutstanding();
        p.carriedValue = loanManager.carriedValue();
        p.provisions = p.totalOutstanding > p.carriedValue ? p.totalOutstanding - p.carriedValue : 0;
        p.reserveBalance = reserve.balance;
        p.totalLenderLoss = defaults.totalLenderLoss();
        p.totalReserveUsed = defaults.totalReserveUsed();
        p.totalRecovered = defaults.totalRecovered();

        uint256[] memory ids = ILoanList(address(loanManager)).activeLoanIds();
        p.activeLoans = ids.length;
        for (uint256 i = 0; i < ids.length; i++) {
            LoanTypes.Loan memory l = loanManager.getLoan(ids[i]);
            uint8 s = uint8(loanManager.stageOf(ids[i]));
            p.countByStage[s] += 1;
            p.outstandingByStage[s] += l.outstandingPrincipal;
            if (l.restructured) p.restructuredLoans += 1;
            if (s >= uint8(LoanTypes.Stage.Grace)) {
                p.arrearsAll += l.outstandingPrincipal;
                if (!l.restructured) p.arrearsExRestructured += l.outstandingPrincipal;
            }
        }
    }

    /// @notice Realised lender losses for the last `months` 30-day months (newest first).
    function lossesByMonth(uint256 months, uint256 secondsPerDay) external view returns (uint256[] memory out, uint256 currentMonth) {
        currentMonth = block.timestamp / (30 * secondsPerDay);
        out = new uint256[](months);
        for (uint256 i = 0; i < months && i <= currentMonth; i++) {
            out[i] = defaults.realisedLossByMonth(currentMonth - i);
        }
    }
}
