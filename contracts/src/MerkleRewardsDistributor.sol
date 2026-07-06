// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MerkleRewardsDistributor — cumulative Merkle claims for DWELL rewards
/// @notice The backend accrues each user's DWELL entitlement offchain (at the
/// campaign-locked rate) and periodically publishes a Merkle root over leaves
/// of `(account, cumulativeAmount)` — LIFETIME totals, not per-epoch deltas.
/// A claim pays `cumulativeAmount - claimed[account]`, so:
///   - a stale proof can never double-pay (claimed[] is monotone);
///   - a user who skips epochs self-heals at the next claim;
///   - a bad root is recoverable: pause, publish a corrected root at the next
///     epoch, unpause — no per-user cleanup.
///
/// Roles: `owner` (the treasury Safe) can pause and rotate the root setter but
/// cannot move funds; `rootSetter` (a backend ops key) can only advance the
/// root by exactly one epoch. Fund the contract per-epoch rather than in bulk
/// so a compromised root setter's blast radius is capped at the current
/// balance. Anyone may execute a claim FOR an account (gas sponsorship), but
/// tokens only ever move TO the entitled account.
contract MerkleRewardsDistributor is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable dwell;

    bytes32 public merkleRoot;
    uint256 public epoch;
    address public rootSetter;
    mapping(address account => uint256 cumulative) public claimed;

    event RootUpdated(uint256 indexed epoch, bytes32 root, uint256 totalNewlyAllocated);
    event RootSetterUpdated(address indexed rootSetter);
    event Claimed(address indexed account, uint256 amount, uint256 cumulativeAmount);

    error NotRootSetter();
    error EpochNotSequential(uint256 expected, uint256 got);
    error InvalidProof();
    error NothingToClaim();

    constructor(IERC20 dwell_, address owner_, address rootSetter_) Ownable(owner_) {
        require(address(dwell_) != address(0), "distributor: dwell is zero");
        require(rootSetter_ != address(0), "distributor: rootSetter is zero");
        dwell = dwell_;
        rootSetter = rootSetter_;
    }

    /// @notice Advance to the next epoch's cumulative root. `totalNewlyAllocated`
    /// is event-only telemetry for offchain reconciliation (sum of this epoch's
    /// new entitlements); the contract does not act on it.
    function setRoot(bytes32 newRoot, uint256 newEpoch, uint256 totalNewlyAllocated) external {
        if (msg.sender != rootSetter) revert NotRootSetter();
        if (newEpoch != epoch + 1) revert EpochNotSequential(epoch + 1, newEpoch);
        merkleRoot = newRoot;
        epoch = newEpoch;
        emit RootUpdated(newEpoch, newRoot, totalNewlyAllocated);
    }

    /// @notice Claim the difference between `cumulativeAmount` (as committed in
    /// the current root) and what `account` has already claimed. Leaves are
    /// double-hashed per OpenZeppelin guidance to rule out second-preimage
    /// tricks with intermediate nodes.
    function claim(address account, uint256 cumulativeAmount, bytes32[] calldata proof)
        external
        nonReentrant
        whenNotPaused
    {
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumulativeAmount))));
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf)) revert InvalidProof();

        uint256 alreadyClaimed = claimed[account];
        if (cumulativeAmount <= alreadyClaimed) revert NothingToClaim();
        uint256 owed = cumulativeAmount - alreadyClaimed;

        claimed[account] = cumulativeAmount;
        dwell.safeTransfer(account, owed);
        emit Claimed(account, owed, cumulativeAmount);
    }

    function setRootSetter(address newRootSetter) external onlyOwner {
        require(newRootSetter != address(0), "distributor: rootSetter is zero");
        rootSetter = newRootSetter;
        emit RootSetterUpdated(newRootSetter);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
