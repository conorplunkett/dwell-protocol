// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSDC — 6-decimal mintable stand-in for USDC, TESTNET ONLY.
/// @notice Lives under test/ so it can never be part of a production build.
/// Anyone can mint; the Base Sepolia dry-run's fiat-sweeper stand-in mints
/// each campaign's 90% tranche directly to the CampaignFunder
/// (docs/08-testnet-dry-run.md, T9).
contract TestUSDC is ERC20 {
    constructor() ERC20("Test USDC", "tUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
