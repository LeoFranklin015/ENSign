import { OPRollup } from '../../src/op/OPRollup.js';
import { testOP } from './common.js';

testOP(OPRollup.cyberMainnetConfig, {
  // https://cyberscan.co/address/0xB0005b45cF88413Bda7F834AD44C5235Ee3cF656#contract
  slotDataContract: '0xB0005b45cF88413Bda7F834AD44C5235Ee3cF656',
  skipCI: true,
});
