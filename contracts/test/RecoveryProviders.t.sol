// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { ECDSA } from "solady/utils/ECDSA.sol";

import { ENSRecoveryProvider } from "../src/recovery/providers/ENSRecoveryProvider.sol";
import { ECDSARecoveryProvider } from "../src/recovery/providers/ECDSARecoveryProvider.sol";

/// @dev Stand-in for an ENSv2 PermissionedRegistry: resource → owner, with the
///      tokenId indirection ENSv2 has (getTokenId ≠ resource).
contract MockRegistry {
    mapping(uint256 resource => address owner) internal _owners;

    function setOwner(uint256 resource, address owner) external {
        _owners[resource] = owner;
    }

    function getTokenId(uint256 resource) external pure returns (uint256) {
        return resource | (1 << 255); // arbitrary stable mapping
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return _owners[tokenId & ~(uint256(1) << 255)];
    }
}

/// @dev Minimal ERC-1271 wallet: valid iff the inner ECDSA signer signed the hash.
contract Mock1271Wallet {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return ECDSA.recoverCalldata(hash, signature) == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract RecoveryProvidersTest is Test {
    ENSRecoveryProvider internal ensProvider;
    ECDSARecoveryProvider internal ecdsaProvider;
    MockRegistry internal registry;

    address internal constant ACCOUNT = address(0xACC0);
    uint256 internal constant RESOURCE = 0xCAFE;
    bytes internal subject = abi.encode(keccak256("qx"), keccak256("qy"));

    address internal guardian;
    uint256 internal guardianPk;

    function setUp() public {
        ensProvider = new ENSRecoveryProvider();
        ecdsaProvider = new ECDSARecoveryProvider();
        registry = new MockRegistry();
        (guardian, guardianPk) = makeAddrAndKey("guardian");
        registry.setOwner(RESOURCE, guardian);
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function _digest(address provider, uint256 nonce) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(provider == address(ensProvider) ? "ENSRecoveryProvider" : "ECDSARecoveryProvider")),
                keccak256(bytes("1")),
                block.chainid,
                provider
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Recover(address account,uint256 nonce,bytes subject)"),
                ACCOUNT,
                nonce,
                keccak256(subject)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _ensCommitment() internal view returns (bytes memory) {
        return abi.encode(address(registry), RESOURCE);
    }

    // ───────────────────────────── ENSRecoveryProvider ─────────────────────────────

    function test_ens_validGuardianSignature() public view {
        bytes memory proof = _sign(guardianPk, _digest(address(ensProvider), 0));
        ensProvider.verify(ACCOUNT, subject, 0, _ensCommitment(), proof);
    }

    function test_ens_rejectsWrongSigner() public {
        (, uint256 strangerPk) = makeAddrAndKey("stranger");
        bytes memory proof = _sign(strangerPk, _digest(address(ensProvider), 0));
        vm.expectRevert(ENSRecoveryProvider.ENSRecoveryProvider_InvalidGuardianSignature.selector);
        ensProvider.verify(ACCOUNT, subject, 0, _ensCommitment(), proof);
    }

    function test_ens_transferRotatesGuardian() public {
        (address newWallet, uint256 newPk) = makeAddrAndKey("mom-new-wallet");
        registry.setOwner(RESOURCE, newWallet); // mom's subname transferred

        // Old wallet's signature no longer counts…
        bytes memory oldProof = _sign(guardianPk, _digest(address(ensProvider), 0));
        vm.expectRevert(ENSRecoveryProvider.ENSRecoveryProvider_InvalidGuardianSignature.selector);
        ensProvider.verify(ACCOUNT, subject, 0, _ensCommitment(), oldProof);

        // …the new owner's does. Same commitment: the name IS the identity.
        bytes memory newProof = _sign(newPk, _digest(address(ensProvider), 0));
        ensProvider.verify(ACCOUNT, subject, 0, _ensCommitment(), newProof);
    }

    function test_ens_expiredOrBurnedNameFailsClosed() public {
        registry.setOwner(RESOURCE, address(0)); // ENSv2 ownerOf semantics on expiry/burn
        bytes memory proof = _sign(guardianPk, _digest(address(ensProvider), 0));
        vm.expectRevert(ENSRecoveryProvider.ENSRecoveryProvider_MethodExpiredOrBurned.selector);
        ensProvider.verify(ACCOUNT, subject, 0, _ensCommitment(), proof);
    }

    function test_ens_erc1271ContractGuardian() public {
        Mock1271Wallet wallet = new Mock1271Wallet(guardian);
        registry.setOwner(RESOURCE, address(wallet)); // a Safe-like contract owns the name
        bytes memory proof = _sign(guardianPk, _digest(address(ensProvider), 0));
        ensProvider.verify(ACCOUNT, subject, 0, _ensCommitment(), proof);
    }

    function test_ens_nonceBindsProof() public {
        bytes memory proof = _sign(guardianPk, _digest(address(ensProvider), 0));
        vm.expectRevert(ENSRecoveryProvider.ENSRecoveryProvider_InvalidGuardianSignature.selector);
        ensProvider.verify(ACCOUNT, subject, 1, _ensCommitment(), proof); // wrong nonce
    }

    function test_ens_rejectsNonCanonicalCommitment() public {
        bytes memory padded = abi.encodePacked(_ensCommitment(), uint8(0)); // trailing byte
        bytes memory proof = _sign(guardianPk, _digest(address(ensProvider), 0));
        vm.expectRevert(
            abi.encodeWithSelector(ENSRecoveryProvider.ENSRecoveryProvider_InvalidCommitment.selector, padded)
        );
        ensProvider.verify(ACCOUNT, subject, 0, padded, proof);
    }

    // ───────────────────────────── ECDSARecoveryProvider ─────────────────────────────

    function test_ecdsa_validSignature() public view {
        bytes memory proof = _sign(guardianPk, _digest(address(ecdsaProvider), 0));
        ecdsaProvider.verify(ACCOUNT, subject, 0, abi.encode(guardian), proof);
    }

    function test_ecdsa_rejectsWrongSigner() public {
        (, uint256 strangerPk) = makeAddrAndKey("stranger");
        bytes memory proof = _sign(strangerPk, _digest(address(ecdsaProvider), 0));
        vm.expectRevert(ECDSARecoveryProvider.ECDSARecoveryProvider_InvalidSignature.selector);
        ecdsaProvider.verify(ACCOUNT, subject, 0, abi.encode(guardian), proof);
    }

    function test_ecdsa_domainSeparatedFromENSProvider() public {
        // A proof produced for the ENS provider's domain must not verify here.
        bytes memory proof = _sign(guardianPk, _digest(address(ensProvider), 0));
        vm.expectRevert(ECDSARecoveryProvider.ECDSARecoveryProvider_InvalidSignature.selector);
        ecdsaProvider.verify(ACCOUNT, subject, 0, abi.encode(guardian), proof);
    }

    function test_ecdsa_rejectsNonCanonicalCommitment() public {
        bytes memory dirty = abi.encode(uint256(uint160(guardian)) | (1 << 200));
        bytes memory proof = _sign(guardianPk, _digest(address(ecdsaProvider), 0));
        vm.expectRevert(
            abi.encodeWithSelector(ECDSARecoveryProvider.ECDSARecoveryProvider_InvalidCommitment.selector, dirty)
        );
        ecdsaProvider.verify(ACCOUNT, subject, 0, dirty, proof);
    }
}
