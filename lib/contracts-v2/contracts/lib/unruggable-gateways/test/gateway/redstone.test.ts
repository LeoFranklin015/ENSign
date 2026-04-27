import { OPRollup } from '../../src/op/OPRollup.js';
import { testOP } from './common.js';

testOP(OPRollup.redstoneMainnetConfig, {
  // https://explorer.redstone.xyz/address/0x4C600c1ee9c81Be765387B7659347fc036D3dE6C?tab=contract
  slotDataContract: '0x4C600c1ee9c81Be765387B7659347fc036D3dE6C',
  skipCI: true,
});
