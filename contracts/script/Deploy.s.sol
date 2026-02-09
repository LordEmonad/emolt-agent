// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/EmotionOracle.sol";

contract DeployScript is Script {
    function run() external {
        vm.startBroadcast();
        EmotionOracle oracle = new EmotionOracle();
        console.log("EmotionOracle deployed at:", address(oracle));
        vm.stopBroadcast();
    }
}
