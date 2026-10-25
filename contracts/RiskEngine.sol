// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PolicyConfig.sol";
import "./IdentityRegistry.sol";
import "./interfaces/IGigLend.sol";
import "./libraries/InterestLib.sol";
import "./libraries/LoanTypes.sol";

interface ILoanBook {
    function totalOutstanding() external view returns (uint256);
    function clusterExposure(bytes32 clusterId) external view returns (uint256);
    function growthWindowStart() external view returns (uint64);
    function originatedInWindow() external view returns (uint256);
    function loansOfMember(uint256 memberId) external view returns (uint256[] memory);
    function memberStats(uint256 memberId)
        external
        view
        returns (
            uint256 largestCompleted,
            uint256 largestCompletedUnsecured,
            uint32 builderCompleted,
            uint64 lastStepAt,
            uint64 prevStepAt,
            uint32 builderSinceDefault,
            bool hadDefault
        );
}

interface IScore {
    function getScore(uint256 memberId) external view returns (uint256);
}

/**
 * @title RiskEngine
 * @notice Prices loans and enforces every prevention rule before money leaves the pool.
 *         Read-only: LoanManager calls quote(), which reverts with a clear reason.
 *           - Credit-builder first (escrowed Builder loans; first Unsecured only after Builder
 *             loans + 90 days of stake, capped, with 50% stake cover checked by LoanManager)
 *           - Capped ladder (≤ 1.5× largest completed, smaller early steps, per-step cap)
 *           - Fast-climber hold (two limit steps within 60 days, then a larger request)
 *           - Total debt burden (installment, monthly, + declared EMIs ≤ 35% of attested income)
 *           - Cohort first-payment-default pause; 2% per loan, 5% per cluster, ~10%/week growth
 *           - 90% utilisation cap
 */
contract RiskEngine {
    PolicyConfig public immutable config;
    IdentityRegistry public immutable registry;
    ILoanBook public immutable loans;
    ILendingPoolV3 public immutable pool;
    IScore public immutable score;

    struct Limits {
        uint256 builderCap;
        uint256 unsecuredCap;      // ladder / first-unsecured cap after misdeclared-debt cut
        uint256 maxMonthlyInstallment;
        uint256 perLoanCap;
        uint256 clusterRoom;
        uint256 weeklyRoom;
        uint256 liquidityRoom;     // 90% utilisation cap
        bool unsecuredAllowed;
        string unsecuredHold;      // reason Unsecured is not available ("" if allowed)
        bool fastClimberHeld;
        bool cohortPaused;
    }

    constructor(PolicyConfig _config, IdentityRegistry _registry, address _loans, address _pool, address _score) {
        config = _config;
        registry = _registry;
        loans = ILoanBook(_loans);
        pool = ILendingPoolV3(_pool);
        score = IScore(_score);
    }

    function _p(bytes32 key) internal view returns (uint256) {
        return config.get(key);
    }

    /**
     * @notice Terms for a proposed loan; reverts with the failing rule's reason.
     */
    function quote(uint256 memberId, LoanTypes.LoanKind kind, uint256 amount, uint16 nInstallments)
        external
        view
        returns (uint256 rateBps, uint256 totalInterest, uint256 installment)
    {
        require(amount > 0, "Amount must be > 0");
        require(
            nInstallments >= _p("minInstallments") && nInstallments <= _p("maxInstallments"),
            "Installments out of range"
        );
        IdentityRegistry.Member memory m = registry.getMember(memberId);

        uint256 outstanding = loans.totalOutstanding();
        {
            uint256 free = pool.freeCash();
            require(amount <= free, "Insufficient pool liquidity");
            uint256 capital = free + outstanding;
            require((outstanding + amount) * 10000 <= capital * _p("maxUtilizationBps"), "Utilization exceeds 90% cap");
            rateBps =
                InterestLib.calculatePoolRate(outstanding + amount, capital) +
                InterestLib.calculateRiskSurcharge(score.getScore(memberId));
        }
        (totalInterest, installment) = InterestLib.amortise(amount, rateBps, nInstallments, m.payoutPeriodDays);
        _checkPrevention(memberId, m, kind, amount, installment);
    }

    function _checkPrevention(
        uint256 memberId,
        IdentityRegistry.Member memory m,
        LoanTypes.LoanKind kind,
        uint256 amount,
        uint256 installment
    ) internal view {
        Limits memory lim = limits(memberId);

        if (kind == LoanTypes.LoanKind.Builder) {
            require(amount <= lim.builderCap, "Builder loan above cap");
        } else {
            require(lim.unsecuredAllowed, lim.unsecuredHold);
            require(!lim.fastClimberHeld || amount <= _largestCompleted(memberId), "Fast climber: held at current step");
            require(amount <= lim.unsecuredCap, "Above ladder limit");
        }

        uint256 monthly = (installment * 30) / m.payoutPeriodDays;
        require(monthly <= lim.maxMonthlyInstallment, "Installment exceeds 35% debt burden");
        require(!lim.cohortPaused, "Cohort paused: first-payment defaults");
        require(amount <= lim.perLoanCap, "Above per-loan cap (2% of pool)");
        require(amount <= lim.clusterRoom, "Cluster exposure cap reached");
        require(amount <= lim.weeklyRoom, "Weekly growth cap reached");
    }

    function _largestCompleted(uint256 memberId) internal view returns (uint256 largest) {
        (largest, , , , , , ) = loans.memberStats(memberId);
    }

    /**
     * @notice Full limit breakdown for the Borrow page (and the reason for any hold).
     */
    function limits(uint256 memberId) public view returns (Limits memory lim) {
        IdentityRegistry.Member memory m = registry.getMember(memberId);
        (
            uint256 largest,
            uint256 largestUnsecured,
            uint32 builderDone,
            uint64 lastStepAt,
            uint64 prevStepAt,
            uint32 builderSinceDefault,
            bool hadDefault
        ) = loans.memberStats(memberId);

        uint256 cutBps = m.misdeclaredDebt ? _p("misdeclaredLimitCutBps") : 0;
        lim.builderCap = (_p("builderMaxWei") * (10000 - cutBps)) / 10000;

        // Ladder: first Unsecured at the fixed cap; then ≤ multiplier × largest completed,
        // with smaller early steps and an absolute per-step cap.
        uint256 ladder;
        if (largestUnsecured == 0) {
            ladder = _p("firstUnsecuredCapWei");
        } else {
            uint256 unsecuredDone = m.completedLoans > builderDone ? m.completedLoans - builderDone : 0;
            uint256 mult = unsecuredDone < _p("ladderEarlySteps") ? _p("ladderEarlyMultiplierBps") : _p("ladderMultiplierBps");
            uint256 byMult = (largestUnsecured * mult) / 10000;
            uint256 byStep = largestUnsecured + _p("ladderStepCapWei");
            ladder = byMult < byStep ? byMult : byStep;
        }
        lim.unsecuredCap = (ladder * (10000 - cutBps)) / 10000;

        uint256 spd = _p("secondsPerDay");
        lim.unsecuredHold = "";
        if (m.defaultCount >= 2) {
            lim.unsecuredHold = "Unsecured borrowing ended after a second default";
        } else if (hadDefault && builderSinceDefault == 0) {
            lim.unsecuredHold = "Re-entry after default starts with a Builder loan";
        } else if (builderDone < _p("builderLoansRequired")) {
            lim.unsecuredHold = "Complete a Builder loan first";
        } else if (
            _p("stakeAgeRequiredDays") > 0 &&
            (m.stakeSince == 0 || block.timestamp - m.stakeSince < _p("stakeAgeRequiredDays") * spd)
        ) {
            lim.unsecuredHold = "Stake must be held for 90 days";
        }
        lim.unsecuredAllowed = bytes(lim.unsecuredHold).length == 0;

        lim.fastClimberHeld =
            lastStepAt != 0 &&
            prevStepAt != 0 &&
            block.timestamp - prevStepAt <= _p("fastClimberWindowDays") * spd;
        if (lim.fastClimberHeld && lim.unsecuredCap > largest) lim.unsecuredCap = largest;

        uint256 burdenRoom = (m.incomeWei * _p("burdenBps")) / 10000;
        lim.maxMonthlyInstallment = burdenRoom > m.declaredDebtWei ? burdenRoom - m.declaredDebtWei : 0;

        bool firstLoan = loans.loansOfMember(memberId).length == 0 && m.completedLoans == 0;
        lim.cohortPaused = firstLoan && registry.cohortPaused(m.cohortId);

        uint256 pv = pool.poolValue();
        lim.perLoanCap = (pv * _p("perLoanCapBps")) / 10000;
        uint256 clusterCap = (pv * _p("clusterCapBps")) / 10000;
        uint256 exposure = loans.clusterExposure(m.clusterId);
        lim.clusterRoom = clusterCap > exposure ? clusterCap - exposure : 0;

        uint256 weeklyCap = (pv * _p("weeklyGrowthCapBps")) / 10000;
        uint256 used = block.timestamp < uint256(loans.growthWindowStart()) + 7 * spd ? loans.originatedInWindow() : 0;
        lim.weeklyRoom = weeklyCap > used ? weeklyCap - used : 0;

        uint256 free = pool.freeCash();
        uint256 outstanding = loans.totalOutstanding();
        uint256 maxTotal = ((free + outstanding) * _p("maxUtilizationBps")) / 10000;
        lim.liquidityRoom = maxTotal > outstanding ? maxTotal - outstanding : 0;
    }
}
