import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { keccak256 } from 'ethers';
import { checkedSignals, type Groth16SolidityProof, type ProveableTransition, type ZkArtifactManifest } from './types.ts';

interface SnarkProof {
  pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol?: string; curve?: string;
}
interface SnarkApi {
  curves: { getCurveFromName(name: string): Promise<{ terminate(): Promise<void> }> };
  groth16: {
    fullProve(input: unknown, wasm: string, zkey: string): Promise<{ proof: SnarkProof; publicSignals: string[] }>;
    verify(vk: unknown, signals: string[], proof: SnarkProof): Promise<boolean>;
  };
}
const snarkjs = createRequire(import.meta.url)('snarkjs') as SnarkApi;
let proofQueue: Promise<unknown> = Promise.resolve();
const curveUsers = new Set<Groth16TransitionProver>();
let sharedCurveUsed = false;

/** All markets share the process's heavy prover/curve budget, including cache verification. */
export function withProverBudget<T>(operation: () => Promise<T>): Promise<T> {
  const result = proofQueue.then(operation);
  proofQueue = result.catch(() => undefined);
  return result;
}

function canonical(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
function fileSha256(path: string): string {
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let length;
    while ((length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  } finally { closeSync(descriptor); }
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface TransitionProof {
  publicSignals: bigint[];
  proof: Groth16SolidityProof;
}

/** Real Groth16 prover. A state version is permanently bound to its original witness and artifacts. */
export class Groth16TransitionProver {
  readonly artifactsDir: string;
  readonly db: DatabaseSync;
  private manifestValue?: ZkArtifactManifest;
  private verificationKey: unknown;
  private wasmPath = '';
  private zkeyPath = '';
  private artifactFingerprint = '';
  private curveUsed = false;
  private closed = false;
  private closeWork?: Promise<void>;
  private readonly inFlight = new Map<string, Promise<TransitionProof>>();

  constructor(db: DatabaseSync, artifactsDir = resolve('zk/artifacts')) {
    this.db = db;
    this.artifactsDir = resolve(artifactsDir);
    db.exec(`CREATE TABLE IF NOT EXISTS zk_proof_cache (
      state_version TEXT PRIMARY KEY,
      witness_hash TEXT NOT NULL,
      artifacts_hash TEXT NOT NULL,
      proof_json TEXT,
      public_signals_json TEXT
    )`);
  }

  initialize(): ZkArtifactManifest {
    if (this.manifestValue) return this.manifestValue;
    const manifest = JSON.parse(readFileSync(resolve(this.artifactsDir, 'manifest.json'), 'utf8')) as ZkArtifactManifest;
    if (manifest.version !== 2 || manifest.circuit !== 'ruba-transition-v2') throw new Error('Unsupported ZK circuit manifest');
    if (!/^0x[0-9a-fA-F]{64}$/.test(manifest.verifierRuntimeCodeHash)) throw new Error('ZK artifact manifest has no pinned verifier runtime code hash');
    if (!/^0x[0-9a-fA-F]{64}$/.test(manifest.poseidonRuntimeCodeHash)) throw new Error('ZK artifact manifest has no pinned Poseidon runtime code hash');
    const localPath = (path: string) => isAbsolute(path) ? path : resolve(this.artifactsDir, path);
    this.wasmPath = localPath(manifest.wasm ?? 'transition_js/transition.wasm');
    this.zkeyPath = localPath(manifest.zkey ?? 'transition_final.zkey');
    const vkPath = localPath(manifest.verificationKey ?? 'verification_key.json');
    const vkBytes = readFileSync(vkPath);
    this.verificationKey = JSON.parse(vkBytes.toString('utf8'));
    const vk = this.verificationKey as { protocol?: string; curve?: string; nPublic?: number };
    if (vk.protocol !== 'groth16' || vk.curve !== 'bn128' || vk.nPublic !== 13) throw new Error('ZK verification key must be Groth16 BN254 with thirteen public signals');
    const digests = [fileSha256(this.wasmPath), fileSha256(this.zkeyPath), sha256(vkBytes.toString('utf8'))];
    for (const [actual, expected] of [[digests[0], manifest.wasmSha256], [digests[1], manifest.zkeySha256], [digests[2], manifest.verificationKeySha256]]) {
      if (expected && actual !== expected.replace(/^0x/, '').toLowerCase()) throw new Error('ZK artifact hash differs from the pinned manifest');
    }
    if (manifest.verificationKeyHash && keccak256(vkBytes).toLowerCase() !== manifest.verificationKeyHash.toLowerCase()) throw new Error('ZK verification key hash differs from the manifest');
    this.artifactFingerprint = sha256(canonical(digests));
    this.manifestValue = manifest;
    return manifest;
  }

  async prove(transition: ProveableTransition): Promise<TransitionProof> {
    if (this.closed) throw new Error('ZK prover is closed');
    this.initialize();
    const version = BigInt(transition.stateVersion).toString();
    const expected = checkedSignals(transition.publicSignals);
    if (BigInt(version) <= 0n || expected[1] !== BigInt(version)) throw new Error('ZK witness version differs from its public header');
    const witnessHash = sha256(canonical({ witness: transition.witness, publicSignals: expected }));
    const previous = this.db.prepare('SELECT * FROM zk_proof_cache WHERE state_version=?').get(version) as
      { witness_hash: string; artifacts_hash: string; proof_json: string | null; public_signals_json: string | null } | undefined;
    if (previous && (previous.witness_hash !== witnessHash || previous.artifacts_hash !== this.artifactFingerprint)) throw new Error('Immutable ZK transition witness or proving artifacts changed');
    if (!previous) this.db.prepare('INSERT INTO zk_proof_cache(state_version,witness_hash,artifacts_hash) VALUES(?,?,?)').run(version, witnessHash, this.artifactFingerprint);
    const running = this.inFlight.get(version);
    if (running) return running;
    const work = withProverBudget(async () => {
      if (previous?.proof_json && previous.public_signals_json) {
        return this.checkedProof(JSON.parse(previous.proof_json) as SnarkProof, JSON.parse(previous.public_signals_json) as string[], expected);
      }
      return this.generate(transition.witness, expected, version);
    });
    this.inFlight.set(version, work);
    try { return await work; }
    finally { this.inFlight.delete(version); }
  }

  private async generate(witness: unknown, expected: bigint[], version: string): Promise<TransitionProof> {
    // fullProve executes the real witness generator and Groth16 prover. A failure
    // stays a failed transition; there is no trusted-signature/legacy fallback.
    this.curveUsed = true;
    curveUsers.add(this); sharedCurveUsed = true;
    const generated = await snarkjs.groth16.fullProve(JSON.parse(canonical(witness)), this.wasmPath, this.zkeyPath);
    const result = await this.checkedProof(generated.proof, generated.publicSignals, expected);
    this.db.prepare('UPDATE zk_proof_cache SET proof_json=?,public_signals_json=? WHERE state_version=?')
      .run(JSON.stringify(generated.proof), JSON.stringify(generated.publicSignals), version);
    return result;
  }

  private async checkedProof(proof: SnarkProof, signals: string[], expected: bigint[]): Promise<TransitionProof> {
    const actual = checkedSignals(signals);
    if (actual.some((value, index) => value !== expected[index])) throw new Error('Generated proof public signals differ from the immutable transition');
    this.curveUsed = true;
    curveUsers.add(this); sharedCurveUsed = true;
    if (!await snarkjs.groth16.verify(this.verificationKey, signals, proof)) throw new Error('Generated Groth16 proof failed verification');
    if (proof.pi_a.length < 2 || proof.pi_b.length < 2 || proof.pi_b[0].length < 2 || proof.pi_b[1].length < 2 || proof.pi_c.length < 2) throw new Error('Malformed Groth16 proof');
    return {
      publicSignals: actual,
      proof: {
        a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
        b: [[BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])], [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])]],
        c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
      },
    };
  }

  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closed = true;
    this.closeWork = (async () => {
      await Promise.allSettled(this.inFlight.values());
      this.curveUsed = false; curveUsers.delete(this);
      await withProverBudget(async () => {
        if (curveUsers.size === 0 && sharedCurveUsed) {
          await (await snarkjs.curves.getCurveFromName('bn128')).terminate();
          sharedCurveUsed = false;
        }
      });
    })();
    return this.closeWork;
  }
}
