import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, Wallet, verifyTypedData } from 'ethers';
import {
  FIELD, buildAccountTree, emptyPool, encryptAccount, encryptPool, fieldHex,
  hashAccount, hashAuthDigest, hashDaDigest, hashOperation, hashPool, hashState, keyCommit, verifyAccountProof,
} from '../crypto.js';
import {
  RECOVERY_VAULT_ABI, applyAcceptedUpdate, buildAccountBackup, createRecoveryState,
  inspectAccountBackup, parseAccountBackup, recoverOwnedAccount, recoverPool, scanAcceptedUpdates,
  validateWithdrawalClaims, inspectWithdrawalClaims, PROVEN_WITHDRAWAL_MODE,
  type AcceptedDaUpdate, type ChainCheckpoint, type RecoveryState, type WithdrawalClaimOpening,
} from '../recovery.js';
import { economicFixtures, registrationFixture } from './fixtures.ts';

const f = registrationFixture();
const hexAddress = (value: bigint) => `0x${value.toString(16).padStart(40, '0')}`;
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const TX_HASH = `0x${'cd'.repeat(32)}`;
const config = { chainId: f.chainId, vault: f.vault, ruba: f.ruba, usdt: f.usdt, poolKeyCommit: f.poolKeyCommit };
const credentials = { owner: f.owner, slot: f.slot, recoveryKey: f.recoveryKey };
const registration: AcceptedDaUpdate = { publicSignals: f.publicSignals, metadata: f.authorizationRecords, da: f.daRecords, pool: f.poolDa };
const anchor = (signals: readonly (string | bigint | number)[]): ChainCheckpoint => ({ source: 'contract',
  chainId: f.chainId, vault: f.vault, stateVersion: signals[1], stateRoot: signals[4],
  blockNumber: 20n, blockHash: BLOCK_HASH, transactionHash: TX_HASH, logIndex: 0n, tradeBatchId: 0n });
const registered = () => applyAcceptedUpdate(createRecoveryState(config), registration, anchor(f.publicSignals));
const zeroMetadata = () => ({ kind: 0n, slot: 0n, owner: 0n, commitment: 0n, eventId: 0n, token: 0n, amount: 0n, reference: 0n, signature: '0x' });
const zeroDa = () => ({ kind: 0n, slot: 0n, owner: 0n, newLeaf: 0n, ciphertext: Array<bigint>(7).fill(0n) });

test('accepted recovery supports 1..4-swap packets and counts packets independently of trade IDs', async () => {
  for (const swapCount of [1, 2, 3, 4] as const) {
    const fixtures = await economicFixtures({ swapCount });
    const first = fixtures[0].witness;
    let state = createRecoveryState({ chainId: first.chainId, vault: first.vault, ruba: first.ruba,
      usdt: first.usdt, poolKeyCommit: first.poolKeyCommit });
    let batchId = 0n;
    for (const fixture of fixtures) {
      if (fixture.mode === 1) ++batchId;
      state = applyAcceptedUpdate(state, fixture.update, { source: 'contract', chainId: first.chainId,
        vault: first.vault, stateVersion: fixture.stateVersion, stateRoot: fixture.publicSignals[4],
        blockNumber: fixture.stateVersion + 20n, blockHash: BLOCK_HASH, transactionHash: TX_HASH,
        tradeBatchId: batchId });
      assert.equal(state.tradeBatchId, batchId);
    }
    assert.equal(state.nextTradeId, BigInt(swapCount) + 1n);
    assert.equal(state.tradeBatchId, 1n);
  }
});

/** Pure replay fixtures use an explicitly separate trusted checkpoint, never an embedded server marker. */
function nextControl(state: RecoveryState, options: { kind: bigint; slot: number; owner: bigint; key: bigint;
  account: bigint[]; accounts?: bigint[][]; pool?: bigint[]; amount?: bigint; eventId?: bigint }) {
  const accounts = (options.accounts ?? f.endingState.accounts).map((a) => [...a]);
  accounts[options.slot] = options.account;
  const metadata = Array.from({ length: 8 }, zeroMetadata);
  const da = Array.from({ length: 8 }, zeroDa);
  const bridge = options.kind === 2n || options.kind === 7n;
  metadata[0] = { kind: options.kind, slot: BigInt(options.slot), owner: options.owner,
    commitment: bridge ? 0n : 123n, eventId: options.eventId ?? 0n,
    token: 0n, amount: options.amount ?? 0n, reference: 0n, signature: '0x' };
  const leaf = hashAccount(options.slot, options.account);
  da[0] = { kind: options.kind, slot: BigInt(options.slot), owner: options.owner, newLeaf: leaf,
    ciphertext: encryptAccount(options.key, leaf, options.account) };
  const pool = options.pool ?? emptyPool(); const poolHash = hashPool(pool);
  const poolDa = { poolHash, poolCiphertext: encryptPool(f.poolRecoveryKey, poolHash, pool) };
  const cursor = state.inboxCursor + (bridge ? 1n : 0n);
  const version = state.stateVersion + 1n;
  const signals = [state.domain, version, 0n, state.root,
    hashState(state.domain, buildAccountTree(accounts).root, poolHash, cursor, state.nextTradeId, f.poolKeyCommit),
    state.inboxCursor, cursor, state.nextTradeId, state.nextTradeId, 0n,
    hashAuthDigest(state.domain, version, metadata), hashDaDigest(state.domain, version, da, poolHash, poolDa.poolCiphertext), f.poolKeyCommit];
  const update = { publicSignals: signals, metadata, da, pool: poolDa };
  return { update, signals, accounts, checkpoint: anchor(signals) };
}

test('recovery genesis is independently derived from all sixteen empty leaves', () => {
  const state = createRecoveryState(config);
  assert.equal(state.root, f.startingState.root);
  assert.equal(state.leaves.length, 16);
  assert.equal(state.nextTradeId, 1n);
  assert.throws(() => createRecoveryState({ ...config, genesisStateRoot: 1n }), /Genesis root/);
  assert.throws(() => createRecoveryState({ ...config, domain: 1n }), /domain/);
});

test('accepted registration restores real encrypted balances, key commitment and ordered Merkle path', () => {
  const state = registered();
  const owned = recoverOwnedAccount(state, credentials);
  assert.deepEqual(owned.account, f.endingState.accounts[f.slot]);
  assert.equal(owned.keyCommit, keyCommit(f.recoveryKey));
  assert.equal(owned.status, 'chain-anchored');
  assert.ok(verifyAccountProof(f.slot, owned.leaf, owned.path, state.accountsRoot));
  assert.deepEqual(recoverPool(state, f.poolRecoveryKey), emptyPool());
  assert.throws(() => recoverPool(state, f.poolRecoveryKey + 1n), /key mismatch/);
});

test('updates of another owner rebuild the latest path while old backup stays historical', () => {
  const before = registered(); const oldBackup = buildAccountBackup(before, credentials);
  const owner2 = f.owner + 1n; const key2 = f.recoveryKey + 1n;
  const account2 = [owner2, 0n, 0n, 0n, 1n, 0n, 0n, keyCommit(key2), 789n];
  const second = nextControl(before, { kind: 1n, slot: 8, owner: owner2, key: key2, account: account2 });
  const after = applyAcceptedUpdate(before, second.update, second.checkpoint);
  const owned = recoverOwnedAccount(after, credentials);
  assert.equal(owned.leaf, before.leaves[f.slot]);
  assert.notDeepEqual(owned.path, oldBackup.path.map(BigInt));
  assert.deepEqual(owned.path, buildAccountTree(second.accounts).proofs[f.slot]);
  assert.equal(inspectAccountBackup(oldBackup, second.checkpoint).status, 'historical');
  assert.equal(inspectAccountBackup(buildAccountBackup(after, credentials), second.checkpoint).current, true);
  assert.equal(inspectAccountBackup(buildAccountBackup(after, credentials), anchor(f.publicSignals)).status, 'not-accepted');
});

test('a canonical deposit advances cursor and restores only the owner balances', () => {
  const before = registered(); const account = [...f.endingState.accounts[f.slot]];
  account[1] = 50n; account[8] = 123456n;
  const next = nextControl(before, { kind: 2n, slot: f.slot, owner: f.owner, key: f.recoveryKey,
    account, amount: 50n, eventId: 1n, pool: [0n, 0n, 0n, 0n, 50n, 0n] });
  const state = applyAcceptedUpdate(before, next.update, next.checkpoint);
  assert.equal(state.inboxCursor, 1n);
  assert.equal(recoverOwnedAccount(state, credentials).account[1], 50n);
  assert.deepEqual(recoverPool(state, f.poolRecoveryKey), [0n, 0n, 0n, 0n, 50n, 0n]);
});

test('wrong recovery keys, owners, slots and expected commitments cannot restore the leaf', () => {
  const state = registered();
  assert.throws(() => recoverOwnedAccount(state, { ...credentials, recoveryKey: f.recoveryKey + 1n }));
  assert.throws(() => recoverOwnedAccount(state, { ...credentials, owner: f.owner + 1n }), /no accepted account/);
  assert.throws(() => recoverOwnedAccount(state, { ...credentials, slot: 16 }), /range/);
  assert.throws(() => recoverOwnedAccount(state, { ...credentials, keyCommit: 1n }), /commitment/);
  assert.throws(() => recoverOwnedAccount({ ...state, anchor: { ...state.anchor!, stateRoot: 1n } }, credentials), /does not accept/);
});

test('metadata, ciphertext and pool DA tampering fail their public digest', () => {
  const metadata = f.authorizationRecords.map((m) => ({ ...m })); metadata[0].commitment = BigInt(metadata[0].commitment) + 1n;
  assert.throws(() => applyAcceptedUpdate(createRecoveryState(config), { ...registration, metadata }, anchor(f.publicSignals)), /Authorization digest/);
  const da = f.daRecords.map((d) => ({ ...d, ciphertext: [...d.ciphertext] })); da[0].ciphertext[0] = BigInt(da[0].ciphertext[0]) + 1n;
  assert.throws(() => applyAcceptedUpdate(createRecoveryState(config), { ...registration, da }, anchor(f.publicSignals)), /DA digest/);
  const pool = { ...f.poolDa, poolCiphertext: [...f.poolDa.poolCiphertext] }; pool.poolCiphertext[0] += 1n;
  assert.throws(() => applyAcceptedUpdate(createRecoveryState(config), { ...registration, pool }, anchor(f.publicSignals)), /DA digest/);
});

test('replay rejects skipped and repeated versions, wrong prior roots and wrong final roots', () => {
  const gap = f.publicSignals.map(BigInt); gap[1] = 2n;
  assert.throws(() => applyAcceptedUpdate(createRecoveryState(config), { ...registration, publicSignals: gap }, anchor(gap)), /version gap/);
  assert.throws(() => applyAcceptedUpdate(registered(), registration, anchor(f.publicSignals)), /version gap/);
  const previous = f.publicSignals.map(BigInt); previous[3] += 1n;
  assert.throws(() => applyAcceptedUpdate(createRecoveryState(config), { ...registration, publicSignals: previous }, anchor(previous)), /Previous root/);
  const root = f.publicSignals.map(BigInt); root[4] += 1n;
  assert.throws(() => applyAcceptedUpdate(createRecoveryState(config), { ...registration, publicSignals: root }, anchor(root)), /Reconstructed state root/);
});

test('a server marker or checkpoint embedded in the update never supplies chain acceptance', () => {
  assert.throws(() => applyAcceptedUpdate(createRecoveryState(config), { ...registration, accepted: anchor(f.publicSignals) } as AcceptedDaUpdate, undefined as unknown as ChainCheckpoint), /checkpoint/);
  assert.throws(() => applyAcceptedUpdate(createRecoveryState(config), registration, { ...anchor(f.publicSignals), source: 'server' } as unknown as ChainCheckpoint), /contract/);
  assert.throws(() => applyAcceptedUpdate(createRecoveryState(config), registration, { ...anchor(f.publicSignals), vault: f.vault + 1n }), /chain or Vault/);
});

test('public counters, cipher fields, owner balances and nonces enforce their exact ranges', () => {
  const cipher = f.daRecords.map((d) => ({ ...d, ciphertext: [...d.ciphertext] })); cipher[0].ciphertext[0] = FIELD;
  assert.throws(() => applyAcceptedUpdate(createRecoveryState(config), { ...registration, da: cipher }, anchor(f.publicSignals)), /field/i);
  const counter = f.publicSignals.map(BigInt); counter[6] = 1n << 64n;
  assert.throws(() => applyAcceptedUpdate(createRecoveryState(config), { ...registration, publicSignals: counter }, anchor(counter)), /range/);
  for (const [index, value] of [[1, 1n << 96n], [4, 1n << 64n]] as const) {
    const account = [...f.endingState.accounts[f.slot]]; account[index] = value;
    const next = nextControl(registered(), { kind: 4n, slot: f.slot, owner: f.owner, key: f.recoveryKey, account });
    const state = applyAcceptedUpdate(registered(), next.update, next.checkpoint);
    assert.throws(() => recoverOwnedAccount(state, credentials), /range/);
  }
});

test('backup import is canonical, self-consistent and always snapshot-only until independent RPC anchoring', () => {
  const backup = buildAccountBackup(registered(), { ...credentials, pendingAuthorizations: [{ commitment: '123' }] });
  const imported = parseAccountBackup(JSON.stringify({ ...backup, status: 'chain-anchored', current: true }));
  assert.equal(imported.status, 'snapshot-only'); assert.equal(imported.current, false);
  assert.equal(inspectAccountBackup(backup).status, 'snapshot-only');
  assert.equal(inspectAccountBackup(backup, anchor(f.publicSignals)).status, 'chain-anchored');
  assert.deepEqual(imported.pendingAuthorizations, [{ commitment: '123' }]);
  assert.throws(() => parseAccountBackup({ ...backup, slot: '03' }), /canonical decimal/);
  assert.throws(() => parseAccountBackup({ ...backup, chainId: 31337 }), /canonical decimal/);
  assert.throws(() => parseAccountBackup({ ...backup, recoveryKey: String(f.recoveryKey + 1n) }), /commitment/);
  assert.throws(() => parseAccountBackup({ ...backup, path: [fieldHex(1n), ...backup.path.slice(1)] }), /path/);
  assert.throws(() => parseAccountBackup(backup, { vault: f.vault + 1n }), /expected vault/);
  assert.throws(() => parseAccountBackup({ ...backup, anchor: { ...backup.anchor, stateRoot: fieldHex(1n) } }), /does not accept/);
  assert.throws(() => parseAccountBackup({ ...backup, anchor: { ...backup.anchor, blockNumber: '020' } }), /canonical decimal/);
  assert.throws(() => inspectAccountBackup(backup, { ...anchor(f.publicSignals), stateRoot: 1n }), /differs/);
});

const iface = new Interface(RECOVERY_VAULT_ABI);
function scannerFixture(method: 'publishZkTransition' | 'publishProvenTransition' | 'publishProvenTransitionAndWithdraw' = 'publishZkTransition') {
  const metadata = f.authorizationRecords.map((m) => [m.kind, m.slot, hexAddress(BigInt(m.owner)), m.commitment, m.eventId, m.token, m.amount, m.reference, m.signature]);
  const da = f.daRecords.map((d) => [d.kind, d.slot, hexAddress(BigInt(d.owner)), d.newLeaf, d.ciphertext]);
  const args = [f.publicSignals, metadata, da, [f.poolDa.poolHash, f.poolDa.poolCiphertext], [[0, 0], [[0, 0], [0, 0]], [0, 0]]] as unknown[];
  if (method === 'publishZkTransition') args.push([9999999999n, 1n, '0x']);
  if (method === 'publishProvenTransitionAndWithdraw') args.push([hexAddress(f.owner), hexAddress(f.ruba), 42n, 1n, 1n, 123n]);
  const data = iface.encodeFunctionData(method, args);
  const encodedEvent = iface.encodeEventLog(iface.getEvent('ZkTransitionPublished')!, [1n, 0n, f.publicSignals]);
  const log = { address: hexAddress(f.vault), blockNumber: 20, blockHash: BLOCK_HASH,
    transactionHash: TX_HASH, index: 0, removed: false, ...encodedEvent };
  const transaction = { hash: TX_HASH, to: hexAddress(f.vault), data, value: 0n };
  const receipt = { hash: TX_HASH, status: 1, blockNumber: 20, blockHash: BLOCK_HASH, logs: [log] };
  const getterResults: Record<string, unknown> = { domain: f.domain, poolKeyCommit: f.poolKeyCommit,
    stateVersion: 1n, stateRoot: fieldHex(f.endingState.root!), genesisStateRoot: fieldHex(f.startingState.root!),
    ruba: hexAddress(f.ruba), usdt: hexAddress(f.usdt), inboxCursor: 0n, nextTradeId: 1n,
    proofMode: 'groth16-bn254-v2', ZK_VERSION: 2n };
  if (method !== 'publishZkTransition') getterResults.withdrawalMode = PROVEN_WITHDRAWAL_MODE;
  const calls: string[] = []; const logs = [log];
  const provider = {
    async getNetwork() { return { chainId: f.chainId }; },
    async getBlock(_tag: string | number) { return { number: 20, hash: BLOCK_HASH }; },
    async call(request: { to: string; data: string; blockTag: string }) {
      calls.push(request.blockTag); assert.equal(request.to, hexAddress(f.vault));
      const parsed = iface.parseTransaction({ data: request.data })!;
      return iface.encodeFunctionResult(parsed.name, [parsed.name === 'transitions' ? f.publicSignals : getterResults[parsed.name]]);
    },
    async getLogs() { return logs; },
    async getTransaction() { return transaction; },
    async getTransactionReceipt() { return receipt; },
  };
  return { provider, logs, log, transaction, receipt, getterResults, calls };
}

test('read-only scanner restores from actual ABI-encoded calldata, logs, receipt and pinned getters', async () => {
  const { provider, calls } = scannerFixture();
  const state = await scanAcceptedUpdates(provider, f.vault, { contractInterface: iface, fromBlock: 20 });
  assert.equal(state.root, f.endingState.root);
  assert.deepEqual(recoverOwnedAccount(state, credentials).account, f.endingState.accounts[f.slot]);
  assert.equal(state.scannedThrough?.blockHash, BLOCK_HASH);
  assert.ok(calls.length >= 12 && calls.every((tag) => tag === '0x14'));
  assert.equal('sendTransaction' in provider, false);
});

test('scanner refuses failed receipts, missing history, altered receipt logs and nested publications', async () => {
  const failed = scannerFixture(); failed.receipt.status = 0;
  await assert.rejects(scanAcceptedUpdates(failed.provider, f.vault, { contractInterface: iface, fromBlock: 20 }), /successful/);
  const missing = scannerFixture(); missing.logs.splice(0);
  await assert.rejects(scanAcceptedUpdates(missing.provider, f.vault, { contractInterface: iface, fromBlock: 20 }), /history is incomplete/);
  const receipt = scannerFixture(); receipt.receipt.logs = [];
  await assert.rejects(scanAcceptedUpdates(receipt.provider, f.vault, { contractInterface: iface, fromBlock: 20 }), /does not occur/);
  const nested = scannerFixture(); nested.transaction.to = hexAddress(f.vault + 1n);
  await assert.rejects(scanAcceptedUpdates(nested.provider, f.vault, { contractInterface: iface, fromBlock: 20 }), /direct Vault/);
});

test('scanner rejects a wrong deployment, accepted getter mismatch and canonical-block change', async () => {
  const wrong = scannerFixture();
  await assert.rejects(scanAcceptedUpdates(wrong.provider, f.vault, { contractInterface: iface, fromBlock: 20, expected: { chainId: 1n } }), /Unexpected recovery chainId/);
  const root = scannerFixture(); root.getterResults.stateRoot = fieldHex(1n);
  await assert.rejects(scanAcceptedUpdates(root.provider, f.vault, { contractInterface: iface, fromBlock: 20 }), /history is incomplete/);
  const reorg = scannerFixture(); let blockCalls = 0;
  reorg.provider.getBlock = async () => ({ number: 20, hash: ++blockCalls < 3 ? BLOCK_HASH : `0x${'ef'.repeat(32)}` });
  await assert.rejects(scanAcceptedUpdates(reorg.provider, f.vault, { contractInterface: iface, fromBlock: 20 }), /reorganized/);
});

const claimContext = { ...config, domain: f.domain, owner: f.owner, slot: f.slot };
function withdrawalClaim(owner = f.owner): WithdrawalClaimOpening {
  const amount = 42n, nonce = 1n, salt = 123456789n;
  return { chainId: f.chainId.toString(), vault: hexAddress(f.vault), domain: fieldHex(f.domain), slot: String(f.slot),
    commitment: fieldHex(hashOperation(f.domain, 6n, f.slot, owner, nonce, [0n, amount, nonce, 0n], salt)),
    withdrawal: { account: hexAddress(owner), token: hexAddress(f.ruba), amount: String(amount), nonce: String(nonce), spendNonce: String(nonce), salt: String(salt) },
    stateVersion: null };
}

test('proof-only and atomic publications replay the same cryptographic DA without an operator permit', async () => {
  for (const method of ['publishProvenTransition', 'publishProvenTransitionAndWithdraw'] as const) {
    const { provider } = scannerFixture(method);
    const state = await scanAcceptedUpdates(provider, f.vault, { contractInterface: iface, fromBlock: 20, expected: { withdrawalMode: PROVEN_WITHDRAWAL_MODE } });
    assert.equal(state.withdrawalMode, PROVEN_WITHDRAWAL_MODE);
    assert.equal(state.root, f.endingState.root);
    assert.deepEqual(recoverOwnedAccount(state, credentials).account, f.endingState.accounts[f.slot]);
  }
  const old = scannerFixture();
  await assert.rejects(scanAcceptedUpdates(old.provider, f.vault, { contractInterface: iface, fromBlock: 20, expected: { withdrawalMode: PROVEN_WITHDRAWAL_MODE } }), /required proven withdrawal mode/);
  const disabled = scannerFixture(); disabled.getterResults.withdrawalMode = PROVEN_WITHDRAWAL_MODE;
  await assert.rejects(scanAcceptedUpdates(disabled.provider, f.vault, { contractInterface: iface, fromBlock: 20 }), /withdrawal mode/);
  const refund = nextControl(registered(), { kind: 8n, slot: f.slot, owner: f.owner, key: f.recoveryKey, account: [...f.endingState.accounts[f.slot]] });
  assert.throws(() => applyAcceptedUpdate({ ...registered(), withdrawalMode: PROVEN_WITHDRAWAL_MODE }, refund.update, refund.checkpoint), /Refund operations are disabled/);
});

test('withdrawal opening backups validate ownership, commitment and canonical fields without trusting acceptance flags', () => {
  const claim = withdrawalClaim();
  const claims = validateWithdrawalClaims([{ ...claim, spent: true, accepted: true }], claimContext);
  assert.deepEqual(claims, [claim]);
  const backup = buildAccountBackup(registered(), { ...credentials, withdrawalClaims: claims });
  assert.deepEqual(parseAccountBackup(JSON.stringify(backup)).withdrawalClaims, claims);
  assert.equal(parseAccountBackup(backup).status, 'snapshot-only');
  const { withdrawalClaims: _oldMissingField, ...historical } = backup;
  assert.deepEqual(parseAccountBackup(historical).withdrawalClaims, []);
  assert.throws(() => validateWithdrawalClaims([claim, claim], claimContext), /Duplicate/);
  assert.throws(() => validateWithdrawalClaims([withdrawalClaim(f.owner + 1n)], claimContext), /another owner/);
  assert.throws(() => validateWithdrawalClaims([{ ...claim, chainId: '031337' }], claimContext), /canonical/);
  assert.throws(() => validateWithdrawalClaims([{ ...claim, slot: '4' }], claimContext), /another owner/);
  assert.throws(() => validateWithdrawalClaims([{ ...claim, domain: fieldHex(1n) }], claimContext), /deployment/);
  assert.throws(() => validateWithdrawalClaims([{ ...claim, stateVersion: '0' }], claimContext), /cannot be zero/);
});

test('withdrawal openings reject altered amounts, tokens, nonce equality, salts and out-of-range integers', () => {
  const claim = withdrawalClaim();
  for (const values of [
    { amount: '43' }, { token: hexAddress(f.usdt) }, { nonce: '2' }, { salt: '0' },
    { amount: '0' }, { amount: String(1n << 96n) }, { nonce: String(1n << 64n) }, { salt: String(FIELD) },
  ]) assert.throws(() => validateWithdrawalClaims([{ ...claim, withdrawal: { ...claim.withdrawal, ...values } }], claimContext));
  assert.throws(() => validateWithdrawalClaims([{ ...claim, withdrawal: { ...claim.withdrawal, token: hexAddress(f.usdt + 1n) } }], claimContext), /Unsupported/);
  assert.throws(() => validateWithdrawalClaims([{ ...claim, signature: '0x' }], claimContext), /signature/);
});

test('optional actual EIP-712 owner signature verification rejects a foreign signer and supports presign drafts', async () => {
  const wallet = new Wallet(`0x${'1'.padStart(64, '0')}`);
  const context = { ...claimContext, owner: wallet.address }; const claim = withdrawalClaim(BigInt(wallet.address));
  const domain = { name: 'RubaZkOperation', version: '2', chainId: f.chainId, verifyingContract: hexAddress(f.vault) };
  const types = { PrivateOperation: [{ name: 'commitment', type: 'uint256' }] };
  claim.signature = await wallet.signTypedData(domain, types, { commitment: claim.commitment });
  assert.deepEqual(validateWithdrawalClaims([claim], context, { recoverSigner: verifyTypedData }), [claim]);
  const foreign = new Wallet(`0x${'2'.padStart(64, '0')}`);
  const badSignature = await foreign.signTypedData(domain, types, { commitment: claim.commitment });
  assert.throws(() => validateWithdrawalClaims([{ ...claim, signature: badSignature }], context, { recoverSigner: verifyTypedData }), /not from its owner/);
  const { signature: _notSignedYet, ...draft } = claim;
  assert.deepEqual(validateWithdrawalClaims([draft], context, { recoverSigner: verifyTypedData }), [draft]);
});

function claimProvider() {
  const mock = scannerFixture('publishProvenTransition'); const claim = withdrawalClaim();
  const mapping = { owner: hexAddress(f.owner), slot: BigInt(f.slot), stateVersion: 1n, spent: false, nonceUsed: false };
  const originalCall = mock.provider.call;
  mock.provider.call = async (request) => {
    const call = iface.parseTransaction({ data: request.data })!;
    if (call.name === 'withdrawalClaims') return iface.encodeFunctionResult(call.name, [mapping.owner, mapping.slot, mapping.stateVersion]);
    if (call.name === 'spentWithdrawalCommitments') return iface.encodeFunctionResult(call.name, [mapping.spent]);
    if (call.name === 'usedWithdrawalNonces') return iface.encodeFunctionResult(call.name, [mapping.nonceUsed]);
    return originalCall(request);
  };
  return { ...mock, mapping, claim };
}

test('claim inspection reads perpetual acceptance and spent flags from a pinned Vault without submitting anything', async () => {
  const mock = claimProvider();
  const options = { contractInterface: iface, claims: [mock.claim], context: claimContext };
  let result = await inspectWithdrawalClaims(mock.provider, f.vault, options);
  assert.equal(result.claims[0].status, 'claimable'); assert.equal(result.claims[0].accepted, true);
  assert.equal(result.claims[0].stateVersion, 1n); assert.equal(result.checkedAt.blockHash, BLOCK_HASH);
  mock.mapping.spent = true; mock.mapping.nonceUsed = true;
  result = await inspectWithdrawalClaims(mock.provider, f.vault, options);
  assert.equal(result.claims[0].status, 'spent');
  mock.mapping.owner = hexAddress(0n); mock.mapping.slot = 0n; mock.mapping.stateVersion = 0n; mock.mapping.spent = false; mock.mapping.nonceUsed = false;
  result = await inspectWithdrawalClaims(mock.provider, f.vault, options);
  assert.equal(result.claims[0].status, 'unpublished'); assert.equal(result.claims[0].accepted, false);
  mock.mapping.nonceUsed = true;
  assert.equal((await inspectWithdrawalClaims(mock.provider, f.vault, options)).claims[0].status, 'nonce-used');
  assert.equal('sendTransaction' in mock.provider, false);
});

test('claim inspection rejects foreign contract records, inconsistent spent flags and another chain', async () => {
  const mock = claimProvider(); const options = { contractInterface: iface, claims: [mock.claim], context: claimContext };
  mock.mapping.owner = hexAddress(f.owner + 1n);
  await assert.rejects(inspectWithdrawalClaims(mock.provider, f.vault, options), /does not match/);
  mock.mapping.owner = hexAddress(f.owner); mock.mapping.spent = true;
  await assert.rejects(inspectWithdrawalClaims(mock.provider, f.vault, options), /flags disagree/);
  mock.mapping.spent = false;
  await assert.rejects(inspectWithdrawalClaims(mock.provider, f.vault, { ...options, context: { ...claimContext, chainId: 1n } }), /deployment|chain/);
});
