// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/EmoodRing.sol";

contract DeployEmoodRingScript is Script {
    function run() external {
        address oracle = 0x840ba82DeFB71e57292187f0d3Fe7A0Fc5995082;
        vm.startBroadcast();
        EmoodRing ring = new EmoodRing(oracle);
        console.log("EmoodRing deployed at:", address(ring));
        vm.stopBroadcast();
    }
}
