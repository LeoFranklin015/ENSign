// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { EIP712 } from "solady/utils/EIP712.sol";
import { SignatureCheckerLib } from "solady/utils/SignatureCheckerLib.sol";

import { IRecoveryProvider } from "../IRecoveryProvider.sol";

/// @notice Minimal read surface of an ENSv2 `PermissionedRegistry`.
interface IRegistryLite {
    function getTokenId(uint256 resource) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title ENSRecoveryProvider
/// @notice A recovery provider whose commitment is an ENS name, not an address.
///
///         `commitment = abi.encode(registry, resource)` — the ENSv2 registry holding
///         the guardian's subname and the name's stable resource id (NOT a tokenId:
///         tokenIds are regenerated on role changes; resources are forever).
///
///         At verify time the guardian's wallet is resolved LIVE via
///         `registry.ownerOf(registry.getTokenId(resource))`:
///         - transfer the subname → the new owner signs; the commitment never rots;
///         - let it expire or burn it → `ownerOf` returns zero → fails closed;
///         - the owner may be an EOA or any ERC-1271 contract (a Safe, another smart
///           account, a zkEmail wrapper) — `isValidSignatureNow` handles both.
///
///         The proof is an EIP-712 signature by the current owner over
///         `Recover(account, nonce, subject)`, domain-bound to this provider
///         deployment and chain, making proofs single-use and non-portable.
contract ENSRecoveryProvider is IRecoveryProvider, EIP712 {

    error ENSRecoveryProvider_InvalidCommitment(bytes commitment);
    error ENSRecoveryProvider_MethodExpiredOrBurned();
    error ENSRecoveryProvider_InvalidGuardianSignature();

    bytes32 public constant RECOVER_TYPEHASH =
        keccak256("Recover(address account,uint256 nonce,bytes subject)");

    /// @inheritdoc IRecoveryProvider
    function verify(
        address account,
        bytes calldata subject,
        uint256 nonce,
        bytes calldata commitment,
        bytes calldata proof
    ) external view {
        // Canonical commitment: exactly one encoding per name, no trailing-byte
        // aliasing that would let one guardian register under several ids.
        if (commitment.length != 64) revert ENSRecoveryProvider_InvalidCommitment(commitment);
        (address registry, uint256 resource) = abi.decode(commitment, (address, uint256));
        if (registry == address(0)) revert ENSRecoveryProvider_InvalidCommitment(commitment);

        // Live resolution — the guardian is whoever owns the name RIGHT NOW.
        address owner = IRegistryLite(registry).ownerOf(IRegistryLite(registry).getTokenId(resource));
        if (owner == address(0)) revert ENSRecoveryProvider_MethodExpiredOrBurned();

        bytes32 digest = _hashTypedData(
            keccak256(abi.encode(RECOVER_TYPEHASH, account, nonce, keccak256(subject)))
        );
        if (!SignatureCheckerLib.isValidSignatureNowCalldata(owner, digest, proof)) {
            revert ENSRecoveryProvider_InvalidGuardianSignature();
        }
    }

    function _domainNameAndVersion()
        internal
        pure
        override
        returns (string memory name, string memory version)
    {
        name = "ENSRecoveryProvider";
        version = "1";
    }
}
