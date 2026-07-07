// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {DWELL} from "../src/DWELL.sol";
import {IDWELL} from "../src/interfaces/IDWELL.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleRewardsDistributor} from "../src/MerkleRewardsDistributor.sol";
import {CampaignFunder} from "../src/CampaignFunder.sol";

/// Deploys the full DWELL stack in dependency order and wires it together.
///
/// Required env:
///   TREASURY_SAFE  — the issuer multisig; receives the full supply and owns
///                    the Distributor + Funder
///   ROOT_SETTER    — backend ops key allowed to publish Merkle roots
///   KEEPER         — backend ops key allowed to call swapAndFund
///   USDC           — canonical USDC on the target chain
///                    (Base mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
///   SWAP_TARGET    — 0x AllowanceHolder / Exchange Proxy on the target chain
///
/// Run:  forge script script/Deploy.s.sol --rpc-url $BASE_RPC_URL --broadcast
contract Deploy is Script {
    function run() external {
        address treasury = vm.envAddress("TREASURY_SAFE");
        address rootSetter = vm.envAddress("ROOT_SETTER");
        address keeper = vm.envAddress("KEEPER");
        address usdc = vm.envAddress("USDC");
        address swapTarget = vm.envAddress("SWAP_TARGET");

        vm.startBroadcast();

        DWELL dwell = new DWELL(treasury);
        MerkleRewardsDistributor distributor =
            new MerkleRewardsDistributor(IERC20(address(dwell)), treasury, rootSetter);
        CampaignFunder funder = new CampaignFunder(
            IERC20(usdc), IDWELL(address(dwell)), address(distributor), treasury, treasury
        );

        // Ownership is Ownable2Step: the deployer holds nothing after this
        // broadcast except what the Safe must accept — but here owner_ is the
        // Safe from construction, so only operational wiring remains. The Safe
        // must call setSwapTarget/setKeeper post-deploy (or the deployer does
        // it if it is the initial owner in a testnet run).
        console.log("DWELL:        ", address(dwell));
        console.log("Distributor: ", address(distributor));
        console.log("Funder:      ", address(funder));
        console.log("Post-deploy (from the Safe):");
        console.log("  funder.setSwapTarget(", swapTarget, ")");
        console.log("  funder.setKeeper(", keeper, ", true)");

        vm.stopBroadcast();
    }
}
