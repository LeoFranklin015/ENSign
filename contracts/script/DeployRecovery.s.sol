// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {ENSignRecoveryManager} from "../src/recovery/ENSignRecoveryManager.sol";
import {ENSRecoveryProvider} from "../src/recovery/providers/ENSRecoveryProvider.sol";
import {ECDSARecoveryProvider} from "../src/recovery/providers/ECDSARecoveryProvider.sol";

/// @notice Deploys the ENSign recovery engine: the singleton manager plus the two
///         launch providers. All three are non-ownable and constructor-only — no
///         wiring, no roles, no follow-up transactions.
contract DeployRecovery is Script {
    function run()
        external
        returns (address manager, address ensProvider, address ecdsaProvider)
    {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = pk != 0 ? vm.addr(pk) : vm.envAddress("SENDER");

        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast(deployer);

        manager = address(new ENSignRecoveryManager());
        ensProvider = address(new ENSRecoveryProvider());
        ecdsaProvider = address(new ECDSARecoveryProvider());

        vm.stopBroadcast();

        console2.log("ENSignRecoveryManager ", manager);
        console2.log("ENSRecoveryProvider   ", ensProvider);
        console2.log("ECDSARecoveryProvider ", ecdsaProvider);
    }
}
