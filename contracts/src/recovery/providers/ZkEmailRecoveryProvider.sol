// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IRecoveryProvider } from "../IRecoveryProvider.sol";

/// @notice zkEmail's proof payload, matching the deployed Sepolia `Verifier`
///         (`0x3E5f...5716`) ABI exactly. Declared locally so this repo doesn't
///         take an npm dependency on the zkEmail contracts package.
struct EmailProof {
    string domainName;      // sender's email domain, e.g. "gmail.com"
    bytes32 publicKeyHash;  // hash of the DKIM public key that signed the email
    uint256 timestamp;      // email timestamp
    string maskedCommand;   // the command text, with code/addresses masked out
    bytes32 emailNullifier; // zkEmail's own replay marker (unused here — see below)
    bytes32 accountSalt;    // Poseidon(emailAddress, accountCode): the guardian's identity
    bool isCodeExist;       // whether the invitation code was present
    bytes proof;            // abi.encode(pA, pB, pC) Groth16 proof
}

interface IZkEmailVerifier {
    function verifyEmailProof(EmailProof memory proof) external view returns (bool);
    function commandBytes() external view returns (uint256);
}

interface IDKIMRegistry {
    function isDKIMPublicKeyHashValid(
        string memory domainName,
        bytes32 publicKeyHash
    ) external view returns (bool);
}

/// @title ZkEmailRecoveryProvider
/// @notice A recovery provider where the guardian is an **email address**. The
///         commitment is `abi.encode(accountSalt, domainName)`; the proof is an
///         abi-encoded zkEmail `EmailProof` showing that the owner of that email
///         sent a DKIM-signed message whose body authorizes this exact recovery.
///
///         Verification, in order:
///           1. the commitment is canonically encoded (no aliasing);
///           2. the proof's `accountSalt` and domain match the commitment, so the
///              proof came from the committed email address;
///           3. the DKIM public key is registered for that domain;
///           4. the command text binds `(account, nonce, subject)` — the email
///              authorizes THIS account, at THIS nonce, to THIS new key;
///           5. the Groth16 proof verifies against the deployed zkEmail verifier.
///
/// @dev    Why this bypasses `EmailAuth`: that contract is stateful (it burns an
///         `emailNullifier`), which cannot be called from a `view` verifier. It is
///         not needed here — replay protection comes from the manager's per-account
///         nonce, which is baked into the command string. The manager bumps the
///         nonce on every successful request, so a proof is single-use by
///         construction, exactly as {IRecoveryProvider} requires.
///
/// @dev    `owner()` exists because the canonical `UserOverrideableDKIMRegistry`
///         resolves the caller's authorizer via `Ownable(msg.sender).owner()`.
contract ZkEmailRecoveryProvider is IRecoveryProvider {

    error ZkEmailRecoveryProvider_InvalidCommitment(bytes commitment);
    error ZkEmailRecoveryProvider_WrongGuardianEmail();
    error ZkEmailRecoveryProvider_WrongDomain();
    error ZkEmailRecoveryProvider_InvalidDKIMKey(string domainName, bytes32 publicKeyHash);
    error ZkEmailRecoveryProvider_CommandMismatch(string expected, string actual);
    error ZkEmailRecoveryProvider_InvalidEmailProof();

    IZkEmailVerifier public immutable verifier;
    IDKIMRegistry public immutable dkimRegistry;

    /// @notice Reported as this contract's `owner()` so DKIM registries that
    ///         resolve `Ownable(msg.sender).owner()` see a configured authorizer.
    address public immutable dkimAuthorizer;

    constructor(IZkEmailVerifier _verifier, IDKIMRegistry _dkimRegistry, address _dkimAuthorizer) {
        verifier = _verifier;
        dkimRegistry = _dkimRegistry;
        dkimAuthorizer = _dkimAuthorizer;
    }

    function owner() external view returns (address) {
        return dkimAuthorizer;
    }

    /// @inheritdoc IRecoveryProvider
    function verify(
        address account,
        bytes calldata subject,
        uint256 nonce,
        bytes calldata commitment,
        bytes calldata proof
    ) external view {
        (bytes32 accountSalt, string memory domainName) = abi.decode(commitment, (bytes32, string));
        // Enforce a single canonical encoding: otherwise one email could be
        // registered under several recoveryIds and satisfy an M-of-N twice.
        if (keccak256(commitment) != keccak256(abi.encode(accountSalt, domainName))) {
            revert ZkEmailRecoveryProvider_InvalidCommitment(commitment);
        }

        EmailProof memory emailProof = abi.decode(proof, (EmailProof));

        if (emailProof.accountSalt != accountSalt) revert ZkEmailRecoveryProvider_WrongGuardianEmail();
        if (keccak256(bytes(emailProof.domainName)) != keccak256(bytes(domainName))) {
            revert ZkEmailRecoveryProvider_WrongDomain();
        }
        if (!dkimRegistry.isDKIMPublicKeyHashValid(emailProof.domainName, emailProof.publicKeyHash)) {
            revert ZkEmailRecoveryProvider_InvalidDKIMKey(emailProof.domainName, emailProof.publicKeyHash);
        }

        string memory expected = expectedCommand(account, nonce, subject);
        // Compared case-insensitively so any address casing the relayer emits
        // (lowercase, EIP-55 checksummed, or uppercase) is accepted.
        if (!_equalsIgnoreCase(emailProof.maskedCommand, expected)) {
            revert ZkEmailRecoveryProvider_CommandMismatch(expected, emailProof.maskedCommand);
        }

        if (!verifier.verifyEmailProof(emailProof)) revert ZkEmailRecoveryProvider_InvalidEmailProof();
    }

    /// @notice The exact text the guardian's email must authorize. Deliberately
    ///         shaped like zkEmail's own deployed recovery template
    ///         ("Recover account {ethAddr} using recovery hash {string}") so the
    ///         existing relayer tooling can produce proofs for it unchanged.
    function expectedCommand(
        address account,
        uint256 nonce,
        bytes memory subject
    ) public pure returns (string memory) {
        return string.concat(
            "Recover account 0x",
            _toHex(abi.encodePacked(account)),
            " using recovery hash 0x",
            _toHex(abi.encodePacked(recoveryHash(account, nonce, subject)))
        );
    }

    /// @notice Binds the new owner and the replay nonce into a single value the
    ///         human-readable command can carry.
    function recoveryHash(
        address account,
        uint256 nonce,
        bytes memory subject
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(account, nonce, subject));
    }

    // ─────────────────────────────────────────── INTERNAL ────────────────────────────────────────

    function _toHex(bytes memory data) internal pure returns (string memory) {
        bytes memory out = new bytes(data.length * 2);
        for (uint256 i; i < data.length; ++i) {
            uint8 b = uint8(data[i]);
            out[i * 2] = _hexChar(b >> 4);
            out[i * 2 + 1] = _hexChar(b & 0x0f);
        }
        return string(out);
    }

    function _hexChar(uint8 nibble) internal pure returns (bytes1) {
        return bytes1(nibble < 10 ? 48 + nibble : 87 + nibble); // 0-9, a-f
    }

    function _equalsIgnoreCase(string memory a, string memory b) internal pure returns (bool) {
        bytes memory aa = bytes(a);
        bytes memory bb = bytes(b);
        if (aa.length != bb.length) return false;
        for (uint256 i; i < aa.length; ++i) {
            if (_lower(uint8(aa[i])) != _lower(uint8(bb[i]))) return false;
        }
        return true;
    }

    function _lower(uint8 c) internal pure returns (uint8) {
        return (c >= 65 && c <= 90) ? c + 32 : c; // A-Z -> a-z
    }
}
