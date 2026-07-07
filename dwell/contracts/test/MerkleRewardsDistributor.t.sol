// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DWELL} from "../src/DWELL.sol";
import {MerkleRewardsDistributor} from "../src/MerkleRewardsDistributor.sol";

contract MerkleRewardsDistributorTest is Test {
    DWELL internal token;
    MerkleRewardsDistributor internal distributor;

    address internal treasury = makeAddr("treasury");
    address internal owner = makeAddr("owner");
    address internal rootSetter = makeAddr("rootSetter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new DWELL(treasury);
        distributor = new MerkleRewardsDistributor(token, owner, rootSetter);
        vm.prank(treasury);
        token.transfer(address(distributor), 1_000_000e18); // per-epoch funding
    }

    // ── Merkle helpers mirroring the backend's tree construction ──

    function _leaf(address account, uint256 cumulative) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, cumulative))));
    }

    /// Commutative pair hash — identical to OpenZeppelin's MerkleProof ordering.
    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _twoLeafRoot(uint256 aliceCumulative, uint256 bobCumulative)
        internal
        view
        returns (bytes32 root, bytes32[] memory aliceProof, bytes32[] memory bobProof)
    {
        bytes32 la = _leaf(alice, aliceCumulative);
        bytes32 lb = _leaf(bob, bobCumulative);
        root = _hashPair(la, lb);
        aliceProof = new bytes32[](1);
        aliceProof[0] = lb;
        bobProof = new bytes32[](1);
        bobProof[0] = la;
    }

    function _publish(bytes32 root, uint256 epoch) internal {
        vm.prank(rootSetter);
        distributor.setRoot(root, epoch, 0);
    }

    // ── Tests ──

    function test_claimHappyPath() public {
        (bytes32 root, bytes32[] memory proof,) = _twoLeafRoot(100e18, 40e18);
        _publish(root, 1);

        distributor.claim(alice, 100e18, proof); // anyone may execute for alice
        assertEq(token.balanceOf(alice), 100e18);
        assertEq(distributor.claimed(alice), 100e18);
    }

    function test_doubleClaimReverts() public {
        (bytes32 root, bytes32[] memory proof,) = _twoLeafRoot(100e18, 40e18);
        _publish(root, 1);
        distributor.claim(alice, 100e18, proof);

        vm.expectRevert(MerkleRewardsDistributor.NothingToClaim.selector);
        distributor.claim(alice, 100e18, proof);
    }

    function test_cumulativeDeltaAcrossEpochs() public {
        (bytes32 root1, bytes32[] memory proof1,) = _twoLeafRoot(100e18, 40e18);
        _publish(root1, 1);
        distributor.claim(alice, 100e18, proof1);

        // Epoch 2: alice's lifetime total rises to 250; she is owed the delta.
        (bytes32 root2, bytes32[] memory proof2, bytes32[] memory bobProof2) =
            _twoLeafRoot(250e18, 90e18);
        _publish(root2, 2);
        distributor.claim(alice, 250e18, proof2);
        assertEq(token.balanceOf(alice), 250e18);

        // Bob never claimed epoch 1 — one claim self-heals to his full total.
        distributor.claim(bob, 90e18, bobProof2);
        assertEq(token.balanceOf(bob), 90e18);
    }

    function test_staleProofCannotDoublePay() public {
        (bytes32 root1, bytes32[] memory proof1,) = _twoLeafRoot(100e18, 40e18);
        _publish(root1, 1);
        distributor.claim(alice, 100e18, proof1);

        (bytes32 root2,,) = _twoLeafRoot(250e18, 90e18);
        _publish(root2, 2);

        // The old (100e18) proof no longer matches the root; and even a replay
        // of an amount ≤ claimed reverts before any transfer.
        vm.expectRevert(MerkleRewardsDistributor.InvalidProof.selector);
        distributor.claim(alice, 100e18, proof1);
    }

    function test_wrongAmountOrForeignProofReverts() public {
        (bytes32 root, bytes32[] memory aliceProof, bytes32[] memory bobProof) =
            _twoLeafRoot(100e18, 40e18);
        _publish(root, 1);

        vm.expectRevert(MerkleRewardsDistributor.InvalidProof.selector);
        distributor.claim(alice, 101e18, aliceProof); // amount not in tree

        vm.expectRevert(MerkleRewardsDistributor.InvalidProof.selector);
        distributor.claim(alice, 40e18, bobProof); // bob's leaf, alice's address
    }

    function test_epochMustBeSequential() public {
        (bytes32 root,,) = _twoLeafRoot(1e18, 1e18);
        vm.prank(rootSetter);
        vm.expectRevert(
            abi.encodeWithSelector(MerkleRewardsDistributor.EpochNotSequential.selector, 1, 2)
        );
        distributor.setRoot(root, 2, 0);
    }

    function test_onlyRootSetterSetsRoot() public {
        (bytes32 root,,) = _twoLeafRoot(1e18, 1e18);
        vm.prank(alice);
        vm.expectRevert(MerkleRewardsDistributor.NotRootSetter.selector);
        distributor.setRoot(root, 1, 0);
    }

    function test_pauseBlocksClaimsOwnerCannotTakeFunds() public {
        (bytes32 root, bytes32[] memory proof,) = _twoLeafRoot(100e18, 40e18);
        _publish(root, 1);

        vm.prank(owner);
        distributor.pause();
        vm.expectRevert(); // Pausable: EnforcedPause
        distributor.claim(alice, 100e18, proof);

        vm.prank(owner);
        distributor.unpause();
        distributor.claim(alice, 100e18, proof);
        assertEq(token.balanceOf(alice), 100e18);
    }

    function test_ownerRotatesRootSetter() public {
        address newSetter = makeAddr("newSetter");
        vm.prank(owner);
        distributor.setRootSetter(newSetter);

        (bytes32 root,,) = _twoLeafRoot(1e18, 1e18);
        vm.prank(rootSetter);
        vm.expectRevert(MerkleRewardsDistributor.NotRootSetter.selector);
        distributor.setRoot(root, 1, 0);
        vm.prank(newSetter);
        distributor.setRoot(root, 1, 0);
        assertEq(distributor.epoch(), 1);
    }
}
