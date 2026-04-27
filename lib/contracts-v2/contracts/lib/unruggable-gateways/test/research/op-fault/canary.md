# Notes on Disputed Games

* OptimismPortal &mdash; https://etherscan.io/address/0xbEb5Fc579115071764c7423A4f12eDde41f106Ed 
* DisputeGameFactory &mdash; https://etherscan.io/address/0xe5965Ab5962eDc7477C8520243A95517CD252fA9

### Anchor Registry

1. `rgt` = `optimismPortal.respectedGameType()` = `0`
1. `disputeGameFactory.gameImpl[rgt]` &mdash; https://etherscan.io/address/0xf691F8A6d908B58C534B624cF16495b491E633BA
1. `.anchorStateRegistry()` &mdash; https://etherscan.io/address/0x18DAc71c228D1C32c99489B7323d441E1175e443
1. `.anchors[rgt]` &rarr; `{root, l2BlockNumber}`

### Time Constants

* disputeGameFinalityDelaySeconds = `302400` &rarr; `3.5 days`
* proofMaturityDelaySeconds = `604800` &rarr; `7.0 days`

### Transactions
1. https://etherscan.io/tx/0xa9ea4db70e7dc5875bcfbe2674861aa710cb94669a6f0b220b68e619e98e0199
1. https://etherscan.io/tx/0x0621733b6a118b49582f1f76bbc36903b0259dbabd68e2f3b3d347eba5c83fa3 
1. https://etherscan.io/tx/0x4edf73ee2880cd86d7c376afb525aa02c6db747e8d046ca5a3c03b75090d8451 

### Proposers
1. https://etherscan.io/address/0xe5965Ab5962eDc7477C8520243A95517CD252fA9
1. https://etherscan.io/address/0xaA08d45476DA6831E03b707DbD4d473e1a0f9288 &larr; ???
1. https://etherscan.io/address/0xe5965Ab5962eDc7477C8520243A95517CD252fA9

### Games
1. https://etherscan.io/address/0x505f00C30c9d94F441E7CC025E925990909854A3
1. https://etherscan.io/address/0xE7FA36c4B527F79B061D1461E5Bbb2C1356b2c35 
1. https://etherscan.io/address/0x36EaAc201B02d0C1a584d3D61C92EBf7e60120F3

### L2BlockNumber
1. `122822846`
1. `1721246403`
1. `122824554` 

### RootClaim
1. `0x3f24da8eb3fcbfff7dc458a61673fcceb1da88a45e32dc534e82c81559dce8e7`
1. `0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`
1. `0x2562f100467cc3f972f52e760c04ac0b102fa0120c08e1fd2c0f7c93e29d2262` 

### Starting Data
1. `0x5471221e4e76d79807fff2b582ccbb0ba59fccf4442da504e2072f7d4bb32b49` `122669564`
1. `0x8f62dcbc3d03ee62f556f18e7ecf1dffc634bc0ee6e31d74bcf398d8daf77424` `122671400`
1. `0x8f62dcbc3d03ee62f556f18e7ecf1dffc634bc0ee6e31d74bcf398d8daf77424` `122671400`

### Distance from Starting
1. `122822846 - 122669564 = 153282`
1. `1721246403 - 122671400 = 1598575003`
1. `122824554 - 122671400 = 153154`

Note: `150XXX` &rarr; `1.75 days`

---

Answer: [`0xaA08d45476DA6831E03b707DbD4d473e1a0f9288` is canary proposer](https://discord.com/channels/667044843901681675/1080862392281481246/1266023793520939038)
> Ethnical — 07/25/2024 6:26 AM: Hey, This is the canary proposer address! This is part of the liveness to ensure that the fault dispute game challenger is working as expected
