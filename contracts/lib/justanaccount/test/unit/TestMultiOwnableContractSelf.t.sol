// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import { Test, Vm, console } from "forge-std/Test.sol";

import { DeployJustanAccount } from "../../script/DeployJustanAccount.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { CodeConstants } from "../../script/HelperConfig.s.sol";
import { JustanAccount } from "../../src/JustanAccount.sol";

contract TestMultiOwnableContractSelf is Test, CodeConstants {

    JustanAccount public justanAccount;
    HelperConfig public helperConfig;
    HelperConfig.NetworkConfig public networkConfig;

    function setUp() public {
        DeployJustanAccount deployer = new DeployJustanAccount();
        (justanAccount,, networkConfig) = deployer.run();

        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);
    }

    /*//////////////////////////////////////////////////////////////
                       CONTRACT SELF ACCESS TESTS
    //////////////////////////////////////////////////////////////*/
    function test_ShouldAllowContractSelfToAddOwnerAddress(address owner) public {
        vm.prank(TEST_ACCOUNT_ADDRESS);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner);

        assertTrue(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerAddress(owner));
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerCount(), 1);
    }

    function test_ShouldAllowContractSelfToAddOwnerPublicKey(bytes32 x, bytes32 y) public {
        vm.prank(TEST_ACCOUNT_ADDRESS);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerPublicKey(x, y);

        assertTrue(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerPublicKey(x, y));
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerCount(), 1);
    }

    function test_ShouldAllowContractSelfToRemoveLastOwner(address owner) public {
        vm.prank(TEST_ACCOUNT_ADDRESS);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner);

        vm.prank(TEST_ACCOUNT_ADDRESS);
        JustanAccount(TEST_ACCOUNT_ADDRESS).removeLastOwner(0, abi.encode(owner));

        assertFalse(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerAddress(owner));
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerCount(), 0);
    }

    function test_ShouldAllowContractSelfToRemoveOwnerAtIndex(address owner1, address owner2) public {
        vm.assume(owner1 != address(0));
        vm.assume(owner2 != address(0));
        vm.assume(owner1 != owner2);
        vm.assume(owner1 != TEST_ACCOUNT_ADDRESS);
        vm.assume(owner2 != TEST_ACCOUNT_ADDRESS);

        vm.startPrank(TEST_ACCOUNT_ADDRESS);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner1);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner2);
        vm.stopPrank();

        vm.prank(TEST_ACCOUNT_ADDRESS);
        JustanAccount(TEST_ACCOUNT_ADDRESS).removeOwnerAtIndex(0, abi.encode(owner1));

        assertFalse(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerAddress(owner1));
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerCount(), 1);
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).removedOwnersCount(), 1);
    }

    function test_ShouldAllowBothContractSelfAndOwnerAccess(address owner, bytes32 x, bytes32 y) public {
        vm.assume(owner != TEST_ACCOUNT_ADDRESS);
        vm.assume(owner != address(0));

        vm.prank(TEST_ACCOUNT_ADDRESS);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner);

        vm.prank(owner);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerPublicKey(x, y);

        vm.prank(TEST_ACCOUNT_ADDRESS);
        JustanAccount(TEST_ACCOUNT_ADDRESS).removeOwnerAtIndex(1, abi.encode(x, y));

        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerCount(), 1);
        assertTrue(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerAddress(owner));
        assertFalse(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerPublicKey(x, y));
    }

}
