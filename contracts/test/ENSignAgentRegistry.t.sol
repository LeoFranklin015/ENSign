// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test, console2 } from "forge-std/Test.sol";

import { VerifiableFactory } from
    "@ensdomains/verifiable-factory/VerifiableFactory.sol";

import { UserRegistry } from "@ensv2/registry/UserRegistry.sol";
import { PermissionedRegistry } from "@ensv2/registry/PermissionedRegistry.sol";
import { IRegistry } from "@ensv2/registry/interfaces/IRegistry.sol";
import { RegistryRolesLib } from "@ensv2/registry/libraries/RegistryRolesLib.sol";
import { EACBaseRolesLib } from "@ensv2/access-control/libraries/EACBaseRolesLib.sol";
import { LibLabel } from "@ensv2/utils/LibLabel.sol";
import { PermissionedResolver } from "@ensv2/resolver/PermissionedResolver.sol";
import { IHCAFactoryBasic } from "@ensv2/hca/interfaces/IHCAFactoryBasic.sol";
import { IRegistryMetadata } from "@ensv2/registry/interfaces/IRegistryMetadata.sol";
import { SimpleRegistryMetadata } from "@ensv2/registry/SimpleRegistryMetadata.sol";

/// @notice Inlined HCA factory mock — matches the one in contracts-v2/test/mocks
///         but defined here to avoid the upstream's `~src/` remapping.
contract MockHCAFactoryBasic is IHCAFactoryBasic {
    mapping(address => address) internal _ownerOf;
    function setAccountOwner(address hca, address owner) external { _ownerOf[hca] = owner; }
    function getAccountOwner(address hca) external view returns (address) { return _ownerOf[hca]; }
}

import { ENSignAgentRegistry, IExecutable, IPermissionedResolver, IVerifiableFactoryLite } from "../src/ENSignAgentRegistry.sol";

/// @notice Bare-bones smart account that implements `IExecutable.executeBatch`,
///         restricted to the owner or any authorized executor (mirrors what
///         SmartAccount.setExecutor does, but stripped to the essentials).
///
/// @dev    We use this in unit tests instead of the full SmartAccount because
///         the full ERC-4337 + WebAuthn pipeline is overkill for testing the
///         agent registry's logic. This account satisfies the interface contract
///         the manager actually depends on.
contract MockSmartAccount is IExecutable {
    address public owner;
    mapping(address => bool) public isExecutor;

    error NotAuthorized();

    constructor(address _owner) {
        owner = _owner;
    }

    function setExecutor(address executor, bool authorized) external {
        if (msg.sender != address(this) && msg.sender != owner) revert NotAuthorized();
        isExecutor[executor] = authorized;
    }

    function executeBatch(IExecutable.Call[] calldata calls) external override {
        if (msg.sender != owner && !isExecutor[msg.sender]) revert NotAuthorized();
        uint256 n = calls.length;
        for (uint256 i; i < n; ++i) {
            (bool ok, bytes memory ret) = calls[i].target.call{ value: calls[i].value }(calls[i].data);
            if (!ok) {
                assembly { revert(add(ret, 0x20), mload(ret)) }
            }
        }
    }

    /// @dev ERC-1155 receiver — registry mints tokens to the account.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external pure returns (bytes4) { return 0xf23a6e61; }
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external pure returns (bytes4) { return 0xbc197c81; }
    function supportsInterface(bytes4) external pure returns (bool) { return true; }

    receive() external payable { }
}

/// @notice Trivial ERC-20 used for spend-cap tests.
contract MockERC20 {
    string public constant name = "Mock";
    string public constant symbol = "MCK";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insuf");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allow");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

contract ENSignAgentRegistryTest is Test {
    /// @dev Parent label for the user (e.g., "leo")
    string constant LEO_LABEL = "leo";
    /// @dev Agent label under leo (e.g., "bot")
    string constant BOT_LABEL = "bot";
    /// @dev Mock parent node — namehash equivalent for tests. We compute a
    ///      stable bytes32 from the label so the contract's _childNode math
    ///      lines up with whatever we declare here.
    bytes32 constant LEO_PARENT_NODE = keccak256(abi.encodePacked(bytes32(uint256(0xfa1afe1)), keccak256(bytes("leo"))));

    VerifiableFactory factory;
    UserRegistry storageImpl;
    PermissionedResolver resolverImpl;
    UserRegistry storageRegistry; // The shared user-storage registry (where leo lives)

    ENSignAgentRegistry manager;

    MockSmartAccount leoAccount;
    address botSpender = makeAddr("botSpender");
    address attacker = makeAddr("attacker");

    uint256 leoTokenId;

    function setUp() public {
        factory = new VerifiableFactory();
        IHCAFactoryBasic hca = IHCAFactoryBasic(address(new MockHCAFactoryBasic()));
        SimpleRegistryMetadata meta = new SimpleRegistryMetadata(hca);
        storageImpl = new UserRegistry(hca, IRegistryMetadata(address(meta)));
        resolverImpl = new PermissionedResolver(hca);

        // Deploy the user-storage registry (where leo's name lives).
        bytes memory storageInit = abi.encodeCall(
            UserRegistry.initialize,
            (address(this), EACBaseRolesLib.ALL_ROLES)
        );
        storageRegistry = UserRegistry(
            factory.deployProxy(address(storageImpl), 0, storageInit)
        );

        // Mint "leo" inside it, owned by leoAccount.
        leoAccount = new MockSmartAccount(address(this));
        uint64 expiry = uint64(block.timestamp + 365 days);
        leoTokenId = storageRegistry.register(
            LEO_LABEL,
            address(leoAccount),
            IRegistry(address(0)),
            address(0),
            RegistryRolesLib.ROLE_SET_RESOLVER |
                RegistryRolesLib.ROLE_SET_SUBREGISTRY |
                RegistryRolesLib.ROLE_RENEW,
            expiry
        );

        // Deploy the manager.
        manager = new ENSignAgentRegistry(
            PermissionedRegistry(address(storageRegistry)),
            address(storageImpl),
            address(resolverImpl),
            IVerifiableFactoryLite(address(factory))
        );
    }

    // ─────────────────────────────────────── HELPERS ───────────────────────────────────────

    function _buildPermission() internal returns (ENSignAgentRegistry.Permission memory p) {
        ENSignAgentRegistry.CallPermission[] memory calls = new ENSignAgentRegistry.CallPermission[](1);
        calls[0] = ENSignAgentRegistry.CallPermission({
            target: makeAddr("erc20Target"),
            selector: bytes4(keccak256("transfer(address,uint256)")),
            checker: address(0)
        });

        ENSignAgentRegistry.SpendLimit[] memory spends = new ENSignAgentRegistry.SpendLimit[](1);
        spends[0] = ENSignAgentRegistry.SpendLimit({
            token: makeAddr("erc20Target"),
            allowance: 1000 ether,
            unit: ENSignAgentRegistry.PeriodUnit.Day,
            multiplier: 1
        });

        p = ENSignAgentRegistry.Permission({
            account: address(leoAccount),
            spender: botSpender,
            parentNode: LEO_PARENT_NODE,
            parentTokenId: leoTokenId,
            label: BOT_LABEL,
            start: uint48(block.timestamp),
            end: uint48(block.timestamp + 30 days),
            salt: 1,
            calls: calls,
            spends: spends
        });
    }

    // ─────────────────────────────────────── TESTS ───────────────────────────────────────

    /// @notice One-time user-side housekeeping: grant manager exec rights on
    ///         the smart account. Done before any agent operation.
    function _grantExecutor() internal {
        IExecutable.Call[] memory bootstrap = new IExecutable.Call[](1);
        bootstrap[0] = IExecutable.Call({
            target: address(leoAccount),
            value: 0,
            data: abi.encodeWithSignature("setExecutor(address,bool)", address(manager), true)
        });
        leoAccount.executeBatch(bootstrap);
    }

    /// @notice After first approve, wire leoAccount's parent subregistry to
    ///         point at the freshly-deployed agent registry. (User-side step.)
    function _wireSubregistry() internal {
        IExecutable.Call[] memory wire = new IExecutable.Call[](1);
        wire[0] = IExecutable.Call({
            target: address(storageRegistry),
            value: 0,
            data: abi.encodeCall(
                PermissionedRegistry.setSubregistry,
                (leoTokenId, IRegistry(manager.agentRegistryOf(address(leoAccount))))
            )
        });
        leoAccount.executeBatch(wire);
    }

    /// @notice approve(): lazy-deploys infra, mints subname, writes resolver
    ///         records, records permission. The user-side ENS housekeeping
    ///         (setSubregistry + setExecutor) is separate.
    function test_approveLazyDeploys() public {
        ENSignAgentRegistry.Permission memory p = _buildPermission();

        assertEq(manager.agentRegistryOf(address(leoAccount)), address(0));
        assertEq(manager.resolverOf(address(leoAccount)), address(0));

        vm.prank(address(leoAccount));
        (bytes32 hash, uint256 tokenId) = manager.approve(p);

        address agentRegistry = manager.agentRegistryOf(address(leoAccount));
        address resolver = manager.resolverOf(address(leoAccount));

        assertTrue(agentRegistry != address(0), "agent registry should be deployed");
        assertTrue(resolver != address(0), "resolver should be deployed");

        // Agent subname should exist inside the agent registry.
        assertTrue(tokenId != 0);
        address botOwner = PermissionedRegistry(agentRegistry).ownerOf(tokenId);
        assertEq(botOwner, botSpender, "agent subname should be owned by the spender");

        // Permission should be approved.
        assertTrue(manager.isApproved(p));
        assertFalse(manager.isRevoked(p));
        assertTrue(hash != bytes32(0));

        // After user wires the parent subregistry pointer, ENS resolution chain works.
        _wireSubregistry();
        IRegistry sub = storageRegistry.getSubregistry(LEO_LABEL);
        assertEq(address(sub), agentRegistry);
    }

    /// @notice Second approve for the same user should NOT redeploy infra —
    ///         agentRegistryOf should remain stable.
    function test_secondApproveReusesInfra() public {
        ENSignAgentRegistry.Permission memory p1 = _buildPermission();
        vm.prank(address(leoAccount));
        manager.approve(p1);
        address firstReg = manager.agentRegistryOf(address(leoAccount));

        // Build a second permission for a different agent label.
        ENSignAgentRegistry.Permission memory p2 = _buildPermission();
        p2.spender = makeAddr("trader");
        p2.label = "trader";
        p2.salt = 2;

        vm.prank(address(leoAccount));
        manager.approve(p2);

        assertEq(manager.agentRegistryOf(address(leoAccount)), firstReg, "infra should be reused");
        // Both subnames should be in the same agent registry.
        address botOwner = PermissionedRegistry(firstReg).ownerOf(
            PermissionedRegistry(firstReg).getTokenId(LibLabel.id("bot"))
        );
        address traderOwner = PermissionedRegistry(firstReg).ownerOf(
            PermissionedRegistry(firstReg).getTokenId(LibLabel.id("trader"))
        );
        assertEq(botOwner, botSpender);
        assertEq(traderOwner, makeAddr("trader"));
    }

    /// @notice Only the account itself can approve. Random caller must fail.
    function test_approve_unauthorized() public {
        ENSignAgentRegistry.Permission memory p = _buildPermission();
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                ENSignAgentRegistry.ENSignAgentRegistry_InvalidSender.selector,
                attacker, address(leoAccount)
            )
        );
        manager.approve(p);
    }

    /// @notice executeBatch enforces the call whitelist: bot can call the
    ///         allowed (target, selector); a different selector must revert.
    function test_executeBatch_callWhitelist() public {
        // Use a real ERC20 as the target so spend tracking works.
        MockERC20 token = new MockERC20();
        token.mint(address(leoAccount), 100 ether);

        // Build a permission that allows ONLY transfer() on this token.
        ENSignAgentRegistry.CallPermission[] memory calls = new ENSignAgentRegistry.CallPermission[](1);
        calls[0] = ENSignAgentRegistry.CallPermission({
            target: address(token),
            selector: bytes4(keccak256("transfer(address,uint256)")),
            checker: address(0)
        });
        ENSignAgentRegistry.SpendLimit[] memory spends = new ENSignAgentRegistry.SpendLimit[](1);
        spends[0] = ENSignAgentRegistry.SpendLimit({
            token: address(token),
            allowance: 50 ether,
            unit: ENSignAgentRegistry.PeriodUnit.Day,
            multiplier: 1
        });

        ENSignAgentRegistry.Permission memory p = ENSignAgentRegistry.Permission({
            account: address(leoAccount),
            spender: botSpender,
            parentNode: LEO_PARENT_NODE,
            parentTokenId: leoTokenId,
            label: BOT_LABEL,
            start: uint48(block.timestamp),
            end: uint48(block.timestamp + 30 days),
            salt: 1,
            calls: calls,
            spends: spends
        });

        vm.prank(address(leoAccount));
        manager.approve(p);
        _grantExecutor();

        // ─── Allowed call: transfer 10 tokens to recipient ───
        address recipient = makeAddr("recipient");
        IExecutable.Call[] memory tx1 = new IExecutable.Call[](1);
        tx1[0] = IExecutable.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", recipient, 10 ether)
        });

        vm.prank(botSpender);
        manager.executeBatch(p, tx1);

        assertEq(token.balanceOf(recipient), 10 ether);
        assertEq(token.balanceOf(address(leoAccount)), 90 ether);

        // ─── Disallowed call: approve() on the same token ───
        IExecutable.Call[] memory tx2 = new IExecutable.Call[](1);
        tx2[0] = IExecutable.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", recipient, 1 ether)
        });

        vm.prank(botSpender);
        vm.expectRevert(); // UnauthorizedCall
        manager.executeBatch(p, tx2);
    }

    /// @notice Spend cap enforced — second tx that pushes over the daily limit reverts.
    function test_executeBatch_spendCap() public {
        MockERC20 token = new MockERC20();
        token.mint(address(leoAccount), 1000 ether);

        ENSignAgentRegistry.CallPermission[] memory calls = new ENSignAgentRegistry.CallPermission[](1);
        calls[0] = ENSignAgentRegistry.CallPermission({
            target: address(token),
            selector: bytes4(keccak256("transfer(address,uint256)")),
            checker: address(0)
        });
        ENSignAgentRegistry.SpendLimit[] memory spends = new ENSignAgentRegistry.SpendLimit[](1);
        spends[0] = ENSignAgentRegistry.SpendLimit({
            token: address(token),
            allowance: 30 ether, // tight cap
            unit: ENSignAgentRegistry.PeriodUnit.Day,
            multiplier: 1
        });

        ENSignAgentRegistry.Permission memory p = ENSignAgentRegistry.Permission({
            account: address(leoAccount),
            spender: botSpender,
            parentNode: LEO_PARENT_NODE,
            parentTokenId: leoTokenId,
            label: BOT_LABEL,
            start: uint48(block.timestamp),
            end: uint48(block.timestamp + 30 days),
            salt: 1,
            calls: calls,
            spends: spends
        });

        vm.prank(address(leoAccount));
        manager.approve(p);
        _grantExecutor();

        address recipient = makeAddr("recipient");
        IExecutable.Call[] memory firstBatch = new IExecutable.Call[](1);
        firstBatch[0] = IExecutable.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", recipient, 25 ether)
        });
        vm.prank(botSpender);
        manager.executeBatch(p, firstBatch); // 25 spent, 5 left

        // 10 ether more would push to 35 > 30 cap → revert.
        IExecutable.Call[] memory secondBatch = new IExecutable.Call[](1);
        secondBatch[0] = IExecutable.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", recipient, 10 ether)
        });
        vm.prank(botSpender);
        vm.expectRevert(); // ExceededSpendLimit
        manager.executeBatch(p, secondBatch);
    }

    /// @notice Revoke makes future executeBatch calls fail.
    function test_revoke() public {
        ENSignAgentRegistry.Permission memory p = _buildPermission();
        vm.prank(address(leoAccount));
        manager.approve(p);
        _grantExecutor();

        assertTrue(manager.isApproved(p));
        assertFalse(manager.isRevoked(p));

        vm.prank(address(leoAccount));
        manager.revoke(p);

        assertTrue(manager.isRevoked(p));

        // Spender can't executeBatch anymore.
        IExecutable.Call[] memory empty = new IExecutable.Call[](1);
        empty[0] = IExecutable.Call({ target: makeAddr("erc20Target"), value: 0, data: abi.encodeWithSignature("transfer(address,uint256)", botSpender, 0) });
        vm.prank(botSpender);
        vm.expectRevert();
        manager.executeBatch(p, empty);
    }
}
