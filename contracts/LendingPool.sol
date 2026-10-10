// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./GLPToken.sol";
import "./CreditScore.sol";
import "./interfaces/ILendingPool.sol";
import "./libraries/InterestLib.sol";

contract LendingPool is ILendingPool, ReentrancyGuard, Ownable {
    using InterestLib for uint256;

    GLPToken public glpToken;
    CreditScore public creditScore;

    uint256 public totalActiveLoans;      // Strictly unpaid principal across active loans
    uint256 public insuranceReserve;      // Earmarked portion of cash ring-fenced for bad debt
    uint256 public secondsPerDay = 86400; // Configurable for local testing and time-travel

    uint256 public constant GRACE_PERIOD_DAYS = 3;
    uint256 public constant DEFAULT_TENURE_DAYS = 30;
    uint256 public constant MAX_UTILIZATION_BPS = 9000; // 90.00%
    uint256 public constant VIRTUAL_OFFSET = 1000000;    // 10^6 wei virtual offset
    uint256 public constant LATE_FEE_BPS = 500;          // 5.00% late surcharge

    struct Loan {
        uint256 principal;           // Remaining unpaid principal (wei)
        uint256 originationTime;     // Timestamp when loan was taken
        uint256 dueDate;             // Origination + tenure
        uint256 lastAccrualTime;     // Timestamp up to which interest is checkpointed
        uint256 accruedInterest;     // Checkpointed unpaid interest
        uint256 interestRateBps;     // Base rate + risk surcharge locked at origination
        uint256 tenureDays;          // Tenure duration in days
    }

    mapping(address => Loan) public loans;
    mapping(address => uint256) public activeLoans;       // Legacy mapping returning principal
    mapping(address => uint256) public writtenOffDebt;    // Off-balance memorandum debt
    mapping(address => uint256) public reserveDrawn;       // Exact insurance reserve drawn for borrower
    mapping(address => bool) public isDefaulter;

    event Deposited(address indexed user, uint256 amount, uint256 shares);
    event Borrowed(address indexed user, uint256 amount, uint256 tenureDays, uint256 interestRateBps);
    event Repaid(address indexed user, uint256 amount, uint256 principalPaid, uint256 interestPaid, uint256 refund);
    event Withdrawn(address indexed user, uint256 ethAmount, uint256 glpBurned);
    event DefaultSettled(
        address indexed borrower,
        uint256 sharesBurned,
        uint256 principalExtinguished,
        uint256 reserveCovered,
        uint256 writtenOffPrincipal,
        uint256 writtenOffInterest
    );
    event DebtRecovered(
        address indexed borrower,
        uint256 totalRecovered,
        uint256 reserveReplenished,
        uint256 memoCleared,
        uint256 refund
    );

    constructor(address _glpToken, address _creditScore) Ownable(msg.sender) {
        glpToken = GLPToken(_glpToken);
        creditScore = CreditScore(_creditScore);
    }

    function setSecondsPerDay(uint256 _secondsPerDay) external onlyOwner {
        require(_secondsPerDay > 0, "Invalid secondsPerDay");
        secondsPerDay = _secondsPerDay;
    }

    /**
     * @notice Deposit ETH into pool to mint GLP tokens with virtual-offset protection.
     */
    function deposit() external payable override nonReentrant {
        require(msg.value > 0, "Deposit must be > 0");

        // address(this).balance already includes msg.value!
        uint256 currentCash = address(this).balance;
        uint256 preCash = currentCash - msg.value;
        uint256 preFreeCash = preCash > insuranceReserve ? preCash - insuranceReserve : 0;
        uint256 preRecognizedAssets = preFreeCash + totalActiveLoans;

        uint256 sharesToMint = (msg.value * (glpToken.totalSupply() + VIRTUAL_OFFSET)) /
            (preRecognizedAssets + VIRTUAL_OFFSET);
        require(sharesToMint > 0, "Zero shares minted");

        glpToken.mint(msg.sender, sharesToMint);
        emit Deposited(msg.sender, msg.value, sharesToMint);
    }

    /**
     * @notice Borrow ETH with default 30-day tenure (backward-compatible overload).
     */
    function borrow(uint256 amount) external override nonReentrant {
        _executeBorrow(amount, DEFAULT_TENURE_DAYS);
    }

    /**
     * @notice Borrow ETH with specified tenure in days (7 to 90 days).
     */
    function borrow(uint256 amount, uint256 tenureDays) external override nonReentrant {
        _executeBorrow(amount, tenureDays);
    }

    function _executeBorrow(uint256 amount, uint256 tenureDays) internal {
        require(amount > 0, "Amount must be > 0");
        require(tenureDays >= 7 && tenureDays <= 90, "Tenure out of range (7-90 days)");
        require(loans[msg.sender].principal == 0, "Existing loan must be repaid");
        require(!isDefaulter[msg.sender], "Defaulter cannot borrow");
        require(
            block.timestamp >= creditScore.rehabilitationCooldownUntil(msg.sender),
            "Rehabilitation cooldown active"
        );
        require(glpToken.balanceOf(msg.sender) > 0, "Must deposit in pool before borrowing");

        uint256 freeCash = address(this).balance > insuranceReserve ? address(this).balance - insuranceReserve : 0;
        require(amount <= freeCash, "Insufficient pool liquidity");

        creditScore.initUser(msg.sender);
        uint256 limit = creditScore.getBorrowLimit(msg.sender);
        require(amount <= limit, "Borrow amount exceeds credit limit");

        // Check 90% post-borrow utilization cap
        uint256 postActiveLoans = totalActiveLoans + amount;
        uint256 totalPoolCapital = freeCash + totalActiveLoans; // Invariant capital before disbursement
        require(postActiveLoans * 10000 <= totalPoolCapital * MAX_UTILIZATION_BPS, "Utilization exceeds 90% cap");

        // Calculate rate based on post-borrow utilization + borrower risk score
        uint256 poolRate = InterestLib.calculatePoolRate(postActiveLoans, totalPoolCapital);
        uint256 userScore = creditScore.getScore(msg.sender);
        uint256 riskSurcharge = InterestLib.calculateRiskSurcharge(userScore);
        uint256 lockedRateBps = poolRate + riskSurcharge;

        uint256 dueDate = block.timestamp + (tenureDays * secondsPerDay);

        loans[msg.sender] = Loan({
            principal: amount,
            originationTime: block.timestamp,
            dueDate: dueDate,
            lastAccrualTime: block.timestamp,
            accruedInterest: 0,
            interestRateBps: lockedRateBps,
            tenureDays: tenureDays
        });

        activeLoans[msg.sender] = amount;
        totalActiveLoans += amount;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");

        emit Borrowed(msg.sender, amount, tenureDays, lockedRateBps);
    }

    /**
     * @notice Returns total accrued and pending interest for a borrower.
     */
    function getAccruedInterest(address user) public view returns (uint256) {
        Loan storage loan = loans[user];
        if (loan.principal == 0) return 0;
        return loan.accruedInterest + _calculatePendingInterest(user);
    }

    /**
     * @notice Returns total repayment amount due including accrued and pending interest.
     */
    function getRepaymentAmount(address user) public view returns (uint256) {
        Loan storage loan = loans[user];
        if (loan.principal == 0) return 0;
        uint256 pendingInterest = _calculatePendingInterest(user);
        return loan.principal + loan.accruedInterest + pendingInterest;
    }

    /**
     * @notice Alias for getRepaymentAmount.
     */
    function getTotalDue(address user) external view returns (uint256) {
        return getRepaymentAmount(user);
    }

    /**
     * @notice Directly seeds or donates funds to the insurance reserve.
     */
    function fundInsuranceReserve() external payable {
        insuranceReserve += msg.value;
    }

    function _calculatePendingInterest(address user) internal view returns (uint256) {
        Loan storage loan = loans[user];
        if (loan.principal == 0 || block.timestamp <= loan.lastAccrualTime) return 0;

        uint256 t0 = loan.lastAccrualTime;
        uint256 t1 = block.timestamp;
        uint256 due = loan.dueDate;

        if (t1 <= due) {
            // Pure ordinary interest
            return InterestLib.calculateAccruedInterest(loan.principal, loan.interestRateBps, t1 - t0, secondsPerDay);
        } else if (t0 < due) {
            // Spans due date
            uint256 ord = InterestLib.calculateAccruedInterest(loan.principal, loan.interestRateBps, due - t0, secondsPerDay);
            uint256 late = InterestLib.calculateAccruedInterest(loan.principal, loan.interestRateBps + LATE_FEE_BPS, t1 - due, secondsPerDay);
            return ord + late;
        } else {
            // Entirely overdue
            return InterestLib.calculateAccruedInterest(loan.principal, loan.interestRateBps + LATE_FEE_BPS, t1 - t0, secondsPerDay);
        }
    }

    /**
     * @notice Repays active loan (interest first, principal second). Excess is refunded.
     */
    function repay() external payable override nonReentrant {
        Loan storage loan = loans[msg.sender];
        require(loan.principal > 0, "No active loan");
        require(msg.value > 0, "Repayment amount must be > 0");

        // Checkpoint interest up to execution block timestamp
        uint256 pending = _calculatePendingInterest(msg.sender);
        loan.accruedInterest += pending;
        loan.lastAccrualTime = block.timestamp;

        // Interest-first waterfall
        uint256 interestPaid = msg.value < loan.accruedInterest ? msg.value : loan.accruedInterest;
        loan.accruedInterest -= interestPaid;

        // Allocate 10% of interest collected to insurance reserve
        uint256 reserveCut = (interestPaid * 10) / 100;
        insuranceReserve += reserveCut;

        uint256 remValue = msg.value - interestPaid;
        uint256 principalPaid = remValue < loan.principal ? remValue : loan.principal;
        loan.principal -= principalPaid;
        activeLoans[msg.sender] = loan.principal;
        totalActiveLoans -= principalPaid;

        uint256 refund = remValue - principalPaid;

        creditScore.updateRepayment(msg.sender, principalPaid + interestPaid);
        if (block.timestamp > loan.dueDate) {
            creditScore.recordLateRepayment(msg.sender);
        }

        if (loan.principal == 0 && loan.accruedInterest == 0) {
            delete loans[msg.sender];
            activeLoans[msg.sender] = 0;
        }

        if (refund > 0) {
            (bool success, ) = msg.sender.call{value: refund}("");
            require(success, "Refund failed");
        }

        emit Repaid(msg.sender, msg.value, principalPaid, interestPaid, refund);
    }

    /**
     * @notice Withdraw liquid ETH by burning GLP shares with virtual-offset protection.
     */
    function withdraw(uint256 glpAmount) external override nonReentrant {
        require(glpAmount > 0, "Amount must be > 0");
        require(glpToken.balanceOf(msg.sender) >= glpAmount, "Insufficient GLP balance");

        uint256 freeCash = address(this).balance > insuranceReserve ? address(this).balance - insuranceReserve : 0;
        uint256 recognizedAssets = freeCash + totalActiveLoans;

        uint256 ethToReturn = (glpAmount * (recognizedAssets + VIRTUAL_OFFSET)) /
            (glpToken.totalSupply() + VIRTUAL_OFFSET);
        require(ethToReturn > 0, "Zero assets to return");
        require(freeCash >= ethToReturn, "Insufficient liquidity to withdraw");

        glpToken.burnFrom(msg.sender, glpAmount);

        (bool success, ) = msg.sender.call{value: ethToReturn}("");
        require(success, "Transfer failed");

        emit Withdrawn(msg.sender, ethToReturn, glpAmount);
    }

    /**
     * @notice Settle default on an overdue loan past grace period via 3-stage waterfall (Approach A).
     */
    function markDefault(address borrower) external override nonReentrant {
        Loan storage loan = loans[borrower];
        require(loan.principal > 0, "No active principal");
        require(
            block.timestamp >= loan.dueDate + (GRACE_PERIOD_DAYS * secondsPerDay),
            "Grace period not elapsed"
        );

        // Checkpoint interest up to default timestamp; interest stops accruing thereafter
        loan.accruedInterest += _calculatePendingInterest(borrower);
        loan.lastAccrualTime = block.timestamp;
        uint256 accruedInt = loan.accruedInterest;
        uint256 loanPrincipal = loan.principal;

        // Stage 1: Borrower share set-off
        (uint256 sharesToBurn, uint256 principalExtinguished) = _calculateShareSetOff(borrower, loanPrincipal);
        if (sharesToBurn > 0) {
            glpToken.burnFrom(borrower, sharesToBurn);
        }

        totalActiveLoans -= principalExtinguished;
        uint256 remPrincipal1 = loanPrincipal - principalExtinguished;

        // Stage 2: Insurance reserve absorption
        uint256 reserveCovered = 0;
        if (remPrincipal1 > 0 && insuranceReserve > 0) {
            reserveCovered = remPrincipal1 < insuranceReserve ? remPrincipal1 : insuranceReserve;
            insuranceReserve -= reserveCovered;
            reserveDrawn[borrower] += reserveCovered;
            totalActiveLoans -= reserveCovered;
        }
        uint256 remPrincipal2 = remPrincipal1 - reserveCovered;

        // Stage 3: Socialized loss write-off & off-balance memorandum
        totalActiveLoans -= remPrincipal2;
        writtenOffDebt[borrower] = remPrincipal2 + accruedInt;
        isDefaulter[borrower] = true;
        activeLoans[borrower] = 0;

        creditScore.penalizeDefault(borrower);

        emit DefaultSettled(
            borrower,
            sharesToBurn,
            principalExtinguished,
            reserveCovered,
            remPrincipal2,
            accruedInt
        );

        delete loans[borrower];
    }

    /**
     * @dev Internal helper for Stage 1 share set-off under Approach A (Impairment Isolation).
     */
    function _calculateShareSetOff(address borrower, uint256 loanPrincipal)
        internal
        view
        returns (uint256 sharesToBurn, uint256 principalExtinguished)
    {
        uint256 borrowerShares = glpToken.balanceOf(borrower);
        if (borrowerShares == 0) {
            return (0, 0);
        }
        uint256 freeCash = address(this).balance > insuranceReserve ? address(this).balance - insuranceReserve : 0;
        uint256 unimpairedLoans = totalActiveLoans > loanPrincipal ? totalActiveLoans - loanPrincipal : 0;
        uint256 unimpairedAssets = freeCash + unimpairedLoans;
        uint256 totalSupply = glpToken.totalSupply();

        uint256 den = unimpairedAssets + VIRTUAL_OFFSET;
        uint256 num = loanPrincipal * (totalSupply + VIRTUAL_OFFSET);
        uint256 sharesNeeded = (num + den - 1) / den; // Ceiling division

        if (borrowerShares < sharesNeeded) {
            sharesToBurn = borrowerShares;
            principalExtinguished = (borrowerShares * den) / (totalSupply + VIRTUAL_OFFSET);
            if (principalExtinguished > loanPrincipal) {
                principalExtinguished = loanPrincipal;
            }
        } else {
            sharesToBurn = sharesNeeded;
            principalExtinguished = loanPrincipal;
        }
    }

    /**
     * @notice Rehabilitate defaulter by recovering written-off debt and replenishing reserve.
     */
    function settleWrittenOffDebt() external payable override nonReentrant {
        uint256 totalDebt = reserveDrawn[msg.sender] + writtenOffDebt[msg.sender];
        require(totalDebt > 0, "No debt to settle");
        require(msg.value > 0, "Amount must be > 0");

        uint256 refund = 0;
        uint256 settleAmount = msg.value;
        if (msg.value > totalDebt) {
            refund = msg.value - totalDebt;
            settleAmount = totalDebt;
        }

        // Priority 1: Replenish reserve drawn
        uint256 reserveRep = 0;
        if (reserveDrawn[msg.sender] > 0) {
            reserveRep = settleAmount < reserveDrawn[msg.sender] ? settleAmount : reserveDrawn[msg.sender];
            reserveDrawn[msg.sender] -= reserveRep;
            insuranceReserve += reserveRep;
        }

        // Priority 2: Settle memorandum debt (90% free cash / 10% reserve)
        uint256 remAmount = settleAmount - reserveRep;
        uint256 memoCleared = 0;
        if (remAmount > 0) {
            memoCleared = remAmount;
            writtenOffDebt[msg.sender] -= memoCleared;
            uint256 reserveAddition = (memoCleared * 10) / 100;
            insuranceReserve += reserveAddition;
        }

        if (reserveDrawn[msg.sender] == 0 && writtenOffDebt[msg.sender] == 0) {
            isDefaulter[msg.sender] = false;
        }

        if (refund > 0) {
            (bool success, ) = msg.sender.call{value: refund}("");
            require(success, "Refund failed");
        }

        emit DebtRecovered(msg.sender, settleAmount, reserveRep, memoCleared, refund);
    }

    receive() external payable {}
}
