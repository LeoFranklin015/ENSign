// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[34] calldata pubSignals
    ) external view returns (bool);
}

struct EmailProof {
    string domainName;
    bytes32 publicKeyHash;
    uint256 timestamp;
    string maskedCommand;
    bytes32 emailNullifier;
    bytes32 accountSalt;
    bool isCodeExist;
    bytes proof;
}

/// @title EmailProofVerifier
/// @notice Immutable re-implementation of zkEmail's `Verifier`: unpacks an
///         `EmailProof` into the circuit's 34 public signals and defers to a
///         Groth16 verifier.
///
/// @dev    Why this exists rather than reusing zkEmail's deployment: their
///         on-chain `Verifier`s (Sepolia and Base Sepolia both) carry
///         verification keys from OLDER circuit builds, and reject proofs from
///         the `v2.0.2-dev` zkey that the current prover pipeline uses — verified
///         empirically against a real proof. This pairs with a `Groth16Verifier`
///         generated from that exact zkey.
///
/// @dev    Behaviour is identical to theirs, minus UUPS/Ownable: the signal
///         layout and `_packBytes2Fields` packing are reproduced exactly, so the
///         same proofs verify. Immutable by design — the verifier is
///         consensus-critical for recovery, so there is no upgrade key.
contract EmailProofVerifier {
    IGroth16Verifier public immutable groth16Verifier;

    uint256 public constant DOMAIN_FIELDS = 9;
    uint256 public constant DOMAIN_BYTES = 255;
    uint256 public constant COMMAND_FIELDS = 20;
    uint256 public constant COMMAND_BYTES = 605;

    /// @dev BN254 base field modulus; proof coordinates must be reduced.
    uint256 internal constant q =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;

    constructor(IGroth16Verifier _groth16Verifier) {
        groth16Verifier = _groth16Verifier;
    }

    function commandBytes() external pure returns (uint256) {
        return COMMAND_BYTES;
    }

    function verifyEmailProof(EmailProof memory proof) public view returns (bool) {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) =
            abi.decode(proof.proof, (uint256[2], uint256[2][2], uint256[2]));
        require(pA[0] < q && pA[1] < q, "invalid format of pA");
        require(
            pB[0][0] < q && pB[0][1] < q && pB[1][0] < q && pB[1][1] < q,
            "invalid format of pB"
        );
        require(pC[0] < q && pC[1] < q, "invalid format of pC");

        uint256[DOMAIN_FIELDS + COMMAND_FIELDS + 5] memory pubSignals;
        uint256[] memory stringFields = _packBytes2Fields(bytes(proof.domainName), DOMAIN_BYTES);
        for (uint256 i = 0; i < DOMAIN_FIELDS; i++) {
            pubSignals[i] = stringFields[i];
        }
        pubSignals[DOMAIN_FIELDS] = uint256(proof.publicKeyHash);
        pubSignals[DOMAIN_FIELDS + 1] = uint256(proof.emailNullifier);
        pubSignals[DOMAIN_FIELDS + 2] = proof.timestamp;

        stringFields = _packBytes2Fields(bytes(proof.maskedCommand), COMMAND_BYTES);
        for (uint256 i = 0; i < COMMAND_FIELDS; i++) {
            pubSignals[DOMAIN_FIELDS + 3 + i] = stringFields[i];
        }
        pubSignals[DOMAIN_FIELDS + 3 + COMMAND_FIELDS] = uint256(proof.accountSalt);
        pubSignals[DOMAIN_FIELDS + 3 + COMMAND_FIELDS + 1] = proof.isCodeExist ? 1 : 0;

        return groth16Verifier.verifyProof(pA, pB, pC, pubSignals);
    }

    /// @dev Packs bytes into 31-byte little-endian field elements, exactly as the
    ///      circuit's PackBytes does.
    function _packBytes2Fields(
        bytes memory _bytes,
        uint256 _paddedSize
    ) private pure returns (uint256[] memory) {
        uint256 remain = _paddedSize % 31;
        uint256 numFields = (_paddedSize - remain) / 31;
        if (remain > 0) {
            numFields += 1;
        }
        uint256[] memory fields = new uint256[](numFields);
        uint256 idx = 0;
        uint256 byteVal = 0;
        for (uint256 i = 0; i < numFields; i++) {
            for (uint256 j = 0; j < 31; j++) {
                idx = i * 31 + j;
                if (idx >= _paddedSize) {
                    break;
                }
                if (idx >= _bytes.length) {
                    byteVal = 0;
                } else {
                    byteVal = uint256(uint8(_bytes[idx]));
                }
                if (j == 0) {
                    fields[i] = byteVal;
                } else {
                    fields[i] += (byteVal << (8 * j));
                }
            }
        }
        return fields;
    }
}
