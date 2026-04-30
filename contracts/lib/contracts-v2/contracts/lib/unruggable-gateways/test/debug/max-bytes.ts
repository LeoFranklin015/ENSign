import { Foundry } from '@adraffy/blocksmith';
import { dataLength, ethers } from 'ethers';


const foundry = await Foundry.launch({ infoLog: false });
const contract = await foundry.deploy({
  sol: `
    contract X {
      bytes public data;
      function set(bytes memory v) external {
        data = v;
      }
      function appendShit(bytes memory v) external {
        data = bytes.concat(data, v);
      }
      function appendFast(bytes memory v) external {
        require(v.length & 31 == 0, "unaligned src");
        uint256 first;
        assembly { first := sload(data.slot) }
        require(first == 0 || first & 63 == 1, "unaligned dst");
        first >>= 6;
        uint256 slot;
        assembly { slot := data.slot }
        slot = uint256(keccak256(abi.encode(slot))) + first;
        uint256 count = v.length >> 5;
        assembly { sstore(data.slot, or(1, shl(6, add(first, count)))) }
        uint256 ptr;
        assembly { ptr := add(v, 32) }
        for (uint256 i = 0; i < count; i++) {
          assembly { 
            sstore(slot, mload(ptr)) 
            ptr := add(ptr, 32)
            slot := add(slot, 1)
          }
        }
      }
    }
  `
});

if (0) {
  for (let n = 40000; ; n += 100) {
    try {
      console.log(n, await contract.set.estimateGas(ethers.randomBytes(n)));
      n += 10;
    } catch (err) {
      break;
    }
  }
}

const chunk = ethers.randomBytes(32000);

console.log(await contract.appendShit.estimateGas(chunk));
console.log(await contract.appendFast.estimateGas(chunk));

if (0) {
  for (let i = 0; i < 3; i++) {
    await foundry.confirm(contract.appendShit(chunk));
  }
}

for (let i = 0; i < 20; i++) {
  try {
    await foundry.confirm(contract.appendFast(chunk));
    console.log(dataLength(await contract.data()), await contract.data.estimateGas());
  } catch (err) {
    console.log((err as any).shortMessage)
    break;
  }
}



await foundry.shutdown();

// 42200 29979445n

