
import { EthProver } from '../../src/eth/EthProver.js';
import {ScrollRollup} from '../../src/scroll/ScrollRollup.js';
import {MorphRollup} from '../../src/morph/MorphRollup.js';
import {createProviderPair} from '../providers.js';

const config = MorphRollup.mainnetConfig;
const rollup = new MorphRollup(createProviderPair(config), config);
//rollup.latestBlockTag = 'latest';

// const config = ScrollRollup.mainnetConfig;
// const rollup = new ScrollRollup(createProviderPair(config), config);

const commit = await rollup.fetchCommit(1932n);

//console.log(await commit.prover.fetchBlock());

console.log(commit.index);

const prover = await EthProver.latest(rollup.provider2);

//console.log(await prover.getProofs('0x0d3e01829E8364DeC0e7475ca06B5c73dbA33ef6', [1n]))

console.log(parseInt(commit.prover.block));
console.log(await commit.prover.fetchStateRoot());
console.log(await rollup.Rollup.finalizedStateRoots(commit.index));

// for (let i = -5; i <= 5; i++) {
// 	console.log(i, await new EthProver(rollup.provider2, parseInt(commit.prover.block) + i).fetchStateRoot());
// }

