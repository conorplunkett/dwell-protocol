// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AIAD} from "../src/AIAD.sol";

contract AIADTest is Test {
    AIAD internal token;
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        token = new AIAD(treasury);
    }

    function test_fixedSupplyMintedToTreasury() public view {
        assertEq(token.totalSupply(), 1_000_000_000e18);
        assertEq(token.balanceOf(treasury), 1_000_000_000e18);
        assertEq(token.decimals(), 18);
    }

    function test_constructorRejectsZeroTreasury() public {
        vm.expectRevert(bytes("AIAD: treasury is zero"));
        new AIAD(address(0));
    }

    function test_burnReducesTotalSupply() public {
        vm.prank(treasury);
        token.burn(1_000e18);
        assertEq(token.totalSupply(), 1_000_000_000e18 - 1_000e18);
    }

    function test_burnFromRespectsAllowance() public {
        address burner = makeAddr("burner");
        vm.prank(treasury);
        token.approve(burner, 500e18);
        vm.prank(burner);
        token.burnFrom(treasury, 500e18);
        assertEq(token.totalSupply(), 1_000_000_000e18 - 500e18);
        vm.prank(burner);
        vm.expectRevert(); // allowance exhausted
        token.burnFrom(treasury, 1);
    }

    function test_permitRoundTrip() public {
        (address holder, uint256 holderKey) = makeAddrAndKey("holder");
        address spender = makeAddr("spender");
        vm.prank(treasury);
        token.transfer(holder, 100e18);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                holder,
                spender,
                42e18,
                token.nonces(holder),
                deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(holderKey, digest);

        token.permit(holder, spender, 42e18, deadline, v, r, s);
        assertEq(token.allowance(holder, spender), 42e18);

        vm.prank(spender);
        token.transferFrom(holder, spender, 42e18);
        assertEq(token.balanceOf(spender), 42e18);
    }

    function test_noMintFunctionExists() public {
        // Nothing to call — this asserts the invariant the type system enforces:
        // total supply is immutable-down-only. Burn then re-check.
        vm.prank(treasury);
        token.burn(1);
        assertEq(token.totalSupply(), 1_000_000_000e18 - 1);
    }
}
