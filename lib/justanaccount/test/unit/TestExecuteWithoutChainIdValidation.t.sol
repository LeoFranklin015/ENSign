// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import { BaseAccount } from "@account-abstraction/core/BaseAccount.sol";
import "@account-abstraction/core/Helpers.sol";
import { IEntryPoint } from "@account-abstraction/interfaces/IEntryPoint.sol";
import { PackedUserOperation } from "@account-abstraction/interfaces/PackedUserOperation.sol";
import { Test, Vm, console } from "forge-std/Test.sol";

import { DeployJustanAccount } from "../../script/DeployJustanAccount.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { CodeConstants } from "../../script/HelperConfig.s.sol";
import { PreparePackedUserOp } from "../../script/PreparePackedUserOp.s.sol";
import { JustanAccount } from "../../src/JustanAccount.sol";
import { JustanAccountFactory } from "../../src/JustanAccountFactory.sol";
import { MultiOwnable } from "../../src/MultiOwnable.sol";

/**
 * @title TestExecuteWithoutChainIdValidation
 * @notice Unit tests for JustanAccount.executeWithoutChainIdValidation() function
 * @dev Tests the cross-chain replayable execution functionality
 */
contract TestExecuteWithoutChainIdValidation is Test, CodeConstants {

    JustanAccount public justanAccount;
    JustanAccountFactory public factory;
    JustanAccount public account;
    HelperConfig.NetworkConfig public networkConfig;
    PreparePackedUserOp public preparePackedUserOp;

    address public owner;
    uint256 public ownerPk;

    function setUp() public {
        DeployJustanAccount deployer = new DeployJustanAccount();
        (justanAccount, factory, networkConfig) = deployer.run();

        preparePackedUserOp = new PreparePackedUserOp();

        // Create an account with an initial owner for testing
        (owner, ownerPk) = makeAddrAndKey("owner");
        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(owner);
        account = factory.createAccount(owners, 0);

        // Fund the account for gas
        vm.deal(address(account), 10 ether);
    }

    /*//////////////////////////////////////////////////////////////
                        AUTHORIZATION TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldRevertWhenCallerNotOwnerOrEntryPoint(address unauthorized, address newOwner) public {
        vm.assume(unauthorized != owner);
        vm.assume(unauthorized != networkConfig.entryPointAddress);
        vm.assume(unauthorized != address(account));

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwner);

        vm.prank(unauthorized);
        vm.expectRevert(abi.encodeWithSelector(MultiOwnable.MultiOwnable_Unauthorized.selector));
        account.executeWithoutChainIdValidation(calls);
    }

    function test_ShouldSucceedWhenCalledByEntryPoint(address newOwner) public {
        vm.assume(newOwner != owner);

        assertFalse(account.isOwnerAddress(newOwner));

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwner);

        vm.prank(networkConfig.entryPointAddress);
        account.executeWithoutChainIdValidation(calls);

        assertTrue(account.isOwnerAddress(newOwner));
    }

    function test_ShouldSucceedWhenCalledByOwner(address newOwner) public {
        vm.assume(newOwner != owner);

        assertFalse(account.isOwnerAddress(newOwner));

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwner);

        vm.prank(owner);
        account.executeWithoutChainIdValidation(calls);

        assertTrue(account.isOwnerAddress(newOwner));
    }

    /*//////////////////////////////////////////////////////////////
                    SELECTOR VALIDATION TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldSucceedWithApprovedSelector_AddOwnerAddress(address newOwner) public {
        vm.assume(newOwner != owner);

        assertFalse(account.isOwnerAddress(newOwner));

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwner);

        vm.prank(owner);
        account.executeWithoutChainIdValidation(calls);

        assertTrue(account.isOwnerAddress(newOwner));
        assertEq(account.ownerCount(), 2);
    }

    function test_ShouldSucceedWithApprovedSelector_AddOwnerPublicKey(bytes32 x, bytes32 y) public {
        assertFalse(account.isOwnerPublicKey(x, y));

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerPublicKey.selector, x, y);

        vm.prank(owner);
        account.executeWithoutChainIdValidation(calls);

        assertTrue(account.isOwnerPublicKey(x, y));
        assertEq(account.ownerCount(), 2);
    }

    function test_ShouldSucceedWithApprovedSelector_RemoveOwnerAtIndex(address newOwner) public {
        // First add a second owner so we can remove the first
        vm.assume(newOwner != owner);

        vm.prank(owner);
        account.addOwnerAddress(newOwner);
        assertEq(account.ownerCount(), 2);

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.removeOwnerAtIndex.selector, 0, abi.encode(owner));

        vm.prank(newOwner);
        account.executeWithoutChainIdValidation(calls);

        assertFalse(account.isOwnerAddress(owner));
        assertEq(account.ownerCount(), 1);
    }

    function test_ShouldSucceedWithApprovedSelector_RemoveLastOwner() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.removeLastOwner.selector, 0, abi.encode(owner));

        vm.prank(owner);
        account.executeWithoutChainIdValidation(calls);

        assertFalse(account.isOwnerAddress(owner));
        assertEq(account.ownerCount(), 0);
    }

    function test_ShouldRevertWithDisallowedSelector_Execute(address newOwner) public {
        bytes memory executeCall = abi.encodeWithSelector(account.execute.selector, newOwner, 0, "");
        bytes[] memory calls = new bytes[](1);
        calls[0] = executeCall;

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(JustanAccount.JustanAccount_SelectorNotAllowed.selector, account.execute.selector)
        );
        account.executeWithoutChainIdValidation(calls);
    }

    function test_ShouldRevertWithDisallowedSelector_ExecuteBatch() public {
        BaseAccount.Call[] memory batchCalls = new BaseAccount.Call[](0);
        bytes memory executeBatchCall = abi.encodeWithSelector(account.executeBatch.selector, batchCalls);
        bytes[] memory calls = new bytes[](1);
        calls[0] = executeBatchCall;

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                JustanAccount.JustanAccount_SelectorNotAllowed.selector, account.executeBatch.selector
            )
        );
        account.executeWithoutChainIdValidation(calls);
    }

    /*//////////////////////////////////////////////////////////////
                        BATCH CALLS TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldSucceedWithMultipleApprovedSelectors(
        address newOwner1,
        address newOwner2,
        bytes32 x,
        bytes32 y
    )
        public
    {
        vm.assume(newOwner1 != owner);
        vm.assume(newOwner2 != owner);
        vm.assume(newOwner1 != newOwner2);

        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwner1);
        calls[1] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwner2);
        calls[2] = abi.encodeWithSelector(MultiOwnable.addOwnerPublicKey.selector, x, y);

        vm.prank(owner);
        account.executeWithoutChainIdValidation(calls);

        assertTrue(account.isOwnerAddress(newOwner1));
        assertTrue(account.isOwnerAddress(newOwner2));
        assertTrue(account.isOwnerPublicKey(x, y));
        assertEq(account.ownerCount(), 4); // original + 3 new
    }

    function test_ShouldRevertWhenOneCallHasDisallowedSelector(address newOwner) public {
        vm.assume(newOwner != owner);

        bytes memory disallowedCall = abi.encodeWithSelector(account.execute.selector, newOwner, 0, "");

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwner);
        calls[1] = disallowedCall;

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(JustanAccount.JustanAccount_SelectorNotAllowed.selector, account.execute.selector)
        );
        account.executeWithoutChainIdValidation(calls);

        // Verify the first call didn't execute (transaction reverted)
        assertFalse(account.isOwnerAddress(newOwner));
    }

    /*//////////////////////////////////////////////////////////////
                        EXECUTION TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldRevertWhenApprovedCallFails(uint256 invalidIndex, address newOwner) public {
        vm.assume(newOwner != owner);
        vm.assume(invalidIndex > account.ownerCount());

        vm.prank(owner);
        account.addOwnerAddress(newOwner);

        // Try to remove an owner that doesn't exist at the index
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.removeOwnerAtIndex.selector, invalidIndex, abi.encode(owner));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MultiOwnable.MultiOwnable_NoOwnerAtIndex.selector, invalidIndex));
        account.executeWithoutChainIdValidation(calls);
    }

    function test_ShouldPropagateRevertData() public {
        // Try to remove the last owner using removeOwnerAtIndex (should fail)
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.removeOwnerAtIndex.selector, 0, abi.encode(owner));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MultiOwnable.MultiOwnable_LastOwner.selector));
        account.executeWithoutChainIdValidation(calls);
    }

    function test_ShouldRevertWithAlreadyOwnerError() public {
        address existingOwner = owner;

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, existingOwner);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(MultiOwnable.MultiOwnable_AlreadyOwner.selector, abi.encode(existingOwner))
        );
        account.executeWithoutChainIdValidation(calls);
    }

    /*//////////////////////////////////////////////////////////////
                            EDGE CASES
    //////////////////////////////////////////////////////////////*/

    function test_ShouldSucceedWithEmptyCallsArray() public {
        bytes[] memory calls = new bytes[](0);

        vm.prank(owner);
        account.executeWithoutChainIdValidation(calls);

        // No state change expected
        assertEq(account.ownerCount(), 1);
    }

    function test_ShouldSucceedWithManyApprovedCalls() public {
        bytes[] memory calls = new bytes[](10);
        address[] memory newOwners = new address[](10);

        for (uint256 i = 0; i < 10; i++) {
            newOwners[i] = makeAddr(string(abi.encodePacked("owner", i)));
            calls[i] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwners[i]);
        }

        vm.prank(owner);
        account.executeWithoutChainIdValidation(calls);

        // Verify all owners were added
        for (uint256 i = 0; i < 10; i++) {
            assertTrue(account.isOwnerAddress(newOwners[i]));
        }
        assertEq(account.ownerCount(), 11); // original + 10 new
    }

    function test_ShouldRevertWithRandomDisallowedSelector(bytes4 disallowedSelector) public {
        // Skip approved selectors
        vm.assume(disallowedSelector != MultiOwnable.addOwnerAddress.selector);
        vm.assume(disallowedSelector != MultiOwnable.addOwnerPublicKey.selector);
        vm.assume(disallowedSelector != MultiOwnable.removeOwnerAtIndex.selector);
        vm.assume(disallowedSelector != MultiOwnable.removeLastOwner.selector);

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodePacked(disallowedSelector);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(JustanAccount.JustanAccount_SelectorNotAllowed.selector, disallowedSelector)
        );
        account.executeWithoutChainIdValidation(calls);
    }

    /*//////////////////////////////////////////////////////////////
                    EIP-7702 SPECIFIC TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldSucceedViaEIP7702Delegation(address newOwner) public {
        vm.assume(newOwner != owner);

        // Create a delegated account using EIP-7702
        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwner);

        vm.prank(TEST_ACCOUNT_ADDRESS);
        JustanAccount(TEST_ACCOUNT_ADDRESS).executeWithoutChainIdValidation(calls);

        assertTrue(JustanAccount(TEST_ACCOUNT_ADDRESS).isOwnerAddress(newOwner));
    }

    /*//////////////////////////////////////////////////////////////
                    COMPLEX SCENARIOS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldHandleAddAndRemoveInSameBatch(address tempOwner, address permanentOwner) public {
        vm.assume(tempOwner != owner);
        vm.assume(permanentOwner != owner);
        vm.assume(tempOwner != permanentOwner);

        // Add a second owner first
        vm.prank(owner);
        account.addOwnerAddress(tempOwner);
        assertEq(account.ownerCount(), 2);

        // Now in one batch: add a new owner and remove the temp owner
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, permanentOwner);
        calls[1] = abi.encodeWithSelector(MultiOwnable.removeOwnerAtIndex.selector, 1, abi.encode(tempOwner));

        vm.prank(owner);
        account.executeWithoutChainIdValidation(calls);

        assertTrue(account.isOwnerAddress(permanentOwner));
        assertFalse(account.isOwnerAddress(tempOwner));
        assertEq(account.ownerCount(), 2); // owner + permanentOwner
    }

    function test_ShouldMaintainStateAcrossMultipleCalls(address owner1, address owner2, address owner3) public {
        vm.assume(owner1 != owner);
        vm.assume(owner2 != owner);
        vm.assume(owner3 != owner);
        vm.assume(owner1 != owner2 && owner1 != owner3 && owner2 != owner3);

        // First batch
        bytes[] memory calls1 = new bytes[](2);
        calls1[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, owner1);
        calls1[1] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, owner2);

        vm.prank(owner);
        account.executeWithoutChainIdValidation(calls1);

        assertEq(account.ownerCount(), 3);

        // Second batch
        bytes[] memory calls2 = new bytes[](1);
        calls2[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, owner3);

        vm.prank(owner);
        account.executeWithoutChainIdValidation(calls2);

        assertEq(account.ownerCount(), 4);
        assertTrue(account.isOwnerAddress(owner1));
        assertTrue(account.isOwnerAddress(owner2));
        assertTrue(account.isOwnerAddress(owner3));
    }

}
