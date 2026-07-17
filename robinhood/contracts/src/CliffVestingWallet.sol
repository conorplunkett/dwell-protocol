// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";

/// @title CliffVestingWallet — team vesting: cliff + linear release
/// @notice Concrete instantiation of OpenZeppelin's abstract
/// `VestingWalletCliff`; this file adds only the constructor. One wallet is
/// deployed per team member; the beneficiary is the wallet's owner and the
/// only party who benefits from `release()`. Launch policy: 12-month cliff,
/// 36-month total duration, `start` = TGE. Tokens are simply transferred to
/// the wallet after deploy — nothing vests early because `releasable()`
/// follows the schedule regardless of when funds arrive.
contract CliffVestingWallet is VestingWalletCliff {
    constructor(address beneficiary, uint64 startTimestamp, uint64 durationSeconds, uint64 cliffSeconds)
        VestingWallet(beneficiary, startTimestamp, durationSeconds)
        VestingWalletCliff(cliffSeconds)
    {}
}
