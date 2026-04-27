// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import { BaseAccount } from "@account-abstraction/core/BaseAccount.sol";
import { IAccount } from "@account-abstraction/interfaces/IAccount.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { Test, Vm, console } from "forge-std/Test.sol";

import { DeployJustanAccount } from "../../script/DeployJustanAccount.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { CodeConstants } from "../../script/HelperConfig.s.sol";
import { JustanAccount } from "../../src/JustanAccount.sol";
import { MultiOwnable } from "../../src/MultiOwnable.sol";

contract Test7702JustanAccount is Test, CodeConstants {

    JustanAccount public justanAccount;
    HelperConfig public helperConfig;
    ERC20Mock public mockERC20;

    HelperConfig.NetworkConfig public networkConfig;

    function setUp() public {
        DeployJustanAccount deployer = new DeployJustanAccount();
        (justanAccount,, networkConfig) = deployer.run();

        mockERC20 = new ERC20Mock();
    }

    /*//////////////////////////////////////////////////////////////
                            EXECUTE TESTS
    //////////////////////////////////////////////////////////////*/
    function test_ThrowErrorIfCallingExecuteFromNotEntrypointOrOwner(
        address target,
        uint256 value,
        bytes calldata data
    )
        public
    {
        vm.expectRevert(abi.encodeWithSelector(MultiOwnable.MultiOwnable_Unauthorized.selector));
        justanAccount.execute(target, value, data);
    }

    function test_ShouldExecuteCorrectly(address to, uint256 amount) public {
        vm.assume(to != address(0));

        bytes memory data = abi.encodeCall(ERC20Mock.mint, (to, amount));

        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);
        vm.prank(TEST_ACCOUNT_ADDRESS);
        JustanAccount(TEST_ACCOUNT_ADDRESS).execute(address(mockERC20), 0, data);

        assertEq(mockERC20.balanceOf(to), amount);
    }

    function test_ShouldThrowErrorIfSponsoringExecute(uint256 amount) public {
        (address BOB_ADDRESS, uint256 BOB_PK) = makeAddrAndKey("bob");

        bytes memory data = abi.encodeCall(ERC20Mock.mint, (BOB_ADDRESS, amount));

        Vm.SignedDelegation memory signedDelegation =
            vm.signDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);

        vm.broadcast(BOB_PK);
        vm.attachDelegation(signedDelegation);
        vm.expectRevert(abi.encodeWithSelector(MultiOwnable.MultiOwnable_Unauthorized.selector));
        JustanAccount(TEST_ACCOUNT_ADDRESS).execute(address(mockERC20), 0, data);
    }

    /*//////////////////////////////////////////////////////////////
                          EXECUTE BATCH TESTS
    //////////////////////////////////////////////////////////////*/
    function test_ThrowErrorIfCallingExecuteBatchFromNotEntrypointOrOwner(
        address target,
        uint256 value,
        bytes calldata data
    )
        public
    {
        vm.assume(target != address(0));

        BaseAccount.Call[] memory calls = new BaseAccount.Call[](1);
        calls[0] = BaseAccount.Call({ target: target, value: value, data: data });

        vm.expectRevert(abi.encodeWithSelector(MultiOwnable.MultiOwnable_Unauthorized.selector));
        justanAccount.executeBatch(calls);
    }

    function test_ShouldExecuteBatchCorrectly(address to, uint256 amount) public {
        vm.assume(to != address(0));

        bytes memory data1 = abi.encodeCall(ERC20Mock.mint, (to, amount));
        bytes memory data2 = abi.encodeCall(ERC20Mock.burn, (to, amount));

        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = BaseAccount.Call({ target: address(mockERC20), value: 0, data: data1 });
        calls[1] = BaseAccount.Call({ target: address(mockERC20), value: 0, data: data2 });

        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);
        vm.prank(TEST_ACCOUNT_ADDRESS);
        JustanAccount(TEST_ACCOUNT_ADDRESS).executeBatch(calls);

        assertEq(mockERC20.balanceOf(to), 0);
    }

    function test_ShouldThrowErrorIfSponsoringExecuteBatch(address to, uint256 amount) public {
        vm.assume(to != address(0));

        (, uint256 BOB_PK) = makeAddrAndKey("bob");

        bytes memory data1 = abi.encodeCall(ERC20Mock.mint, (to, amount));
        bytes memory data2 = abi.encodeCall(ERC20Mock.burn, (to, amount));

        BaseAccount.Call[] memory calls = new BaseAccount.Call[](2);
        calls[0] = BaseAccount.Call({ target: address(mockERC20), value: 0, data: data1 });
        calls[1] = BaseAccount.Call({ target: address(mockERC20), value: 0, data: data2 });

        Vm.SignedDelegation memory signedDelegation =
            vm.signDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);

        vm.broadcast(BOB_PK);
        vm.attachDelegation(signedDelegation);
        vm.expectRevert(abi.encodeWithSelector(MultiOwnable.MultiOwnable_Unauthorized.selector));
        JustanAccount(TEST_ACCOUNT_ADDRESS).executeBatch(calls);
    }

}
