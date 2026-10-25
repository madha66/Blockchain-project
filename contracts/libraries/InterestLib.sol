// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library InterestLib {
    uint256 public constant VIRTUAL_OFFSET = 1000000; // 10^6 wei

    // Annual base interest rate in basis points (4.00%)
    uint256 public constant BASE_RATE_BPS = 400;
    // Optimal utilization point: 80.00%
    uint256 public constant OPTIMAL_UTILIZATION_BPS = 8000;
    // Slope 1: 5.00% additional at optimal utilization
    uint256 public constant SLOPE1_BPS = 500;
    // Slope 2: 25.00% steep jump beyond optimal
    uint256 public constant SLOPE2_BPS = 2500;

    /**
     * @notice Computes dynamic pool borrow rate based on post-borrow utilization.
     * @param activeLoans Outstanding principal plus proposed loan.
     * @param totalPoolCapital Free cash plus active loans.
     * @return rateBps Annual interest rate in basis points (10000 = 100%).
     */
    function calculatePoolRate(
        uint256 activeLoans,
        uint256 totalPoolCapital
    ) internal pure returns (uint256 rateBps) {
        if (totalPoolCapital == 0 || activeLoans == 0) {
            return BASE_RATE_BPS;
        }

        uint256 utilizationBps = (activeLoans * 10000) / totalPoolCapital;

        if (utilizationBps <= OPTIMAL_UTILIZATION_BPS) {
            rateBps = BASE_RATE_BPS + (utilizationBps * SLOPE1_BPS) / OPTIMAL_UTILIZATION_BPS;
        } else {
            uint256 excessUtilization = utilizationBps - OPTIMAL_UTILIZATION_BPS;
            uint256 excessRange = 10000 - OPTIMAL_UTILIZATION_BPS;
            rateBps = BASE_RATE_BPS + SLOPE1_BPS + (excessUtilization * SLOPE2_BPS) / excessRange;
        }
    }

    /**
     * @notice Credit-risk rate surcharge on the 300–900 score scale.
     */
    function calculateRiskSurcharge(uint256 creditScore) internal pure returns (uint256) {
        if (creditScore >= 800) return 0;      // Prime band: 0% surcharge
        if (creditScore >= 700) return 50;     // Trusted band: +0.50%
        if (creditScore >= 600) return 100;    // Standard band: +1.00%
        return 200;                            // New/Builder band: +2.00%
    }

    /**
     * @notice Calculates simple accrued interest for an interval.
     */
    function calculateAccruedInterest(
        uint256 principal,
        uint256 rateBps,
        uint256 timeElapsedSeconds,
        uint256 secondsPerDay
    ) internal pure returns (uint256) {
        if (principal == 0 || rateBps == 0 || timeElapsedSeconds == 0) return 0;
        uint256 yearSeconds = 365 * secondsPerDay;
        return (principal * rateBps * timeElapsedSeconds) / (10000 * yearSeconds);
    }

    /**
     * @notice Fixed-installment schedule from simple interest over the whole tenure.
     *         Interest is computed in policy days so time compression does not change it.
     * @return totalInterest Interest over all installments.
     * @return installment Fixed installment (rounded up; the last one absorbs rounding).
     */
    function amortise(
        uint256 principal,
        uint256 rateBps,
        uint256 nInstallments,
        uint256 periodDays
    ) internal pure returns (uint256 totalInterest, uint256 installment) {
        totalInterest = (principal * rateBps * nInstallments * periodDays) / (10000 * 365);
        installment = (principal + totalInterest + nInstallments - 1) / nInstallments;
    }
}
