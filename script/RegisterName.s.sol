// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {ENSignRegistry} from "../src/ENSignRegistry.sol";

/// @notice Calls ENSignRegistry.register(...) for a single label. Pass env vars
///         REGISTRY (wrapper), LABEL, QX, QY, optional CREDENTIAL_ID.
contract RegisterName is Script {
    function run() external returns (uint256 tokenId, address account) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address wrapper = vm.envAddress("REGISTRY");
        string memory label = vm.envString("LABEL");
        bytes32 qx = vm.envBytes32("QX");
        bytes32 qy = vm.envBytes32("QY");
        string memory credentialId = vm.envOr("CREDENTIAL_ID", string(""));
        uint64 expiry = uint64(block.timestamp + 365 days);

        address predicted = ENSignRegistry(wrapper).predictAccount(qx, qy);
        console2.log("predicted smart account   ", predicted);

        vm.startBroadcast(pk);
        (tokenId, account) = ENSignRegistry(wrapper).register(
            label,
            qx,
            qy,
            credentialId,
            expiry
        );
        vm.stopBroadcast();

        console2.log("tokenId         ", tokenId);
        console2.log("account (smart account)   ", account);
        require(account == predicted, "smart account address drift");
    }
}
