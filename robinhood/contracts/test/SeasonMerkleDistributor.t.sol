// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DWELL} from "../src/DWELL.sol";
import {SeasonMerkleDistributor} from "../src/SeasonMerkleDistributor.sol";

contract SeasonMerkleDistributorTest is Test {
    DWELL internal token;
    SeasonMerkleDistributor internal distributor;

    address internal treasury = makeAddr("treasury");
    address internal owner = makeAddr("owner");
    address internal rootSetter = makeAddr("rootSetter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant POOL = 60_000_000e18; // one season = 6% of 1B
    uint64 internal constant WINDOW = 90 days;

    function setUp() public {
        token = new DWELL(treasury);
        distributor = new SeasonMerkleDistributor(IERC20(address(token)), owner, rootSetter);
    }

    // ── Merkle helpers mirroring the backend's tree construction ──

    function _leaf(uint256 seasonId, address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(seasonId, account, amount))));
    }

    /// Commutative pair hash — identical to OpenZeppelin's MerkleProof ordering.
    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _twoLeafRoot(uint256 seasonId, uint256 aliceAmount, uint256 bobAmount)
        internal
        view
        returns (bytes32 root, bytes32[] memory aliceProof, bytes32[] memory bobProof)
    {
        bytes32 la = _leaf(seasonId, alice, aliceAmount);
        bytes32 lb = _leaf(seasonId, bob, bobAmount);
        root = _hashPair(la, lb);
        aliceProof = new bytes32[](1);
        aliceProof[0] = lb;
        bobProof = new bytes32[](1);
        bobProof[0] = la;
    }

    function _fundAndStart(bytes32 root, uint256 pool) internal {
        vm.prank(treasury);
        token.transfer(address(distributor), pool);
        vm.prank(rootSetter);
        distributor.startSeason(root, pool, uint64(block.timestamp) + WINDOW);
    }

    // ── startSeason ──

    function test_startSeason_requiresRootSetter() public {
        vm.expectRevert(SeasonMerkleDistributor.NotRootSetter.selector);
        distributor.startSeason(bytes32(uint256(1)), 0, uint64(block.timestamp) + 1);
    }

    function test_startSeason_requiresFunding() public {
        vm.prank(rootSetter);
        vm.expectRevert(bytes("distributor: underfunded"));
        distributor.startSeason(bytes32(uint256(1)), POOL, uint64(block.timestamp) + WINDOW);
    }

    function test_startSeason_requiresPreviousClosed() public {
        (bytes32 root,,) = _twoLeafRoot(1, 1e18, 2e18);
        _fundAndStart(root, POOL);
        vm.prank(rootSetter);
        vm.expectRevert(SeasonMerkleDistributor.PreviousSeasonOpen.selector);
        distributor.startSeason(root, 0, uint64(block.timestamp) + WINDOW);
    }

    // ── claim ──

    function test_claim_paysAndBlocksDoubleClaim() public {
        (bytes32 root, bytes32[] memory aliceProof,) = _twoLeafRoot(1, 100e18, POOL - 100e18);
        _fundAndStart(root, POOL);

        distributor.claim(1, alice, 100e18, aliceProof);
        assertEq(token.balanceOf(alice), 100e18);

        vm.expectRevert(SeasonMerkleDistributor.AlreadyClaimed.selector);
        distributor.claim(1, alice, 100e18, aliceProof);
    }

    function test_claim_rejectsWrongAmountProof() public {
        (bytes32 root, bytes32[] memory aliceProof,) = _twoLeafRoot(1, 100e18, POOL - 100e18);
        _fundAndStart(root, POOL);
        vm.expectRevert(SeasonMerkleDistributor.InvalidProof.selector);
        distributor.claim(1, alice, 200e18, aliceProof);
    }

    function test_claim_rejectsAfterDeadline() public {
        (bytes32 root, bytes32[] memory aliceProof,) = _twoLeafRoot(1, 100e18, POOL - 100e18);
        _fundAndStart(root, POOL);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(SeasonMerkleDistributor.ClaimWindowClosed.selector);
        distributor.claim(1, alice, 100e18, aliceProof);
    }

    function test_claim_pausable() public {
        (bytes32 root, bytes32[] memory aliceProof,) = _twoLeafRoot(1, 100e18, POOL - 100e18);
        _fundAndStart(root, POOL);
        vm.prank(owner);
        distributor.pause();
        vm.expectRevert();
        distributor.claim(1, alice, 100e18, aliceProof);
    }

    // ── rollover ──

    function test_close_rollsUnclaimedIntoNextSeason() public {
        (bytes32 root, bytes32[] memory aliceProof,) = _twoLeafRoot(1, 100e18, POOL - 100e18);
        _fundAndStart(root, POOL);
        distributor.claim(1, alice, 100e18, aliceProof);

        vm.expectRevert(SeasonMerkleDistributor.SeasonStillOpen.selector);
        distributor.closeSeason(1);

        vm.warp(block.timestamp + WINDOW + 1);
        distributor.closeSeason(1);
        assertEq(distributor.carryover(), POOL - 100e18);

        // Season 2's pool = fresh funding + carryover; only the fresh funding
        // needs a new transfer because the carryover never left the contract.
        (bytes32 root2,,) = _twoLeafRoot(2, 1e18, 2e18);
        vm.prank(treasury);
        token.transfer(address(distributor), POOL);
        vm.prank(rootSetter);
        distributor.startSeason(root2, POOL, uint64(block.timestamp) + WINDOW);

        (,, uint256 pool2,,) = distributor.seasons(2);
        assertEq(pool2, POOL + (POOL - 100e18));
        assertEq(distributor.carryover(), 0);
    }

    function test_close_onlyOnceAndOnlyKnownSeasons() public {
        (bytes32 root,,) = _twoLeafRoot(1, 1e18, 2e18);
        _fundAndStart(root, POOL);
        vm.warp(block.timestamp + WINDOW + 1);
        distributor.closeSeason(1);
        vm.expectRevert(SeasonMerkleDistributor.AlreadyClosed.selector);
        distributor.closeSeason(1);
        vm.expectRevert(SeasonMerkleDistributor.UnknownSeason.selector);
        distributor.closeSeason(2);
    }

    // ── sweep ──

    function test_sweep_onlyOwnerOnlyBetweenSeasons() public {
        (bytes32 root,,) = _twoLeafRoot(1, 1e18, 2e18);
        _fundAndStart(root, POOL);

        vm.prank(owner);
        vm.expectRevert(SeasonMerkleDistributor.PreviousSeasonOpen.selector);
        distributor.sweepCarryover(treasury);

        vm.warp(block.timestamp + WINDOW + 1);
        distributor.closeSeason(1);

        vm.expectRevert(); // not owner
        distributor.sweepCarryover(treasury);

        uint256 before = token.balanceOf(treasury);
        vm.prank(owner);
        distributor.sweepCarryover(treasury);
        assertEq(token.balanceOf(treasury) - before, POOL);
        assertEq(distributor.carryover(), 0);
    }
}
