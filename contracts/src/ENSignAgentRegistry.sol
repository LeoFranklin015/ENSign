// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { ERC165Checker } from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import { DateTimeLib } from "solady/utils/DateTimeLib.sol";
import { DynamicArrayLib } from "solady/utils/DynamicArrayLib.sol";
import { EIP712 } from "solady/utils/EIP712.sol";
import { FixedPointMathLib as Math } from "solady/utils/FixedPointMathLib.sol";
import { LibBytes } from "solady/utils/LibBytes.sol";
import { LibSort } from "solady/utils/LibSort.sol";
import { ReentrancyGuard } from "solady/utils/ReentrancyGuard.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";

import { IRegistry } from "@ensv2/registry/interfaces/IRegistry.sol";
import { PermissionedRegistry } from "@ensv2/registry/PermissionedRegistry.sol";
import { UserRegistry } from "@ensv2/registry/UserRegistry.sol";
import { RegistryRolesLib } from "@ensv2/registry/libraries/RegistryRolesLib.sol";
import { EACBaseRolesLib } from "@ensv2/access-control/libraries/EACBaseRolesLib.sol";

/// @notice Generic execution interface — any account that exposes `executeBatch`
///         can be the `account` in a permission. Replaces the old hard import
///         of `SmartAccount` so the manager isn't tied to a specific account
///         implementation.
interface IExecutable {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }
    function executeBatch(Call[] calldata calls) external;
}

/// @notice Optional pluggable authorization layer. A `CallPermission.checker`
///         pointing at this interface gets called for every matching execution.
interface ICallChecker {
    function canExecute(
        bytes32 permissionHash,
        address account,
        address spender,
        address target,
        uint256 value,
        bytes calldata data
    ) external view returns (bool);
}

/// @notice Minimal Permit2 surface so we can build the lockdown call without
///         pulling in the permit2 lib as a dep. Only used during approval revocation.
interface IPermit2Lockdown {
    struct TokenSpenderPair {
        address token;
        address spender;
    }
    function lockdown(TokenSpenderPair[] calldata approvals) external;
}

/// @notice Verifiable factory surface for deploying canonical-impl proxies.
///         Keeps the agent registry's storage layout indexer-recognised.
interface IVerifiableFactoryLite {
    function deployProxy(
        address implementation,
        uint256 salt,
        bytes calldata data
    ) external returns (address);
}

/// @notice Minimal write surface on a per-subname `PermissionedResolver` proxy.
interface IPermissionedResolver {
    function initialize(address admin, uint256 roleBitmap) external;
    function setAddr(bytes32 node, uint256 coinType, bytes calldata addressBytes) external;
    function setText(bytes32 node, string calldata key, string calldata value) external;
}

/**
 * @title ENSignAgentRegistry
 *
 * @notice Permission-gated agent delegation. Acts as both:
 *
 *           1. An ENS subname registrar — when a user approves a permission,
 *              the agent's subname is atomically minted in the user's
 *              per-user agent `UserRegistry` proxy (lazy-deployed on first
 *              approval). The agent's address + permission hash are written
 *              to the agent's resolver as `addr` and `text("permission")`.
 *
 *           2. A capability ledger — calls/spends are validated and tracked
 *              here. `executeBatch` runs as the spender (agent), checks the
 *              permission, and calls back into the user's account via
 *              `IExecutable.executeBatch` to perform the actual writes.
 *
 *         The user's account never has to hand over ownership; instead it
 *         authorizes this manager as an "executor" (see `SmartAccount.setExecutor`).
 */
contract ENSignAgentRegistry is EIP712, ReentrancyGuard {

    using SafeERC20 for IERC20;
    using LibBytes for *;
    using DynamicArrayLib for *;

    // ─────────────────────────────────────────── ERRORS ───────────────────────────────────────────

    error ENSignAgentRegistry_InvalidSender(address sender, address expected);
    error ENSignAgentRegistry_UnauthorizedPermission();
    error ENSignAgentRegistry_ZeroSpender();
    error ENSignAgentRegistry_InvalidStartEnd(uint48 start, uint48 end);
    error ENSignAgentRegistry_BeforePermissionStart(uint48 currentTimestamp, uint48 start);
    error ENSignAgentRegistry_AfterPermissionEnd(uint48 currentTimestamp, uint48 end);
    error ENSignAgentRegistry_SpendValueOverflow(uint256 value);
    error ENSignAgentRegistry_ExceededSpendLimit(uint256 value, uint256 allowance);
    error ENSignAgentRegistry_UnauthorizedCall(address target, bytes4 selector);
    error ENSignAgentRegistry_ZeroToken();
    error ENSignAgentRegistry_ZeroAllowance();
    error ENSignAgentRegistry_ERC721TokenNotSupported(address token);
    error ENSignAgentRegistry_ERC1155TokenNotSupported(address token);
    error ENSignAgentRegistry_EmptyPermission();
    error ENSignAgentRegistry_ZeroTarget();
    error ENSignAgentRegistry_ZeroSelector();
    error ENSignAgentRegistry_DuplicateSpendLimit();
    error ENSignAgentRegistry_NoSpendPermissions();
    error ENSignAgentRegistry_CannotTargetSelf();
    error ENSignAgentRegistry_CannotTargetAccount();
    error ENSignAgentRegistry_PeriodOverflow();
    error ENSignAgentRegistry_ApprovalRevocationFailed(address token, address spender);
    error ENSignAgentRegistry_ZeroMultiplier();
    error ENSignAgentRegistry_CheckerRejectedCall(address target, bytes4 selector, address checker);
    error ENSignAgentRegistry_CheckerHasNoCode(address checker);
    error ENSignAgentRegistry_InvalidCalldataLength(uint256 length);
    error ENSignAgentRegistry_EmptyLabel();
    error ENSignAgentRegistry_NotParentOwner(address account, uint256 parentTokenId);

    // ─────────────────────────────────────────── ENUMS ───────────────────────────────────────────

    enum PeriodUnit {
        Minute,
        Hour,
        Day,
        Week,
        Month,
        Forever
    }

    // ─────────────────────────────────────────── STRUCTS ─────────────────────────────────────────

    /// @notice A call permission allowing execution of specific functions.
    struct CallPermission {
        address target;
        bytes4 selector;
        address checker;
    }

    /// @notice A spend limit for a specific token with recurring periods.
    struct SpendLimit {
        address token;
        uint160 allowance;
        PeriodUnit unit;
        uint16 multiplier; // 1-65535, ignored for Forever
    }

    /// @notice Complete permission: who-can-call-what + how-much-can-be-spent +
    ///         which subname this agent gets minted under the user's name.
    struct Permission {
        address account;        // The user's smart account
        address spender;        // The agent (any executable address)
        bytes32 parentNode;     // namehash of the user's name (e.g., leo.ensign.eth)
        uint256 parentTokenId;  // user's tokenId in the parent storage registry
        string  label;          // agent label (e.g., "bot")
        uint48  start;
        uint48  end;
        uint256 salt;
        CallPermission[] calls;
        SpendLimit[]     spends;
    }

    struct PeriodSpend {
        uint48 start;
        uint48 end;
        uint160 spend;
    }

    /// @dev Temp storage during executeBatch — kept as struct to avoid stack-deep.
    struct ExecuteTemps {
        DynamicArrayLib.DynamicArray approvedERC20s;
        DynamicArrayLib.DynamicArray approvalSpenders;
        DynamicArrayLib.DynamicArray erc20s;
        DynamicArrayLib.DynamicArray transferAmounts;
        DynamicArrayLib.DynamicArray permit2ERC20s;
        DynamicArrayLib.DynamicArray permit2Spenders;
    }

    // ─────────────────────────────────────────── CONSTANTS ───────────────────────────────────────

    address public constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    address public constant ANY_TARGET = 0x3232323232323232323232323232323232323232;
    bytes4 public constant ANY_FN_SEL = 0x32323232;
    bytes4 public constant EMPTY_CALLDATA_FN_SEL = 0xe0e0e0e0;

    /// @notice Roles granted to the agent (token owner) on its subname resource.
    uint256 internal constant AGENT_TOKEN_ROLES =
        RegistryRolesLib.ROLE_SET_RESOLVER |
        RegistryRolesLib.ROLE_SET_SUBREGISTRY |
        RegistryRolesLib.ROLE_RENEW;

    bytes32 public constant CALL_PERMISSION_TYPEHASH =
        keccak256("CallPermission(address target,bytes4 selector,address checker)");

    bytes32 public constant SPEND_LIMIT_TYPEHASH =
        keccak256("SpendLimit(address token,uint160 allowance,uint8 unit,uint16 multiplier)");

    bytes32 public constant PERMISSION_TYPEHASH = keccak256(
        "Permission(address account,address spender,bytes32 parentNode,uint256 parentTokenId,string label,uint48 start,uint48 end,uint256 salt,CallPermission[] calls,SpendLimit[] spends)CallPermission(address target,bytes4 selector,address checker)SpendLimit(address token,uint160 allowance,uint8 unit,uint16 multiplier)"
    );

    // ─────────────────────────────────────────── IMMUTABLES ──────────────────────────────────────

    /// @notice Storage registry where users live (e.g., the canonical UserRegistry
    ///         proxy that holds `leo`, `alice`, …). Each user's tokenId here is
    ///         what we point at their freshly-deployed agent registry.
    PermissionedRegistry public immutable userStorageRegistry;

    /// @notice Canonical UserRegistry impl — used to deploy per-user agent
    ///         registries. Same impl as the parent so the indexer recognises them.
    address public immutable userRegistryImpl;

    /// @notice Canonical PermissionedResolver impl — one resolver proxy per
    ///         agent registry, shared across all of that user's agents.
    address public immutable resolverImpl;

    /// @notice Verifiable factory that deploys both the agent registry and the
    ///         shared resolver as upgradeable proxies.
    IVerifiableFactoryLite public immutable verifiableFactory;

    // ─────────────────────────────────────────── STORAGE ─────────────────────────────────────────

    mapping(bytes32 permissionHash => bool approved) internal _isApproved;
    mapping(bytes32 permissionHash => bool revoked) internal _isRevoked;
    mapping(bytes32 permissionHash => mapping(bytes32 spendLimitHash => PeriodSpend))
        internal _lastUpdatedPeriod;

    /// @notice Per-user agent registry proxy. Lazy-deployed on first approve().
    mapping(address account => address agentRegistry) public agentRegistryOf;

    /// @notice Per-user shared resolver proxy. Lazy-deployed alongside the registry.
    mapping(address account => address resolver) public resolverOf;

    // ─────────────────────────────────────────── EVENTS ──────────────────────────────────────────

    event AgentRegistryDeployed(address indexed account, address agentRegistry, address resolver);
    event PermissionApproved(bytes32 indexed permissionHash, Permission permission, uint256 tokenId);
    event PermissionRevoked(bytes32 indexed permissionHash);
    event CallsExecuted(bytes32 indexed permissionHash);
    event SpendLimitUsed(bytes32 indexed permissionHash, address indexed token, PeriodSpend periodSpend);

    // ─────────────────────────────────────────── MODIFIERS ───────────────────────────────────────

    modifier requireSender(address sender) {
        if (msg.sender != sender) {
            revert ENSignAgentRegistry_InvalidSender(msg.sender, sender);
        }
        _;
    }

    constructor(
        PermissionedRegistry _userStorageRegistry,
        address _userRegistryImpl,
        address _resolverImpl,
        IVerifiableFactoryLite _verifiableFactory
    ) {
        userStorageRegistry = _userStorageRegistry;
        userRegistryImpl = _userRegistryImpl;
        resolverImpl = _resolverImpl;
        verifiableFactory = _verifiableFactory;
    }

    // ─────────────────────────────────────────── ADMIN ───────────────────────────────────────────

    /// @notice Approve a permission. On the first call for a given account this
    ///         lazily deploys that account's agent UserRegistry + shared resolver,
    ///         wires the user's parent ENS subregistry pointer, grants this
    ///         contract ROLE_REGISTRAR + executor authorization — all batched
    ///         atomically through `account.executeBatch`. After setup, the
    ///         agent subname is minted, resolver records are written, and the
    ///         permission is recorded.
    function approve(Permission calldata permission)
        external
        nonReentrant
        requireSender(permission.account)
        returns (bytes32 hash, uint256 tokenId)
    {
        _validatePermission(permission);

        hash = getHash(permission);

        if (_isRevoked[hash]) revert ENSignAgentRegistry_UnauthorizedPermission();
        if (_isApproved[hash]) {
            // Already approved — nothing else to do.
            return (hash, 0);
        }

        // Verify the caller actually owns the parent name in the storage registry.
        if (userStorageRegistry.ownerOf(permission.parentTokenId) != permission.account) {
            revert ENSignAgentRegistry_NotParentOwner(permission.account, permission.parentTokenId);
        }

        // ─── First approve for this user: lazy-deploy infra ───
        address agentRegistry = agentRegistryOf[permission.account];
        address resolver = resolverOf[permission.account];
        if (agentRegistry == address(0)) {
            (agentRegistry, resolver) = _setupForUser(permission.account);
        }

        // ─── Mint the agent subname inside leo's agent registry ───
        tokenId = PermissionedRegistry(agentRegistry).register(
            permission.label,
            permission.spender,
            IRegistry(address(0)),
            resolver,
            AGENT_TOKEN_ROLES,
            permission.end
        );

        // ─── Write resolver records (addr = spender, text("permission") = hash) ───
        bytes32 childNode = _childNode(permission.parentNode, keccak256(bytes(permission.label)));
        IPermissionedResolver(resolver).setAddr(
            childNode,
            60, // SLIP-44 ETH
            abi.encodePacked(permission.spender)
        );
        IPermissionedResolver(resolver).setText(
            childNode,
            "permission",
            _toHexString(hash)
        );

        _isApproved[hash] = true;
        emit PermissionApproved(hash, permission, tokenId);
    }

    /// @notice Revoke a permission as the account owner.
    function revoke(Permission calldata permission)
        external
        nonReentrant
        requireSender(permission.account)
    {
        _revoke(permission);
    }

    /// @notice Revoke a permission as the spender.
    function revokeAsSpender(Permission calldata permission)
        external
        nonReentrant
        requireSender(permission.spender)
    {
        _revoke(permission);
    }

    // ─────────────────────────────────────────── EXECUTION ───────────────────────────────────────

    /// @notice Run a batch of calls under a permission, as the spender. Same
    ///         enforcement model as the legacy permission manager — calldata
    ///         whitelist, optional `ICallChecker`s, balance-tracked spend caps,
    ///         and approval auto-revoke.
    function executeBatch(
        Permission calldata permission,
        IExecutable.Call[] calldata calls
    )
        external
        nonReentrant
        requireSender(permission.spender)
    {
        bytes32 hash = getHash(permission);
        _checkApprovedNotRevoked(hash);
        _checkPermissionTimeBounds(permission.start, permission.end);

        // STEP 1: per-call whitelist + checker validation (fail-fast)
        uint256 callsLength = calls.length;
        for (uint256 i = 0; i < callsLength;) {
            address target = calls[i].target;
            if (target == address(this)) revert ENSignAgentRegistry_CannotTargetSelf();
            if (target == permission.account) revert ENSignAgentRegistry_CannotTargetAccount();

            uint256 dataLength = calls[i].data.length;
            if (dataLength > 0 && dataLength < 4) {
                revert ENSignAgentRegistry_InvalidCalldataLength(dataLength);
            }

            bytes4 selector = dataLength >= 4
                ? bytes4(LibBytes.loadCalldata(calls[i].data, 0x00))
                : EMPTY_CALLDATA_FN_SEL;

            (bool isAllowed, address[] memory matchingCheckers) =
                _findMatchingPermissions(permission, target, selector);
            if (!isAllowed) revert ENSignAgentRegistry_UnauthorizedCall(target, selector);

            uint256 checkersLength = matchingCheckers.length;
            for (uint256 j = 0; j < checkersLength;) {
                if (
                    !ICallChecker(matchingCheckers[j]).canExecute(
                        hash, permission.account, permission.spender, target, calls[i].value, calls[i].data
                    )
                ) {
                    revert ENSignAgentRegistry_CheckerRejectedCall(target, selector, matchingCheckers[j]);
                }
                unchecked { ++j; }
            }

            unchecked { ++i; }
        }

        // STEP 2: collect tracked tokens, parse calldata for token ops, snapshot balances
        ExecuteTemps memory t;

        uint256 spendsLength = permission.spends.length;
        for (uint256 i = 0; i < spendsLength;) {
            address token = permission.spends[i].token;
            if (token != NATIVE_TOKEN) {
                t.erc20s.p(token);
                t.transferAmounts.p(uint256(0));
            }
            unchecked { ++i; }
        }

        uint256 totalNativeSpend;
        for (uint256 i; i < callsLength; ++i) {
            address target = calls[i].target;
            uint256 value = calls[i].value;
            bytes calldata data = calls[i].data;

            if (value != 0) totalNativeSpend += value;
            if (data.length < 4) continue;

            uint32 fnSel = uint32(bytes4(LibBytes.loadCalldata(data, 0x00)));

            // transfer(address,uint256)
            if (fnSel == 0xa9059cbb) {
                t.erc20s.p(target);
                t.transferAmounts.p(LibBytes.loadCalldata(data, 0x24));
            }
            // transferFrom(address,address,uint256)
            if (fnSel == 0x23b872dd) {
                if (ERC165Checker.supportsInterface(target, type(IERC721).interfaceId)) continue;
                address from = _lsbToAddress(LibBytes.loadCalldata(data, 0x04));
                if (LibBytes.loadCalldata(data, 0x44) == 0) continue;
                if (from == permission.account) {
                    t.erc20s.p(target);
                    t.transferAmounts.p(LibBytes.loadCalldata(data, 0x44));
                }
            }
            // approve(address,uint256)
            if (fnSel == 0x095ea7b3) {
                if (ERC165Checker.supportsInterface(target, type(IERC721).interfaceId)) continue;
                if (LibBytes.loadCalldata(data, 0x24) == 0) continue;
                t.approvedERC20s.p(target);
                t.approvalSpenders.p(_lsbToAddress(LibBytes.loadCalldata(data, 0x04)));
                t.erc20s.p(target);
                t.transferAmounts.p(LibBytes.loadCalldata(data, 0x24));
            }
            // increaseAllowance(address,uint256)
            if (fnSel == 0x39509351) {
                if (LibBytes.loadCalldata(data, 0x24) == 0) continue;
                t.approvedERC20s.p(target);
                t.approvalSpenders.p(_lsbToAddress(LibBytes.loadCalldata(data, 0x04)));
                t.erc20s.p(target);
                t.transferAmounts.p(LibBytes.loadCalldata(data, 0x24));
            }
            // Permit2 approve(address,address,uint160,uint48)
            if (fnSel == 0x87517c45) {
                if (target != PERMIT2) continue;
                if (LibBytes.loadCalldata(data, 0x44) == 0) continue;
                t.permit2ERC20s.p(_lsbToAddress(LibBytes.loadCalldata(data, 0x04)));
                t.permit2Spenders.p(_lsbToAddress(LibBytes.loadCalldata(data, 0x24)));
                t.erc20s.p(_lsbToAddress(LibBytes.loadCalldata(data, 0x04)));
                t.transferAmounts.p(LibBytes.loadCalldata(data, 0x44));
            }
        }

        if (t.erc20s.length() > 0) {
            LibSort.groupSum(t.erc20s.data, t.transferAmounts.data);
        }

        uint256[] memory balancesBefore = DynamicArrayLib.malloc(t.erc20s.length());
        for (uint256 i; i < t.erc20s.length(); ++i) {
            address token = t.erc20s.getAddress(i);
            balancesBefore.set(i, SafeTransferLib.balanceOf(token, permission.account));
        }

        // STEP 3: execute through the user's account
        _executeBatch(permission.account, calls);

        emit CallsExecuted(hash);

        // STEP 4: spend cap accounting + approval revocation
        if (totalNativeSpend != 0) {
            _checkAndIncrementSpend(hash, permission, NATIVE_TOKEN, totalNativeSpend);
        }

        uint256 approvedLength = t.approvedERC20s.length();
        if (approvedLength > 0) {
            IExecutable.Call[] memory revokeCalls = new IExecutable.Call[](approvedLength);
            for (uint256 i; i < approvedLength; ++i) {
                revokeCalls[i] = IExecutable.Call({
                    target: t.approvedERC20s.getAddress(i),
                    value: 0,
                    data: abi.encodeWithSelector(
                        IERC20.approve.selector,
                        t.approvalSpenders.getAddress(i),
                        0
                    )
                });
            }
            _executeBatch(permission.account, revokeCalls);

            for (uint256 i; i < approvedLength; ++i) {
                address token = t.approvedERC20s.getAddress(i);
                address spender = t.approvalSpenders.getAddress(i);
                if (IERC20(token).allowance(permission.account, spender) != 0) {
                    revert ENSignAgentRegistry_ApprovalRevocationFailed(token, spender);
                }
            }
        }

        uint256 permit2Length = t.permit2ERC20s.length();
        if (permit2Length > 0) {
            IPermit2Lockdown.TokenSpenderPair[] memory approvals =
                new IPermit2Lockdown.TokenSpenderPair[](permit2Length);
            for (uint256 i; i < permit2Length; ++i) {
                approvals[i] = IPermit2Lockdown.TokenSpenderPair({
                    token: t.permit2ERC20s.getAddress(i),
                    spender: t.permit2Spenders.getAddress(i)
                });
            }
            IExecutable.Call[] memory permit2RevokeCalls = new IExecutable.Call[](1);
            permit2RevokeCalls[0] = IExecutable.Call({
                target: PERMIT2,
                value: 0,
                data: abi.encodeWithSelector(IPermit2Lockdown.lockdown.selector, approvals)
            });
            _executeBatch(permission.account, permit2RevokeCalls);
        }

        for (uint256 i; i < t.erc20s.length(); ++i) {
            address token = t.erc20s.getAddress(i);
            uint256 spentAmount = Math.max(
                t.transferAmounts.get(i),
                Math.saturatingSub(
                    balancesBefore.get(i),
                    SafeTransferLib.balanceOf(token, permission.account)
                )
            );
            if (spentAmount > 0) {
                _checkAndIncrementSpend(hash, permission, token, spentAmount);
            }
        }
    }

    // ─────────────────────────────────────────── VIEWS ───────────────────────────────────────────

    function isApproved(Permission calldata permission) external view returns (bool) {
        return _isApproved[getHash(permission)];
    }

    function isRevoked(Permission calldata permission) external view returns (bool) {
        return _isRevoked[getHash(permission)];
    }

    function getLastUpdatedPeriod(
        Permission calldata permission,
        SpendLimit calldata spendLimit
    ) external view returns (PeriodSpend memory) {
        return _lastUpdatedPeriod[getHash(permission)][_hashSpendLimit(spendLimit)];
    }

    function getCurrentPeriod(
        Permission calldata permission,
        SpendLimit calldata spendLimit
    ) external view returns (PeriodSpend memory) {
        bytes32 hash = getHash(permission);
        return _getCurrentPeriod(hash, _hashSpendLimit(spendLimit), spendLimit, permission.start, permission.end);
    }

    function getHash(Permission calldata permission) public view returns (bytes32) {
        uint256 callsLength = permission.calls.length;
        bytes32[] memory callHashes = new bytes32[](callsLength);
        for (uint256 i = 0; i < callsLength;) {
            callHashes[i] = _hashCallPermission(permission.calls[i]);
            unchecked { ++i; }
        }

        uint256 spendsLength = permission.spends.length;
        bytes32[] memory spendHashes = new bytes32[](spendsLength);
        for (uint256 i = 0; i < spendsLength;) {
            spendHashes[i] = _hashSpendLimit(permission.spends[i]);
            unchecked { ++i; }
        }

        return _hashTypedData(
            keccak256(
                abi.encode(
                    PERMISSION_TYPEHASH,
                    permission.account,
                    permission.spender,
                    permission.parentNode,
                    permission.parentTokenId,
                    keccak256(bytes(permission.label)),
                    permission.start,
                    permission.end,
                    permission.salt,
                    keccak256(abi.encodePacked(callHashes)),
                    keccak256(abi.encodePacked(spendHashes))
                )
            )
        );
    }

    function startOfSpendPeriod(
        uint256 unixTimestamp,
        PeriodUnit unit,
        uint16 multiplier,
        uint256 permissionStart
    ) public pure returns (uint256) {
        if (unit == PeriodUnit.Forever) return 1;
        if (unit == PeriodUnit.Month) {
            (uint256 periodStart,) = _monthPeriodStart(unixTimestamp, multiplier, permissionStart);
            return periodStart;
        }
        return _fixedPeriodStart(unixTimestamp, unit, multiplier, permissionStart);
    }

    // ─────────────────────────────────────────── INTERNAL ────────────────────────────────────────

    /// @notice Lazy-deploys leo's agent UserRegistry + shared resolver proxies.
    ///         No callback into the user's account — the user is responsible
    ///         for `setExecutor(manager, true)` and `parentRegistry.setSubregistry`
    ///         as one-time ENS housekeeping (typically batched into the same
    ///         outer `account.executeBatch` that calls `approve()`).
    function _setupForUser(address account)
        internal
        returns (address agentRegistry, address resolver)
    {
        // Agent registry — admin = this contract so we have ROLE_REGISTRAR
        // out of the box. User retains soft control via ENS hierarchy
        // (ownerOf(parentTokenId) == account).
        bytes memory registryInitData = abi.encodeCall(
            UserRegistry.initialize,
            (address(this), EACBaseRolesLib.ALL_ROLES)
        );
        uint256 registrySalt = uint256(keccak256(abi.encode("agent-registry", account)));
        agentRegistry = verifiableFactory.deployProxy(
            userRegistryImpl,
            registrySalt,
            registryInitData
        );

        // Shared resolver — admin = this contract so we can write records during approve().
        bytes memory resolverInitData = abi.encodeCall(
            IPermissionedResolver.initialize,
            (address(this), EACBaseRolesLib.ALL_ROLES)
        );
        uint256 resolverSalt = uint256(keccak256(abi.encode("agent-resolver", account)));
        resolver = verifiableFactory.deployProxy(
            resolverImpl,
            resolverSalt,
            resolverInitData
        );

        agentRegistryOf[account] = agentRegistry;
        resolverOf[account] = resolver;

        emit AgentRegistryDeployed(account, agentRegistry, resolver);
    }

    function _validatePermission(Permission calldata permission) internal view {
        if (permission.spender == address(0)) revert ENSignAgentRegistry_ZeroSpender();
        if (permission.start >= permission.end) {
            revert ENSignAgentRegistry_InvalidStartEnd(permission.start, permission.end);
        }
        if (bytes(permission.label).length == 0) revert ENSignAgentRegistry_EmptyLabel();
        if (permission.calls.length == 0) revert ENSignAgentRegistry_EmptyPermission();

        uint256 callsLength = permission.calls.length;
        for (uint256 i = 0; i < callsLength;) {
            CallPermission calldata c = permission.calls[i];
            if (c.target == address(this)) revert ENSignAgentRegistry_CannotTargetSelf();
            if (c.target == permission.account) revert ENSignAgentRegistry_CannotTargetAccount();
            if (c.target == address(0)) revert ENSignAgentRegistry_ZeroTarget();
            if (c.selector == bytes4(0)) revert ENSignAgentRegistry_ZeroSelector();
            if (c.checker == address(this)) revert ENSignAgentRegistry_CannotTargetSelf();
            if (c.checker == permission.account) revert ENSignAgentRegistry_CannotTargetAccount();
            if (c.checker != address(0) && c.checker.code.length == 0) {
                revert ENSignAgentRegistry_CheckerHasNoCode(c.checker);
            }
            unchecked { ++i; }
        }

        uint256 spendsLength = permission.spends.length;
        for (uint256 i = 0; i < spendsLength;) {
            SpendLimit calldata s = permission.spends[i];
            if (s.token == address(0)) revert ENSignAgentRegistry_ZeroToken();
            if (s.allowance == 0) revert ENSignAgentRegistry_ZeroAllowance();
            if (s.multiplier == 0) revert ENSignAgentRegistry_ZeroMultiplier();
            if (s.token != NATIVE_TOKEN) {
                if (ERC165Checker.supportsInterface(s.token, type(IERC721).interfaceId)) {
                    revert ENSignAgentRegistry_ERC721TokenNotSupported(s.token);
                }
                if (ERC165Checker.supportsInterface(s.token, type(IERC1155).interfaceId)) {
                    revert ENSignAgentRegistry_ERC1155TokenNotSupported(s.token);
                }
            }
            unchecked { ++i; }
        }

        if (spendsLength > 1) {
            bytes32[] memory spendHashes = new bytes32[](spendsLength);
            for (uint256 i = 0; i < spendsLength;) {
                spendHashes[i] = _hashSpendLimit(permission.spends[i]);
                unchecked { ++i; }
            }
            LibSort.sort(spendHashes);
            for (uint256 i = 1; i < spendsLength;) {
                if (spendHashes[i] == spendHashes[i - 1]) {
                    revert ENSignAgentRegistry_DuplicateSpendLimit();
                }
                unchecked { ++i; }
            }
        }
    }

    function _findMatchingPermissions(
        Permission calldata permission,
        address target,
        bytes4 selector
    )
        internal
        pure
        returns (bool matched, address[] memory checkers)
    {
        uint256 callsLength = permission.calls.length;
        checkers = new address[](callsLength);
        bool hasMatch;
        uint256 idx;

        for (uint256 i = 0; i < callsLength;) {
            bool targetMatch = permission.calls[i].target == target || permission.calls[i].target == ANY_TARGET;
            bool selectorMatch = permission.calls[i].selector == selector || permission.calls[i].selector == ANY_FN_SEL;
            if (targetMatch && selectorMatch) {
                hasMatch = true;
                if (permission.calls[i].checker != address(0)) {
                    checkers[idx++] = permission.calls[i].checker;
                }
            }
            unchecked { ++i; }
        }

        if (!hasMatch) return (false, checkers);

        assembly {
            mstore(checkers, idx)
        }
        return (true, checkers);
    }

    function _checkAndIncrementSpend(
        bytes32 hash,
        Permission calldata permission,
        address token,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        bool found;
        uint256 spendsLength = permission.spends.length;
        for (uint256 i = 0; i < spendsLength;) {
            if (permission.spends[i].token == token) {
                found = true;
                bytes32 spendLimitHash = _hashSpendLimit(permission.spends[i]);
                _useSpendLimit(hash, spendLimitHash, permission.spends[i], amount, permission.start, permission.end);
            }
            unchecked { ++i; }
        }
        if (!found) revert ENSignAgentRegistry_NoSpendPermissions();
    }

    function _checkApprovedNotRevoked(bytes32 hash) internal view {
        if (!_isApproved[hash] || _isRevoked[hash]) {
            revert ENSignAgentRegistry_UnauthorizedPermission();
        }
    }

    function _checkPermissionTimeBounds(uint48 start, uint48 end) internal view returns (uint48 currentTimestamp) {
        currentTimestamp = uint48(block.timestamp);
        if (currentTimestamp < start) {
            revert ENSignAgentRegistry_BeforePermissionStart(currentTimestamp, start);
        }
        if (currentTimestamp > end) {
            revert ENSignAgentRegistry_AfterPermissionEnd(currentTimestamp, end);
        }
    }

    function _useSpendLimit(
        bytes32 hash,
        bytes32 spendLimitHash,
        SpendLimit calldata spendLimit,
        uint256 value,
        uint48 permissionStart,
        uint48 permissionEnd
    ) internal {
        PeriodSpend memory currentPeriod =
            _getCurrentPeriod(hash, spendLimitHash, spendLimit, permissionStart, permissionEnd);

        uint256 totalSpend = value + uint256(currentPeriod.spend);
        if (totalSpend > type(uint160).max) {
            revert ENSignAgentRegistry_SpendValueOverflow(totalSpend);
        }
        if (totalSpend > spendLimit.allowance) {
            revert ENSignAgentRegistry_ExceededSpendLimit(totalSpend, spendLimit.allowance);
        }

        currentPeriod.spend = uint160(totalSpend);
        _lastUpdatedPeriod[hash][spendLimitHash] = currentPeriod;

        emit SpendLimitUsed(hash, spendLimit.token, PeriodSpend(currentPeriod.start, currentPeriod.end, uint160(value)));
    }

    function _getCurrentPeriod(
        bytes32 hash,
        bytes32 spendLimitHash,
        SpendLimit calldata spendLimit,
        uint48 permissionStart,
        uint48 permissionEnd
    ) internal view returns (PeriodSpend memory) {
        uint48 currentTimestamp = _checkPermissionTimeBounds(permissionStart, permissionEnd);

        PeriodSpend memory lastUpdatedPeriod = _lastUpdatedPeriod[hash][spendLimitHash];
        bool lastPeriodExists = lastUpdatedPeriod.end != 0;
        bool lastPeriodStillActive = currentTimestamp <= lastUpdatedPeriod.end;
        if (lastPeriodExists && lastPeriodStillActive) return lastUpdatedPeriod;

        if (spendLimit.unit == PeriodUnit.Forever) {
            return PeriodSpend({ start: permissionStart, end: permissionEnd, spend: 0 });
        }

        uint48 periodStart;
        uint48 periodEnd;

        if (spendLimit.unit == PeriodUnit.Month) {
            (uint256 candidateStart, uint256 periodIndex) =
                _monthPeriodStart(currentTimestamp, spendLimit.multiplier, permissionStart);
            periodStart = uint48(candidateStart);
            uint256 calculatedEnd =
                DateTimeLib.addMonths(uint256(permissionStart), (periodIndex + 1) * uint256(spendLimit.multiplier));
            if (calculatedEnd > type(uint48).max) revert ENSignAgentRegistry_PeriodOverflow();
            periodEnd = uint48(calculatedEnd);
        } else {
            periodStart = uint48(_fixedPeriodStart(currentTimestamp, spendLimit.unit, spendLimit.multiplier, permissionStart));
            uint48 duration = _fixedPeriodDuration(spendLimit.unit, spendLimit.multiplier);
            uint256 calculatedEnd = uint256(periodStart) + uint256(duration);
            if (calculatedEnd > type(uint48).max) revert ENSignAgentRegistry_PeriodOverflow();
            periodEnd = uint48(calculatedEnd);
        }

        if (periodEnd > permissionEnd) periodEnd = permissionEnd;
        return PeriodSpend({ start: periodStart, end: periodEnd, spend: 0 });
    }

    function _fixedPeriodDuration(PeriodUnit unit, uint16 multiplier) internal pure returns (uint48) {
        if (unit == PeriodUnit.Minute) return 60 * uint48(multiplier);
        if (unit == PeriodUnit.Hour) return 3600 * uint48(multiplier);
        if (unit == PeriodUnit.Day) return 86_400 * uint48(multiplier);
        return 604_800 * uint48(multiplier); // Week
    }

    function _monthPeriodStart(
        uint256 unixTimestamp,
        uint16 multiplier,
        uint256 permissionStart
    ) internal pure returns (uint256 periodStart, uint256 periodIndex) {
        (uint256 permYear, uint256 permMonth,) = DateTimeLib.timestampToDate(permissionStart);
        (uint256 curYear, uint256 curMonth,) = DateTimeLib.timestampToDate(unixTimestamp);
        uint256 monthsElapsed = (curYear * 12 + curMonth) - (permYear * 12 + permMonth);
        periodIndex = monthsElapsed / uint256(multiplier);
        periodStart = DateTimeLib.addMonths(permissionStart, periodIndex * uint256(multiplier));
        if (periodStart > unixTimestamp) {
            periodIndex -= 1;
            periodStart = DateTimeLib.addMonths(permissionStart, periodIndex * uint256(multiplier));
        }
    }

    function _fixedPeriodStart(
        uint256 unixTimestamp,
        PeriodUnit unit,
        uint16 multiplier,
        uint256 permissionStart
    ) internal pure returns (uint256) {
        uint256 duration = uint256(_fixedPeriodDuration(unit, multiplier));
        uint256 elapsed = unixTimestamp - permissionStart;
        return permissionStart + (elapsed / duration) * duration;
    }

    function _revoke(Permission calldata permission) internal {
        bytes32 hash = getHash(permission);
        if (_isRevoked[hash]) return;
        if (!_isApproved[hash]) revert ENSignAgentRegistry_UnauthorizedPermission();
        _isRevoked[hash] = true;
        emit PermissionRevoked(hash);
    }

    function _hashCallPermission(CallPermission calldata call) internal pure returns (bytes32) {
        return keccak256(abi.encode(CALL_PERMISSION_TYPEHASH, call.target, call.selector, call.checker));
    }

    function _hashSpendLimit(SpendLimit calldata spendLimit) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SPEND_LIMIT_TYPEHASH, spendLimit.token, spendLimit.allowance, spendLimit.unit, spendLimit.multiplier
            )
        );
    }

    function _executeBatch(address account, IExecutable.Call[] memory calls) internal {
        IExecutable(account).executeBatch(calls);
    }

    function _childNode(bytes32 parent, bytes32 labelHash) internal pure returns (bytes32 node) {
        assembly {
            mstore(0, parent)
            mstore(32, labelHash)
            node := keccak256(0, 64)
        }
    }

    /// @notice "0x"-prefixed lowercase hex of a bytes32. Used to write the
    ///         permission hash into the resolver as a text record.
    function _toHexString(bytes32 value) internal pure returns (string memory) {
        bytes memory buffer = new bytes(66);
        buffer[0] = "0";
        buffer[1] = "x";
        for (uint256 i = 0; i < 32; ++i) {
            uint8 b = uint8(value[i]);
            buffer[2 + i * 2] = _hexChar(b >> 4);
            buffer[3 + i * 2] = _hexChar(b & 0x0f);
        }
        return string(buffer);
    }

    function _hexChar(uint8 nibble) internal pure returns (bytes1) {
        return bytes1(nibble < 10 ? 48 + nibble : 87 + nibble);
    }

    function _lsbToAddress(bytes32 b) internal pure returns (address) {
        return address(uint160(uint256(b)));
    }

    function _domainNameAndVersion()
        internal
        pure
        override
        returns (string memory name, string memory version)
    {
        name = "ENSignAgentRegistry";
        version = "1";
    }
}
