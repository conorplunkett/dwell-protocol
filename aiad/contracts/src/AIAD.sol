// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title AIAD — the attention-ad token
/// @notice Deliberately boring by design: a fixed-supply ERC-20 with EIP-2612
/// permit and holder-initiated burn. The full 1B supply is minted once, in the
/// constructor, to the issuer treasury (a multisig Safe). There is no mint
/// function, no owner, no pause, no transfer hooks, and no fees — so routers,
/// exchanges, and integrators get exactly the ERC-20 they expect, and supply
/// can only ever go down.
///
/// Every line of token logic is inherited unmodified from OpenZeppelin
/// Contracts v5 (pinned in lib/openzeppelin-contracts); this file adds only
/// the constructor mint.
contract AIAD is ERC20, ERC20Burnable, ERC20Permit {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    constructor(address treasury) ERC20("AIAD", "AIAD") ERC20Permit("AIAD") {
        require(treasury != address(0), "AIAD: treasury is zero");
        _mint(treasury, TOTAL_SUPPLY);
    }
}
