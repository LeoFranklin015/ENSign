import { JsonRpcProvider } from 'ethers';
import { createProvider, providerURL } from '../providers.js';
import { toPaddedHex } from '../../src/utils.js';
import { test, expect, afterAll } from 'bun:test';
import { describe } from '../bun-describe-fix.js';
import { CHAINS } from '../../src/chains.js';
import { EthProver } from '../../src/eth/EthProver.js';
import { Provider } from '../../src/types.js';

describe.skipIf(!!process.env.IS_CI)('polygon eth_getProof retry', async () => {
  const chain = CHAINS.POLYGON_POS;

  test('JsonRpcProvider: fail', async () => {
    const provider = new JsonRpcProvider(providerURL(chain), chain, {
      staticNetwork: true,
    });
    expect(getProof(provider)).rejects.toThrow();
  });

  test('GatewayProvider: pass', async () => {
    const provider = createProvider(chain);
    afterAll(() => provider.destroy());
    expect(getProof(provider)).resolves.toBeDefined();
  });
});

async function getProof(provider: Provider) {
  const prover = await EthProver.latest(provider, -1000);
  return prover.fetchProofs(toPaddedHex(1, 20));
}
