// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SeasonMerkleDistributor — seasonal airdrop claims with a fixed
/// window and unclaimed-rollover
/// @notice One season is open at a time. The backend snapshots season points,
/// converts them pro-rata into token amounts against the season's fixed pool,
/// and publishes a Merkle root over `(seasonId, account, amount)` leaves
/// (double-hashed per OZ guidance). Claims are accepted until the season's
/// `claimDeadline` (policy: 3 months after open). After the deadline anyone
/// may `closeSeason`, which rolls the unclaimed remainder into `carryover`;
/// the next `startSeason` folds carryover into its pool. Unclaimed tokens
/// therefore stay inside the community program by construction — they are
/// never silently returned to the treasury.
///
/// Funding is by plain transfer: the treasury Safe sends the season's new
/// funding to this contract, then the root setter opens the season;
/// `startSeason` requires the contract balance to cover the full pool.
/// The root setter MUST publish a root whose leaf amounts sum to exactly the
/// season pool — the contract cannot verify this, so `SeasonStarted` carries
/// the pool for offchain reconciliation and per-season funding caps the blast
/// radius of a compromised root setter at one season's pool.
///
/// Roles: `owner` (treasury Safe) can pause claims, rotate the root setter,
/// and — only while no season is open — sweep carryover for program
/// wind-down. It can never touch an open season's pool. `rootSetter` (a
/// backend ops key, rotatable by the owner) can only open the next season.
/// A bad root is recoverable without new privileges: pause, let the window
/// lapse, close, and correct entitlements in the next season's root.
/// Anyone may execute a claim FOR an account (gas sponsorship), but tokens
/// only ever move TO the entitled account.
contract SeasonMerkleDistributor is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Season {
        bytes32 root;
        uint64 claimDeadline;
        uint256 pool; // new funding + carryover at open
        uint256 claimedTotal;
        bool closed;
    }

    IERC20 public immutable token;
    address public rootSetter;

    /// @notice Seasons are 1-indexed; `seasons[seasonCount]` is the latest.
    uint256 public seasonCount;
    mapping(uint256 seasonId => Season) public seasons;
    mapping(uint256 seasonId => mapping(address account => bool)) public claimed;

    /// @notice Unclaimed tokens from closed seasons, awaiting the next pool.
    uint256 public carryover;

    event SeasonStarted(uint256 indexed seasonId, bytes32 root, uint256 pool, uint64 claimDeadline);
    event Claimed(uint256 indexed seasonId, address indexed account, uint256 amount);
    event SeasonClosed(uint256 indexed seasonId, uint256 unclaimed);
    event RootSetterUpdated(address indexed rootSetter);
    event CarryoverSwept(address indexed to, uint256 amount);

    error NotRootSetter();
    error PreviousSeasonOpen();
    error UnknownSeason();
    error ClaimWindowClosed();
    error AlreadyClaimed();
    error InvalidProof();
    error SeasonStillOpen();
    error AlreadyClosed();

    constructor(IERC20 token_, address owner_, address rootSetter_) Ownable(owner_) {
        require(address(token_) != address(0), "distributor: token is zero");
        require(rootSetter_ != address(0), "distributor: rootSetter is zero");
        token = token_;
        rootSetter = rootSetter_;
    }

    function setRootSetter(address rootSetter_) external onlyOwner {
        require(rootSetter_ != address(0), "distributor: rootSetter is zero");
        rootSetter = rootSetter_;
        emit RootSetterUpdated(rootSetter_);
    }

    /// @notice Open the next season. The previous season must be closed and
    /// the contract must already hold the full pool (carryover stayed here;
    /// the treasury tops up `newFunding` by direct transfer beforehand).
    function startSeason(bytes32 root, uint256 newFunding, uint64 claimDeadline) external {
        if (msg.sender != rootSetter) revert NotRootSetter();
        if (seasonCount != 0 && !seasons[seasonCount].closed) revert PreviousSeasonOpen();
        require(root != bytes32(0), "distributor: empty root");
        require(claimDeadline > block.timestamp, "distributor: deadline in past");

        uint256 pool = newFunding + carryover;
        carryover = 0;
        require(token.balanceOf(address(this)) >= pool, "distributor: underfunded");

        uint256 seasonId = ++seasonCount;
        seasons[seasonId] =
            Season({root: root, claimDeadline: claimDeadline, pool: pool, claimedTotal: 0, closed: false});
        emit SeasonStarted(seasonId, root, pool, claimDeadline);
    }

    /// @notice Claim `account`'s allocation for `seasonId`. Callable by anyone
    /// on the account's behalf; funds always go to `account`.
    function claim(uint256 seasonId, address account, uint256 amount, bytes32[] calldata proof)
        external
        nonReentrant
        whenNotPaused
    {
        if (seasonId == 0 || seasonId > seasonCount) revert UnknownSeason();
        Season storage s = seasons[seasonId];
        if (s.closed || block.timestamp > s.claimDeadline) revert ClaimWindowClosed();
        if (claimed[seasonId][account]) revert AlreadyClaimed();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(seasonId, account, amount))));
        if (!MerkleProof.verify(proof, s.root, leaf)) revert InvalidProof();

        claimed[seasonId][account] = true;
        s.claimedTotal += amount;
        token.safeTransfer(account, amount);
        emit Claimed(seasonId, account, amount);
    }

    /// @notice After the deadline anyone may close the season; the unclaimed
    /// remainder rolls into `carryover` for the next season's pool.
    function closeSeason(uint256 seasonId) external {
        if (seasonId == 0 || seasonId > seasonCount) revert UnknownSeason();
        Season storage s = seasons[seasonId];
        if (s.closed) revert AlreadyClosed();
        if (block.timestamp <= s.claimDeadline) revert SeasonStillOpen();

        s.closed = true;
        uint256 unclaimed = s.pool - s.claimedTotal;
        carryover += unclaimed;
        emit SeasonClosed(seasonId, unclaimed);
    }

    /// @notice Program wind-down only: return accumulated carryover to the
    /// treasury. Blocked while any season is open, so an open season's pool
    /// can never be pulled out from under claimants.
    function sweepCarryover(address to) external onlyOwner {
        if (seasonCount != 0 && !seasons[seasonCount].closed) revert PreviousSeasonOpen();
        uint256 amount = carryover;
        carryover = 0;
        token.safeTransfer(to, amount);
        emit CarryoverSwept(to, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
