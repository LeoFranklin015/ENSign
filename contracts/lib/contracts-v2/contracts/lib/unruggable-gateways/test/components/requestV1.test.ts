import { GatewayRequest } from '../../src/vm.js';
import { GatewayRequestV1 } from '../../src/v1.js';
import { Foundry } from '@adraffy/blocksmith';
import { EthProver } from '../../src/eth/EthProver.js';
import { test, expect, afterAll } from 'bun:test';
import { describe } from '../bun-describe-fix.js';

const A = '0x1234567890AbcdEF1234567890aBcdef12345678';

describe('v1', async () => {
  const foundry = await Foundry.launch({ infoLog: false });
  afterAll(foundry.shutdown);
  const prover = await EthProver.latest(foundry.provider);

  async function same(v1: GatewayRequestV1, v2: GatewayRequest) {
    const state1 = await prover.evalRequest(v1.v2());
    const state2 = await prover.evalRequest(v2);
    expect(state1.needs).toEqual(state2.needs); // not sure if this needs to hold
    const values1 = await state1.resolveOutputs();
    const values2 = await state2.resolveOutputs();
    expect(values1).toEqual(values2);
  }

  test('getDynamic(8)', async () => {
    const r1 = new GatewayRequestV1(A).getDynamic(8);
    const r2 = new GatewayRequest()
      .setTarget(A)
      .setSlot(8)
      .readBytes()
      .addOutput();
    await same(r1, r2);
  });

  test('getDynamic(1).element(2)', async () => {
    const r1 = new GatewayRequestV1(A).getDynamic(1).element(2);
    const r2 = new GatewayRequest()
      .setTarget(A)
      .setSlot(1)
      .push(2)
      .follow()
      .readBytes()
      .addOutput();
    await same(r1, r2);
  });

  test('getStatic(3).getStatic(4).ref(0)', async () => {
    const r1 = new GatewayRequestV1(A).getStatic(3).getStatic(4).ref(0);
    const r2 = new GatewayRequest()
      .setTarget(A)
      .setSlot(3)
      .read()
      .addOutput()
      .setSlot(4)
      .pushOutput(0)
      .follow()
      .read()
      .addOutput();
    await same(r1, r2);
  });

  test('getDynamic(3).element(4).element(5).getStatic(6).element(bytes("raffy"))', async () => {
    const r1 = new GatewayRequestV1(A)
      .getDynamic(3)
      .element(4)
      .element(5)
      .getStatic(6)
      .elementStr('raffy');
    const r2 = new GatewayRequest()
      .setTarget(A)
      .setSlot(3)
      .push(4)
      .follow()
      .push(5)
      .follow()
      .readBytes()
      .addOutput()
      .setSlot(6)
      .pushStr('raffy')
      .follow()
      .read()
      .addOutput();
    await same(r1, r2);
  });
});
