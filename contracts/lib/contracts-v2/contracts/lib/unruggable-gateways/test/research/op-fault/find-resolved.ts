import { ethers } from 'ethers';
import { OPFaultRollup } from '../../../src/op/OPFaultRollup.js';
import { createProviderPair } from '../../providers.js';

const config = OPFaultRollup.mainnetConfig;
const rollup = new OPFaultRollup(createProviderPair(config), config);

// find the most recent dispute games
// warning: these might not be official games!
const topic = ethers.id('Resolved(uint8)');
const block = await rollup.provider1.getBlockNumber();
const logs = await rollup.provider1.getLogs({
  topics: [topic],
  fromBlock: block - 86400 / 12,
  toBlock: block,
});

console.log({ topic, block });
logs
  .reverse()
  .forEach((x, i) =>
    console.log(
      i.toString().padStart(2),
      x.blockNumber,
      x.transactionHash,
      parseInt(x.topics[1])
    )
  );
