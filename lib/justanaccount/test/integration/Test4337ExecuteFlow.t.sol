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

contract Test4337ExecuteFlow is Test, CodeConstants {

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

    function test_ShouldExecute4337FlowCorrectly(address to, uint256 amount, bytes32 messageHash) public {
        vm.assume(to != address(0));
        vm.assume(to != networkConfig.entryPointAddress);

        vm.deal(TEST_ACCOUNT_ADDRESS, 10 ether);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TEST_ACCOUNT_PRIVATE_KEY, messageHash);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);

        _executeMintOperation(to, amount);
        _executeBatchOperation(to, amount);
    }

    function _executeMintOperation(address to, uint256 amount) internal {
        bytes memory functionData = abi.encodeWithSelector(mockERC20.mint.selector, TEST_ACCOUNT_ADDRESS, amount);
        bytes memory executeCallData =
            abi.encodeWithSelector(justanAccount.execute.selector, address(mockERC20), 0, functionData);
        (PackedUserOperation memory userOp,) =
            preparePackedUserOp.generateSignedUserOperation(executeCallData, networkConfig.entryPointAddress);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        vm.prank(to);
        IEntryPoint(networkConfig.entryPointAddress).handleOps(ops, payable(TEST_ACCOUNT_ADDRESS));

        assertEq(mockERC20.balanceOf(TEST_ACCOUNT_ADDRESS), amount);
    }

    function _executeBatchOperation(address to, uint256 amount) internal {
        bytes memory mintData = abi.encodeCall(ERC20Mock.mint, (to, amount));
        bytes memory burnData = abi.encodeCall(ERC20Mock.burn, (to, amount));

        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = BaseAccount.Call({ target: address(mockERC20), value: 0, data: mintData });
        calls[1] = BaseAccount.Call({ target: address(mockERC20), value: 0, data: burnData });

        bytes memory executeBatchCallData = abi.encodeWithSelector(justanAccount.executeBatch.selector, calls);
        (PackedUserOperation memory userOp,) =
            preparePackedUserOp.generateSignedUserOperation(executeBatchCallData, networkConfig.entryPointAddress);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;

        vm.prank(to);
        IEntryPoint(networkConfig.entryPointAddress).handleOps(ops, payable(TEST_ACCOUNT_ADDRESS));

        assertEq(mockERC20.balanceOf(TEST_ACCOUNT_ADDRESS), amount);
    }

}
