// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../PolicyConfig.sol";
import "../IdentityRegistry.sol";
import "../GLPToken.sol";
import "../interfaces/IGigLend.sol";
import "./InterestLib.sol";
import "./LoanTypes.sol";

/**
 * @title LoanOpsLib
 * @notice Externally linked library for LoanManager. Its functions run via DELEGATECALL on
 *         LoanManager's storage, which keeps LoanManager under the 24 KB EIP-170 limit.
 */
library LoanOpsLib {
    struct Deps {
        PolicyConfig config;
        IdentityRegistry registry;
        ICreditScore score;
        IPayoutRouter payouts;
        ILendingPoolV3 pool;
        GLPToken glp;
    }

    // Same signature as LoanManager.RestructureGranted, so the event decodes with LoanManager's ABI.
    event RestructureGranted(
        uint256 indexed loanId,
        LoanTypes.RestructureOption option,
        uint64 nextDueDate,
        uint256 installment,
        uint16 nInstallments,
        uint256 fee
    );

    /**
     * @notice One priced restructure per loan, at most maxRestructuresPer12m per member.
     *         PaymentHoliday: skip one installment, interest frozen for that period, tenure +1
     *         period, small flat fee. TenureStretch: attested income dropped for the last two
     *         payouts; re-amortise the remaining balance to the window maximum with the term
     *         premium. Asking early makes the affected installment count as late-within-grace.
     *         Stage gating (before due or in Onset) is checked by the caller.
     */
    function restructure(LoanTypes.Loan storage l, Deps memory d, LoanTypes.RestructureOption option) external {
        require(!l.restructured, "Loan already restructured");
        require(
            d.registry.restructuresInWindow(l.memberId) < d.config.get("maxRestructuresPer12m"),
            "Restructure limit reached"
        );

        uint16 number = l.paidCount + 1;
        uint256 fee;
        if (option == LoanTypes.RestructureOption.PaymentHoliday) {
            fee = d.config.get("holidayFeeWei");
            l.lateFeesDue += fee;
            // The schedule shifts one period with no extra interest, so tenure grows by one period.
            l.nextDueDate += uint64(uint256(l.periodDays) * d.config.secondsPerDay());
        } else if (option == LoanTypes.RestructureOption.TenureStretch) {
            _stretch(l, d);
        } else {
            revert("Unknown option");
        }

        if (block.timestamp <= l.nextDueDate) l.firstMissedAt = 0;
        l.helpFor = number;
        l.restructured = true;
        l.askedForHelp = true;
        l.activeRestructure = option;
        l.restructureEndsAt = l.nextDueDate;
        d.registry.recordRestructure(l.memberId);
        d.score.recordRestructure(l.memberId);
        emit RestructureGranted(l.id, option, l.nextDueDate, l.installment, l.nInstallments, fee);
    }

    function _stretch(LoanTypes.Loan storage l, Deps memory d) private {
        (uint256 latest, uint256 previous) = d.payouts.lastPayouts(l.borrower);
        uint256 expected = (d.registry.getMember(l.memberId).incomeWei * l.periodDays) / 30;
        uint256 threshold = (expected * d.config.get("incomeDropBps")) / 10000;
        require(
            latest > 0 && previous > 0 && latest < threshold && previous < threshold,
            "Income has not dropped for 2 payouts"
        );

        uint256 maxN = d.config.get("maxInstallments");
        uint256 remainingNow = l.nInstallments - l.paidCount;
        require(maxN > l.paidCount && maxN - l.paidCount > remainingNow, "Already at maximum tenure");
        uint256 newK = maxN - l.paidCount;

        l.rateBps += d.config.get("termPremiumBps");
        (uint256 newInterest, uint256 newInstallment) =
            InterestLib.amortise(l.outstandingPrincipal, l.rateBps, newK, l.periodDays);
        l.interestRemaining = newInterest;
        l.nInstallments = uint16(maxN);
        l.installment = newInstallment;
        // Restart the current installment on the new schedule (paid amounts are already booked).
        l.curInterestPortion = newK == 1 ? newInterest : newInterest / newK;
        l.curPrincipalPortion = newK == 1 ? l.outstandingPrincipal : l.outstandingPrincipal / newK;
        l.curInterestPaid = 0;
        l.curPrincipalPaid = 0;
    }

    /**
     * @notice Locks all of the borrower's free GLP for the life of the loan (Unsecured loans must
     *         reach the required cover, counting a guarantor's pledge) and takes over the pledge.
     *         The default waterfall burns only what the debt needs and unlocks the rest.
     */
    function lockStake(
        LoanTypes.Loan storage l,
        mapping(address => mapping(address => uint256)) storage pledges,
        Deps memory d,
        address guarantor
    ) external {
        uint256 coverBps = l.kind == LoanTypes.LoanKind.Unsecured ? d.config.get("unsecuredStakeCoverBps") : 0;
        uint256 requiredShares = coverBps == 0 ? 0 : d.pool.sharesForValue((l.principal * coverBps) / 10000);

        uint256 borrowerLock = d.glp.unlockedBalanceOf(l.borrower);

        uint256 guarantorLock;
        if (guarantor != address(0)) {
            require(guarantor != l.borrower, "Self-guarantee not allowed");
            guarantorLock = pledges[guarantor][l.borrower];
            require(guarantorLock > 0, "No guarantee pledged");
            delete pledges[guarantor][l.borrower];
            l.guarantor = guarantor;
            l.guarantorStakeLocked = guarantorLock; // already locked at pledge time
        }
        require(borrowerLock + guarantorLock >= requiredShares, "Insufficient stake cover");
        if (borrowerLock > 0) d.glp.lock(l.borrower, borrowerLock);
        l.stakeLocked = borrowerLock;
    }
}
