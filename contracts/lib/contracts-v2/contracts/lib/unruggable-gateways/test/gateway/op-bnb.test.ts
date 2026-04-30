import { OPRollup } from '../../src/op/OPRollup.js';
import { testOP } from './common.js';

// 20241002: untested, unable to find bsc node sufficient eth_getProof depth
testOP(OPRollup.opBNBMainnetConfig, {
  // https://opbnbscan.com/address/0x0d3e01829E8364DeC0e7475ca06B5c73dbA33ef6?tab=Contract&p=1&view=contract_code
  slotDataContract: '0x0d3e01829E8364DeC0e7475ca06B5c73dbA33ef6',
  skipCI: true,
});
