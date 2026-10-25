// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LoanTypes
 * @notice Shared enums and the Loan record used by LoanManager, DefaultManager and RiskEngine.
 */
library LoanTypes {
    enum LoanKind { Builder, Unsecured }
    enum LoanStatus { None, Active, Repaid, Defaulted, Exited }
    enum Stage { Active, Grace, Onset, Significant, DefaultEligible }
    enum DefaultType { None, Hardship, Strategic, Fraud }
    enum RestructureOption { None, PaymentHoliday, TenureStretch }

    struct Loan {
        uint256 id;
        uint256 memberId;
        address borrower;
        LoanKind kind;
        LoanStatus status;
        uint256 principal;
        uint256 outstandingPrincipal;
        uint256 rateBps;
        uint32 periodDays;
        uint16 nInstallments;
        uint16 paidCount;
        uint256 installment;
        uint64 startAt;
        uint64 nextDueDate;
        uint64 firstMissedAt;
        uint256 lateFeesDue;
        uint256 stakeLocked;           // borrower GLP shares locked for this loan
        address guarantor;
        uint256 guarantorStakeLocked;  // guarantor GLP shares locked for this loan
        bool askedForHelp;
        bool restructured;
        RestructureOption activeRestructure;
        DefaultType dtype;
        uint64 classifiedAt;
        bool appealOpen;
        // Schedule bookkeeping
        uint256 interestRemaining;     // scheduled interest not yet paid
        uint256 curInterestPortion;    // interest part of the current installment
        uint256 curPrincipalPortion;   // principal part of the current installment
        uint256 curInterestPaid;
        uint256 curPrincipalPaid;
        uint16 lateFeeChargedFor;      // installment number (paidCount + 1) already charged a late fee
        uint16 lateMarkedFor;          // installment number already given a late score mark
        uint16 helpFor;                // installment number covered by an early restructure request
        uint16 missedFor;              // installment number already reported by InstallmentMissed
        uint8 tierAtOpen;              // member tier at origination (sets the grace window)
        uint32 cohortId;               // member cohort at origination (shock mode, FPD screen)
        uint64 restructureEndsAt;
        uint256 escrow;                // Builder loans: principal held until full repayment
        bool autopay;                  // SafeRepay + income sweep opted in
    }
}
