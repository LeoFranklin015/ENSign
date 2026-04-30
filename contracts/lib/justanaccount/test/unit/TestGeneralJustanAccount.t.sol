// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import { IAccount } from "@account-abstraction/interfaces/IAccount.sol";

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import { ERC1155 } from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { Test, Vm, console } from "forge-std/Test.sol";

import { DeployJustanAccount } from "../../script/DeployJustanAccount.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { CodeConstants } from "../../script/HelperConfig.s.sol";
import { JustanAccount } from "../../src/JustanAccount.sol";
import { JustanAccountFactory } from "../../src/JustanAccountFactory.sol";
import { MultiOwnable } from "../../src/MultiOwnable.sol";

contract ERC721Mock is ERC721 {

    constructor() ERC721("ERC721Mock", "E721M") { }

    function mint(address to, uint256 tokenId) public {
        _mint(to, tokenId);
    }

}

contract ERC1155Mock is ERC1155 {

    constructor() ERC1155("") { }

    function mint(address to, uint256 tokenId, uint256 amount, bytes memory data) public {
        _mint(to, tokenId, amount, data);
    }

}

contract TestGeneralJustanAccount is Test, CodeConstants {

    JustanAccount public justanAccount;
    JustanAccountFactory public factory;
    HelperConfig public helperConfig;

    ERC721Mock public erc721Mock;
    ERC1155Mock public erc1155Mock;

    HelperConfig.NetworkConfig public networkConfig;

    address public NFT_OWNER;

    function setUp() public {
        DeployJustanAccount deployer = new DeployJustanAccount();
        (justanAccount, factory, networkConfig) = deployer.run();

        NFT_OWNER = makeAddr("nft_owner");

        erc721Mock = new ERC721Mock();
        erc1155Mock = new ERC1155Mock();
    }

    /*//////////////////////////////////////////////////////////////
                          INITIALIZATION TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldInitializeCorrectly() public {
        address owner1 = makeAddr("owner1");
        address owner2 = makeAddr("owner2");

        bytes[] memory owners = new bytes[](2);
        owners[0] = abi.encode(owner1);
        owners[1] = abi.encode(owner2);

        JustanAccount newAccount = factory.createAccount(owners, 123);

        assertEq(newAccount.nextOwnerIndex(), 2);
        assertEq(newAccount.ownerCount(), 2);
        assertTrue(newAccount.isOwnerAddress(owner1));
        assertTrue(newAccount.isOwnerAddress(owner2));
        assertEq(newAccount.ownerAtIndex(0), abi.encode(owner1));
        assertEq(newAccount.ownerAtIndex(1), abi.encode(owner2));
    }

    function test_ShouldFailInitializeWhenAlreadyInitialized() public {
        address owner1 = makeAddr("owner1");

        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(owner1);

        JustanAccount newAccount = factory.createAccount(owners, 456);

        vm.expectRevert(JustanAccount.JustanAccount_AlreadyInitialized.selector);
        newAccount.initialize(owners);
    }

    function test_ShouldRevertOnInvalidOwnerBytesLength(uint8 length) public {
        // Valid lengths are 32 and 64, so test all other lengths
        vm.assume(length != 32 && length != 64);
        vm.assume(length > 0 && length < 128); // Reasonable bounds for testing

        bytes memory invalidOwner = new bytes(length);
        // Fill with some data
        for (uint256 i = 0; i < length; i++) {
            invalidOwner[i] = bytes1(uint8(i));
        }

        bytes[] memory owners = new bytes[](1);
        owners[0] = invalidOwner;

        vm.expectRevert(abi.encodeWithSelector(MultiOwnable.MultiOwnable_InvalidOwnerBytesLength.selector, owners[0]));
        factory.createAccount(owners, uint256(keccak256(abi.encode(length))));
    }

    function test_ShouldRevertOnInvalidEthereumAddressOwner(uint256 invalidAddress) public {
        vm.assume(invalidAddress > type(uint160).max);

        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(invalidAddress);

        vm.expectRevert(
            abi.encodeWithSelector(MultiOwnable.MultiOwnable_InvalidEthereumAddressOwner.selector, owners[0])
        );
        factory.createAccount(owners, invalidAddress);
    }

    function test_ShouldAcceptValidEthereumAddressOwner(uint160 validAddress) public {
        vm.assume(validAddress != 0);

        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(validAddress);

        JustanAccount newAccount = factory.createAccount(owners, uint256(validAddress));

        assertTrue(newAccount.isOwnerAddress(address(validAddress)));
    }

    /*//////////////////////////////////////////////////////////////
                          ENTRYPOINT TESTS
    //////////////////////////////////////////////////////////////*/
    function test_ShouldReturnCorrectEntryPoint() public view {
        address _entryPoint = address(justanAccount.entryPoint());
        assertEq(_entryPoint, networkConfig.entryPointAddress);
    }

    function test_ShouldReturnTrueIfCorrectInterface() public view {
        assertTrue(justanAccount.supportsInterface(type(IAccount).interfaceId));
        assertTrue(justanAccount.supportsInterface(type(IERC165).interfaceId));
        assertTrue(justanAccount.supportsInterface(type(IERC1271).interfaceId));
        assertTrue(justanAccount.supportsInterface(type(IERC721Receiver).interfaceId));
        assertTrue(justanAccount.supportsInterface(type(IERC1155Receiver).interfaceId));
    }

    /*//////////////////////////////////////////////////////////////
                        SUPPORTS INTERFACE TESTS
    //////////////////////////////////////////////////////////////*/
    function test_ShouldReturnFalseIfIncorrectInterface(bytes4 _interfaceId) public view {
        vm.assume(_interfaceId != type(IAccount).interfaceId);
        vm.assume(_interfaceId != type(IERC165).interfaceId);
        vm.assume(_interfaceId != type(IERC1271).interfaceId);
        vm.assume(_interfaceId != type(IERC721Receiver).interfaceId);
        vm.assume(_interfaceId != type(IERC1155Receiver).interfaceId);

        assertFalse(justanAccount.supportsInterface(_interfaceId));
    }

    /*//////////////////////////////////////////////////////////////
                            RECEIVER TESTS
    //////////////////////////////////////////////////////////////*/
    function test_ShouldReceiveERC721Correctly(uint256 tokenId) public {
        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);

        erc721Mock.mint(NFT_OWNER, tokenId);

        vm.prank(NFT_OWNER);
        erc721Mock.approve(TEST_ACCOUNT_ADDRESS, tokenId);

        vm.prank(TEST_ACCOUNT_ADDRESS);
        erc721Mock.safeTransferFrom(NFT_OWNER, TEST_ACCOUNT_ADDRESS, tokenId);

        assertEq(erc721Mock.balanceOf(TEST_ACCOUNT_ADDRESS), 1);

        vm.prank(TEST_ACCOUNT_ADDRESS);
        erc721Mock.safeTransferFrom(TEST_ACCOUNT_ADDRESS, NFT_OWNER, tokenId);

        assertEq(erc721Mock.balanceOf(TEST_ACCOUNT_ADDRESS), 0);
    }

    function test_ShouldReceiveERC1155Correctly(uint256 tokenId, uint256 amount) public {
        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);

        erc1155Mock.mint(NFT_OWNER, tokenId, amount, bytes(""));

        vm.prank(NFT_OWNER);
        erc1155Mock.safeTransferFrom(NFT_OWNER, TEST_ACCOUNT_ADDRESS, tokenId, amount, bytes(""));

        assertEq(erc1155Mock.balanceOf(TEST_ACCOUNT_ADDRESS, tokenId), amount);

        vm.prank(TEST_ACCOUNT_ADDRESS);
        erc1155Mock.safeTransferFrom(TEST_ACCOUNT_ADDRESS, NFT_OWNER, tokenId, amount, bytes(""));

        assertEq(erc1155Mock.balanceOf(TEST_ACCOUNT_ADDRESS, tokenId), 0);
    }

    function test_ShouldReceiveEtherCorrectly(address sender, uint256 amount) public payable {
        vm.assume(sender != address(0));
        vm.assume(sender != TEST_ACCOUNT_ADDRESS);

        vm.deal(sender, amount);

        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);

        vm.prank(sender);
        (bool success,) = payable(TEST_ACCOUNT_ADDRESS).call{ value: amount }("");
        assertTrue(success);

        assertEq(TEST_ACCOUNT_ADDRESS.balance, amount);
    }

}
