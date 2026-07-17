// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DWELL} from "../src/DWELL.sol";
import {SeasonMerkleDistributor} from "../src/SeasonMerkleDistributor.sol";
import {CliffVestingWallet} from "../src/CliffVestingWallet.sol";

/// Deploys the Robinhood Chain launch stack: token, season distributor, and
/// one team vesting wallet. The full supply mints to the treasury Safe; every
/// allocation move after that (vesting top-ups, season funding, LP seed,
/// ecosystem transfers) is an explicit Safe transaction recorded in
/// ../LAUNCH-PLAN.md, so the distribution is auditable from chain history.
///
/// Required env:
///   TREASURY_SAFE     — issuer multisig; receives the full 1B supply and owns
///                       the distributor
///   ROOT_SETTER       — backend ops key allowed to open seasons
///   TEAM_BENEFICIARY  — team member receiving the vesting wallet (deploy one
///                       wallet per member; re-run with each beneficiary)
///   TGE_TIMESTAMP     — vesting start (unix seconds); cliff = 12 months and
///                       duration = 36 months from this moment
///
/// Run:  forge script script/Deploy.s.sol --rpc-url $ROBINHOOD_CHAIN_RPC_URL --broadcast
contract Deploy is Script {
    uint64 internal constant VESTING_DURATION = 36 * 30 days;
    uint64 internal constant VESTING_CLIFF = 12 * 30 days;

    function run() external {
        address treasury = vm.envAddress("TREASURY_SAFE");
        address rootSetter = vm.envAddress("ROOT_SETTER");
        address teamBeneficiary = vm.envAddress("TEAM_BENEFICIARY");
        uint64 tge = uint64(vm.envUint("TGE_TIMESTAMP"));

        vm.startBroadcast();

        DWELL dwell = new DWELL(treasury);
        SeasonMerkleDistributor distributor =
            new SeasonMerkleDistributor(IERC20(address(dwell)), treasury, rootSetter);
        CliffVestingWallet teamVesting =
            new CliffVestingWallet(teamBeneficiary, tge, VESTING_DURATION, VESTING_CLIFF);

        console.log("DWELL:        ", address(dwell));
        console.log("Distributor:  ", address(distributor));
        console.log("TeamVesting:  ", address(teamVesting));
        console.log("Post-deploy (from the Safe):");
        console.log("  transfer team allocation to the vesting wallet(s)");
        console.log("  transfer season 1 pool to the distributor, then rootSetter.startSeason(...)");
        console.log("  seed + lock the Uniswap pool per ../LAUNCH-PLAN.md");

        vm.stopBroadcast();
    }
}
