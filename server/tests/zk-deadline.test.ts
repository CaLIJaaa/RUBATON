import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, parseUnits } from 'ethers';
import { RubaApi, type ActionRequest, type Operation } from '../api.ts';
import { ZK_OPERATION_TYPES, ZK_TIMED_OPERATION_TYPES, operationHash, operationSignatureDeadline, recoverOperationSigner,
  timedOperationSignature, zkOperationDomain } from '../auth.ts';
import type { VaultChain } from '../chain.ts';
import type { ServerConfig } from '../config.ts';
import { ZkRubaEngine } from '../zk/engine.ts';
import type { CanonicalInboxRecord } from '../zk/engine.ts';

const owner = new Wallet('0x' + '11'.repeat(32));
const operator = new Wallet('0x' + '22'.repeat(32));
const start = 1_800_000_000n;

function fixture() {
  const config: ServerConfig = {
    rpcUrl: 'http://127.0.0.1:1', chainId: 31337n, proofMode: 'zk',
    vaultAddress: '0x1000000000000000000000000000000000000001',
    rubaAddress: '0x2000000000000000000000000000000000000002',
    usdtAddress: '0x3000000000000000000000000000000000000003',
    operatorPrivateKey: operator.privateKey, deploymentBlock: 0, confirmations: 0,
    withdrawalTtl: 600n, dbPath: ':memory:', host: '127.0.0.1', port: 3001, syncIntervalMs: 2000,
  };
  const engine = new ZkRubaEngine(config, 987654321n);
  const domain = zkOperationDomain(config.chainId, config.vaultAddress);
  let salt = 100n;
  const events: CanonicalInboxRecord[] = [];
  const chain = {
    now: start,
    async sync() { for (const event of events.splice(0)) engine.applyInboxRecord(event); },
    async latestTimestamp() { return this.now; },
    async assertWhitelisted() {},
    async assertNewActivity() {},
    async publishPendingBatches() {},
  };
  const api = new RubaApi(engine, chain as unknown as VaultChain, config);
  async function request(operation: Operation, lifetime?: bigint): Promise<ActionRequest> {
    const intent = { account: owner.address, actionHash: operationHash(operation),
      nonce: engine.getActionNonce(owner.address).toString(), deadline: (chain.now + 600n).toString() };
    const prepared = engine.prepareAuthorization(owner.address, operation, ++salt);
    const signature = lifetime === undefined
      ? await owner.signTypedData(domain, ZK_OPERATION_TYPES, { commitment: prepared.commitment })
      : timedOperationSignature(chain.now + lifetime, await owner.signTypedData(domain, ZK_TIMED_OPERATION_TYPES, { commitment: prepared.commitment, deadline: chain.now + lifetime }));
    return { intent, operation, signature, zk: { commitment: prepared.commitment.toString(), nonce: prepared.nonce.toString(), salt: prepared.salt.toString() } };
  }
  const act = async (operation: Operation, lifetime?: bigint) => api.execute(await request(operation, lifetime));
  async function market() {
    await act({ kind: 'zkRegister', recoveryKey: '123456789', slot: '0' });
    events.push({ eventId: 1n, kind: 2, owner: owner.address, token: 'RUBA', amount: parseUnits('1000', 18), reference: 1n, legacyEventId: 'canonical:1' });
    events.push({ eventId: 2n, kind: 2, owner: owner.address, token: 'USDT', amount: parseUnits('1000', 6), reference: 2n, legacyEventId: 'canonical:2' });
    await act({ kind: 'addLiquidity', rubaDesired: parseUnits('500', 18).toString(), usdtDesired: parseUnits('500', 6).toString(), rubaMin: '0', usdtMin: '0' }, 3600n);
    engine.closePendingBatch();
    engine.markTransitionAccepted(1n, '0x' + '01'.repeat(32), 10);
  }
  const swap = (lifetime?: bigint) => act({ kind: 'swap', tokenIn: 'RUBA', amountIn: parseUnits('1', 18).toString(), minOut: '1' }, lifetime);
  return { engine, chain, api, domain, request, act, market, swap, close: () => engine.close() };
}

test('timed signature carries the owner deadline in its first word and cannot be moved', async () => {
  const domain = zkOperationDomain(31337n, '0x1000000000000000000000000000000000000001');
  const raw = await owner.signTypedData(domain, ZK_TIMED_OPERATION_TYPES, { commitment: 77n, deadline: 5000n });
  const signature = timedOperationSignature(5000n, raw);
  assert.equal((signature.length - 2) / 2, 97);
  assert.equal(operationSignatureDeadline(signature), 5000n);
  assert.equal(recoverOperationSigner(domain, 77n, signature), owner.address);
  assert.notEqual(recoverOperationSigner(domain, 77n, timedOperationSignature(9000n, raw)), owner.address);
  const legacy = await owner.signTypedData(domain, ZK_OPERATION_TYPES, { commitment: 77n });
  assert.equal(operationSignatureDeadline(legacy), undefined);
  assert.equal(recoverOperationSigner(domain, 77n, legacy), owner.address);
});

test('server keeps the owner deadline, refuses one with no time left to publish and closes the draft before it runs out', async () => {
  const f = fixture();
  try {
    await f.market();
    await assert.rejects(f.swap(300n), /no time to publish/);
    assert.equal(f.engine.journal.operations(true).length, 0);
    await f.swap(3600n);
    const [draft] = f.engine.journal.operations(true);
    assert.equal(operationSignatureDeadline(draft.metadata.signature), start + 3600n);
    assert.equal(f.engine.earliestDraftDeadline(), start + 3600n);
    await f.api.sync();
    assert.equal(f.engine.journal.operations(true).length, 1);
    f.chain.now = start + 2500n;
    await f.api.sync();
    assert.equal(f.engine.journal.operations(true).length, 0);
    const [pending] = f.engine.listTransitions().filter((item) => item.status === 'pending');
    assert.equal(pending.operations[0].metadata.signature, draft.metadata.signature);
  } finally { f.close(); }
});

test('queue rebuild drops an operation whose owner deadline already passed', async () => {
  const f = fixture();
  try {
    await f.market();
    await f.swap(3600n);
    await f.swap();
    f.engine.closePendingBatch();
    const result = f.engine.rebuildQueue(({ deadline }) => deadline !== undefined && deadline < start + 4000n ? 'owner deadline passed' : undefined);
    assert.deepEqual(result.dropped.map((item) => [item.kind, item.reason]), [[3, 'owner deadline passed'], [3, 'follows a dropped operation of this account']]);
    assert.deepEqual(result.pendingVersions, []);
    assert.equal(f.engine.journal.operations().length, f.engine.getAcceptedCheckpoint().journalSeq);
  } finally { f.close(); }
});
