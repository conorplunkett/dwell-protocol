// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The DWELL token as its consumers see it: plain ERC-20 plus the
/// ERC20Burnable entry points. No mint function exists anywhere — supply can
/// only decrease.
interface IDWELL is IERC20 {
    function burn(uint256 value) external;
    function burnFrom(address account, uint256 value) external;
}
