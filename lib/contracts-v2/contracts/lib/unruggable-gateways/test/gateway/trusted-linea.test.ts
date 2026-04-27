import { testTrustedEth } from './common.js';
import { CHAINS } from '../../src/chains.js';

testTrustedEth(CHAINS.LINEA, {
  slotDataContract: '0x48F5931C5Dbc2cD9218ba085ce87740157326F59',
  skipCI: true,
});
