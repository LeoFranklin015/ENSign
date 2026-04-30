import { GatewayRequest } from '../../src/vm.js';
import { EthProver } from '../../src/eth/EthProver.js';
import { Foundry } from '@adraffy/blocksmith';
//import { toPaddedHex, toUnpaddedHex } from '../../src/utils.js';
import { hexlify, keccak256, randomBytes } from 'ethers';
import { expect } from 'bun:test';
import { toPaddedHex } from '../../src/utils.js';

function rngUint(n = 32) {
  return BigInt(hexlify(randomBytes(n)));
}

const foundry = await Foundry.launch({ infoLog: true });
try {
  const GatewayVM = await foundry.deploy({ file: 'GatewayVM' });
  const hooks = await foundry.deploy({ file: 'EthVerifierHooks' });
  const verifier = await foundry.deploy({
    file: 'SelfVerifier',
    args: [[], 0, hooks],
    libs: { GatewayVM },
  });

  async function verify(req: GatewayRequest) {
    const prover = await EthProver.latest(foundry.provider);
    const stateRoot = await prover.fetchStateRoot();
    const state = await prover.evalRequest(req);
    const [proofSeq, values] = await Promise.all([
      prover.prove(state.needs),
      state.resolveOutputs(),
    ]);
    const args = [req.toTuple(), stateRoot, proofSeq.proofs, proofSeq.order];
    const res = await verifier.verify(...args);
    expect(res.outputs.toArray()).toEqual(values);
    expect(res.exitCode).toEqual(BigInt(state.exitCode));
    return { values, ...state };
  }

  const req = new GatewayRequest();
  req.debug('before');
  // req.push(0);
  // req.slice(0, 1000);
  req.push(0);
  let sum = 0n;
  for (let i = 0; i < 5000; i++) {
    //req.push(1).plus();

	const x = BigInt(i); // rngUint(32);
	//req.pushBytes(toPaddedHex(x)).plus();
	req.push(x).plus();
	sum += x;

	// req.dup().isNonzero().plus();
	// sum += 1n;

    //req.keccak();
    //sum = BigInt(keccak256(toPaddedHex(sum)));
    //req.keccak();

    //req.push(i).concat();
  }

  req.addOutput();
  req.debug('after');
  const state = await verify(req);
  //expect(state.values[0]).toEqual(toPaddedHex(sum));
} finally {
  await foundry.shutdown();
}
