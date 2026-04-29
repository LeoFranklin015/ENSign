// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Constants for known Sepolia deployments used by ENSign scripts.
library Addresses {
    /// @notice ERC-4337 EntryPoint v0.8 (canonical, same on every chain).
    address internal constant ENTRYPOINT_V08 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;

    /// @notice ENSv2 staging `.eth` PermissionedRegistry on Sepolia. The registry that holds
    ///         the `loooo.eth` token. Provided by the user.
    address internal constant ENS_V2_ETH_REGISTRY_SEPOLIA =
        0xF332544e6234f1CA149907D0d4658afD5feB6831;

    /// @notice The parent label our subregistry sits under (i.e. our parent's leaf label).
    string internal constant PARENT_LABEL = "looooo";

    /// @notice ENS namehash of "eth".
    bytes32 internal constant ETH_NODE =
        0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae;

    /// @notice Compute namehash("loooo.eth") at call site.
    function parentNode() internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(ETH_NODE, keccak256(bytes(PARENT_LABEL))));
    }
}
