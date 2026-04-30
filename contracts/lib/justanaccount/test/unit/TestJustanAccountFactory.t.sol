// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { Test, console2 } from "forge-std/Test.sol";
import { LibClone } from "solady/utils/LibClone.sol";

import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { JustanAccount } from "../../src/JustanAccount.sol";
import { JustanAccountFactory } from "../../src/JustanAccountFactory.sol";
import { MultiOwnable } from "../../src/MultiOwnable.sol";

contract TestJustanAccountFactory is Test {

    JustanAccountFactory factory;
    JustanAccount account;
    bytes[] owners;
    HelperConfig helperConfig;
    address entryPoint;

    function setUp() public {
        helperConfig = new HelperConfig();
        entryPoint = helperConfig.getConfig().entryPointAddress;
        factory = new JustanAccountFactory(entryPoint);
        account = JustanAccount(payable(factory.getImplementation()));
        owners.push(abi.encode(address(1)));
        owners.push(abi.encode(address(2)));
    }

    function test_constructor_deploysImplementation() public {
        JustanAccountFactory newFactory = new JustanAccountFactory(entryPoint);
        address implementation = newFactory.getImplementation();
        assertTrue(implementation != address(0));
        assertEq(address(JustanAccount(payable(implementation)).entryPoint()), entryPoint);
    }

    function test_createAccountSetsOwnersCorrectly() public {
        address expectedAddress = factory.getAddress(owners, 0);
        vm.expectCall(expectedAddress, abi.encodeCall(JustanAccount.initialize, (owners)));
        JustanAccount a = factory.createAccount{ value: 1e18 }(owners, 0);
        assert(a.isOwnerAddress(address(1)));
        assert(a.isOwnerAddress(address(2)));
    }

    function test_revertsIfNoOwners() public {
        owners.pop();
        owners.pop();
        vm.expectRevert(JustanAccountFactory.JustanAccountFactory_OwnerRequired.selector);
        factory.createAccount{ value: 1e18 }(owners, 0);
    }

    function test_revertsIfAccountAlreadyExists() public {
        factory.createAccount(owners, 0);

        vm.expectRevert(JustanAccountFactory.JustanAccountFactory_AlreadyDeployed.selector);
        factory.createAccount(owners, 0);
    }

    function test_RevertsIfLength32ButLargerThanAddress() public {
        bytes memory badOwner = abi.encode(uint256(type(uint160).max) + 1);
        owners.push(badOwner);
        vm.expectRevert(
            abi.encodeWithSelector(MultiOwnable.MultiOwnable_InvalidEthereumAddressOwner.selector, badOwner)
        );
        factory.createAccount{ value: 1e18 }(owners, 0);
    }

    function test_createAccountDeploysToPredeterminedAddress() public {
        address p = factory.getAddress(owners, 0);
        JustanAccount a = factory.createAccount{ value: 1e18 }(owners, 0);
        assertEq(address(a), p);
    }

    function test_DeployDeterministicPassValues() public {
        vm.deal(address(this), 1e18);
        JustanAccount a = factory.createAccount{ value: 1e18 }(owners, 0);
        assertEq(address(a).balance, 1e18);
    }

    function test_implementation_returnsExpectedAddress() public view {
        assertEq(factory.getImplementation(), address(account));
    }

    function test_initCodeHash() public view {
        bytes32 execptedHash = LibClone.initCodeHash(address(account), "");
        bytes32 factoryHash = factory.initCodeHash();
        assertEq(factoryHash, execptedHash);
    }

}
