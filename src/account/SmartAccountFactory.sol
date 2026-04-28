// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { LibClone } from "solady/utils/LibClone.sol";

import { SmartAccount } from "./SmartAccount.sol";

contract SmartAccountFactory {

    /**
     * @notice Address of the SmartAccount implementation used as implementation for new accounts.
     */
    address private immutable i_implementation;

    /**
     * @notice Thrown when trying to create a new account without any owner.
     */
    error SmartAccountFactory_OwnerRequired();

    /**
     * @notice Thrown if account already deployed.
     */
    error SmartAccountFactory_AlreadyDeployed();

    /**
     * @notice Factory constructor that deploys the SmartAccount implementation.
     * @param entryPointAddress The address of the entry point contract.
     */
    constructor(address entryPointAddress) {
        i_implementation = address(new SmartAccount(entryPointAddress, address(this)));
    }

    /**
     * @notice Creates and returns a new SmartAccount with the given `owners` and `nonce`.
     *         Reverts if an account with these parameters already exists.
     * @dev Deployed as a minimal clone of `this.implementation`.
     * @param owners Array of initial owners. Each item should be an ABI encoded address or 64 byte public key.
     * @param nonce  The nonce of the account, a caller defined value which allows multiple accounts
     *              with the same `owners` to exist at different addresses.
     * @return account The address of the minimal clone created with inputs `owners`, `nonce`, and
     *                 `this.implementation`.
     */
    function createAccount(
        bytes[] calldata owners,
        uint256 nonce
    )
        external
        payable
        virtual
        returns (SmartAccount account)
    {
        if (owners.length == 0) {
            revert SmartAccountFactory_OwnerRequired();
        }

        (bool alreadyDeployed, address accountAddress) =
            LibClone.createDeterministicClone(msg.value, i_implementation, "", _getSalt(owners, nonce));

        if (alreadyDeployed) {
            revert SmartAccountFactory_AlreadyDeployed();
        }

        account = SmartAccount(payable(accountAddress));

        account.initialize(owners);
    }

    /**
     * @notice Returns the deterministic address of the account that would be created by `createAccount`.
     *
     * @param owners Array of initial owners. Each item should be an ABI encoded address or 64 byte public key.
     * @param nonce  The nonce provided to `createAccount()`.
     *
     * @return The predicted account deployment address.
     */
    function getAddress(bytes[] calldata owners, uint256 nonce) external view returns (address) {
        return LibClone.predictDeterministicAddress(initCodeHash(), _getSalt(owners, nonce), address(this));
    }

    /**
     * @notice Returns the initialization code hash of the account:
     *         a minimal clone (EIP-1167) of `this.implementation`.
     * @return The initialization code hash.
     */
    function initCodeHash() public view virtual returns (bytes32) {
        return LibClone.initCodeHash(i_implementation, "");
    }

    /**
     * @notice Returns the implementation address used for new account deployments.
     * @return The address of the SmartAccount implementation contract.
     */
    function getImplementation() external view returns (address) {
        return i_implementation;
    }

    /**
     * @notice Returns the create2 salt for `LibClone.predictDeterministicAddress`
     *
     * @param owners Array of initial owners. Each item should be an ABI encoded address or 64 byte public key.
     * @param nonce  The nonce provided to `createAccount()`.
     *
     * @return The computed salt.
     */
    function _getSalt(bytes[] calldata owners, uint256 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(owners, nonce));
    }

}
