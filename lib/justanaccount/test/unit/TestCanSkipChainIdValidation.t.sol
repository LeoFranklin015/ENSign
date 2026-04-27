// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import { Test, Vm, console } from "forge-std/Test.sol";

import { DeployJustanAccount } from "../../script/DeployJustanAccount.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { CodeConstants } from "../../script/HelperConfig.s.sol";
import { JustanAccount } from "../../src/JustanAccount.sol";
import { MultiOwnable } from "../../src/MultiOwnable.sol";

/**
 * @title TestCanSkipChainIdValidation
 * @notice Unit tests for JustanAccount.canSkipChainIdValidation() function
 * @dev Tests which function selectors are allowed to skip chain ID validation for cross-chain replay
 */
contract TestCanSkipChainIdValidation is Test, CodeConstants {

    JustanAccount public justanAccount;
    HelperConfig.NetworkConfig public networkConfig;

    function setUp() public {
        DeployJustanAccount deployer = new DeployJustanAccount();
        (justanAccount,, networkConfig) = deployer.run();
    }

    /*//////////////////////////////////////////////////////////////
                    APPROVED SELECTORS - SHOULD RETURN TRUE
    //////////////////////////////////////////////////////////////*/

    function test_ShouldReturnTrueForAddOwnerAddress() public view {
        bytes4 selector = MultiOwnable.addOwnerAddress.selector;
        assertTrue(justanAccount.canSkipChainIdValidation(selector));
    }

    function test_ShouldReturnTrueForAddOwnerPublicKey() public view {
        bytes4 selector = MultiOwnable.addOwnerPublicKey.selector;
        assertTrue(justanAccount.canSkipChainIdValidation(selector));
    }

    function test_ShouldReturnTrueForRemoveOwnerAtIndex() public view {
        bytes4 selector = MultiOwnable.removeOwnerAtIndex.selector;
        assertTrue(justanAccount.canSkipChainIdValidation(selector));
    }

    function test_ShouldReturnTrueForRemoveLastOwner() public view {
        bytes4 selector = MultiOwnable.removeLastOwner.selector;
        assertTrue(justanAccount.canSkipChainIdValidation(selector));
    }

    function test_ShouldReturnTrueForAllApprovedSelectors() public view {
        bytes4[] memory approvedSelectors = new bytes4[](4);
        approvedSelectors[0] = MultiOwnable.addOwnerAddress.selector;
        approvedSelectors[1] = MultiOwnable.addOwnerPublicKey.selector;
        approvedSelectors[2] = MultiOwnable.removeOwnerAtIndex.selector;
        approvedSelectors[3] = MultiOwnable.removeLastOwner.selector;

        for (uint256 i = 0; i < approvedSelectors.length; i++) {
            assertTrue(
                justanAccount.canSkipChainIdValidation(approvedSelectors[i]), "Approved selector should return true"
            );
        }
    }

    /*//////////////////////////////////////////////////////////////
                  DISALLOWED SELECTORS - SHOULD RETURN FALSE
    //////////////////////////////////////////////////////////////*/

    function test_ShouldReturnFalseForExecute() public view {
        bytes4 selector = justanAccount.execute.selector;
        assertFalse(justanAccount.canSkipChainIdValidation(selector));
    }

    function test_ShouldReturnFalseForExecuteBatch() public view {
        bytes4 selector = justanAccount.executeBatch.selector;
        assertFalse(justanAccount.canSkipChainIdValidation(selector));
    }

    function test_ShouldReturnFalseForValidateUserOp() public view {
        bytes4 selector = justanAccount.validateUserOp.selector;
        assertFalse(justanAccount.canSkipChainIdValidation(selector));
    }

    function test_ShouldReturnFalseForInitialize() public view {
        bytes4 selector = justanAccount.initialize.selector;
        assertFalse(justanAccount.canSkipChainIdValidation(selector));
    }

    function test_ShouldReturnFalseForExecuteWithoutChainIdValidation() public view {
        bytes4 selector = justanAccount.executeWithoutChainIdValidation.selector;
        assertFalse(justanAccount.canSkipChainIdValidation(selector));
    }

    function test_ShouldReturnFalseForIsValidSignature() public view {
        bytes4 selector = justanAccount.isValidSignature.selector;
        assertFalse(justanAccount.canSkipChainIdValidation(selector));
    }

    function test_ShouldReturnFalseForSupportsInterface() public view {
        bytes4 selector = justanAccount.supportsInterface.selector;
        assertFalse(justanAccount.canSkipChainIdValidation(selector));
    }

    function test_ShouldReturnFalseForEntryPoint() public view {
        bytes4 selector = justanAccount.entryPoint.selector;
        assertFalse(justanAccount.canSkipChainIdValidation(selector));
    }

    /*//////////////////////////////////////////////////////////////
                        FUZZ TESTS - RANDOM SELECTORS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldReturnFalseForRandomSelector(bytes4 randomSelector) public view {
        // Skip if the random selector happens to be one of the approved ones
        vm.assume(randomSelector != MultiOwnable.addOwnerAddress.selector);
        vm.assume(randomSelector != MultiOwnable.addOwnerPublicKey.selector);
        vm.assume(randomSelector != MultiOwnable.removeOwnerAtIndex.selector);
        vm.assume(randomSelector != MultiOwnable.removeLastOwner.selector);

        assertFalse(justanAccount.canSkipChainIdValidation(randomSelector));
    }

    function test_ShouldReturnConsistentResultForSameSelector() public view {
        bytes4 selector = MultiOwnable.addOwnerAddress.selector;

        // Call multiple times to ensure consistency
        bool firstCall = justanAccount.canSkipChainIdValidation(selector);
        bool secondCall = justanAccount.canSkipChainIdValidation(selector);
        bool thirdCall = justanAccount.canSkipChainIdValidation(selector);

        assertTrue(firstCall);
        assertEq(firstCall, secondCall);
        assertEq(secondCall, thirdCall);
    }

    /*//////////////////////////////////////////////////////////////
                          EDGE CASES
    //////////////////////////////////////////////////////////////*/

    function test_ShouldReturnFalseForZeroSelector() public view {
        bytes4 zeroSelector = bytes4(0);
        assertFalse(justanAccount.canSkipChainIdValidation(zeroSelector));
    }

    function test_ShouldReturnFalseForMaxSelector() public view {
        bytes4 maxSelector = bytes4(type(uint32).max);
        assertFalse(justanAccount.canSkipChainIdValidation(maxSelector));
    }

}
