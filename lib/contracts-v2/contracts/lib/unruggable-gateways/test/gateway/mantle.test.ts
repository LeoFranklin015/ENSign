import { OPRollup } from '../../src/op/OPRollup.js';
import { testOP } from './common.js';

testOP(OPRollup.mantleMainnetConfig, {
  // https://explorer.mantle.xyz/address/0xaD85E1DcfF8adA5420EcB5095D3CCd9bC2e26404?tab=contract
  slotDataContract: '0xaD85E1DcfF8adA5420EcB5095D3CCd9bC2e26404',
  skipCI: true,
});
