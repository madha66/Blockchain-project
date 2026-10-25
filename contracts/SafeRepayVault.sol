// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SafeRepayVault
 * @notice Per-borrower prefunded repayment vault (autopay by default, opt-out). The borrower
 *         sets the limits: maximum pull per installment, a protected minimum balance that is
 *         never pulled, and an expiry. LoanManager pulls installments within those limits.
 *
 *         Future work: EIP-7702 lets a plain MetaMask EOA delegate to code with the same
 *         limits without moving funds into a vault (see IMPLEMENTATION_NOTES.md).
 */
contract SafeRepayVault is AccessControl, ReentrancyGuard {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant LOAN_ROLE = keccak256("LOAN_ROLE");

    struct Vault {
        uint256 balance;
        uint256 maxPull;
        uint256 protectedMin;
        uint64 expiry;
        bool configured;
    }

    mapping(address => Vault) public vaults;

    event VaultFunded(address indexed borrower, address indexed from, uint256 amount);
    event VaultWithdrawn(address indexed borrower, uint256 amount);
    event VaultConfigured(address indexed borrower, uint256 maxPull, uint256 protectedMin, uint64 expiry);
    event VaultPulled(address indexed borrower, uint256 amount);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    function deposit() external payable {
        _deposit(msg.sender);
    }

    function depositFor(address borrower) external payable {
        _deposit(borrower);
    }

    function _deposit(address borrower) internal {
        require(msg.value > 0, "Nothing to deposit");
        vaults[borrower].balance += msg.value;
        emit VaultFunded(borrower, msg.sender, msg.value);
    }

    /// @notice Borrower-chosen limits.
    function configure(uint256 maxPull, uint256 protectedMin, uint64 expiry) external {
        Vault storage v = vaults[msg.sender];
        v.maxPull = maxPull;
        v.protectedMin = protectedMin;
        v.expiry = expiry;
        v.configured = true;
        emit VaultConfigured(msg.sender, maxPull, protectedMin, expiry);
    }

    /// @notice Default limits set at disbursement when the borrower has not configured any.
    function setupFor(address borrower, uint256 maxPull, uint64 expiry) external onlyRole(LOAN_ROLE) {
        Vault storage v = vaults[borrower];
        if (v.configured && v.expiry > block.timestamp) return;
        v.maxPull = maxPull;
        v.expiry = expiry;
        v.configured = true;
        emit VaultConfigured(borrower, maxPull, v.protectedMin, expiry);
    }

    function withdraw(uint256 amount) external nonReentrant {
        Vault storage v = vaults[msg.sender];
        require(amount <= v.balance, "Exceeds vault balance");
        v.balance -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "Withdraw failed");
        emit VaultWithdrawn(msg.sender, amount);
    }

    function available(address borrower) public view returns (uint256) {
        Vault storage v = vaults[borrower];
        if (!v.configured || v.expiry <= block.timestamp || v.balance <= v.protectedMin) return 0;
        uint256 free = v.balance - v.protectedMin;
        return free < v.maxPull ? free : v.maxPull;
    }

    /**
     * @notice Pulls up to `amount` (capped by the borrower's limits) and sends it to LoanManager.
     */
    function pull(address borrower, uint256 amount) external onlyRole(LOAN_ROLE) nonReentrant returns (uint256 pulled) {
        uint256 avail = available(borrower);
        pulled = amount < avail ? amount : avail;
        if (pulled == 0) return 0;
        vaults[borrower].balance -= pulled;
        (bool ok, ) = msg.sender.call{value: pulled}("");
        require(ok, "Pull transfer failed");
        emit VaultPulled(borrower, pulled);
    }
}
