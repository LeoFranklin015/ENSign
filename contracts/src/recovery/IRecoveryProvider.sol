// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IRecoveryProvider
/// @notice Stateless verifier interface for ENSign recovery providers. A provider holds
///         no per-account state: `ENSignRecoveryManager` owns the registered commitments
///         and the per-account replay nonce, and passes both in on every call. A
///         provider's sole job is to answer — for a given commitment — whether a proof
///         authorizes recovering `account` to the new owner encoded in `subject`.
///
///         Implementations MUST:
///         - revert on an invalid proof, and return normally on success;
///         - bind the proof to `(account, nonce, subject)` so it cannot be replayed
///           across accounts, nonces, or target owners;
///         - verify against exactly one canonical `commitment` encoding, so one proof
///           cannot satisfy several recoveries of the same provider.
interface IRecoveryProvider {
    function verify(
        address account,
        bytes calldata subject,
        uint256 nonce,
        bytes calldata commitment,
        bytes calldata proof
    ) external view;
}
