// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import { Test, Vm, console } from "forge-std/Test.sol";

import { DeployJustanAccount } from "../../script/DeployJustanAccount.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { CodeConstants } from "../../script/HelperConfig.s.sol";
import { JustanAccount } from "../../src/JustanAccount.sol";
import { MultiOwnable } from "../../src/MultiOwnable.sol";

contract TestMultiOwnableWithOwners is Test, CodeConstants {

    JustanAccount public justanAccount;
    HelperConfig public helperConfig;
    HelperConfig.NetworkConfig public networkConfig;

    address public INITIAL_OWNER;
    uint256 public INITIAL_OWNER_PK;

    function setUp() public {
        DeployJustanAccount deployer = new DeployJustanAccount();
        (justanAccount,, networkConfig) = deployer.run();

        (INITIAL_OWNER, INITIAL_OWNER_PK) = makeAddrAndKey("INITIAL_OWNER");

        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);

        vm.prank(TEST_ACCOUNT_ADDRESS);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(INITIAL_OWNER);
    }

    /*//////////////////////////////////////////////////////////////
                        INITIAL OWNERSHIP CHECK TESTS
    //////////////////////////////////////////////////////////////*/
    function test_ShouldReturnTrueForOwnerAddress() public view {
        assertTrue(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerAddress(INITIAL_OWNER));
    }

    function test_ShouldReturnFalseForNonOwnerAddress(address nonOwner) public view {
        vm.assume(nonOwner != INITIAL_OWNER);

        assertFalse(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerAddress(nonOwner));
    }

    function test_ShouldReturnTrueForOwnerPublicKey(bytes32 x, bytes32 y) public {
        vm.prank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerPublicKey(x, y);

        assertTrue(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerPublicKey(x, y));
    }

    function test_ShouldReturnFalseForNonOwnerPublicKey(bytes32 x, bytes32 y) public view {
        assertFalse(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerPublicKey(x, y));
    }

    function test_ShouldReturnTrueForOwnerBytes() public view {
        assertTrue(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerBytes(abi.encode(INITIAL_OWNER)));
    }

    function test_ShouldReturnFalseForNonOwnerBytes(address nonOwner) public view {
        vm.assume(nonOwner != INITIAL_OWNER);

        assertFalse(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerBytes(abi.encode(nonOwner)));
    }

    function test_ShouldReturnCorrectOwnerAtIndex() public view {
        bytes memory ownerBytes = JustanAccount(TEST_ACCOUNT_ADDRESS).ownerAtIndex(0);
        assertEq(ownerBytes, abi.encode(INITIAL_OWNER));
    }

    function test_ShouldReturnEmptyBytesForEmptyIndex() public view {
        bytes memory ownerBytes = JustanAccount(TEST_ACCOUNT_ADDRESS).ownerAtIndex(5);
        assertEq(ownerBytes.length, 0);
    }

    function test_ShouldReturnCorrectNextOwnerIndex() public view {
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).nextOwnerIndex(), 1);
    }

    function test_ShouldReturnCorrectOwnerCount() public view {
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerCount(), 1);
    }

    function test_ShouldReturnZeroRemovedOwnersCount() public view {
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).removedOwnersCount(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                        ADD OWNER ADDRESS TESTS
    //////////////////////////////////////////////////////////////*/
    function test_ShouldAddOwnerAddressCorrectly(address owner) public {
        vm.assume(owner != INITIAL_OWNER);
        vm.assume(owner != address(0));

        vm.expectEmit(true, false, false, false, TEST_ACCOUNT_ADDRESS);
        emit MultiOwnable.AddOwner(1, abi.encode(owner));

        vm.prank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner);

        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerCount(), 2);
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).nextOwnerIndex(), 2);
        assertTrue(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerAddress(owner));
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerAtIndex(1), abi.encode(owner));
    }

    function test_ThrowErrorIfAddingDuplicateOwnerAddress() public {
        vm.prank(INITIAL_OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(MultiOwnable.MultiOwnable_AlreadyOwner.selector, abi.encode(INITIAL_OWNER))
        );
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(INITIAL_OWNER);
    }

    function test_ThrowErrorIfNonOwnerAddsOwnerAddress(address nonOwner) public {
        vm.assume(nonOwner != INITIAL_OWNER);
        vm.assume(nonOwner != address(0));
        vm.assume(nonOwner != TEST_ACCOUNT_ADDRESS);
        vm.assume(nonOwner != address(networkConfig.entryPointAddress));

        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(MultiOwnable.MultiOwnable_Unauthorized.selector));
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(nonOwner);
    }

    /*//////////////////////////////////////////////////////////////
                       ADD OWNER PUBLIC KEY TESTS
    //////////////////////////////////////////////////////////////*/
    function test_ShouldAddOwnerPublicKeyCorrectly(bytes32 x, bytes32 y) public {
        vm.expectEmit(true, false, false, false, TEST_ACCOUNT_ADDRESS);
        emit MultiOwnable.AddOwner(1, abi.encode(x, y));

        vm.prank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerPublicKey(x, y);

        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerCount(), 2);
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).nextOwnerIndex(), 2);
        assertTrue(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerPublicKey(x, y));
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerAtIndex(1), abi.encode(x, y));
    }

    function test_ThrowErrorIfAddingDuplicateOwnerPublicKey(bytes32 x, bytes32 y) public {
        vm.prank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerPublicKey(x, y);

        vm.prank(INITIAL_OWNER);
        vm.expectRevert(abi.encodeWithSelector(MultiOwnable.MultiOwnable_AlreadyOwner.selector, abi.encode(x, y)));
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerPublicKey(x, y);
    }

    function test_ThrowErrorIfNonOwnerAddsOwnerPublicKey(address nonOwner, bytes32 x, bytes32 y) public {
        vm.assume(nonOwner != INITIAL_OWNER);
        vm.assume(nonOwner != address(0));
        vm.assume(nonOwner != TEST_ACCOUNT_ADDRESS);
        vm.assume(nonOwner != address(networkConfig.entryPointAddress));

        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(MultiOwnable.MultiOwnable_Unauthorized.selector));
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerPublicKey(x, y);
    }

    /*//////////////////////////////////////////////////////////////
                      REMOVE OWNER AT INDEX TESTS
    //////////////////////////////////////////////////////////////*/
    function test_ShouldRemoveOwnerAtIndexCorrectly(address owner) public {
        vm.assume(owner != INITIAL_OWNER);
        vm.assume(owner != address(0));

        vm.prank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner);

        vm.expectEmit(true, false, false, false, TEST_ACCOUNT_ADDRESS);
        emit MultiOwnable.RemoveOwner(0, abi.encode(INITIAL_OWNER));

        vm.prank(owner);
        JustanAccount(TEST_ACCOUNT_ADDRESS).removeOwnerAtIndex(0, abi.encode(INITIAL_OWNER));

        assertFalse(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerAddress(INITIAL_OWNER));
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerCount(), 1);
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).removedOwnersCount(), 1);
    }

    function test_ThrowErrorIfRemovingLastOwner() public {
        vm.prank(INITIAL_OWNER);
        vm.expectRevert(abi.encodeWithSelector(MultiOwnable.MultiOwnable_LastOwner.selector));
        JustanAccount(TEST_ACCOUNT_ADDRESS).removeOwnerAtIndex(0, abi.encode(INITIAL_OWNER));
    }

    function test_ThrowErrorIfRemovingOwnerFromEmptyIndex(address owner) public {
        vm.assume(owner != INITIAL_OWNER);
        vm.assume(owner != address(0));

        vm.prank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner);

        vm.prank(INITIAL_OWNER);
        vm.expectRevert(abi.encodeWithSelector(MultiOwnable.MultiOwnable_NoOwnerAtIndex.selector, 5));
        JustanAccount(TEST_ACCOUNT_ADDRESS).removeOwnerAtIndex(5, abi.encode(owner));
    }

    function test_ThrowErrorIfWrongOwnerAtIndex(address owner) public {
        vm.assume(owner != INITIAL_OWNER);
        vm.assume(owner != address(0));

        vm.prank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                MultiOwnable.MultiOwnable_WrongOwnerAtIndex.selector, 0, abi.encode(owner), abi.encode(INITIAL_OWNER)
            )
        );
        JustanAccount(TEST_ACCOUNT_ADDRESS).removeOwnerAtIndex(0, abi.encode(owner));
    }

    function test_ThrowErrorIfNonOwnerRemovesOwner(address nonOwner) public {
        vm.assume(nonOwner != INITIAL_OWNER);
        vm.assume(nonOwner != address(0));
        vm.assume(nonOwner != TEST_ACCOUNT_ADDRESS);
        vm.assume(nonOwner != address(networkConfig.entryPointAddress));

        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(MultiOwnable.MultiOwnable_Unauthorized.selector));
        JustanAccount(TEST_ACCOUNT_ADDRESS).removeOwnerAtIndex(0, abi.encode(INITIAL_OWNER));
    }

    /*//////////////////////////////////////////////////////////////
                        REMOVE LAST OWNER TESTS
    //////////////////////////////////////////////////////////////*/
    function test_ShouldRemoveLastOwnerCorrectly() public {
        vm.prank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).removeLastOwner(0, abi.encode(INITIAL_OWNER));

        assertFalse(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerAddress(INITIAL_OWNER));
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerCount(), 0);
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).removedOwnersCount(), 1);
    }

    function test_ThrowErrorIfRemoveLastOwnerWithMultipleOwners(address owner) public {
        vm.assume(owner != INITIAL_OWNER);
        vm.assume(owner != address(0));

        vm.prank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner);

        vm.prank(INITIAL_OWNER);
        vm.expectRevert(abi.encodeWithSelector(MultiOwnable.MultiOwnable_NotLastOwner.selector, 2));
        JustanAccount(TEST_ACCOUNT_ADDRESS).removeLastOwner(0, abi.encode(INITIAL_OWNER));
    }

    /*//////////////////////////////////////////////////////////////
                        OWNER MANAGEMENT EDGE CASES
    //////////////////////////////////////////////////////////////*/
    function test_OwnerAtIndexAfterMultipleRemovals(address owner1, address owner2, address owner3) public {
        vm.assume(owner1 != address(0) && owner2 != address(0) && owner3 != address(0));
        vm.assume(owner1 != owner2 && owner1 != owner3 && owner2 != owner3);
        vm.assume(owner1 != INITIAL_OWNER && owner2 != INITIAL_OWNER && owner3 != INITIAL_OWNER);

        // Add multiple owners
        vm.startPrank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner1); // index 1
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner2); // index 2
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner3); // index 3
        vm.stopPrank();

        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerCount(), 4);

        // Remove owner at index 1 (owner1)
        vm.prank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).removeOwnerAtIndex(1, abi.encode(owner1));

        // Verify owner at index 1 is now empty but other indices remain
        bytes memory emptyOwner = JustanAccount(TEST_ACCOUNT_ADDRESS).ownerAtIndex(1);
        assertEq(emptyOwner.length, 0);
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerAtIndex(0), abi.encode(INITIAL_OWNER));
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerAtIndex(2), abi.encode(owner2));
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerAtIndex(3), abi.encode(owner3));

        // Remove owner at index 2 (owner2)
        vm.prank(owner3);
        JustanAccount(TEST_ACCOUNT_ADDRESS).removeOwnerAtIndex(2, abi.encode(owner2));

        // Verify both indices 1 and 2 are empty
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerAtIndex(1).length, 0);
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerAtIndex(2).length, 0);
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerCount(), 2);
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).removedOwnersCount(), 2);
    }

    function test_NextOwnerIndexAfterRemovals(address owner1, address owner2) public {
        vm.assume(owner1 != address(0) && owner2 != address(0));
        vm.assume(owner1 != owner2);
        vm.assume(owner1 != INITIAL_OWNER && owner2 != INITIAL_OWNER);

        // Initial state: nextOwnerIndex should be 1 (INITIAL_OWNER at index 0)
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).nextOwnerIndex(), 1);

        // Add two more owners
        vm.startPrank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner1); // index 1
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner2); // index 2
        vm.stopPrank();

        // nextOwnerIndex should be 3 now
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).nextOwnerIndex(), 3);

        // Remove owner at index 1
        vm.prank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).removeOwnerAtIndex(1, abi.encode(owner1));

        // nextOwnerIndex should still be 3 (removals don't decrease nextOwnerIndex)
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).nextOwnerIndex(), 3);
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerCount(), 2);
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).removedOwnersCount(), 1);

        // Add another owner - should get index 3
        address owner4 = makeAddr("owner4");
        vm.prank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner4);

        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).nextOwnerIndex(), 4);
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerAtIndex(3), abi.encode(owner4));
    }

    function test_AddOwnerAtNonContiguousIndex(address owner1, address owner2, address owner3) public {
        vm.assume(owner1 != address(0) && owner2 != address(0) && owner3 != address(0));
        vm.assume(owner1 != owner2 && owner1 != owner3 && owner2 != owner3);
        vm.assume(owner1 != INITIAL_OWNER && owner2 != INITIAL_OWNER && owner3 != INITIAL_OWNER);

        // Add owners to create indices 0, 1, 2, 3
        vm.startPrank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner1); // index 1
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner2); // index 2
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(owner3); // index 3
        vm.stopPrank();

        // Remove owner at index 1, creating a gap
        vm.prank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).removeOwnerAtIndex(1, abi.encode(owner1));

        // Add a new owner - should get index 4 (next available), not fill the gap at index 1
        address newOwner = makeAddr("newOwner");
        vm.prank(INITIAL_OWNER);
        JustanAccount(TEST_ACCOUNT_ADDRESS).addOwnerAddress(newOwner);

        // Verify the new owner is at index 4, and index 1 remains empty
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerAtIndex(1).length, 0); // Gap remains
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerAtIndex(4), abi.encode(newOwner));
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).nextOwnerIndex(), 5);
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).ownerCount(), 4); // INITIAL_OWNER + owner2 + owner3 + newOwner
        assertEq(JustanAccount(TEST_ACCOUNT_ADDRESS).removedOwnersCount(), 1);

        // Verify all active owners are accessible
        assertTrue(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerAddress(INITIAL_OWNER));
        assertFalse(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerAddress(owner1)); // Removed
        assertTrue(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerAddress(owner2));
        assertTrue(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerAddress(owner3));
        assertTrue(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerAddress(newOwner));
    }

}
