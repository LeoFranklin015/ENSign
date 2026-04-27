// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import { BaseAccount } from "@account-abstraction/core/BaseAccount.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { Test, Vm, console } from "forge-std/Test.sol";

import { DeployJustanAccount } from "../../script/DeployJustanAccount.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { CodeConstants } from "../../script/HelperConfig.s.sol";
import { JustanAccount } from "../../src/JustanAccount.sol";

contract Test7702ExecuteFlow is Test, CodeConstants {

    JustanAccount public justanAccount;
    HelperConfig public helperConfig;
    ERC20Mock public mockERC20;

    HelperConfig.NetworkConfig public networkConfig;

    function setUp() public {
        DeployJustanAccount deployer = new DeployJustanAccount();
        (justanAccount,, networkConfig) = deployer.run();

        mockERC20 = new ERC20Mock();
    }

    function test_ShouldExecute7702FlowCorrectly(address to, uint256 amount, bytes32 messageHash) public {
        vm.assume(to != address(0));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TEST_ACCOUNT_PRIVATE_KEY, messageHash);
        bytes memory signature = abi.encodePacked(r, s, v);

        bytes memory mintData = abi.encodeCall(ERC20Mock.mint, (to, amount));
        bytes memory burnData = abi.encodeCall(ERC20Mock.burn, (to, amount));

        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);
        vm.prank(TEST_ACCOUNT_ADDRESS);
        JustanAccount(TEST_ACCOUNT_ADDRESS).execute(address(mockERC20), 0, mintData);

        assertEq(mockERC20.balanceOf(to), amount);

        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = BaseAccount.Call({ target: address(mockERC20), value: 0, data: burnData });
        calls[1] = BaseAccount.Call({ target: address(mockERC20), value: 0, data: mintData });

        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);
        vm.prank(TEST_ACCOUNT_ADDRESS);
        JustanAccount(TEST_ACCOUNT_ADDRESS).executeBatch(calls);

        assertEq(mockERC20.balanceOf(to), amount);
    }

}
