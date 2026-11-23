import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, parseUnits } from 'ethers';
import { RubaApi, type ActionRequest, type Operation } from '../api.ts';
import { ACTION_TYPES, ZK_OPERATION_TYPES, actionDomain, operationHash, zkOperationDomain } from '../auth.ts';
import type { VaultChain } from '../chain.ts';
import type { ServerConfig } from '../config.ts';
import type { WithdrawalRecord } from '../types.ts';
import { ZkRubaEngine } from '../zk/engine.ts';
import type { CanonicalInboxRecord } from '../zk/engine.ts';

const owner = new Wallet('0x' + '11'.repeat(32));
const operator = new Wallet('0x' + '22'.repeat(32));
const timestamp = 1_800_000_000n;
const claimDeadline = (1n << 64n) - 1n;

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
  let salt = 100n;
  const events: CanonicalInboxRecord[] = [];
  const chain = {
    allowed: false, paused: false, admissionReads: 0,
    async sync() { for (const event of events.splice(0)) engine.applyInboxRecord(event); },
    async latestTimestamp() { return timestamp; },
    async assertWhitelisted(account: string) {
      this.admissionReads++;
      if (account !== owner.address || !this.allowed) throw new Error('Account is not whitelisted');
    },
    async assertNewActivity(account: string) {
      await this.assertWhitelisted(account);
      if (this.paused) throw new Error('Market is paused');
    },
    async withdrawalContext() { return { deadline: claimDeadline, signerEpoch: 0n }; },
    async signWithdrawal(record: WithdrawalRecord) { return record; },
    async publishPendingBatches() {},
  };
  const api = new RubaApi(engine, chain as unknown as VaultChain, config);
  async function request(operation: Operation): Promise<ActionRequest> {
    const intent = { account: owner.address, actionHash: operationHash(operation),
      nonce: engine.getActionNonce(owner.address).toString(), deadline: (timestamp + 600n).toString() };
    if (['zkRegister', 'swap', 'addLiquidity', 'removeLiquidity', 'withdraw'].includes(operation.kind)) {
      const prepared = engine.prepareAuthorization(owner.address, operation, ++salt);
      return { intent, operation,
        signature: await owner.signTypedData(zkOperationDomain(config.chainId, config.vaultAddress), ZK_OPERATION_TYPES, { commitment: prepared.commitment }),
        zk: { commitment: prepared.commitment.toString(), nonce: prepared.nonce.toString(), salt: prepared.salt.toString() } };
    }
    return { intent, operation, signature: await owner.signTypedData(actionDomain(config.chainId, config.vaultAddress), ACTION_TYPES, intent) };
  }
  const act = async (operation: Operation) => api.execute(await request(operation));
  const register = async () => act({ kind: 'zkRegister', recoveryKey: '123456789', slot: '0' });
  function inbox(eventId: bigint, token: 'RUBA' | 'USDT', amount: bigint, kind: 2 | 7 = 2, reference = eventId) {
    events.push({ eventId, kind, owner: owner.address, token, amount, reference, legacyEventId: `canonical:${eventId}` });
  }
  return { engine, chain, api, request, act, register, inbox, close: () => engine.close() };
}

test('ZK API denies non-whitelisted registration without consuming slot, recovery key or either nonce', async () => {
  const f = fixture();
  try {
    const before = f.engine.getZkAccount(owner.address);
    const request = await f.request({ kind: 'zkRegister', recoveryKey: '123456789', slot: '0' });
    await assert.rejects(f.api.execute(request), /not whitelisted/);
    const after = f.engine.getZkAccount(owner.address);
    assert.equal(after.registered, false);
    assert.equal(after.stateRoot, before.stateRoot);
    assert.equal(after.spendNonce, before.spendNonce);
    assert.equal(f.engine.getActionNonce(owner.address), 0n);
    assert.equal(f.engine.journal.operations().length, 0);
    assert.equal(f.engine.journal.getKey(0), undefined);
    f.chain.allowed = true;
    await f.api.execute(request);
    assert.equal(f.engine.getZkAccount(owner.address).registered, true);
    assert.equal(f.engine.getActionNonce(owner.address), 1n);
  } finally { f.close(); }
});

test('ZK registration preserves the existing policy that market pause alone does not block an admitted owner', async () => {
  const f = fixture();
  try {
    f.chain.allowed = true; f.chain.paused = true;
    await f.register();
    assert.equal(f.engine.getZkAccount(owner.address).registered, true);
  } finally { f.close(); }
});

test('one authenticated ZK account read includes the same owner proof without an economic mutation', async () => {
  const f = fixture();
  try {
    f.chain.allowed = true; await f.register();
    f.inbox(1n, 'RUBA', parseUnits('100', 18));
    await f.api.sync();
    const before = f.engine.getZkAccount(owner.address);
    const actionNonce = f.engine.getActionNonce(owner.address);
    const response = await f.act({ kind: 'account' }) as ReturnType<ZkRubaEngine['accountSnapshot']>
      & { zkProof: ReturnType<ZkRubaEngine['getZkAccount']> };
    assert.equal(response.account, owner.address);
    assert.equal(response.zkProof.registered, true);
    assert.equal(response.zkProof.account[0], BigInt(owner.address));
    assert.equal(response.balances.RUBA, response.zkProof.account[1]);
    assert.equal(response.zkProof.stateRoot, before.stateRoot);
    assert.equal(response.zkProof.spendNonce, before.spendNonce);
    assert.equal(f.engine.getActionNonce(owner.address), actionNonce + 1n);
    assert.deepEqual(f.engine.getZkAccount(owner.address), before);
  } finally { f.close(); }
});

test('an unregistered owner can read its zero ZK proof without whitelist but cannot request another owner proof', async () => {
  const f = fixture();
  try {
    const response = await f.act({ kind: 'account' }) as { zkProof: ReturnType<ZkRubaEngine['getZkAccount']> };
    assert.equal(response.zkProof.registered, false);
    assert.ok(response.zkProof.account.every((value) => value === 0n));
    assert.equal(f.chain.admissionReads, 0);
    const forged = await f.request({ kind: 'account' });
    forged.intent.account = operator.address;
    await assert.rejects(f.api.execute(forged), /signature/i);
    assert.equal(f.engine.getActionNonce(operator.address), 0n);
  } finally { f.close(); }
});

test('revocation does not discard a previously accepted canonical deposit or block authenticated balance reads', async () => {
  const f = fixture();
  try {
    f.chain.allowed = true; await f.register();
    f.inbox(1n, 'RUBA', parseUnits('100', 18));
    f.chain.allowed = false;
    const reads = f.chain.admissionReads;
    await f.api.sync();
    await f.act({ kind: 'account' });
    await f.act({ kind: 'zkState' });
    assert.equal(f.engine.accountSnapshot(owner.address).balances.RUBA, parseUnits('100', 18));
    assert.equal(f.engine.getCurrentInboxCursor(), 1n);
    assert.equal(f.chain.admissionReads, reads);
  } finally { f.close(); }
});

test('revoked ZK owner cannot trade or add LP but can remove LP, reserve withdrawal and settle payout', async () => {
  const f = fixture();
  try {
    f.chain.allowed = true; await f.register();
    f.inbox(1n, 'RUBA', parseUnits('1000', 18));
    f.inbox(2n, 'USDT', parseUnits('1000', 6));
    await f.api.sync();
    await f.act({ kind: 'addLiquidity', rubaDesired: parseUnits('1000', 18).toString(), usdtDesired: parseUnits('1000', 6).toString(), rubaMin: '0', usdtMin: '0' });
    f.chain.allowed = false; f.chain.paused = true;
    const actionNonce = f.engine.getActionNonce(owner.address);
    await assert.rejects(f.act({ kind: 'quote', tokenIn: 'RUBA', amountIn: '1' }), /not whitelisted/);
    await assert.rejects(f.act({ kind: 'swap', tokenIn: 'RUBA', amountIn: '1', minOut: '0' }), /not whitelisted/);
    await assert.rejects(f.act({ kind: 'addLiquidity', rubaDesired: '1', usdtDesired: '1', rubaMin: '0', usdtMin: '0' }), /not whitelisted/);
    assert.equal(f.engine.getActionNonce(owner.address), actionNonce);
    const admissionReads = f.chain.admissionReads;
    const shares = f.engine.accountSnapshot(owner.address).lpShares;
    const removal = await f.act({ kind: 'removeLiquidity', shares: shares.toString(), rubaMin: '0', usdtMin: '0' }) as { closedThroughStateVersion: bigint | null };
    assert.ok(removal.closedThroughStateVersion !== null && removal.closedThroughStateVersion > 0n,
      'A pure control LP exit must return its sealed publication boundary even without pending swaps');
    assert.equal(f.engine.getTransition(removal.closedThroughStateVersion)!.operations.at(-1)!.kind, 5);
    const amount = f.engine.accountSnapshot(owner.address).balances.USDT;
    assert.ok(amount > 0n);
    const claim = await f.act({ kind: 'withdraw', token: 'USDT', amount: amount.toString() }) as WithdrawalRecord;
    assert.equal(f.engine.accountSnapshot(owner.address).balances.USDT, 0n);
    assert.equal(f.engine.snapshot().pending.USDT, amount);
    f.inbox(3n, 'USDT', amount, 7, claim.nonce);
    await f.api.sync();
    assert.equal(f.engine.snapshot().pending.USDT, 0n);
    assert.equal(f.engine.getWithdrawal(owner.address, claim.nonce)?.status, 'settled');
    assert.equal(f.chain.admissionReads, admissionReads, 'exit and canonical settlement never ask for trading admission');
  } finally { f.close(); }
});

test('LP removal and closing its pure control packet roll back together if sealing fails', async () => {
  const f = fixture();
  try {
    f.chain.allowed = true; await f.register();
    f.inbox(1n, 'RUBA', parseUnits('1000', 18));
    f.inbox(2n, 'USDT', parseUnits('1000', 6));
    await f.api.sync();
    await f.act({ kind: 'addLiquidity', rubaDesired: parseUnits('1000', 18).toString(), usdtDesired: parseUnits('1000', 6).toString(), rubaMin: '0', usdtMin: '0' });
    const before = f.engine.accountSnapshot(owner.address);
    const nonce = f.engine.getActionNonce(owner.address);
    const records = f.engine.journal.operations().length;
    Object.assign(f.engine, { closePendingBatch() { throw new Error('Injected sealing failure'); } });
    await assert.rejects(f.act({ kind: 'removeLiquidity', shares: before.lpShares.toString(), rubaMin: '0', usdtMin: '0' }), /sealing failure/);
    assert.deepEqual(f.engine.accountSnapshot(owner.address), before);
    assert.equal(f.engine.getActionNonce(owner.address), nonce);
    assert.equal(f.engine.journal.operations().length, records);
  } finally { f.close(); }
});
