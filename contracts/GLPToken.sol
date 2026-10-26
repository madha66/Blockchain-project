// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

interface IDebtView {
    function isDefaulter(address wallet) external view returns (bool);
}

/**
 * @title GLPToken
 * @notice Pool share token with governance checkpoints.
 *         - Borrower and guarantor stake is locked for the life of a loan; `_update` blocks any
 *           transfer or burn that would dip into the locked balance.
 *         - A wallet with an unpaid default claim cannot send or receive GLP ("Debt outstanding");
 *           only the pool may burn it (stake set-off). Once the debt is settled it is free again.
 *         - ERC20Votes (block-number clock): every holder is self-delegated on first receipt, so
 *           voting weight is the balance at a proposal's snapshot block and moving tokens after
 *           the snapshot cannot add weight.
 */
contract GLPToken is ERC20, ERC20Votes, AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant POOL_ROLE = keccak256("POOL_ROLE");     // mint / burn
    bytes32 public constant LOCKER_ROLE = keccak256("LOCKER_ROLE"); // lock / unlock stake

    mapping(address => uint256) public lockedBalance;
    IDebtView public debtView; // LendingPool, set once

    event StakeLocked(address indexed account, uint256 shares, uint256 totalLocked);
    event StakeUnlocked(address indexed account, uint256 shares, uint256 totalLocked);

    constructor(address admin) ERC20("GigLendingPool", "GLP") EIP712("GigLendingPool", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    function setDebtView(address view_) external onlyRole(ADMIN_ROLE) {
        require(address(debtView) == address(0), "Already set");
        debtView = IDebtView(view_);
    }

    function mint(address to, uint256 amount) external onlyRole(POOL_ROLE) {
        _mint(to, amount);
    }

    function burnFrom(address account, uint256 amount) external onlyRole(POOL_ROLE) {
        _burn(account, amount);
    }

    function lock(address account, uint256 shares) external onlyRole(LOCKER_ROLE) {
        require(unlockedBalanceOf(account) >= shares, "Insufficient unlocked GLP");
        lockedBalance[account] += shares;
        emit StakeLocked(account, shares, lockedBalance[account]);
    }

    function unlock(address account, uint256 shares) external onlyRole(LOCKER_ROLE) {
        require(lockedBalance[account] >= shares, "Unlock exceeds locked");
        lockedBalance[account] -= shares;
        emit StakeUnlocked(account, shares, lockedBalance[account]);
    }

    function unlockedBalanceOf(address account) public view returns (uint256) {
        uint256 bal = balanceOf(account);
        uint256 locked = lockedBalance[account];
        return bal > locked ? bal - locked : 0;
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        if (from != address(0) && lockedBalance[from] > 0) {
            require(balanceOf(from) - lockedBalance[from] >= value, "GLP locked");
        }
        // Peer-to-peer transfers only; mints (deposits) and pool burns (set-off) still work.
        if (from != address(0) && to != address(0) && address(debtView) != address(0)) {
            require(!debtView.isDefaulter(from) && !debtView.isDefaulter(to), "Debt outstanding");
        }
        super._update(from, to, value);
        if (to != address(0) && delegates(to) == address(0)) {
            _delegate(to, to);
        }
    }
}
