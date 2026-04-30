import { OPRollup } from '../../src/op/OPRollup.js';
import { testOP } from './common.js';

testOP(OPRollup.shapeMainnetConfig, {
  // https://shapescan.xyz/address/0x2B61B95C4484fAec2a8DE939cC2629e64d8B6f67?tab=contract
  slotDataContract: '0x2B61B95C4484fAec2a8DE939cC2629e64d8B6f67',
  // https://shapescan.xyz/address/0x90d2f24a9C81778713EbDa7C417EC0dd30207094?tab=contract
  slotDataPointer: '0x90d2f24a9C81778713EbDa7C417EC0dd30207094',
  skipCI: true,
});
