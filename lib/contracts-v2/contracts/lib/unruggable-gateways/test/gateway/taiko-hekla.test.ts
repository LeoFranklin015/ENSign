import { TaikoRollup } from '../../src/taiko/TaikoRollup.js';
import { testTaiko } from './common.js';

testTaiko(TaikoRollup.heklaConfig, {
  // https://hekla.taikoscan.io/address/0xA2e3c1b0a43336A21E2fA56928bc7B7848c156A8#code
  slotDataContract: '0xA2e3c1b0a43336A21E2fA56928bc7B7848c156A8',
  // https://hekla.taikoscan.io/address/0xb3664493FB8414d3Dad1275aC0E8a12Ef859694d#code
  slotDataPointer: '0xb3664493FB8414d3Dad1275aC0E8a12Ef859694d',
  skipCI: true,
});
