// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./GLPToken.sol";
import "./PolicyConfig.sol";
import "./IdentityRegistry.sol";
import "./interfaces/IGigLend.sol";

/**
 * @title LendingPool
 * @notice Lender side of GigLend: deposits, withdrawals and the withdrawal queue.
 *         Shares are priced off poolValue() = free cash + carried value of open loans, where
 *         late loans are carried at a discount by stage (book losses in steps). The 10^6 wei
 *         virtual offset protects against share-inflation attacks.
 *         Only LoanManager / DefaultManager (LOAN_ROLE) move pool cash for loans.
 */
contract LendingPool is ReentrancyGuard, AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant LOAN_ROLE = keccak256("LOAN_ROLE");
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE"); // DefaulterGovernance

    uint256 public constant VIRTUAL_OFFSET = 1000000; // 10^6 wei virtual offset

    struct WithdrawalRequest {
        address owner;
        uint256 shares; // remaining shares held in escrow by the pool
    }

    GLPToken public immutable glpToken;
    PolicyConfig public immutable config;
    IdentityRegistry public immutable registry;
    ILoanManager public loanManager;
    IDefaultManager public defaultManager;
    address public reserveFund;

    WithdrawalRequest[] public queue;
    uint256 public queueHead;
    uint256 public totalQueuedShares;
    mapping(address => uint256) public queuedSharesOf;
    /// @notice Wallets expelled by member vote. Expulsion never cancels debt.
    mapping(address => bool) public expelled;

    event Deposited(address indexed user, uint256 amount, uint256 shares);
    event Withdrawn(address indexed user, uint256 ethAmount, uint256 glpBurned);
    event WithdrawalQueued(address indexed user, uint256 shares, uint256 queueIndex);
    event WithdrawalPaid(address indexed user, uint256 ethAmount, uint256 sharesBurned, uint256 sharesRemaining);
    event WithdrawalCancelled(address indexed user, uint256 shares);
    event ResidualSwept(address indexed user, uint256 indexed memberId, uint256 amount);
    event StakeBurned(address indexed account, uint256 shares, uint256 value);
    event WalletExpelled(address indexed wallet, bool expelled);

    constructor(address admin, GLPToken _glp, PolicyConfig _config, IdentityRegistry _registry) {
        glpToken = _glp;
        config = _config;
        registry = _registry;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Wiring (set once)
    // ─────────────────────────────────────────────────────────────────────

    function setLoanManager(address lm) external onlyRole(ADMIN_ROLE) {
        require(address(loanManager) == address(0), "Already set");
        loanManager = ILoanManager(lm);
    }

    function setDefaultManager(address dm) external onlyRole(ADMIN_ROLE) {
        require(address(defaultManager) == address(0), "Already set");
        defaultManager = IDefaultManager(dm);
    }

    function setReserveFund(address rf) external onlyRole(ADMIN_ROLE) {
        require(reserveFund == address(0), "Already set");
        reserveFund = rf;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Valuation
    // ─────────────────────────────────────────────────────────────────────

    function freeCash() public view returns (uint256) {
        return address(this).balance;
    }

    /**
     * @notice freeCash + Σ carried(loan). Carried value falls with each loan's stage.
     */
    function poolValue() public view returns (uint256) {
        uint256 carried = address(loanManager) == address(0) ? 0 : loanManager.carriedValue();
        return freeCash() + carried;
    }

    /// @notice Value of `shares` at the current (provisioned) share price.
    function valueOfShares(uint256 shares) public view returns (uint256) {
        return (shares * (poolValue() + VIRTUAL_OFFSET)) / (glpToken.totalSupply() + VIRTUAL_OFFSET);
    }

    /// @notice Shares worth `valueWei` at the current share price, rounded up.
    function sharesForValue(uint256 valueWei) public view returns (uint256) {
        uint256 den = poolValue() + VIRTUAL_OFFSET;
        return (valueWei * (glpToken.totalSupply() + VIRTUAL_OFFSET) + den - 1) / den;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Lender actions
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Deposit ETH for GLP. A member with a residual default claim has residualSweepBps
     *         (50%) of the deposit applied to the claim first.
     */
    function deposit() external payable nonReentrant {
        require(msg.value > 0, "Deposit must be > 0");
        require(!expelled[msg.sender], "Wallet expelled");
        require(registry.isVerified(msg.sender), "Identity not verified");
        uint256 value = msg.value;

        uint256 memberId = registry.memberOf(msg.sender);
        if (memberId != 0 && address(defaultManager) != address(0)) {
            uint256 claim = defaultManager.claimOf(memberId);
            if (claim > 0) {
                uint256 sweep = (value * config.get("residualSweepBps")) / 10000;
                if (sweep > claim) sweep = claim;
                if (sweep > 0) {
                    value -= sweep;
                    defaultManager.applyRecovery{value: sweep}(memberId);
                    emit ResidualSwept(msg.sender, memberId, sweep);
                }
            }
        }
        require(value > 0, "Nothing left to deposit");

        // Pre-deposit value: everything recognised except this deposit's remaining cash.
        uint256 preValue = poolValue() - value;
        uint256 sharesToMint = (value * (glpToken.totalSupply() + VIRTUAL_OFFSET)) / (preValue + VIRTUAL_OFFSET);
        require(sharesToMint > 0, "Zero shares minted");

        glpToken.mint(msg.sender, sharesToMint);
        if (memberId != 0 && registry.getMember(memberId).stakeSince == 0) {
            registry.setStakeSince(memberId, uint64(block.timestamp));
        }
        emit Deposited(msg.sender, value, sharesToMint);
        _processQueue();
    }

    /**
     * @notice Burn GLP for ETH at the provisioned share price. If free cash is short, or other
     *         withdrawals are already waiting, the request joins the FIFO queue instead of reverting.
     */
    function withdraw(uint256 glpAmount) external nonReentrant {
        require(glpAmount > 0, "Amount must be > 0");
        require(glpToken.balanceOf(msg.sender) >= glpAmount, "Insufficient GLP balance");
        require(glpToken.unlockedBalanceOf(msg.sender) >= glpAmount, "GLP locked");
        require(!isDefaulter(msg.sender), "Debt outstanding");

        uint256 ethToReturn = valueOfShares(glpAmount);
        require(ethToReturn > 0, "Zero assets to return");

        if (queueHead == queue.length && freeCash() >= ethToReturn) {
            glpToken.burnFrom(msg.sender, glpAmount);
            _afterStakeChange(msg.sender);
            (bool success, ) = msg.sender.call{value: ethToReturn}("");
            require(success, "Transfer failed");
            emit Withdrawn(msg.sender, ethToReturn, glpAmount);
            return;
        }

        require(queue.length - queueHead < config.get("maxQueueLength"), "Withdrawal queue full");
        // Escrow the shares with the pool: they keep sharing gains and losses while queued.
        glpToken.burnFrom(msg.sender, glpAmount);
        glpToken.mint(address(this), glpAmount);
        _afterStakeChange(msg.sender);
        queue.push(WithdrawalRequest(msg.sender, glpAmount));
        totalQueuedShares += glpAmount;
        queuedSharesOf[msg.sender] += glpAmount;
        emit WithdrawalQueued(msg.sender, glpAmount, queue.length - 1);
        _processQueue();
    }

    /// @notice Returns the caller's remaining queued shares.
    function cancelQueuedWithdrawals() external nonReentrant {
        uint256 total;
        for (uint256 i = queueHead; i < queue.length; i++) {
            if (queue[i].owner == msg.sender && queue[i].shares > 0) {
                total += queue[i].shares;
                queue[i].shares = 0;
            }
        }
        require(total > 0, "Nothing queued");
        totalQueuedShares -= total;
        queuedSharesOf[msg.sender] = 0;
        glpToken.burnFrom(address(this), total);
        glpToken.mint(msg.sender, total);
        _advanceHead();
        emit WithdrawalCancelled(msg.sender, total);
    }

    function processQueue() external nonReentrant {
        _processQueue();
    }

    /**
     * @notice Pays queued withdrawals from free cash. If cash covers everything, all are paid;
     *         otherwise each request is paid the same fraction (pro rata, Maple 2.0 style).
     */
    function _processQueue() internal {
        if (queueHead == queue.length || totalQueuedShares == 0) return;
        uint256 cash = freeCash();
        if (cash == 0) return;

        uint256 pv = poolValue();
        uint256 supply = glpToken.totalSupply();
        uint256 totalValue = (totalQueuedShares * (pv + VIRTUAL_OFFSET)) / (supply + VIRTUAL_OFFSET);
        if (totalValue == 0) return;

        uint256 end = queue.length;
        uint256 burnedTotal;
        for (uint256 i = queueHead; i < end; i++) {
            WithdrawalRequest storage r = queue[i];
            if (r.shares == 0) continue;
            uint256 payShares = cash >= totalValue ? r.shares : (r.shares * cash) / totalValue;
            if (payShares == 0) continue;
            uint256 payEth = (payShares * (pv + VIRTUAL_OFFSET)) / (supply + VIRTUAL_OFFSET);
            r.shares -= payShares;
            queuedSharesOf[r.owner] -= payShares;
            burnedTotal += payShares;
            (bool ok, ) = r.owner.call{value: payEth}("");
            require(ok, "Queue payout failed");
            emit WithdrawalPaid(r.owner, payEth, payShares, r.shares);
        }
        if (burnedTotal > 0) {
            totalQueuedShares -= burnedTotal;
            glpToken.burnFrom(address(this), burnedTotal);
        }
        _advanceHead();
    }

    function _advanceHead() internal {
        while (queueHead < queue.length && queue[queueHead].shares == 0) queueHead++;
    }

    function queueLength() external view returns (uint256) {
        return queue.length - queueHead;
    }

    /// @notice Shares queued ahead of the caller's first open request, and the caller's own.
    function queuePosition(address user) external view returns (uint256 sharesAhead, uint256 ownShares) {
        bool found;
        for (uint256 i = queueHead; i < queue.length; i++) {
            if (queue[i].owner == user) {
                found = true;
                ownShares += queue[i].shares;
            } else if (!found) {
                sharesAhead += queue[i].shares;
            }
        }
        if (!found) sharesAhead = 0;
    }

    /**
     * @notice A defaulter is a member whose default left an unpaid claim. Their GLP is frozen
     *         (no withdraw, no transfer) until the claim is settled.
     */
    function isDefaulter(address wallet) public view returns (bool) {
        if (address(defaultManager) == address(0)) return false;
        uint256 memberId = registry.memberOf(wallet);
        return memberId != 0 && defaultManager.claimOf(memberId) > 0;
    }

    function setExpelled(address wallet, bool value) external onlyRole(GOVERNANCE_ROLE) {
        expelled[wallet] = value;
        emit WalletExpelled(wallet, value);
    }

    function _afterStakeChange(address account) internal {
        uint256 memberId = registry.memberOf(account);
        if (memberId != 0 && glpToken.balanceOf(account) == 0 && registry.getMember(memberId).stakeSince != 0) {
            registry.setStakeSince(memberId, 0);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Loan engine hooks (LOAN_ROLE)
    // ─────────────────────────────────────────────────────────────────────

    function disburse(address to, uint256 amount) external onlyRole(LOAN_ROLE) nonReentrant {
        require(amount <= freeCash(), "Insufficient pool liquidity");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "Disburse failed");
    }

    /**
     * @notice Called after cash returns to the pool so queued withdrawals get paid. When the
     *         pool is already mid-call (e.g. a deposit whose residual sweep repays a claim), the
     *         outer call processes the queue itself, so this returns early.
     */
    function onCashIn() external onlyRole(LOAN_ROLE) {
        if (_reentrancyGuardEntered()) return;
        _guardedProcessQueue();
    }

    function _guardedProcessQueue() private nonReentrant {
        _processQueue();
    }

    function transferToReserve(uint256 amount) external onlyRole(LOAN_ROLE) nonReentrant {
        if (amount == 0) return;
        require(amount <= freeCash(), "Insufficient pool liquidity");
        (bool ok, ) = reserveFund.call{value: amount}("");
        require(ok, "Reserve transfer failed");
    }

    /**
     * @notice Applies locked stake to a debt at the fair share price, i.e. excluding the
     *         impaired loan's own carried value (V2 "Approach A" impairment isolation).
     * @param maxShares Locked shares available for this loan.
     * @param valueWei Debt to cover.
     * @param excludedCarry Carried value of the impaired loan, left out of the price.
     */
    function burnStake(address account, uint256 maxShares, uint256 valueWei, uint256 excludedCarry)
        external
        onlyRole(LOAN_ROLE)
        nonReentrant
        returns (uint256 sharesBurned, uint256 valueCovered)
    {
        if (maxShares == 0 || valueWei == 0) return (0, 0);
        uint256 pv = poolValue();
        uint256 fairAssets = pv > excludedCarry ? pv - excludedCarry : 0;
        uint256 supply = glpToken.totalSupply();
        uint256 den = fairAssets + VIRTUAL_OFFSET;
        uint256 needed = (valueWei * (supply + VIRTUAL_OFFSET) + den - 1) / den;

        if (maxShares < needed) {
            sharesBurned = maxShares;
            valueCovered = (maxShares * den) / (supply + VIRTUAL_OFFSET);
            if (valueCovered > valueWei) valueCovered = valueWei;
        } else {
            sharesBurned = needed;
            valueCovered = valueWei;
        }
        glpToken.unlock(account, sharesBurned);
        glpToken.burnFrom(account, sharesBurned);
        _afterStakeChange(account);
        emit StakeBurned(account, sharesBurned, valueCovered);
    }

    /**
     * @notice Expulsion set-off: burns the wallet GLP (locked or not) up to `valueWei` at the
     *         fair share price (Stage 1 valuation). The value stays with remaining lenders.
     */
    function seizeShares(address account, uint256 valueWei)
        external
        onlyRole(LOAN_ROLE)
        nonReentrant
        returns (uint256 sharesBurned, uint256 valueCovered)
    {
        uint256 balance = glpToken.balanceOf(account);
        if (balance == 0 || valueWei == 0) return (0, 0);
        uint256 supply = glpToken.totalSupply();
        uint256 den = poolValue() + VIRTUAL_OFFSET;
        uint256 needed = (valueWei * (supply + VIRTUAL_OFFSET) + den - 1) / den;
        if (balance < needed) {
            sharesBurned = balance;
            valueCovered = (balance * den) / (supply + VIRTUAL_OFFSET);
            if (valueCovered > valueWei) valueCovered = valueWei;
        } else {
            sharesBurned = needed;
            valueCovered = valueWei;
        }
        uint256 locked = glpToken.lockedBalance(account);
        if (locked > 0) glpToken.unlock(account, locked < sharesBurned ? locked : sharesBurned);
        glpToken.burnFrom(account, sharesBurned);
        _afterStakeChange(account);
        emit StakeBurned(account, sharesBurned, valueCovered);
    }

    receive() external payable {}
}
