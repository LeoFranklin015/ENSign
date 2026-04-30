# Notes on Permissioned Fallback

* 2024-08-16 
	* https://twitter.com/Optimism/status/1824560759747256596
	* https://gov.optimism.io/t/upgrade-proposal-10-granite-network-upgrade/8733
	* `respectedGameType` [changed](https://etherscan.io/tx/0x493e2f3354e8c6c46fb37925a13c02364c1f3b38f88548b9bb4673e3fc762e69#eventlog) from `gameType(0)` to `gameType(1)`
	* `AnchorStateRegistry` for `gameType(1)` is [stale](https://etherscan.io/address/0x18DAc71c228D1C32c99489B7323d441E1175e443#readProxyContract)
		* `root = 0x2694ac14dcf54b7a77363e3f60e6462dc78da0d43d1e2f058dbb6a1488814977`
		* [`l2BlockNumber = 120059863`](https://optimistic.etherscan.io/block/120059863)
	* First `PermissionedDisputeGame` is [Game #1633](https://etherscan.io/address/0x75d9947382aE5a2f2424305fE3e40dcACB03456c#readContract)
		* `startingRootHash` and `startingBlockNumber` match `AnchorStateRegistry`
* 2024-09-11
	* https://twitter.com/Optimism/status/1833903320945041685
	* `respectedGameType` [changed](https://etherscan.io/tx/0x592e73fdf57e7cc2c51cfaafa891fe91164d125b7943aa26a15285276de27509) from `gameType(1)` to `gameType(0)`
	* [`OPFaultGameFinder`](https://etherscan.io/address/0x5A8E83f0E728bEb821b91bB82cFAE7F67bD36f7e#readContract) works as expected
		* `0b00 = 1632` Respected
		* `0b01 = 1632` Fault
		* `0b10 = 2183` Permissioned
		* `0b11 = 2183` Max(Fault, Permissioned)
