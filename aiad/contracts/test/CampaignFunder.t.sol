// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AIAD} from "../src/AIAD.sol";
import {IAIAD} from "../src/interfaces/IAIAD.sol";
import {CampaignFunder} from "../src/CampaignFunder.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Stands in for the 0x router: pulls the approved USDC and pays out a
/// preconfigured amount of AIAD. `payout`/`pull` are set per test to model
/// good routes, slippage, and hostile routes that overdraw.
contract MockSwapTarget {
    IERC20 public immutable usdc;
    IERC20 public immutable aiad;
    uint256 public payout;
    uint256 public pull;

    constructor(IERC20 usdc_, IERC20 aiad_) {
        usdc = usdc_;
        aiad = aiad_;
    }

    function setBehavior(uint256 pull_, uint256 payout_) external {
        pull = pull_;
        payout = payout_;
    }

    function swap() external {
        usdc.transferFrom(msg.sender, address(this), pull);
        aiad.transfer(msg.sender, payout);
    }
}

contract CampaignFunderTest is Test {
    MockUSDC internal usdc;
    AIAD internal aiad;
    MockSwapTarget internal swapTarget;
    CampaignFunder internal funder;

    address internal treasury = makeAddr("treasury");
    address internal distributor = makeAddr("distributor");
    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");

    bytes32 internal constant CAMPAIGN = keccak256("campaign-1");
    uint256 internal constant TRANCHE = 90e6; // $90 USDC

    function setUp() public {
        usdc = new MockUSDC();
        aiad = new AIAD(treasury);
        funder = new CampaignFunder(usdc, IAIAD(address(aiad)), distributor, treasury, owner);
        swapTarget = new MockSwapTarget(usdc, aiad);

        vm.startPrank(owner);
        funder.setSwapTarget(address(swapTarget));
        funder.setKeeper(keeper, true);
        vm.stopPrank();

        vm.prank(treasury);
        aiad.transfer(address(swapTarget), 10_000_000e18); // router liquidity
        usdc.mint(address(funder), TRANCHE); // sweeper deposited the tranche
    }

    function _swapCalldata() internal pure returns (bytes memory) {
        return abi.encodeCall(MockSwapTarget.swap, ());
    }

    function _fund(uint256 pull, uint256 payout, uint256 minOut) internal {
        swapTarget.setBehavior(pull, payout);
        vm.prank(keeper);
        funder.swapAndFund(CAMPAIGN, TRANCHE, minOut, _swapCalldata());
    }

    function test_splitsSixtyFiveThirtyFive() public {
        _fund(TRANCHE, 45_000e18, 45_000e18); // $90 at $0.002 → 45,000 AIAD

        assertEq(aiad.balanceOf(distributor), 29_250e18); // 65%
        assertEq(aiad.balanceOf(treasury) - (1_000_000_000e18 - 10_000_000e18), 15_750e18); // 35%
        assertEq(funder.fundedCampaigns(CAMPAIGN), 45_000e18);
        assertEq(funder.totalUsdcSpent(), TRANCHE);
        assertEq(funder.totalAiadBurned(), 0);
        // approvals reset
        assertEq(usdc.allowance(address(funder), address(swapTarget)), 0);
    }

    function test_burnBpsBurnsTreasurySlice() public {
        vm.prank(owner);
        funder.setShares(3_500, 2_000); // burn 20% of the treasury leg
        uint256 supplyBefore = aiad.totalSupply();

        _fund(TRANCHE, 45_000e18, 45_000e18);

        uint256 expectedBurn = (15_750e18 * 2_000) / 10_000;
        assertEq(aiad.totalSupply(), supplyBefore - expectedBurn);
        assertEq(funder.totalAiadBurned(), expectedBurn);
        assertEq(aiad.balanceOf(distributor), 29_250e18); // distributor leg untouched
    }

    function test_slippageGuard() public {
        swapTarget.setBehavior(TRANCHE, 40_000e18); // route returns less than quoted
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                CampaignFunder.InsufficientOutput.selector, 40_000e18, 45_000e18
            )
        );
        funder.swapAndFund(CAMPAIGN, TRANCHE, 45_000e18, _swapCalldata());
    }

    function test_zeroMinOutRejected() public {
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(CampaignFunder.InsufficientOutput.selector, 0, 1)
        );
        funder.swapAndFund(CAMPAIGN, TRANCHE, 0, _swapCalldata());
    }

    function test_routeCannotOverdrawQueuedTranches() public {
        usdc.mint(address(funder), 500e6); // another campaign's tranche queued
        swapTarget.setBehavior(TRANCHE + 500e6, 45_000e18); // hostile route pulls extra
        // The exact-amount approval makes the overdraw revert inside the router
        // call; the guard surfaces it as SwapFailed.
        vm.prank(keeper);
        vm.expectRevert(CampaignFunder.SwapFailed.selector);
        funder.swapAndFund(CAMPAIGN, TRANCHE, 45_000e18, _swapCalldata());
    }

    function test_onlyKeeper() public {
        swapTarget.setBehavior(TRANCHE, 45_000e18);
        vm.expectRevert(CampaignFunder.NotKeeper.selector);
        funder.swapAndFund(CAMPAIGN, TRANCHE, 45_000e18, _swapCalldata());
    }

    function test_campaignFundsOnlyOnce() public {
        _fund(TRANCHE, 45_000e18, 45_000e18);
        usdc.mint(address(funder), TRANCHE);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CampaignFunder.AlreadyFunded.selector, CAMPAIGN));
        funder.swapAndFund(CAMPAIGN, TRANCHE, 45_000e18, _swapCalldata());
    }

    function test_pauseBlocksFunding() public {
        vm.prank(owner);
        funder.pause();
        swapTarget.setBehavior(TRANCHE, 45_000e18);
        vm.prank(keeper);
        vm.expectRevert(); // Pausable: EnforcedPause
        funder.swapAndFund(CAMPAIGN, TRANCHE, 45_000e18, _swapCalldata());
    }

    function test_rescueBlocklistsFlowTokens() public {
        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(CampaignFunder.RescueBlocked.selector, address(usdc))
        );
        funder.rescue(address(usdc), owner, 1);
        vm.expectRevert(
            abi.encodeWithSelector(CampaignFunder.RescueBlocked.selector, address(aiad))
        );
        funder.rescue(address(aiad), owner, 1);
        vm.stopPrank();

        // Airdropped junk is recoverable.
        MockUSDC junk = new MockUSDC();
        junk.mint(address(funder), 123e6);
        vm.prank(owner);
        funder.rescue(address(junk), owner, 123e6);
        assertEq(junk.balanceOf(owner), 123e6);
    }

    function test_sharesBpsBounds() public {
        vm.prank(owner);
        vm.expectRevert(CampaignFunder.BadBps.selector);
        funder.setShares(10_001, 0);
    }
}
