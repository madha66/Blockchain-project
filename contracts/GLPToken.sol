// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title GLPToken
 * @notice Pool share token. Borrower and guarantor stake is locked for the life of a loan;
 *         `_update` blocks any transfer or burn that would dip into the locked balance, so the
 *         stake really is there when the default waterfall needs it.
 */
contract GLPToken is ERC20, AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant POOL_ROLE = keccak256("POOL_ROLE");     // mint / burn
    bytes32 public constant LOCKER_ROLE = keccak256("LOCKER_ROLE"); // lock / unlock stake

    mapping(address => uint256) public lockedBalance;

    event StakeLocked(address indexed account, uint256 shares, uint256 totalLocked);
    event StakeUnlocked(address indexed account, uint256 shares, uint256 totalLocked);

    constructor(address admin) ERC20("GigLendingPool", "GLP") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
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

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && lockedBalance[from] > 0) {
            require(balanceOf(from) - lockedBalance[from] >= value, "GLP locked");
        }
        super._update(from, to, value);
    }
}
