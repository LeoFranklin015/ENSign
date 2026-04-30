import { JsonRpcApiProvider, Network } from 'ethers/providers';
import { CHAINS } from './chains.js';

export const VOID_PROVIDER: JsonRpcApiProvider =
  new (class extends JsonRpcApiProvider {
    // ..._args: Parameters<JsonRpcApiProvider['_send']
    override async _send(): ReturnType<JsonRpcApiProvider['_send']> {
      throw new Error('not implemented: void provider');
    }
  })(new Network('void', CHAINS.VOID), { staticNetwork: true });
