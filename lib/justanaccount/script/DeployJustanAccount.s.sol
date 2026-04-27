// SPDX-License-Identifier: MIT

pragma solidity ^0.8.4;

import { JustanAccount } from "../src/JustanAccount.sol";
import { JustanAccountFactory } from "../src/JustanAccountFactory.sol";
import { HelperConfig } from "./HelperConfig.s.sol";
import { Script, console2 } from "forge-std/Script.sol";
import { SafeSingletonDeployer } from "safe-singleton-deployer-sol/src/SafeSingletonDeployer.sol";

contract DeployJustanAccount is Script {

    address constant EXPECTED_FACTORY = 0x5803c076563C85799989d42Fc00292A8aE52fa9E;

    bytes32 constant FACTORY_SALT = 0x0000000000000000000000000000000000000000000000000000000000000124;

    function run() external returns (JustanAccount, JustanAccountFactory, HelperConfig.NetworkConfig memory) {
        HelperConfig helperConfig = new HelperConfig();
        HelperConfig.NetworkConfig memory config = helperConfig.getConfig();

        console2.log("Deploying on chain ID", block.chainid);

        address factory;

        if (block.chainid == 31_337) {
            vm.startBroadcast();
            factory = address(new JustanAccountFactory(config.entryPointAddress));
            vm.stopBroadcast();
        } else {
            factory = SafeSingletonDeployer.broadcastDeploy({
                creationCode: type(JustanAccountFactory).creationCode,
                args: abi.encode(config.entryPointAddress),
                salt: FACTORY_SALT
            });

            console2.log("factory", factory);
            assert(factory == EXPECTED_FACTORY);
        }

        JustanAccountFactory factoryContract = JustanAccountFactory(factory);
        address implementation = factoryContract.getImplementation();
        console2.log("implementation", implementation);

        return (JustanAccount(payable(implementation)), factoryContract, config);
    }

}
