// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title PolicyConfig
 * @notice Single home for every policy number. Each parameter is a named bytes32 key with
 *         a min/max bound; admin changes are bounds-checked and emit ParameterUpdated.
 *         Production would hold ADMIN_ROLE in a Safe multisig; locally the deployer holds it.
 */
contract PolicyConfig is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    struct Param {
        uint256 value;
        uint256 min;
        uint256 max;
        bool exists;
    }

    mapping(bytes32 => Param) private _params;
    bytes32[] private _keys;

    event ParameterDefined(bytes32 indexed key, uint256 value, uint256 min, uint256 max);
    event ParameterUpdated(bytes32 indexed key, uint256 oldValue, uint256 newValue);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    /**
     * @notice Defines a parameter once with its bounds. Used by the deploy script.
     */
    function defineParam(bytes32 key, uint256 value, uint256 min, uint256 max) public onlyRole(ADMIN_ROLE) {
        require(!_params[key].exists, "Param already defined");
        require(min <= value && value <= max, "Value out of bounds");
        _params[key] = Param(value, min, max, true);
        _keys.push(key);
        emit ParameterDefined(key, value, min, max);
    }

    function defineParams(
        bytes32[] calldata keys_,
        uint256[] calldata values,
        uint256[] calldata mins,
        uint256[] calldata maxs
    ) external onlyRole(ADMIN_ROLE) {
        require(
            keys_.length == values.length && values.length == mins.length && mins.length == maxs.length,
            "Length mismatch"
        );
        for (uint256 i = 0; i < keys_.length; i++) {
            defineParam(keys_[i], values[i], mins[i], maxs[i]);
        }
    }

    /**
     * @notice Bounded admin setter for any defined parameter.
     */
    function setParam(bytes32 key, uint256 value) external onlyRole(ADMIN_ROLE) {
        Param storage p = _params[key];
        require(p.exists, "Unknown param");
        require(value >= p.min && value <= p.max, "Value out of bounds");
        uint256 old = p.value;
        p.value = value;
        emit ParameterUpdated(key, old, value);
    }

    function get(bytes32 key) external view returns (uint256) {
        Param storage p = _params[key];
        require(p.exists, "Unknown param");
        return p.value;
    }

    function bounds(bytes32 key) external view returns (uint256 value, uint256 min, uint256 max) {
        Param storage p = _params[key];
        require(p.exists, "Unknown param");
        return (p.value, p.min, p.max);
    }

    function isDefined(bytes32 key) external view returns (bool) {
        return _params[key].exists;
    }

    function keys() external view returns (bytes32[] memory) {
        return _keys;
    }

    /// @notice Shorthand used by every contract to convert policy days to seconds.
    function secondsPerDay() external view returns (uint256) {
        return _params["secondsPerDay"].value;
    }

    function daysToSeconds(uint256 d) external view returns (uint256) {
        return d * _params["secondsPerDay"].value;
    }
}
