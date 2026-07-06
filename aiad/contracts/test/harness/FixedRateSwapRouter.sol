// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title FixedRateSwapRouter — TESTNET-ONLY swap target for the dry run.
/// @notice Stands in for the 0x route on Base Sepolia, where no AIAD
/// liquidity exists (docs/08-testnet-dry-run.md, Stage 2). Pulls the exact
/// approved USDC from the caller and pays out AIAD from its own balance at a
/// fixed owner-set rate. Exercises every property CampaignFunder.swapAndFund
/// guards: arbitrary calldata against an owner-set target, exact approval,
/// balance-delta measurement, and the minAiadOut slippage floor (set `rate`
/// low to rehearse an InsufficientOutput revert).
contract FixedRateSwapRouter {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    IERC20 public immutable aiad;
    address public immutable owner;

    /// AIAD wei paid per 1.0 USDC (1e6 units) swapped in.
    uint256 public rate;

    event Swapped(address indexed caller, uint256 usdcIn, uint256 aiadOut);
    event RateUpdated(uint256 rate);

    error NotOwner();

    constructor(IERC20 usdc_, IERC20 aiad_, uint256 rate_) {
        usdc = usdc_;
        aiad = aiad_;
        owner = msg.sender;
        rate = rate_;
    }

    function setRate(uint256 newRate) external {
        if (msg.sender != owner) revert NotOwner();
        rate = newRate;
        emit RateUpdated(newRate);
    }

    function swap(uint256 usdcIn) external returns (uint256 aiadOut) {
        usdc.safeTransferFrom(msg.sender, address(this), usdcIn);
        aiadOut = (usdcIn * rate) / 1e6;
        aiad.safeTransfer(msg.sender, aiadOut);
        emit Swapped(msg.sender, usdcIn, aiadOut);
    }
}
