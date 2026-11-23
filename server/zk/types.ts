import type { TransitionWitness, PublicationMetadata, DaRecord, PoolDa } from '../../zk/schema.ts';
import type { SignedBatchPublication } from '../types.ts';
export type { ProvenWithdrawal, ProvenWithdrawalTicket as ZkWithdrawalTicket } from '../types.ts';

export const ZK_PROOF_MODE = 'groth16-bn254-v2' as const;
export const ZK_WITHDRAWAL_MODE = 'proven-reservation-v1' as const;
export const ZK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const SIGNAL = {
  domain: 0, stateVersion: 1, mode: 2, previousRoot: 3, newRoot: 4,
  previousInboxCursor: 5, newInboxCursor: 6, previousTradeId: 7, newTradeId: 8,
  receiptsRoot: 9, authDigest: 10, daDigest: 11, poolKeyCommit: 12,
} as const;

export interface Groth16SolidityProof {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
}

/** Only committed public calldata. This structure must never contain witness/key material. */
export interface ZkSignedPublication extends Omit<SignedBatchPublication, 'kind'> {
  kind: 'zk';
  authorizationMode: 'proof-only';
  chainId: bigint;
  vault: string;
  publicSignals: bigint[];
  operations: PublicationMetadata[];
  accountDA: DaRecord[];
  poolDA: PoolDa;
  proof: Groth16SolidityProof;
  authorization: { deadline: bigint; signerEpoch: bigint; signature: string };
}

export interface ProveableTransition {
  stateVersion: bigint | string;
  publicSignals: readonly (bigint | string)[];
  witness: TransitionWitness;
}

export interface ZkArtifactManifest {
  version?: number;
  testSetup?: boolean;
  circuit?: string;
  wasm?: string;
  zkey?: string;
  verificationKey?: string;
  verifierRuntimeCodeHash: string;
  poseidonRuntimeCodeHash: string;
  verificationKeyHash?: string;
  wasmSha256?: string;
  zkeySha256?: string;
  verificationKeySha256?: string;
}

export function checkedSignals(values: readonly (string | bigint)[]): bigint[] {
  if (values.length !== 13) throw new Error('ZK transition must contain exactly thirteen public signals');
  return values.map((value) => {
    if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))) throw new Error('Non-canonical ZK public signal');
    const number = BigInt(value);
    if (number < 0n || number >= ZK_FIELD) throw new Error('ZK public signal is outside Fr');
    return number;
  });
}
