// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IDWELL} from "./interfaces/IDWELL.sol";

/// @title CampaignFunder — one market buy per paid ad campaign
/// @notice The fiat sweeper deposits USDC here; when a campaign's payment
/// clears, a keeper calls `swapAndFund` with a 0x-quoted route. The received
/// DWELL splits `treasuryBps` (default 30%) to the protocol treasury — with an
/// optional `burnBps` slice burned — and the remainder (the viewer + referrer
/// legs) to the MerkleRewardsDistributor. The emitted `CampaignFunded` event
/// is the onchain source of truth for that campaign's locked token rate
/// (dwellOut ÷ the campaign's impressions, computed offchain).
///
/// The unreferred case (viewer with no referrer, protocol takes 40% not 30%)
/// is settled offchain: the extra 10% stays in the distributor and the backend
/// includes the treasury address as a leaf in the Merkle root for its
/// shortfall, so onchain balances always reconcile exactly.
///
/// Why the arbitrary-calldata swap is safe enough here: (a) only allowlisted
/// keepers can call; (b) only the owner (Safe) can change `swapTarget`;
/// (c) the balance-delta check enforces the keeper-supplied `minDwellOut` from
/// the live quote; (d) approvals are exact and reset to zero after the call;
/// (e) the contract holds only the tranche(s) queued for funding, so worst
/// case is bounded by USDC in flight — never the treasury.
contract CampaignFunder is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    IERC20 public immutable usdc;
    IDWELL public immutable dwell;
    address public immutable distributor;
    address public immutable treasury;

    address public swapTarget;
    uint256 public treasuryBps = 3_000; // protocol's share of each campaign pool
    uint256 public burnBps = 0; // slice of the treasury leg to burn (default: none)
    mapping(address keeper => bool allowed) public keepers;
    mapping(bytes32 campaignId => uint256 dwellOut) public fundedCampaigns;

    uint256 public totalUsdcSpent;
    uint256 public totalDwellToDistributor;
    uint256 public totalDwellToTreasury;
    uint256 public totalDwellBurned;

    event SwapTargetUpdated(address indexed swapTarget);
    event KeeperUpdated(address indexed keeper, bool allowed);
    event SharesUpdated(uint256 treasuryBps, uint256 burnBps);
    event CampaignFunded(
        bytes32 indexed campaignId,
        uint256 usdcIn,
        uint256 dwellOut,
        uint256 toDistributor,
        uint256 toTreasury,
        uint256 burned
    );
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error NotKeeper();
    error SwapTargetUnset();
    error AlreadyFunded(bytes32 campaignId);
    error InsufficientOutput(uint256 got, uint256 min);
    error SwapFailed();
    error RescueBlocked(address token);
    error BadBps();

    modifier onlyKeeper() {
        if (!keepers[msg.sender]) revert NotKeeper();
        _;
    }

    constructor(IERC20 usdc_, IDWELL dwell_, address distributor_, address treasury_, address owner_)
        Ownable(owner_)
    {
        require(address(usdc_) != address(0), "funder: usdc is zero");
        require(address(dwell_) != address(0), "funder: dwell is zero");
        require(distributor_ != address(0), "funder: distributor is zero");
        require(treasury_ != address(0), "funder: treasury is zero");
        usdc = usdc_;
        dwell = dwell_;
        distributor = distributor_;
        treasury = treasury_;
    }

    /// @notice Execute the campaign's market buy and split the proceeds.
    /// @param campaignId  Backend campaign UUID (as bytes32) — one buy per campaign.
    /// @param usdcAmount  The campaign's 90% tranche, already held by this contract.
    /// @param minDwellOut  Floor from the keeper's live 0x quote (slippage guard). Must be > 0.
    /// @param swapCalldata The 0x route to execute against `swapTarget`.
    function swapAndFund(
        bytes32 campaignId,
        uint256 usdcAmount,
        uint256 minDwellOut,
        bytes calldata swapCalldata
    ) external onlyKeeper nonReentrant whenNotPaused {
        if (swapTarget == address(0)) revert SwapTargetUnset();
        if (fundedCampaigns[campaignId] != 0) revert AlreadyFunded(campaignId);
        if (minDwellOut == 0) revert InsufficientOutput(0, 1);

        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 dwellBefore = dwell.balanceOf(address(this));

        usdc.forceApprove(swapTarget, usdcAmount);
        (bool ok,) = swapTarget.call(swapCalldata);
        if (!ok) revert SwapFailed();
        usdc.forceApprove(swapTarget, 0);

        // Trust balances, not return data: measure what actually moved.
        uint256 usdcSpent = usdcBefore - usdc.balanceOf(address(this));
        uint256 dwellOut = dwell.balanceOf(address(this)) - dwellBefore;
        if (dwellOut < minDwellOut) revert InsufficientOutput(dwellOut, minDwellOut);
        if (usdcSpent > usdcAmount) revert SwapFailed(); // route may not raid queued tranches

        uint256 toTreasury = (dwellOut * treasuryBps) / BPS;
        uint256 burned = (toTreasury * burnBps) / BPS;
        uint256 toDistributor = dwellOut - toTreasury;

        fundedCampaigns[campaignId] = dwellOut;
        totalUsdcSpent += usdcSpent;
        totalDwellToDistributor += toDistributor;
        totalDwellToTreasury += toTreasury - burned;
        totalDwellBurned += burned;

        if (burned != 0) dwell.burn(burned);
        if (toTreasury - burned != 0) IERC20(address(dwell)).safeTransfer(treasury, toTreasury - burned);
        IERC20(address(dwell)).safeTransfer(distributor, toDistributor);

        emit CampaignFunded(campaignId, usdcSpent, dwellOut, toDistributor, toTreasury - burned, burned);
    }

    function setSwapTarget(address newSwapTarget) external onlyOwner {
        swapTarget = newSwapTarget;
        emit SwapTargetUpdated(newSwapTarget);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        keepers[keeper] = allowed;
        emit KeeperUpdated(keeper, allowed);
    }

    function setShares(uint256 newTreasuryBps, uint256 newBurnBps) external onlyOwner {
        if (newTreasuryBps > BPS || newBurnBps > BPS) revert BadBps();
        treasuryBps = newTreasuryBps;
        burnBps = newBurnBps;
        emit SharesUpdated(newTreasuryBps, newBurnBps);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover tokens airdropped to this contract by mistake. USDC and
    /// DWELL are deliberately blocked so the owner cannot divert the funding
    /// flow — queued tranches leave only through `swapAndFund`.
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(usdc) || token == address(dwell)) revert RescueBlocked(token);
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }
}
