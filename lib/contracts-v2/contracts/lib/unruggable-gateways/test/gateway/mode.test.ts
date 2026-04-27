import { OPRollup } from '../../src/op/OPRollup.js';
import { testOP } from './common.js';

testOP(OPRollup.modeMainnetConfig, {
  // https://explorer.mode.network/address/0xFD649fAB87f436cC3De7d589d8F62c2109C8c59c?tab=contract
  slotDataContract: '0xFD649fAB87f436cC3De7d589d8F62c2109C8c59c',
  skipCI: true,
});
