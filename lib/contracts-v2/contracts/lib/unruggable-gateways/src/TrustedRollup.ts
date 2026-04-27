import type {
  HexString,
  HexString32,
  ProofSequence,
  Provider,
} from './types.js';
import type { AbstractProver, LatestProverFactory } from './vm.js';
import { AbstractRollup, type RollupCommit } from './rollup.js';
import { ABI_CODER } from './utils.js';
import { CachedValue } from './cached.js';
import { VOID_PROVIDER } from './VoidProvider.js';
import { ZeroAddress } from 'ethers/constants';
import { SigningKey } from 'ethers/crypto';
import { computeAddress } from 'ethers/transaction';
import { solidityPackedKeccak256 } from 'ethers/hash';

export type TrustedCommit<P extends AbstractProver> = RollupCommit<P> & {
  readonly stateRoot: HexString32;
  readonly signature: HexString;
  readonly signedAt: number;
};

export class TrustedRollup<P extends AbstractProver> extends AbstractRollup<
  TrustedCommit<P>
> {
  readonly latest: CachedValue<TrustedCommit<P>>;
  #signed = 0n;
  constructor(
    provider2: Provider,
    readonly factory: LatestProverFactory<P>,
    readonly signingKey: SigningKey
  ) {
    super({ provider1: VOID_PROVIDER, provider2 });
    this.latest = new CachedValue(async () => {
      const prover = await factory.latest(this.provider2, this.latestBlockTag);
      const stateRoot = await prover.fetchStateRoot();
      const signedAt = Math.ceil(Date.now() / 1000);
      const hash = solidityPackedKeccak256(
        ['bytes', 'address', 'uint64', 'bytes32'],
        ['0x1900', ZeroAddress, signedAt, stateRoot]
      );
      const signature = this.signingKey.sign(hash).serialized;
      return {
        index: this.#signed++,
        prover,
        stateRoot,
        signature,
        signedAt,
      };
    }, 60000);
  }
  get signerAddress() {
    return computeAddress(this.signingKey);
  }
  override get unfinalized() {
    return true;
  }
  override async fetchLatestCommitIndex(): Promise<bigint> {
    return (await this.latest.get()).index;
  }
  protected override async _fetchParentCommitIndex(
    _commit: RollupCommit<P>
  ): Promise<bigint> {
    return -1n;
  }
  protected override async _fetchCommit(
    _index: bigint
  ): Promise<TrustedCommit<P>> {
    return this.latest.get();
  }
  override encodeWitness(
    commit: TrustedCommit<P>,
    proofSeq: ProofSequence
  ): HexString {
    return ABI_CODER.encode(
      ['(bytes,uint64,bytes32,bytes[],bytes)'],
      [
        [
          commit.signature,
          commit.signedAt,
          commit.stateRoot,
          proofSeq.proofs,
          proofSeq.order,
        ],
      ]
    );
  }
  override windowFromSec(sec: number): number {
    return sec;
  }
}
