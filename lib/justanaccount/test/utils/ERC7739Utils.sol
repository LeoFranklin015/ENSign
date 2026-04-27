// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title ERC7739Utils
 * @notice Utility library for ERC-7739 PersonalSign message hashing for smart accounts
 * @dev Implements the exact behavior of viem's erc7739HashMessage function
 */
library ERC7739Utils {

    using Strings for uint256;

    /// @dev The PersonalSign typehash as per ERC-7739
    /// keccak256("PersonalSign(bytes prefixed)")
    bytes32 internal constant PERSONAL_SIGN_TYPEHASH =
        0x983e65e5148e570cd828ead231ee759a8d7958721a768f93bc4483ba005c32de;

    /// @dev EIP-712 typed data prefix
    bytes2 internal constant EIP712_PREFIX = 0x1901;

    /// @dev EIP-191 personal message prefix
    string internal constant EIP191_PREFIX = "\x19Ethereum Signed Message:\n";

    /**
     * @notice Domain data structure for EIP-712
     */
    struct DomainData {
        string name;
        string version;
        uint256 chainId;
        address verifyingContract;
        bytes32 salt;
        bytes32 domainSeparator;
    }

    /**
     * @notice Creates an ERC-7739 compliant hash for a message
     * @param message The raw message bytes to hash
     * @param domainData The EIP-712 domain data of the smart account
     * @return The ERC-7739 compliant hash
     */
    function erc7739HashMessage(bytes memory message, DomainData memory domainData) internal pure returns (bytes32) {
        // Step 1: Create the EIP-191 personal message hash
        bytes32 messageHash = hashEIP191PersonalMessage(message);

        // Step 2: Create the PersonalSign struct hash using the EIP-191 hash
        return erc7739HashFromPersonalSignHash(messageHash, domainData);
    }

    /**
     * @notice Creates an ERC-7739 compliant hash from an already-computed personal sign message hash
     * @param personalSignHash The EIP-191 personal message hash
     * @param domainData The EIP-712 domain data of the smart account
     * @return The ERC-7739 compliant hash
     */
    function erc7739HashFromPersonalSignHash(
        bytes32 personalSignHash,
        DomainData memory domainData
    )
        internal
        pure
        returns (bytes32)
    {
        // Step 1: Create the PersonalSign struct hash
        bytes32 structHash = keccak256(abi.encode(PERSONAL_SIGN_TYPEHASH, personalSignHash));

        // Step 2: Combine with EIP-712 prefix and domain separator
        return keccak256(abi.encodePacked(EIP712_PREFIX, domainData.domainSeparator, structHash));
    }

    /**
     * @notice Creates an ERC-7739 compliant hash for a string message
     * @param message The string message to hash
     * @param domainData The EIP-712 domain data of the smart account
     * @return The ERC-7739 compliant hash
     */
    function generatePersonalSignHash(
        string memory message,
        DomainData memory domainData
    )
        internal
        pure
        returns (bytes32)
    {
        return erc7739HashMessage(bytes(message), domainData);
    }

    /**
     * @notice Creates an EIP-191 personal message hash
     * @param message The raw message bytes
     * @return The EIP-191 personal message hash
     */
    function hashEIP191PersonalMessage(bytes memory message) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(EIP191_PREFIX, message.length.toString(), message));
    }

    /**
     * @notice Retrieves domain data from a smart account that implements EIP-5267
     * @param account The address of the smart account
     * @return domainData The domain data including the computed domain separator
     */
    function getDomainDataFromAccount(address account) internal view returns (DomainData memory domainData) {
        // Call eip712Domain() on the account to get the domain parameters
        (, string memory name, string memory version, uint256 chainId, address verifyingContract, bytes32 salt,) =
            IEIP5267(account).eip712Domain();

        domainData.name = name;
        domainData.version = version;
        domainData.chainId = chainId;
        domainData.verifyingContract = verifyingContract;
        domainData.salt = salt;

        // Compute the domain separator
        domainData.domainSeparator = computeDomainSeparator(domainData);
    }

    /**
     * @notice Computes the EIP-712 domain separator to match Solady's EIP712 implementation
     * @param domainData The domain data
     * @return The computed domain separator
     */
    function computeDomainSeparator(DomainData memory domainData) internal pure returns (bytes32) {
        // keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
        return keccak256(
            abi.encode(
                0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f,
                keccak256(bytes(domainData.name)),
                keccak256(bytes(domainData.version)),
                domainData.chainId,
                domainData.verifyingContract
            )
        );
        // Note: No salt - Solady EIP712 doesn't use salt
    }

}

/**
 * @notice Interface for EIP-5267 compliant contracts
 */
interface IEIP5267 {

    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        );

}
