import type {
  EncodedProof,
  HexAddress,
  HexString,
  HexString32,
} from '../types.js';
import { Interface } from 'ethers/abi';
import { ABI_CODER } from '../utils.js';

export const ROOT_CHAIN_ABI = new Interface([
  //   `event NewHeaderBlock(
  //      address indexed proposer,
  // 	 uint256 indexed blockId,
  // 	 uint256 indexed reward,
  // 	 uint256 start,
  // 	 uint256 end,
  // 	 bytes32 root
  //   )`,
  `function currentHeaderBlock() view returns (uint256)`,
  `function getLastChildBlock() view returns (uint256)`,
  `function headerBlocks(uint256) view returns (bytes32 rootHash, uint256 l2BlockNumberStart, uint256 l2BlockNumberEnd, uint256 createdAt, address proposer)`,
]);

export type ABIHeaderTuple = {
  readonly rootHash: HexString32;
  readonly l2BlockNumberStart: bigint;
  readonly l2BlockNumberEnd: bigint;
};

// https://github.com/0xPolygonHermez/zkevm-contracts/blob/main/contracts/v2/PolygonRollupManager.sol
export const ROLLUP_ABI = new Interface([
  `function chainIDToRollupID(uint64 chainID) view returns (uint32)`,
  `function getRollupBatchNumToStateRoot(uint32 rollupID, uint64 batchNum) view returns (bytes32)`,
  `function getLastVerifiedBatch(uint32 rollupID) view returns (uint64)`,
]);

export type ZKEVMProof = HexString[];

export type RPCZKEVMGetProof = {
  address: HexAddress;
  balance: HexString;
  codeHash: HexString32;
  codeLength: HexString;
  nonce: HexString;
  balanceProof: ZKEVMProof;
  nonceProof: ZKEVMProof;
  codeHashProof: ZKEVMProof;
  codeLengthProof: ZKEVMProof;
  storageProof: ZKEVMStorageProof[];
};

export type ZKEVMAccountProof = Omit<RPCZKEVMGetProof, 'storageProof'>;

export type ZKEVMStorageProof = {
  key: HexString32;
  value: HexString;
  proof: ZKEVMProof;
};

export function isContract(proof: ZKEVMAccountProof) {
  return parseInt(proof.codeLength) > 0;
}

export function encodeProof(proof: ZKEVMProof): EncodedProof {
  return ABI_CODER.encode(['bytes[]'], [proof]);
}
