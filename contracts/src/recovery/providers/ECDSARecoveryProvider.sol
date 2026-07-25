// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ECDSA } from "solady/utils/ECDSA.sol";
import { EIP712 } from "solady/utils/EIP712.sol";

import { IRecoveryProvider } from "../IRecoveryProvider.sol";

/// @title ECDSARecoveryProvider
/// @notice The simplest recovery provider: the commitment is a raw backup EOA
///         (canonical 32-byte `abi.encode(address)`), the proof an EIP-712 signature
///         from it over `Recover(account, nonce, subject)`. No ENS indirection — if the
///         backup key rotates, the account must re-register the recovery. Exists as the
///         non-ENS fallback and to seed the provider catalog with a second entry.
contract ECDSARecoveryProvider is IRecoveryProvider, EIP712 {

    error ECDSARecoveryProvider_InvalidCommitment(bytes commitment);
    error ECDSARecoveryProvider_InvalidSignature();

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
        // Canonical: exactly 32 bytes, a clean non-zero address word.
        if (commitment.length != 32) revert ECDSARecoveryProvider_InvalidCommitment(commitment);
        uint256 word = uint256(bytes32(commitment));
        if (word == 0 || word > type(uint160).max) {
            revert ECDSARecoveryProvider_InvalidCommitment(commitment);
        }
        address signer = address(uint160(word));

        bytes32 digest = _hashTypedData(
            keccak256(abi.encode(RECOVER_TYPEHASH, account, nonce, keccak256(subject)))
        );
        if (ECDSA.recoverCalldata(digest, proof) != signer) {
            revert ECDSARecoveryProvider_InvalidSignature();
        }
    }

    function _domainNameAndVersion()
        internal
        pure
        override
        returns (string memory name, string memory version)
    {
        name = "ECDSARecoveryProvider";
        version = "1";
    }
}
