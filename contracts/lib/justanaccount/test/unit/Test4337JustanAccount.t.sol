// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import { BaseAccount } from "@account-abstraction/core/BaseAccount.sol";
import "@account-abstraction/core/Helpers.sol";
import { IEntryPoint } from "@account-abstraction/interfaces/IEntryPoint.sol";
import { PackedUserOperation } from "@account-abstraction/interfaces/PackedUserOperation.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { Test, Vm, console } from "forge-std/Test.sol";

import { DeployJustanAccount } from "../../script/DeployJustanAccount.s.sol";
import { CodeConstants, HelperConfig } from "../../script/HelperConfig.s.sol";

import { PreparePackedUserOp } from "../../script/PreparePackedUserOp.s.sol";
import { JustanAccount } from "../../src/JustanAccount.sol";

contract Test4337JustanAccount is Test, CodeConstants {

    JustanAccount public justanAccount;
    HelperConfig public helperConfig;
    ERC20Mock public mockERC20;
    PreparePackedUserOp public preparePackedUserOp;

    HelperConfig.NetworkConfig public networkConfig;

    function setUp() public {
        DeployJustanAccount deployer = new DeployJustanAccount();
        (justanAccount,, networkConfig) = deployer.run();

        mockERC20 = new ERC20Mock();
        preparePackedUserOp = new PreparePackedUserOp();
    }

    /*//////////////////////////////////////////////////////////////
                         VALIDATE USEROP TESTS
    //////////////////////////////////////////////////////////////*/
    function test_ThrowErrorIfCallingValidateUserOpFromNotEntrypoint(
        address sender,
        bytes memory callData,
        uint256 missingAccountFunds
    )
        public
    {
        vm.assume(sender != networkConfig.entryPointAddress);
        vm.assume(sender != address(0));

        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);

        (PackedUserOperation memory userOp, bytes32 userOpHash) =
            preparePackedUserOp.generateSignedUserOperation(callData, networkConfig.entryPointAddress);

        vm.prank(sender);
        vm.expectRevert("account: not from EntryPoint");
        JustanAccount(TEST_ACCOUNT_ADDRESS).validateUserOp(userOp, userOpHash, missingAccountFunds);
    }

    // TODO: test the payPrefund function
    function test_ShouldValidateUserOpCorrectly(bytes memory callData) public {
        vm.assume(
            keccak256(callData)
                != keccak256(abi.encodeWithSelector(JustanAccount.executeWithoutChainIdValidation.selector))
        );
        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);

        (PackedUserOperation memory userOp, bytes32 userOpHash) =
            preparePackedUserOp.generateSignedUserOperation(callData, networkConfig.entryPointAddress);

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = JustanAccount(TEST_ACCOUNT_ADDRESS).validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_SUCCESS);
    }

    /*//////////////////////////////////////////////////////////////
                              EXECUTE TESTS
    //////////////////////////////////////////////////////////////*/
    function test_ShouldExecuteCallCorrectly(address sender, uint256 amount) public {
        vm.assume(sender != networkConfig.entryPointAddress);
        vm.assume(sender != address(0));

        vm.deal(TEST_ACCOUNT_ADDRESS, 10 ether);

        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);

        bytes memory functionData =
            abi.encodeWithSelector(mockERC20.mint.selector, address(TEST_ACCOUNT_ADDRESS), amount);
        bytes memory executeCallData =
            abi.encodeWithSelector(justanAccount.execute.selector, address(mockERC20), 0, functionData);
        (PackedUserOperation memory userOp,) =
            preparePackedUserOp.generateSignedUserOperation(executeCallData, networkConfig.entryPointAddress);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        vm.prank(sender);
        IEntryPoint(networkConfig.entryPointAddress).handleOps(ops, payable(TEST_ACCOUNT_ADDRESS));

        assertEq(mockERC20.balanceOf(TEST_ACCOUNT_ADDRESS), amount);
    }

    /*//////////////////////////////////////////////////////////////
                           EXECUTE BATCH TESTS
    //////////////////////////////////////////////////////////////*/
    function test_ShouldExecuteBatchCallsCorrectly(address sender, uint256 amount) public {
        vm.assume(sender != networkConfig.entryPointAddress);
        vm.assume(sender != address(0));

        vm.deal(TEST_ACCOUNT_ADDRESS, 10 ether);

        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);

        bytes memory functionata1 = abi.encodeCall(mockERC20.mint, (TEST_ACCOUNT_ADDRESS, amount));
        bytes memory functionData2 = abi.encodeCall(mockERC20.burn, (TEST_ACCOUNT_ADDRESS, amount));

        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = BaseAccount.Call({ target: address(mockERC20), value: 0, data: functionata1 });
        calls[1] = BaseAccount.Call({ target: address(mockERC20), value: 0, data: functionData2 });

        bytes memory executeCallData = abi.encodeWithSelector(justanAccount.executeBatch.selector, calls);
        (PackedUserOperation memory userOp,) =
            preparePackedUserOp.generateSignedUserOperation(executeCallData, networkConfig.entryPointAddress);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        vm.prank(sender);
        IEntryPoint(networkConfig.entryPointAddress).handleOps(ops, payable(TEST_ACCOUNT_ADDRESS));

        assertEq(mockERC20.balanceOf(TEST_ACCOUNT_ADDRESS), 0);
    }

}
