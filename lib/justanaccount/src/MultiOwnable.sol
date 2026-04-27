// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @notice Storage layout used by this contract.
 * @custom:storage-location erc7201:justanaccount.storage.MultiOwnable
 */
struct MultiOwnableStorage {
    /**
     * @dev Tracks the index of the next owner to add.
     */
    uint256 s_nextOwnerIndex;
    /**
     * @dev Tracks number of owners that have been removed.
     */
    uint256 s_removedOwnersCount;
    /**
     * @dev Maps index to owner bytes, used to identify owners via a uint256 index.
     *
     * The `owner` bytes should be:
     *  - An ABI encoded Ethereum address (20 bytes)
     *  - A public key (64 bytes)
     */
    mapping(uint256 index => bytes owner) s_ownerAtIndex;
    /**
     * @dev Mapping of bytes to booleans indicating whether or not
     * bytes_ is an owner of this contract.
     */
    mapping(bytes bytes_ => bool isOwner_) s_isOwner;
}

/**
 * @title Multi Ownable
 * @notice Auth contract allowing multiple owners, each identified as bytes.
 */
abstract contract MultiOwnable {

    /**
     * @notice Thrown when trying to add an already registered owner.
     * @param owner The owner bytes.
     */
    error MultiOwnable_AlreadyOwner(bytes owner);

    /**
     * @notice Thrown when the `msg.sender` is not an owner and is trying to call a privileged function.
     */
    error MultiOwnable_Unauthorized();

    /**
     * @notice Thrown when trying to remove an owner from an index that is empty.
     * @param index The targeted index for removal.
     */
    error MultiOwnable_NoOwnerAtIndex(uint256 index);

    /**
     * @notice Thrown when `owner` argument does not match owner found at index.
     * @param index         The index of the owner to be removed.
     * @param expectedOwner The owner passed in the remove call.
     * @param actualOwner   The actual owner at `index`.
     */
    error MultiOwnable_WrongOwnerAtIndex(uint256 index, bytes expectedOwner, bytes actualOwner);

    /**
     * @notice Thrown when removeOwnerAtIndex is called and there is only one current owner.
     */
    error MultiOwnable_LastOwner();

    /**
     * @notice Thrown when removeLastOwner is called and there is more than one current owner.
     * @param ownersRemaining The number of current owners.
     */
    error MultiOwnable_NotLastOwner(uint256 ownersRemaining);

    /**
     * @notice Thrown when a provided owner is neither 64 bytes long (for public key) nor an ABI encoded address.
     *  @param owner The invalid owner.
     */
    error MultiOwnable_InvalidOwnerBytesLength(bytes owner);

    /**
     * @notice Thrown when a provided owner is 32 bytes long but does not fit in an `address` type.
     * @param owner The invalid owner.
     */
    error MultiOwnable_InvalidEthereumAddressOwner(bytes owner);

    /**
     * @dev Slot for the `MultiOwnableStorage` struct in storage.
     * Computed from
     * keccak256(abi.encode(uint256(keccak256("justanaccount.storage.MultiOwnable")) - 1)) & ~bytes32(uint256(0xff))
     * Follows ERC-7201 (see https://eips.ethereum.org/EIPS/eip-7201).
     */
    bytes32 private constant MULTI_OWNABLE_STORAGE_LOCATION =
        0x548403af3b7bfc881040446090ff025838396ebf051dc219a19859cf4ef8e800;

    /**
     * @notice Emitted when a new owner is registered.
     * @param index The owner index of the owner added.
     * @param owner The owner added.
     */
    event AddOwner(uint256 indexed index, bytes owner);

    /**
     * @notice Emitted when an owner is removed.
     * @param index The owner index of the owner removed.
     * @param owner The owner removed.
     */
    event RemoveOwner(uint256 indexed index, bytes owner);

    /**
     * @notice Access control modifier ensuring the caller is an authorized owner
     */
    modifier onlyOwnerOrEntryPoint() virtual {
        _checkOwnerOrEntryPoint();
        _;
    }

    /**
     * @notice Virtual function to check authorization for owner-restricted functions.
     * @dev Must be overridden in derived contracts to implement actual authorization logic.
     * @dev Should revert if the caller is not authorized.
     */
    function _checkOwnerOrEntryPoint() internal view virtual { }

    /**
     * @notice Adds a new Ethereum-address owner.
     * @param owner The owner address.
     */
    function addOwnerAddress(address owner) external virtual onlyOwnerOrEntryPoint {
        _addOwnerAtIndex(abi.encode(owner), _getMultiOwnableStorage().s_nextOwnerIndex++);
    }

    /**
     * @notice Adds a new public-key owner.
     * @param x The owner public key x coordinate.
     * @param y The owner public key y coordinate.
     */
    function addOwnerPublicKey(bytes32 x, bytes32 y) external virtual onlyOwnerOrEntryPoint {
        _addOwnerAtIndex(abi.encode(x, y), _getMultiOwnableStorage().s_nextOwnerIndex++);
    }

    /**
     * @notice Removes owner at the given `index`.
     *
     * @dev Reverts if the owner is not registered at `index`.
     * @dev Reverts if there is currently only one owner.
     * @dev Reverts if `owner` does not match bytes found at `index`.
     *
     * @param index The index of the owner to be removed.
     * @param owner The ABI encoded bytes of the owner to be removed.
     */
    function removeOwnerAtIndex(uint256 index, bytes calldata owner) external virtual onlyOwnerOrEntryPoint {
        if (ownerCount() == 1) {
            revert MultiOwnable_LastOwner();
        }

        _removeOwnerAtIndex(index, owner);
    }

    /**
     * @notice Removes owner at the given `index`, which should be the only current owner.
     *
     * @dev Reverts if the owner is not registered at `index`.
     * @dev Reverts if there is currently more than one owner.
     * @dev Reverts if `owner` does not match bytes found at `index`.
     *
     * @param index The index of the owner to be removed.
     * @param owner The ABI encoded bytes of the owner to be removed.
     */
    function removeLastOwner(uint256 index, bytes calldata owner) external virtual onlyOwnerOrEntryPoint {
        uint256 ownersRemaining = ownerCount();
        if (ownersRemaining > 1) {
            revert MultiOwnable_NotLastOwner(ownersRemaining);
        }

        _removeOwnerAtIndex(index, owner);
    }

    /**
     * @notice Checks if the given `account` address is registered as owner.
     * @param account The account address to check.
     * @return `true` if the account is an owner else `false`.
     */
    function isOwnerAddress(address account) public view virtual returns (bool) {
        return _getMultiOwnableStorage().s_isOwner[abi.encode(account)];
    }

    /**
     * @notice Checks if the given `x`, `y` public key is registered as owner.
     * @param x The public key x coordinate.
     * @param y The public key y coordinate.
     * @return `true` if the public key is an owner else `false`.
     */
    function isOwnerPublicKey(bytes32 x, bytes32 y) public view virtual returns (bool) {
        return _getMultiOwnableStorage().s_isOwner[abi.encode(x, y)];
    }

    /**
     * @notice Checks if the given `account` bytes is registered as owner.
     * @param account The account, should be ABI encoded address or public key.
     * @return `true` if the account is an owner else `false`.
     */
    function isOwnerBytes(bytes memory account) public view virtual returns (bool) {
        return _getMultiOwnableStorage().s_isOwner[account];
    }

    /**
     * @notice Returns the owner bytes at the given `index`.
     * @param index The index to lookup.
     * @return The owner bytes (empty if no owner is registered at this `index`).
     */
    function ownerAtIndex(uint256 index) public view virtual returns (bytes memory) {
        return _getMultiOwnableStorage().s_ownerAtIndex[index];
    }

    /**
     * @notice Returns the next index that will be used to add a new owner.
     * @return The next index that will be used to add a new owner.
     */
    function nextOwnerIndex() public view virtual returns (uint256) {
        return _getMultiOwnableStorage().s_nextOwnerIndex;
    }

    /**
     * @notice Returns the current number of owners
     * @return The current owner count
     */
    function ownerCount() public view virtual returns (uint256) {
        MultiOwnableStorage storage $ = _getMultiOwnableStorage();
        return $.s_nextOwnerIndex - $.s_removedOwnersCount;
    }

    /**
     * @notice Returns the number of owners that have been removed.
     * @dev Used with `s_nextOwnerIndex` to calculate the current owner count.
     * @return The total number of owners that have been removed.
     */
    function removedOwnersCount() public view virtual returns (uint256) {
        return _getMultiOwnableStorage().s_removedOwnersCount;
    }

    /**
     * @notice Initialize the owners of this contract.
     * @dev Intended to be called when the contract is first deployed and never again.
     * @dev Reverts if a provided owner is neither 64 bytes long (for public key) nor a valid address.
     * @param owners The initial set of owners.
     */
    function _initializeOwners(bytes[] memory owners) internal virtual {
        MultiOwnableStorage storage $ = _getMultiOwnableStorage();
        uint256 nextOwnerIndex_ = $.s_nextOwnerIndex;
        for (uint256 i; i < owners.length; i++) {
            if (owners[i].length != 32 && owners[i].length != 64) {
                revert MultiOwnable_InvalidOwnerBytesLength(owners[i]);
            }

            if (owners[i].length == 32 && uint256(bytes32(owners[i])) > type(uint160).max) {
                revert MultiOwnable_InvalidEthereumAddressOwner(owners[i]);
            }

            _addOwnerAtIndex(owners[i], nextOwnerIndex_++);
        }
        $.s_nextOwnerIndex = nextOwnerIndex_;
    }

    /**
     * @notice Adds an owner at the given `index`.
     *
     * @dev Reverts if `owner` is already registered as an owner.
     *
     * @param owner The owner raw bytes to register.
     * @param index The index to write to.
     */
    function _addOwnerAtIndex(bytes memory owner, uint256 index) internal virtual {
        if (isOwnerBytes(owner)) {
            revert MultiOwnable_AlreadyOwner(owner);
        }

        MultiOwnableStorage storage $ = _getMultiOwnableStorage();
        $.s_isOwner[owner] = true;
        $.s_ownerAtIndex[index] = owner;

        emit AddOwner(index, owner);
    }

    /**
     * @notice Removes owner at the given `index`.
     *
     * @dev Reverts if the owner is not registered at `index`.
     * @dev Reverts if `owner` does not match bytes found at `index`.
     *
     * @param index The index of the owner to be removed.
     * @param owner The ABI encoded bytes of the owner to be removed.
     */
    function _removeOwnerAtIndex(uint256 index, bytes calldata owner) internal virtual {
        bytes memory owner_ = ownerAtIndex(index);
        if (owner_.length == 0) {
            revert MultiOwnable_NoOwnerAtIndex(index);
        }
        if (keccak256(owner_) != keccak256(owner)) {
            revert MultiOwnable_WrongOwnerAtIndex({ index: index, expectedOwner: owner, actualOwner: owner_ });
        }

        MultiOwnableStorage storage $ = _getMultiOwnableStorage();
        delete $.s_isOwner[owner];
        delete $.s_ownerAtIndex[index];
        $.s_removedOwnersCount++;

        emit RemoveOwner(index, owner);
    }

    /**
     * @notice Checks if the sender is an owner of this contract or the contract itself.
     * @dev Reverts if the sender is not an owner of the contract itself.
     */
    function _checkOwner() internal view virtual {
        if (isOwnerAddress(msg.sender) || (msg.sender == address(this))) {
            return;
        }

        revert MultiOwnable_Unauthorized();
    }

    /**
     * @notice Helper function to get a storage reference to the `MultiOwnableStorage` struct.
     * @return $ A storage reference to the `MultiOwnableStorage` struct.
     */
    function _getMultiOwnableStorage() internal pure returns (MultiOwnableStorage storage $) {
        assembly ("memory-safe") {
            $.slot := MULTI_OWNABLE_STORAGE_LOCATION
        }
    }

}
