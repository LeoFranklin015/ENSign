import { JsonRpcProvider } from 'ethers';
import { createProviderPair, providerURL } from '../providers.js';
import { LineaRollup } from '../../src/linea/LineaRollup.js';
import { LineaProver } from '../../src/linea/LineaProver.js';
import { toPaddedHex } from '../../src/utils.js';
import { test, expect } from 'bun:test';
import { describe } from '../bun-describe-fix.js';

describe.skipIf(!!process.env.IS_CI)(
  'linea_getProof is unbatchable',
  async () => {
    const config = LineaRollup.mainnetConfig;
    const rollup = new LineaRollup(createProviderPair(config), config);
    const commit0 = await rollup.fetchLatestCommit();
    const commit1 = await rollup.fetchParentCommit(commit0);

    test('JsonRpcProvider: fail', async () => {
      const provider = new JsonRpcProvider(
        providerURL(config.chain2),
        config.chain2,
        { staticNetwork: true }
      );
      const prover = new LineaProver(provider, commit1.prover.block);
      expect(proveBatch(prover)).rejects.toThrow();
    });

    test('GatewayProvider: pass', async () => {
      expect(proveBatch(commit1.prover)).resolves.toBeArray();
    });
  }
);

async function proveBatch(prover: LineaProver) {
  return Promise.all([
    prover.fetchProofs(toPaddedHex(1, 20)),
    prover.fetchProofs(toPaddedHex(2, 20)),
  ]);
}
