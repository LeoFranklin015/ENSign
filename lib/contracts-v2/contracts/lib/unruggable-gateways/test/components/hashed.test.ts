import { Foundry } from '@adraffy/blocksmith';
import { GatewayRequest } from '../../src/vm.js';
import { EthProver } from '../../src/eth/EthProver.js';
import { hexlify } from 'ethers/utils';
import { keccak256, randomBytes } from 'ethers/crypto';
import { afterAll, test, expect } from 'bun:test';
import { describe } from '../bun-describe-fix.js';

describe('hashed', async () => {
  const foundry = await Foundry.launch({ infoLog: false });
  afterAll(foundry.shutdown);
  const GatewayVM = await foundry.deploy({ file: 'GatewayVM' });
  const hooks = await foundry.deploy({ file: 'EthVerifierHooks' });
  const verifier = await foundry.deploy({
    file: 'SelfVerifier',
    args: [[], 0, hooks],
    libs: { GatewayVM },
  });
  // this is almost ~400 rpc calls!
  const bytes = hexlify(randomBytes(12345));
  async function deployContract(fast: boolean) {
    return foundry.deploy({
      sol: `
        import {ReadBytesAt} from '@src/ReadBytesAt.sol';
        contract ${fast ? 'Fast is ReadBytesAt' : 'Slow'} {
          struct Prefixed {
            bytes32 hash;
            bytes value;
          }
          Prefixed prefixed;
          mapping (uint256 => Prefixed) prefixedMap;
          mapping (uint256 => bytes32) hashMap;
          mapping (uint256 => bytes) valueMap;
          constructor(bytes memory v) {
            _update(prefixed, v);
            _update(prefixedMap[1337], v);
            valueMap[123] = v;
            hashMap[123] = keccak256(v);
          }
          function _update(Prefixed storage p, bytes memory v) internal {
            p.value = v;
            p.hash = keccak256(v);
          }
        }
      `,
      args: [bytes],
    });
  }

  // deploy two versions of the contract
  const slow = await deployContract(false); // w/o helper
  const fast = await deployContract(true); // with helper

  async function verify(req: GatewayRequest) {
    const prover = await EthProver.latest(foundry.provider);
    const stateRoot = await prover.fetchStateRoot();
    const vm = await prover.evalRequest(req);
    const proofSeq = await prover.prove(vm.needs);
    const values = await vm.resolveOutputs();
    const res = await verifier.verify(
      req.toTuple(),
      stateRoot,
      proofSeq.proofs,
      proofSeq.order
    );
    expect(res.outputs.toArray()).toEqual(values);
    expect(res.exitCode).toBe(BigInt(vm.exitCode));
    return { values, ...vm };
  }

  for (const contract of [slow, fast]) {
    describe(String(contract), () => {
      test('prefixed: direct', async () => {
        const { values } = await verify(
          new GatewayRequest()
            .setTarget(contract.target)
            .setSlot(0) // prefixed.hash
            .read()
            .setSlot(1) // prefixed.value
            .readHashedBytes()
            .addOutput()
        );
        expect(values[0]).toEqual(bytes);
      });
      test('prefixed: mapped', async () => {
        const { values } = await verify(
          new GatewayRequest()
            .setTarget(contract.target)
            .setSlot(2)
            .push(1337)
            .follow() // prefixedMap[1337]
            .read()
            .offset(1)
            .readHashedBytes()
            .addOutput()
        );
        expect(values[0]).toEqual(bytes);
      });
      test('split', async () => {
        const { values } = await verify(
          new GatewayRequest()
            .setTarget(contract.target)
            .setSlot(3)
            .push(123)
            .follow() // hashMap[123]
            .read()
            .setSlot(4)
            .push(123)
            .follow() // valueMap[123]
            .readHashedBytes()
            .addOutput()
        );
        expect(values[0]).toEqual(bytes);
      });
      test('inline hash', async () => {
        const { values } = await verify(
          new GatewayRequest()
            .setTarget(contract.target)
            .setSlot(1) // prefixed.value
            .push(keccak256(bytes)) // inline hash
            .readHashedBytes()
            .addOutput()
        );
        expect(values[0]).toEqual(bytes);
      });
      test('wrong hash', async () => {
        expect(
          verify(
            new GatewayRequest()
              .setTarget(contract.target)
              .setSlot(1) // prefixed.value
              .push(0) // wrong hash
              .readHashedBytes()
              .addOutput()
          )
        ).rejects.toThrow('InvalidProof()');
      });
    });
  }
});
