import { Foundry } from '@adraffy/blocksmith';
import { fetchBlock } from '../../src/utils.js';
import { encodeRlpBlock } from '../../src/rlp.js';
import { keccak256 } from 'ethers';
import { createProvider } from '../providers.js';
import { CHAINS } from '../../src/chains.js';
import { inspect } from 'bun';
import { Provider } from '../../src/types.js';

const foundry = await Foundry.launch({ infoLog: false });
await dump(foundry.provider);
await foundry.shutdown();

await dump(createProvider(CHAINS.MAINNET));
await dump(createProvider(CHAINS.OP));

async function dump(provider: Provider) {
  const block = await fetchBlock(provider);
  console.log(
    inspect(
      {
        //block,
        hashFromRPC: block.hash,
        hashFromRLP: keccak256(encodeRlpBlock(block)),
      },
      { colors: true, depth: Infinity }
    )
  );
}

await foundry.shutdown();
