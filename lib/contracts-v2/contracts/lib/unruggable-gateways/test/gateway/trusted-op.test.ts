import { testTrustedEth } from './common.js';
import { CHAINS } from '../../src/chains.js';

testTrustedEth(CHAINS.OP, {
  slotDataContract: '0xf9d79d8c09d24e0C47E32778c830C545e78512CF',
  skipCI: true,
});
