// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IRegistry} from "@ensv2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ensv2/registry/libraries/RegistryRolesLib.sol";
import {EACBaseRolesLib} from "@ensv2/access-control/libraries/EACBaseRolesLib.sol";

interface IUserRegistry {
    function register(
        string memory label,
        address owner,
        IRegistry registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256);

    function getSubregistry(string calldata label) external view returns (IRegistry);
    function getResolver(string calldata label) external view returns (address);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getTokenId(uint256 anyId) external view returns (uint256);
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
}

interface ISmartAccountFactory {
    function getAddress(bytes[] calldata owners, uint256 nonce) external view returns (address);
    function createAccount(bytes[] calldata owners, uint256 nonce) external payable returns (address);
}

interface IVerifiableFactoryLite {
    function deployProxy(
        address implementation,
        uint256 salt,
        bytes calldata data
    ) external returns (address);
}

interface IPermissionedResolver {
    function initialize(address admin, uint256 roleBitmap) external;
    /// @dev Canonical impl exposes the multi-coin form. Pass coinType=60 (SLIP-44 ETH)
    ///      with `abi.encodePacked(addr)` to set the mainnet address.
    function setAddr(bytes32 node, uint256 coinType, bytes calldata addressBytes) external;
    function setText(bytes32 node, string calldata key, string calldata value) external;
}

/// @title ENSignRegistry
/// @notice The developer-facing single registry for ENSign. Atomic `register(...)`
///         deploys a passkey-controlled `SmartAccount`, deploys a per-subname canonical
///         `PermissionedResolver` proxy, writes `addr` + `credentialId` records, and
///         registers the subname inside the canonical `UserRegistry` proxy that this
///         contract owns.
/// @dev    The .eth registry's subregistry pointer for the parent name points at the
///         canonical UserRegistry proxy (so the ENS indexer's impl-allowlist matches),
///         not at this contract. From the SDK's POV this is the registry — register()
///         lives here, predictAccount lives here, IRegistry-shaped read-throughs live here.
contract ENSignRegistry is Ownable {
    IUserRegistry public immutable storageRegistry;
    ISmartAccountFactory public immutable jawFactory;
    IVerifiableFactoryLite public immutable verifiableFactory;
    address public immutable canonicalResolverImpl;
    bytes32 public immutable parentNode;

    /// @notice Roles granted to the smart account (token owner) on its subname resource.
    uint256 internal constant USER_TOKEN_ROLES =
        RegistryRolesLib.ROLE_SET_RESOLVER |
        RegistryRolesLib.ROLE_SET_SUBREGISTRY |
        RegistryRolesLib.ROLE_RENEW;

    mapping(address registrar => bool allowed) public isRegistrar;

    event RegistrarSet(address indexed registrar, bool allowed);
    event Registered(
        string label,
        address indexed account,
        address indexed resolver,
        uint256 indexed tokenId
    );

    error NotRegistrar();

    constructor(
        IUserRegistry _storageRegistry,
        ISmartAccountFactory _jawFactory,
        IVerifiableFactoryLite _verifiableFactory,
        address _canonicalResolverImpl,
        bytes32 _parentNode,
        address admin
    ) Ownable(admin) {
        storageRegistry = _storageRegistry;
        jawFactory = _jawFactory;
        verifiableFactory = _verifiableFactory;
        canonicalResolverImpl = _canonicalResolverImpl;
        parentNode = _parentNode;
        isRegistrar[admin] = true;
        emit RegistrarSet(admin, true);
    }

    function setRegistrar(address registrar, bool allowed) external onlyOwner {
        isRegistrar[registrar] = allowed;
        emit RegistrarSet(registrar, allowed);
    }

    /// @notice One-shot atomic register: smart account + per-subname resolver + ENS token mint.
    function register(
        string calldata label,
        bytes32 qx,
        bytes32 qy,
        string calldata credentialId,
        uint64 expiry
    ) external returns (uint256 tokenId, address account) {
        if (!isRegistrar[msg.sender]) revert NotRegistrar();

        // 1. smart account (canonical factory; same address on every chain).
        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(qx, qy);
        account = jawFactory.getAddress(owners, 0);
        if (account.code.length == 0) {
            jawFactory.createAccount(owners, 0);
        }

        // 2. Per-subname resolver via canonical PermissionedResolver impl
        //    (indexer-allowlisted). This contract is set as the resolver's admin
        //    so it can write addr/text records.
        bytes memory initData = abi.encodeCall(
            IPermissionedResolver.initialize,
            (address(this), EACBaseRolesLib.ALL_ROLES)
        );
        address resolver = verifiableFactory.deployProxy(
            canonicalResolverImpl,
            uint256(keccak256(abi.encode("res", label))),
            initData
        );

        // 3. Write addr + credentialId records. coinType 60 = SLIP-44 ETH.
        bytes32 node = _childNode(parentNode, keccak256(bytes(label)));
        IPermissionedResolver(resolver).setAddr(node, 60, abi.encodePacked(account));
        if (bytes(credentialId).length > 0) {
            IPermissionedResolver(resolver).setText(node, "credentialId", credentialId);
        }

        // 4. Mint the subname inside the canonical storage registry, owned by the smart account.
        tokenId = storageRegistry.register(
            label,
            account,
            IRegistry(address(0)),
            resolver,
            USER_TOKEN_ROLES,
            expiry
        );

        emit Registered(label, account, resolver, tokenId);
    }

    /// @notice Predict the smart account address for a passkey without deploying.
    function predictAccount(bytes32 qx, bytes32 qy) external view returns (address) {
        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(qx, qy);
        return jawFactory.getAddress(owners, 0);
    }

    // ------ IRegistry-shaped read-throughs (developer convenience) ------

    function getSubregistry(string calldata label) external view returns (IRegistry) {
        return storageRegistry.getSubregistry(label);
    }
    function getResolver(string calldata label) external view returns (address) {
        return storageRegistry.getResolver(label);
    }
    function ownerOf(uint256 tokenId) external view returns (address) {
        return storageRegistry.ownerOf(tokenId);
    }

    function _childNode(bytes32 parent, bytes32 labelHash) internal pure returns (bytes32 node) {
        assembly {
            mstore(0, parent)
            mstore(32, labelHash)
            node := keccak256(0, 64)
        }
    }
}
