import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Wallet, getAddress, keccak256, verifyTypedData } from 'ethers';
import { RubaClient, recoveryKeyMessage } from '../client.js';
import * as c from '../../zk/crypto.js';

const owner = new Wallet('0x' + '11'.repeat(32));
const other = new Wallet('0x' + '22'.repeat(32));
const config = { proofMode: 'zk', chainId: '31337', vaultAddress: getAddress('0x' + '01'.repeat(20)),
  tokens: { RUBA: { address: getAddress('0x' + '02'.repeat(20)), decimals: 18 }, USDT: { address: getAddress('0x' + '03'.repeat(20)), decimals: 6 } } };
const privateTypes = { PrivateOperation: [{ name: 'commitment', type: 'uint256' }] };
const timedTypes = { TimedPrivateOperation: [{ name: 'commitment', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
const operationSigner = (domain, commitment, signature) => signature.length === 196
  ? verifyTypedData(domain, timedTypes, { commitment, deadline: BigInt('0x' + signature.slice(2, 66)) }, '0x' + signature.slice(66))
  : verifyTypedData(domain, privateTypes, { commitment }, signature);
const readTypes = { Action: [{ name: 'account', type: 'address' }, { name: 'actionHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
const wire = (value) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));

async function fixture({ registered = true, proven = false, whitelisted = true, poolRecoveryKey = 77n, sharedStorage, embeddedAccountProof = true, onWalletStep } = {}) {
  const clientConfig = { ...config, ...(proven ? { withdrawalMode: 'proven-reservation-v1', publicationAuthorization: 'proof-only' } : {}) };
  const viewSeed = await owner.signMessage(recoveryKeyMessage(config, owner.address));
  const viewKey = BigInt(keccak256(viewSeed)) % c.FIELD;
  const ctx = { apiNonce: 0n, posts: [], typed: [], messages: [], sends: [], domain: c.hashDomain(config.chainId, config.vaultAddress,
    config.tokens.RUBA.address, config.tokens.USDT.address, c.keyCommit(poolRecoveryKey)),
    account: registered ? [BigInt(owner.address), 1_000_000n, 2_000_000n, 50_000n, 1n, 0n, 0n, c.keyCommit(viewKey), 42n] : c.emptyAccount(),
    registered, registeredOnchain: registered, whitelisted, pending: false, baseVersion: 0n, contextOwner: owner.address, tamperState: null, dropPost: false,
    claims: new Map(), spent: new Set(), serverClaims: [], publicationResponse: { status: 'idle', request: null, progress: { collected: 0, required: 4 } } };
  const poolHash = c.hashPool(c.emptyPool());
  const makeState = () => {
    const tree = c.buildAccountTree([ctx.account]);
    const state = { domain: ctx.domain, slot: 0n, registered: ctx.registered, account: ctx.account, path: tree.proofs[0],
      accountsRoot: tree.root, poolHash, inboxCursor: 0n, nextTradeId: 1n, poolKeyCommit: c.keyCommit(poolRecoveryKey),
      stateVersion: ctx.baseVersion + (ctx.pending ? 1n : 0n), status: ctx.pending ? 'pending' : 'accepted', withdrawalNonce: '7' };
    state.stateRoot = c.hashState(state);
    if (proven) state.provenWithdrawals = ctx.serverClaims;
    return state;
  };
  const accepted = makeState();
  const provider = { async send(method) {
    if (method === 'eth_chainId') return '0x7a69';
    if (method === 'eth_accounts') return [ctx.contextOwner];
    throw new Error(method);
  }, async getBlock() { return { timestamp: 1800000000 }; } };
  const vault = { async domain() { return ctx.domain; }, async poolKeyCommit() { return c.keyCommit(poolRecoveryKey); },
    async stateRoot() { return c.fieldHex(accepted.stateRoot); }, async stateVersion() { return accepted.stateVersion; },
    async ownerSlotPlusOne() { return ctx.registeredOnchain ? 1n : 0n; }, async withdrawalMode() { return 'proven-reservation-v1'; },
    async withdrawalClaims(commitment) { return ctx.claims.get(BigInt(commitment).toString()) ?? { owner: '0x' + '00'.repeat(20), slot: 0n, stateVersion: 0n }; },
    async spentWithdrawalCommitments(commitment) { return ctx.spent.has(BigInt(commitment).toString()); },
    async withdrawalsPaused() { return false; }, async whitelist() { return ctx.whitelisted; }, async marketPaused() { return false; },
    async ruba() { return config.tokens.RUBA.address; }, async usdt() { return config.tokens.USDT.address; },
    async withdrawProven(opening) { ctx.sends.push({ kind: 'withdraw', opening }); return { hash: '0x' + '77'.repeat(32), async wait() {
      const commitment = c.hashOperation(ctx.domain, 6, 0, owner.address, opening.spendNonce, [opening.token === config.tokens.RUBA.address.toLowerCase() ? 0 : 1, opening.amount, opening.nonce, 0], opening.salt);
      if (ctx.withdrawError) throw ctx.withdrawError;
      ctx.spent.add(commitment.toString()); return { status: 1, hash: '0x' + '77'.repeat(32) };
    } }; } };
  const signer = { async getAddress() { return owner.address; }, async signTypedData(domain, types, value) {
    ctx.typed.push({ domain, types, value });
    if (domain.name === 'RubaZkOperation') { ctx.beforePrivateSignature?.(); if (ctx.rejectPrivate) throw Object.assign(new Error('rejected'), { code: 4001 }); }
    return owner.signTypedData(domain, types, value);
  }, async signMessage(message) { ctx.messages.push(message); return owner.signMessage(message); } };
  const storage = sharedStorage ?? new Map();
  const client = new RubaClient(clientConfig, provider, signer, { zkCrypto: c, onWalletStep,
    storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    contractFactory: () => vault, fetchImpl: async (path, init) => {
      if (path === '/publication') return { ok: true, async json() { return wire(ctx.publicationResponse); } };
      if (path.startsWith('/nonce?')) return { ok: true, async json() { return { account: owner.address, nonce: ctx.apiNonce.toString() }; } };
      assert.equal(path, '/actions');
      const body = JSON.parse(init.body); ctx.posts.push(body);
      assert.equal(BigInt(body.intent.nonce), ctx.apiNonce++);
      const domain = { name: body.zk ? 'RubaZkOperation' : 'RubaServer', version: body.zk ? '2' : '1', chainId: 31337n, verifyingContract: config.vaultAddress };
      assert.equal(body.zk ? operationSigner(domain, body.zk.commitment, body.signature) : verifyTypedData(domain, readTypes, body.intent, body.signature), owner.address);
      let result;
      if (body.operation.kind === 'zkState') result = ctx.tamperState?.(wire(makeState())) ?? makeState();
      else if (body.operation.kind === 'account') result = { account: owner.address, balances: { RUBA: '9', USDT: '9' }, lpShares: '0', withdrawals: [], ...(embeddedAccountProof ? { zkProof: ctx.tamperState?.(wire(makeState())) ?? makeState() } : {}) };
      else if (body.zk) {
        ctx.beforeZkPost?.();
        assert.equal(BigInt(body.zk.nonce), ctx.account[4]);
        const params = body.operation.kind === 'zkRegister' ? [c.keyCommit(body.operation.recoveryKey), 0n, 0n, 0n]
          : body.operation.kind === 'swap' ? [0n, BigInt(body.operation.amountIn), BigInt(body.operation.minOut), 0n]
            : [1n, BigInt(body.operation.amount), proven ? ctx.account[4] : 7n, 0n];
        const kind = { zkRegister: 1, swap: 3, withdraw: 6 }[body.operation.kind];
        assert.equal(BigInt(body.zk.commitment), c.hashOperation(ctx.domain, kind, 0n, owner.address, ctx.account[4], params, body.zk.salt));
        if (kind === 1) { ctx.registered = true; ctx.account = [BigInt(owner.address), 0n, 0n, 0n, 1n, 0n, 0n, c.keyCommit(body.operation.recoveryKey), BigInt(body.zk.salt)]; }
        else { ctx.account[4]++; ctx.account[8] = BigInt(body.zk.salt); }
        ctx.pending = true;
        result = { tradeId: '1', amountOut: '995', publication: { status: 'collecting', collected: 1, required: 4 } };
        if (proven && kind === 6) {
          result = { kind: 'zk-withdrawal', chainId: config.chainId, vault: config.vaultAddress, commitment: c.fieldHex(body.zk.commitment), stateVersion: null,
            withdrawal: { account: owner.address.toLowerCase(), token: config.tokens.USDT.address.toLowerCase(), amount: body.operation.amount,
              nonce: body.zk.nonce, spendNonce: body.zk.nonce, salt: body.zk.salt } };
          ctx.serverClaims.push(result);
        }
        if (ctx.dropPost) throw new TypeError('lost response');
      } else result = {};
      return { ok: true, async json() { return { result: wire(result) }; } };
    } });
  return { client, ctx, accepted, makeState, storage, viewKey, viewSeed };
}

async function publicationFixture({ proven = false, tradeCount = 4, batchId = 1, firstTradeId = 1, onWalletStep } = {}) {
  const f = await fixture({ proven, onWalletStep });
  const operations = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const commitment = i < tradeCount ? c.hashOperation(f.ctx.domain, 3, 0, owner.address, i + 1, [0, 1000, 990, 0], 200 + i) : 0n;
    return { kind: i < tradeCount ? '3' : '0', slot: '0', owner: i < tradeCount ? owner.address : '0x' + '00'.repeat(20), commitment: commitment.toString(),
      eventId: '0', token: '0', amount: '0', reference: '0', signature: i < tradeCount
        ? await owner.signTypedData({ name: 'RubaZkOperation', version: '2', chainId: 31337n, verifyingContract: config.vaultAddress }, privateTypes, { commitment }) : '0x' };
  }));
  const accountDA = operations.map((op, i) => ({ kind: op.kind, slot: op.slot, owner: op.owner,
    newLeaf: i < tradeCount ? String(i + 100) : '0', ciphertext: Array(7).fill('0') }));
  const poolDA = { poolHash: '123', poolCiphertext: Array(6).fill('0') };
  const receipts = Array.from({ length: tradeCount }, (_, i) => ({ version: 2, chainId: config.chainId, vault: config.vaultAddress,
    tradeId: String(firstTradeId + i), account: owner.address, tokenIn: config.tokens.RUBA.address, tokenOut: config.tokens.USDT.address,
    amountIn: '1000', amountOut: '990', feeNumerator: '3000', feeDenominator: '1000', reserveRubaBefore: '100000', reserveUsdtBefore: '100000',
    reserveRubaAfter: '101000', reserveUsdtAfter: '99010', salt: c.fieldHex(BigInt(100 + i)) }));
  const receiptTree = c.buildReceiptTreeV2(receipts);
  f.receipt = { ...receipts[0], leaf: c.fieldHex(receiptTree.leaves[0]), proof: receiptTree.proofs[0].map(c.fieldHex), batchId: String(batchId) };
  const signals = [f.ctx.domain, 1n, 1n, f.accepted.stateRoot, 999n, 0n, 0n, BigInt(firstTradeId), BigInt(firstTradeId + tradeCount), receiptTree.root,
    c.hashAuthDigest(f.ctx.domain, 1, operations), c.hashDaDigest(f.ctx.domain, 1, accountDA, poolDA.poolHash, poolDA.poolCiphertext), c.keyCommit(77n)].map(String);
  const headerDigest = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(['uint256[13]'], [signals])));
  const authorization = { deadline: '1800000600', signerEpoch: '1' };
  authorization.signature = await other.signTypedData({ name: 'RubaZkPublication', version: '2', chainId: 31337n, verifyingContract: config.vaultAddress },
    { ZkPublication: [{ name: 'headerDigest', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'signerEpoch', type: 'uint256' }] }, { headerDigest, ...authorization });
  const published = new Map();
  f.published = published;
  Object.assign(f.client.vault, { async proofMode() { return 'groth16-bn254-v2'; }, async ZK_VERSION() { return 2n; },
    async inboxCursor() { return 0n; }, async nextTradeId() { return BigInt(firstTradeId); }, async operator() { return other.address; }, async signerEpoch() { return 1n; },
    async verifier() { return config.tokens.RUBA.address; }, async verifierCodeHash() { return keccak256('0x6001'); },
    async poseidon2() { return config.tokens.USDT.address; }, async poseidonCodeHash() { return keccak256('0x6001'); },
    async transitions(version) { return published.get(String(version)); },
    async publishZkTransition(...args) {
      f.ctx.sends.push(args);
      return { hash: '0x' + '55'.repeat(32), async wait() {
        if (f.ctx.publicationError) { if (f.ctx.competitor) { published.set('1', signals); f.accepted.stateVersion = 1n; } throw f.ctx.publicationError; }
        published.set('1', signals); f.accepted.stateVersion = 1n; f.accepted.stateRoot = 999n;
        return { status: 1, hash: '0x' + '55'.repeat(32) };
      } };
    } });
  f.client.provider.getCode = async () => '0x6001';
  f.ticket = { kind: 'zk', chainId: config.chainId, vault: config.vaultAddress, publicSignals: signals, operations, accountDA, poolDA,
    proof: { a: ['1', '2'], b: [['3', '4'], ['5', '6']], c: ['7', '8'] }, authorization,
    batch: { batchId: String(batchId), firstTradeId: String(firstTradeId), tradeCount: String(tradeCount), previousStateRoot: c.fieldHex(signals[3]), newStateRoot: c.fieldHex(999n), receiptsRoot: c.fieldHex(receiptTree.root) } };
  if (proven) {
    f.ticket.authorizationMode = 'proof-only'; f.ticket.authorization = { deadline: '0', signerEpoch: '0', signature: '0x' };
    f.client.vault.publishProvenTransition = (...args) => f.client.vault.publishSignedTest(...args);
    f.client.vault.publishSignedTest = f.client.vault.publishZkTransition;
    f.client.vault.publishZkTransition = async () => { throw new Error('Forbidden legacy publication'); };
    f.client.vault.operator = async () => { throw new Error('Operator must not be read'); };
    f.client.vault.signerEpoch = async () => { throw new Error('Epoch must not be read'); };
  }
  return f;
}

test('ZK mutations locally commit private parameters and spend nonce while reads retain separate EIP-712 auth', async () => {
  const f = await fixture();
  await f.client.signedAction({ kind: 'swap', tokenIn: 'RUBA', amountIn: '1000', minOut: '990' });
  assert.deepEqual(f.ctx.posts.map((post) => post.operation.kind), ['zkState', 'swap']);
  assert.equal(f.ctx.posts[0].zk, undefined);
  assert.equal(f.ctx.posts[1].zk.nonce, '1');
  assert.equal(f.ctx.posts[1].intent.nonce, '1');
  assert.equal(f.ctx.typed[1].domain.name, 'RubaZkOperation');
  assert.deepEqual(Object.keys(f.ctx.typed[1].value), ['commitment', 'deadline']);
  assert.equal(BigInt('0x' + f.ctx.posts[1].signature.slice(2, 66)), f.ctx.typed[1].value.deadline);
  assert.equal(f.ctx.typed[1].value.deadline - BigInt(f.ctx.posts[1].intent.deadline), 3000n);
  await f.client.signedAction({ kind: 'withdraw', token: 'USDT', amount: '10' });
  assert.equal(f.ctx.posts.at(-1).signature.length, 132);
  assert.equal(f.ctx.posts.at(-1).zk.nonce, '2');
  assert.equal(f.ctx.posts.at(-1).intent.nonce, '3');
  assert.notEqual(f.ctx.posts[1].zk.salt, f.ctx.posts.at(-1).zk.salt);
});

test('ZK state rejects owner, domain, path and falsely accepted pending data before mutation signature', async () => {
  for (const tamper of [
    (state) => { state.account[0] = BigInt(other.address).toString(); return state; },
    (state) => { state.domain = '1'; return state; },
    (state) => { state.path[0] = '2'; return state; },
    (state) => { state.stateVersion = '1'; state.status = 'accepted'; return state; },
  ]) {
    const f = await fixture(); f.ctx.tamperState = tamper;
    await assert.rejects(f.client.signedAction({ kind: 'swap', tokenIn: 'RUBA', amountIn: '1000', minOut: '990' }));
    assert.equal(f.ctx.posts.length, 1);
    assert.equal(f.ctx.typed.filter((item) => item.domain.name === 'RubaZkOperation').length, 0);
  }
});

test('recovery seed signature stays local, registration signs its immutable key commitment and cached keys are checked', async () => {
  const steps = [];
  const f = await fixture({ registered: false, onWalletStep: (event) => steps.push(event) });
  await f.client.ensureZkRegistration();
  assert.deepEqual(f.ctx.messages, [recoveryKeyMessage(config, owner.address)]);
  const registration = f.ctx.posts.find((post) => post.operation.kind === 'zkRegister');
  assert.equal(registration.operation.recoveryKey, f.viewKey.toString());
  assert.equal(JSON.stringify(f.ctx.posts).includes(f.viewSeed), false);
  assert.equal(f.ctx.registered, true);
  await f.client.ensureZkRegistration();
  assert.equal(f.ctx.posts.filter((post) => post.operation.kind === 'zkRegister').length, 1);
  assert.equal(f.ctx.messages.length, 1);
  const promptTitles = steps.filter((step) => step.kind === 'signature' && step.phase === 'start').map((step) => step.title);
  assert.equal(promptTitles.filter((title) => title === 'Подписать создание ключа восстановления').length, 1);
  assert.equal(promptTitles.filter((title) => title === 'Подписать регистрацию защищённого баланса').length, 1);
  assert.equal(JSON.stringify(steps).includes(f.viewSeed), false);
  f.client.recoveryKey = '999';
  await assert.rejects(f.client.ensureZkRegistration(), /Ключ восстановления не совпадает/);
});

test('registration without whitelist fails before recovery signatures or API requests', async () => {
  for (const proven of [false, true]) {
    const f = await fixture({ registered: false, proven, whitelisted: false });
    await assert.rejects(f.client.ensureZkRegistration(), /not whitelisted/);
    assert.equal(f.ctx.messages.length, 0);
    assert.equal(f.ctx.typed.length, 0);
    assert.equal(f.ctx.posts.length, 0);
    assert.equal(f.client.recoveryKey, null);
    assert.equal(f.ctx.registered, false);
  }
});

test('displayed balances come from locally validated tree and backup import never replays operations', async () => {
  const f = await fixture();
  f.ctx.baseVersion = 1n; f.accepted.stateVersion = 1n;
  const snapshot = await f.client.getAccount();
  assert.equal(snapshot.balances.RUBA, f.ctx.account[1]);
  assert.equal(snapshot.zkProof.verified, true);
  const backup = await f.client.exportZkBackup();
  assert.equal(backup.format, 'ruba-zk-account-backup');
  const before = f.ctx.posts.length;
  assert.equal((await f.client.importZkBackup(JSON.stringify(wire(backup)))).verified, true);
  assert.equal(f.ctx.posts.length, before);
  const corrupt = wire(backup); corrupt.account[1] = '1234';
  await assert.rejects(f.client.importZkBackup(JSON.stringify(corrupt)), /leaf mismatch/);
  assert.equal(f.ctx.posts.length, before);
});

test('a ZK balance refresh uses one owner signature and validates the embedded proof without a recovery signature', async () => {
  const steps = [];
  const f = await fixture({ onWalletStep: (event) => steps.push(event) });
  const snapshot = await f.client.getAccount();
  assert.deepEqual(f.ctx.posts.map((post) => post.operation.kind), ['account']);
  assert.equal(f.ctx.typed.length, 1);
  assert.equal(f.ctx.messages.length, 0, 'reading a balance must not derive a recovery key');
  assert.equal(snapshot.zkProof.verified, true);
  assert.equal(snapshot.balances.RUBA, f.ctx.account[1]);
  assert.equal(snapshot.lpShares, f.ctx.account[3]);
  assert.equal(f.client.zkState.stateRoot, snapshot.zkProof.stateRoot);
  assert.deepEqual(steps.map((step) => [step.phase, step.kind]), [
    ['start', 'signature'], ['done', 'signature'], ['start', 'check'], ['done', 'check'],
  ]);
  await f.client.saveRecoveryCache();
  const cached = JSON.parse(f.storage.get(await f.client.recoveryStorageKey()));
  assert.equal(cached.accountProof.stateRoot, snapshot.zkProof.stateRoot.toString());
});

test('an older server without an embedded account proof retains the separately authenticated fallback', async () => {
  const f = await fixture({ embeddedAccountProof: false });
  const snapshot = await f.client.getAccount();
  assert.deepEqual(f.ctx.posts.map((post) => post.operation.kind), ['account', 'zkState']);
  assert.equal(f.ctx.typed.length, 2);
  assert.equal(snapshot.zkProof.verified, true);
  assert.equal(snapshot.balances.USDT, f.ctx.account[2]);
});

test('a tampered embedded balance proof is rejected rather than displayed or replaced by a silent fallback', async () => {
  const f = await fixture();
  f.ctx.tamperState = (raw) => { raw.account[1] = '900000'; return raw; };
  await assert.rejects(f.client.getAccount(), /Merkle proof/);
  assert.deepEqual(f.ctx.posts.map((post) => post.operation.kind), ['account']);
  assert.equal(f.client.zkState, null);
});

test('an unregistered owner can read its verified zero balance with one signature', async () => {
  const f = await fixture({ registered: false });
  const snapshot = await f.client.getAccount();
  assert.equal(snapshot.zkProof.registered, false);
  assert.equal(snapshot.zkProof.verified, true);
  assert.deepEqual(snapshot.balances, { RUBA: 0n, USDT: 0n });
  assert.deepEqual(f.ctx.posts.map((post) => post.operation.kind), ['account']);
  assert.equal(f.ctx.messages.length, 0);
});

test('the embedded account proof refresh retains recovery keys and pending proven withdrawal openings', async () => {
  const f = await fixture({ proven: true });
  await f.client.loadRecoveryKey();
  const ticket = await f.client.signedAction({ kind: 'withdraw', token: 'USDT', amount: '100' });
  const postsBefore = f.ctx.posts.length;
  f.client.currentWithdrawalCommitments.clear();
  f.client.withdrawalClaims = [];
  const snapshot = await f.client.getAccount();
  assert.equal(f.ctx.posts.length, postsBefore + 1);
  assert.equal(f.ctx.posts.at(-1).operation.kind, 'account');
  assert.equal(f.client.recoveryKey, f.viewKey.toString());
  assert.equal(f.ctx.messages.length, 1, 'the refresh keeps the previously derived recovery key');
  assert.equal(f.client.withdrawalClaims.length, 1);
  assert.equal(f.client.currentWithdrawalCommitments.has(BigInt(ticket.commitment).toString()), true);
  assert.equal(snapshot.withdrawals.length, 1);
  assert.equal(snapshot.withdrawals[0].commitment, ticket.commitment);
  assert.equal(snapshot.withdrawals[0].status, 'pending');
});

test('a balance refresh never erases a previously cached recovery key before the next registration check', async () => {
  const f = await fixture();
  await f.client.loadRecoveryKey();
  const storageKey = await f.client.recoveryStorageKey();
  await Promise.resolve();
  const cachedKey = JSON.parse(f.storage.get(storageKey)).recoveryKey;
  const fresh = new RubaClient(config, f.client.provider, f.client.signer, { zkCrypto: c,
    storage: { getItem: (key) => f.storage.get(key), setItem: (key, value) => f.storage.set(key, value) },
    contractFactory: () => f.client.vault, fetchImpl: f.client.fetchImpl });
  await fresh.getAccount();
  await Promise.resolve();
  assert.equal(JSON.parse(f.storage.get(storageKey)).recoveryKey, cachedKey);
  await fresh.ensureZkRegistration();
  assert.equal(fresh.recoveryKey, cachedKey);
  assert.equal(f.ctx.messages.length, 1, 'the cached key avoids asking the wallet for a new seed');
});

test('persistent cache isolates two Anvil deployments with identical addresses but different ZK domains', async () => {
  const sharedStorage = new Map();
  const oldDeployment = await fixture({ proven: true, poolRecoveryKey: 77n, sharedStorage });
  await oldDeployment.client.loadRecoveryKey();
  await oldDeployment.client.signedAction({ kind: 'withdraw', token: 'USDT', amount: '100' });
  await oldDeployment.client.saveRecoveryCache();
  const oldKey = await oldDeployment.client.recoveryStorageKey();
  const oldRecord = sharedStorage.get(oldKey);
  assert.equal(JSON.parse(oldRecord).withdrawalClaims.length, 1);
  // A pre-upgrade cache entry must not migrate across a fresh deployment either.
  const legacyKey = await oldDeployment.client.legacyRecoveryStorageKey();
  sharedStorage.set(legacyKey, oldRecord);
  const freshDeployment = await fixture({ proven: true, poolRecoveryKey: 88n, sharedStorage });
  const snapshot = await freshDeployment.client.getAccount();
  const freshKey = await freshDeployment.client.recoveryStorageKey();
  assert.notEqual(freshKey, oldKey);
  assert.equal(snapshot.withdrawals.length, 0);
  assert.equal(freshDeployment.client.withdrawalClaims.length, 0);
  assert.equal(JSON.parse(sharedStorage.get(freshKey)).withdrawalClaims.length, 0);
  assert.equal(sharedStorage.get(oldKey), oldRecord, 'the prior deployment backup must remain recoverable');
  assert.equal(sharedStorage.get(legacyKey), oldRecord);
  // The existing client also clears its in-memory old claims when RPC exposes a new deployment.
  oldDeployment.client.vault.domain = async () => freshDeployment.ctx.domain;
  assert.equal(await oldDeployment.client.recoveryStorageKey(), freshKey);
  assert.equal(oldDeployment.client.withdrawalClaims.length, 0);
  assert.equal(oldDeployment.client.zkAuthorizations.length, 0);
  assert.equal(oldDeployment.client.recoveryKey, null);
});

test('a matching-domain legacy cache migrates without discarding its legitimate viewing key or deleting the original', async () => {
  const f = await fixture({ proven: true });
  const legacyKey = await f.client.legacyRecoveryStorageKey();
  const legacy = JSON.stringify({ recoveryKey: f.viewKey.toString(), authorizations: [], withdrawalClaims: [], accountProof: wire(f.makeState()) });
  f.storage.set(legacyKey, legacy);
  await f.client.getAccount();
  await f.client.loadRecoveryKey();
  assert.equal(f.client.recoveryKey, f.viewKey.toString());
  assert.equal(f.ctx.messages.length, 0, 'migration must not ask the wallet for another recovery seed');
  assert.equal(f.storage.get(legacyKey), legacy);
  assert.equal(JSON.parse(f.storage.get(await f.client.recoveryStorageKey())).recoveryKey, f.viewKey.toString());
});

test('lost ZK mutation response preserves authorization but does not resubmit the economic operation', async () => {
  const f = await fixture(); f.ctx.dropPost = true;
  await assert.rejects(f.client.signedAction({ kind: 'swap', tokenIn: 'RUBA', amountIn: '1000', minOut: '990' }), (error) => error.uncertain === true);
  assert.equal(f.ctx.posts.filter((post) => post.operation.kind === 'swap').length, 1);
  assert.equal(f.client.zkAuthorizations[0].status, 'submitted');
  assert.equal(f.ctx.account[4], 2n);
});

test('an oversized ZK deposit is rejected before registration, allowance reads, approvals or wallet gas', async () => {
  const f = await fixture({ registered: false });
  let allowanceReads = 0; let approvals = 0; let deposits = 0;
  f.client.tokens.RUBA = { async allowance() { allowanceReads++; return 0n; }, async approve() { approvals++; } };
  f.client.vault.deposit = async () => { deposits++; };
  await assert.rejects(f.client.deposit('RUBA', 1n << 96n), /96 бит/);
  assert.equal(allowanceReads, 0);
  assert.equal(approvals, 0);
  assert.equal(deposits, 0);
  assert.equal(f.ctx.posts.length, 0);
  assert.equal(f.ctx.messages.length, 0);
  assert.equal(f.ctx.typed.length, 0);
});

test('ZK publication checks actual code identities and signatures then sends only the fixed user-paid contract call once', async () => {
  const steps = [];
  const f = await publicationFixture({ onWalletStep: (event) => steps.push(event) });
  const result = await f.client.publishBatch(f.ticket, () => {}, f.receipt);
  assert.deepEqual(result, { status: 'published', transactionHash: '0x' + '55'.repeat(32) });
  assert.equal(f.ctx.sends.length, 1);
  assert.equal(f.ctx.sends[0].length, 6);
  assert.deepEqual(f.ctx.sends[0][0], f.ticket.publicSignals);
  assert.equal(f.ctx.sends[0][1][0].referenceId, '0');
  assert.equal(f.ctx.sends[0][1][0].reference, undefined);
  assert.deepEqual(await f.client.publishBatch(f.ticket), { status: 'already-published' });
  assert.equal(f.ctx.sends.length, 1);
  const txSteps = steps.filter((step) => step.kind === 'transaction');
  assert.deepEqual(txSteps.map((step) => step.phase), ['start', 'update', 'done']);
  assert.ok(txSteps.every((step) => step.title === 'Опубликовать ZK-переход' && step.id === txSteps[0].id));
});

test('ZK publication rejects altered field values, DA, user signatures and verifier code before requesting gas', async () => {
  const f = await publicationFixture();
  for (const corrupt of [
    (ticket) => { ticket.publicSignals[3] = c.FIELD.toString(); },
    (ticket) => { ticket.accountDA[0].ciphertext[0] = '3'; },
    (ticket) => { ticket.operations[0].signature = ticket.authorization.signature; },
    (ticket) => { ticket.authorization.deadline = '1'; },
    (ticket) => { ticket.vault = config.tokens.RUBA.address; },
  ]) { const ticket = structuredClone(f.ticket); corrupt(ticket); await assert.rejects(f.client.publishBatch(ticket)); }
  await assert.rejects(f.client.publishBatch(f.ticket, () => {}, { ...f.receipt, amountOut: '991' }), /квитанция/i);
  f.client.provider.getCode = async () => '0x6002';
  await assert.rejects(f.client.publishBatch(f.ticket), /Код verifier/);
  assert.equal(f.ctx.sends.length, 0);
});

test('a competing ZK publication confirms acceptance without attributing a failed user transaction hash', async () => {
  const f = await publicationFixture();
  f.ctx.competitor = true;
  f.ctx.publicationError = Object.assign(new Error('own revert'), { receipt: { status: 0, hash: '0x' + '55'.repeat(32) } });
  assert.deepEqual(await f.client.publishBatch(f.ticket), { status: 'already-published' });
  assert.equal(f.ctx.sends.length, 1);
});

test('proof-only publication uses five fixed arguments without any operator signature, epoch or deadline gate', async () => {
  const f = await publicationFixture({ proven: true });
  assert.equal((await f.client.publishBatch(f.ticket)).status, 'published');
  assert.equal(f.ctx.sends[0].length, 5);
});

test('proven opening is durable before wallet signing and POST; cancelled drafts never count as reserved funds', async () => {
  const f = await fixture({ proven: true });
  const storageKey = await f.client.recoveryStorageKey();
  f.ctx.beforePrivateSignature = () => {
    const claims = JSON.parse(f.storage.get(storageKey)).withdrawalClaims;
    assert.equal(claims.length, 1);
    assert.equal(claims[0].withdrawal.nonce, '1');
    assert.equal(claims[0].signature, undefined);
  };
  f.ctx.rejectPrivate = true;
  await assert.rejects(f.client.signedAction({ kind: 'withdraw', token: 'USDT', amount: '100' }), (error) => error.code === 4001);
  assert.equal(f.ctx.posts.filter((request) => request.operation.kind === 'withdraw').length, 0);
  const snapshot = await f.client.getAccount();
  assert.equal(snapshot.withdrawals[0].status, 'draft');
  assert.equal(snapshot.withdrawals.filter((record) => record.status === 'pending').length, 0);
  f.ctx.rejectPrivate = false;
  f.ctx.beforePrivateSignature = undefined;
  f.ctx.beforeZkPost = () => assert.ok(JSON.parse(f.storage.get(storageKey)).withdrawalClaims.at(-1).signature);
  const ticket = await f.client.signedAction({ kind: 'withdraw', token: 'USDT', amount: '100' });
  assert.equal(ticket.withdrawal.nonce, ticket.withdrawal.spendNonce);
  assert.equal(ticket.withdrawal.nonce, '1');
});

test('revoked access still allows withdrawal reservation and retaining its saved claim behind pending swaps', async () => {
  const f = await fixture({ proven: true, whitelisted: false });
  const ticket = await f.client.signedAction({ kind: 'withdraw', token: 'USDT', amount: '100' });
  f.ctx.publicationResponse.progress.collected = 2;
  const result = await f.client.redeemWithdrawal(ticket);
  assert.equal(result.status, 'waiting');
  assert.match(result.message, /2 из 4/);
  assert.equal(f.ctx.sends.length, 0);
  assert.equal(f.ctx.posts.filter((request) => request.operation.kind === 'withdraw').length, 1);
});

test('pending-format backup rejects a tampered claim before replacing the recovery cache', async () => {
  const f = await fixture({ proven: true });
  await f.client.signedAction({ kind: 'withdraw', token: 'USDT', amount: '100' });
  const backup = await f.client.exportZkBackup();
  assert.equal(backup.format, 'ruba-owner-backup');
  const before = JSON.stringify(f.client.withdrawalClaims);
  const keyBefore = f.client.recoveryKey;
  backup.withdrawalClaims[0].withdrawal.amount = '101';
  await assert.rejects(f.client.importZkBackup(JSON.stringify(wire(backup))), /commitment/);
  assert.equal(JSON.stringify(f.client.withdrawalClaims), before);
  assert.equal(f.client.recoveryKey, keyBefore);
});

test('proven atomic payout handles a competing publication by redeeming the same accepted claim directly', async () => {
  for (const competitor of [false, true]) {
    const f = await publicationFixture({ proven: true });
    const ticket = await f.client.signedAction({ kind: 'withdraw', token: 'USDT', amount: '100' });
    const claim = f.client.withdrawalClaims.at(-1);
    const nop = structuredClone(f.ticket.operations[7]);
    f.ticket.operations = Array.from({ length: 8 }, () => structuredClone(nop));
    f.ticket.operations[0] = { ...nop, kind: '6', owner: owner.address, commitment: BigInt(claim.commitment).toString(), signature: claim.signature };
    f.ticket.accountDA = f.ticket.operations.map((op, index) => ({ kind: op.kind, slot: '0', owner: op.owner,
      newLeaf: index === 0 ? '100' : '0', ciphertext: Array(7).fill('0') }));
    const signals = f.ticket.publicSignals;
    signals[2] = '0'; signals[8] = '1'; signals[9] = '0';
    signals[10] = c.hashAuthDigest(signals[0], signals[1], f.ticket.operations).toString();
    signals[11] = c.hashDaDigest(signals[0], signals[1], f.ticket.accountDA, f.ticket.poolDA.poolHash, f.ticket.poolDA.poolCiphertext).toString();
    f.ticket.batch.batchId = '0'; f.ticket.batch.tradeCount = '0'; f.ticket.batch.receiptsRoot = c.fieldHex(0n);
    f.ctx.publicationResponse = { status: 'ready', request: f.ticket, progress: { collected: 0, required: 4 } };
    f.client.vault.publishProvenTransitionAndWithdraw = async (...args) => {
      f.ctx.sends.push({ kind: 'atomic', args });
      return { hash: '0x' + '55'.repeat(32), async wait() {
        f.published.set('1', signals); f.accepted.stateVersion = 1n; f.accepted.stateRoot = BigInt(signals[4]);
        f.ctx.claims.set(BigInt(claim.commitment).toString(), { owner: owner.address, slot: 0n, stateVersion: 1n });
        if (competitor) throw Object.assign(new Error('stale atomic header'), { receipt: { status: 0, hash: '0x' + '55'.repeat(32) } });
        f.ctx.spent.add(BigInt(claim.commitment).toString());
        return { status: 1, hash: '0x' + '55'.repeat(32) };
      } };
    };
    const result = await f.client.redeemWithdrawal(ticket);
    assert.equal(result.status, 'withdrawn');
    assert.equal(result.transactionHash, '0x' + (competitor ? '77' : '55').repeat(32));
    assert.equal(f.ctx.sends[0].args.length, 6);
    assert.equal(f.ctx.sends.length, competitor ? 2 : 1);
    assert.equal((await f.client.redeemWithdrawal(ticket)).status, 'already-withdrawn');
    assert.equal(f.ctx.sends.length, competitor ? 2 : 1);
  }
});

test('a whitelisted proven depositor publishes accepted registration before approve, and unknown publication blocks spending', async () => {
  for (const resultStatus of ['published', 'submitted']) {
    const f = await fixture({ proven: true }); f.ctx.registeredOnchain = false;
    const sequence = [];
    f.client.getPublicationRequest = async () => ({ status: 'ready', request: {}, progress: { collected: 0, required: 4 } });
    f.client.publishZkTransition = async () => { sequence.push('publish'); if (resultStatus === 'published') f.ctx.registeredOnchain = true; return { status: resultStatus }; };
    f.client.tokens.USDT = { async allowance() { return 0n; }, async approve() { sequence.push('approve'); return { async wait() { return { status: 1 }; } }; } };
    f.client.vault.deposit = async () => { sequence.push('deposit'); return { async wait() { return { status: 1 }; } }; };
    if (resultStatus === 'published') { await f.client.deposit('USDT', '100'); assert.deepEqual(sequence, ['publish', 'approve', 'deposit']); }
    else { await assert.rejects(f.client.deposit('USDT', '100'), /неизвестен/); assert.deepEqual(sequence, ['publish']); }
  }
});

test('non-whitelisted proven deposits are rejected before registration, approval or transfer', async () => {
  for (const registered of [false, true]) {
    const f = await fixture({ registered, proven: true, whitelisted: false });
    const sequence = [];
    f.client.tokens.USDT = {
      async allowance() { sequence.push('allowance'); return 0n; },
      async approve() { sequence.push('approve'); },
    };
    f.client.vault.deposit = async () => { sequence.push('deposit'); };
    await assert.rejects(f.client.deposit('USDT', '100'), /not whitelisted/);
    assert.deepEqual(sequence, []);
    assert.equal(f.ctx.posts.length, 0);
    assert.equal(f.ctx.messages.length, 0);
    assert.equal(f.ctx.typed.length, 0);
  }
});

test('revoking access during registration publication blocks token approval', async () => {
  const f = await fixture({ proven: true });
  f.ctx.registeredOnchain = false;
  const sequence = [];
  f.client.getPublicationRequest = async () => ({ status: 'ready', request: {}, progress: { collected: 0, required: 4 } });
  f.client.publishZkTransition = async () => {
    sequence.push('publish'); f.ctx.registeredOnchain = true; f.ctx.whitelisted = false;
    return { status: 'published' };
  };
  f.client.tokens.USDT = {
    async allowance() { sequence.push('allowance'); return 0n; },
    async approve() { sequence.push('approve'); },
  };
  f.client.vault.deposit = async () => { sequence.push('deposit'); };
  await assert.rejects(f.client.deposit('USDT', '100'), /not whitelisted/);
  assert.deepEqual(sequence, ['publish']);
});

test('revoking access during token approval blocks deposit submission', async () => {
  const f = await fixture({ proven: true });
  const sequence = [];
  f.client.tokens.USDT = {
    async allowance() { return 0n; },
    async approve() { sequence.push('approve'); return { async wait() { f.ctx.whitelisted = false; return { status: 1 }; } }; },
  };
  f.client.vault.deposit = async () => { sequence.push('deposit'); };
  await assert.rejects(f.client.deposit('USDT', '100'), /not whitelisted/);
  assert.deepEqual(sequence, ['approve']);
});

test('actual ZK API accepts browser registration, LP and swaps with wallet commitments and locally checked balance paths', async () => {
  const { ZkRubaEngine } = await import('../../server/zk/engine.ts');
  const { RubaApi } = await import('../../server/api.ts');
  const backend = { proofMode: 'zk', chainId: 31337n, vaultAddress: config.vaultAddress, rubaAddress: config.tokens.RUBA.address,
    usdtAddress: config.tokens.USDT.address, dbPath: ':memory:', rpcUrl: 'http://127.0.0.1:8545', operatorPrivateKey: other.privateKey,
    deploymentBlock: 0, confirmations: 0, withdrawalTtl: 900n, host: '127.0.0.1', port: 3001, syncIntervalMs: 2000 };
  const engine = new ZkRubaEngine(backend, 77n);
  try {
    const chain = { async sync() {}, async latestTimestamp() { return 1800000000n; }, async assertWhitelisted() {}, async assertNewActivity() {},
      async publishPendingBatches() {}, async getDisclosureBatch() {} };
    const api = new RubaApi(engine, chain, backend);
    const provider = { async send(method) { return method === 'eth_chainId' ? '0x7a69' : [owner.address]; }, async getBlock() { return { timestamp: 1800000000 }; } };
    const vault = { async domain() { return engine.getDomain(); }, async poolKeyCommit() { return engine.getPoolKeyCommit(); },
      async stateRoot() { return c.fieldHex(engine.getGenesisStateRoot()); }, async stateVersion() { return 0n; }, async whitelist() { return true; } };
    const posts = [];
    const client = new RubaClient(config, provider, owner, { zkCrypto: c, storage: null, contractFactory: () => vault,
      fetchImpl: async (path, init) => {
        if (path.startsWith('/nonce?')) return { ok: true, async json() { return { account: owner.address, nonce: engine.getActionNonce(owner.address).toString() }; } };
        const request = JSON.parse(init.body); posts.push(request);
        try { const result = await api.execute(request); return { ok: true, async json() { return wire({ result }); } }; }
        catch (error) { return { ok: false, status: error.status ?? 400, async json() { return { error: error.message }; } }; }
      } });
    await client.ensureZkRegistration();
    for (const [eventId, token, amount] of [[1n, 'RUBA', 10n ** 20n], [2n, 'USDT', 10n ** 8n]]) engine.applyInboxRecord({
      eventId, kind: 2, owner: owner.address, token, amount, reference: eventId, legacyEventId: `deposit:${eventId}`,
    });
    await client.signedAction({ kind: 'addLiquidity', rubaDesired: (10n ** 19n).toString(), usdtDesired: '10000000', rubaMin: '0', usdtMin: '0' });
    for (let i = 0; i < 4; i++) await client.signedAction({ kind: 'swap', tokenIn: 'RUBA', amountIn: (10n ** 16n).toString(), minOut: '1' });
    await client.signedAction({ kind: 'removeLiquidity', shares: '1000000000', rubaMin: '0', usdtMin: '0' });
    const snapshot = await client.getAccount();
    assert.equal(snapshot.zkProof.registered, true);
    assert.equal(snapshot.zkProof.verified, false, 'a real server state is still pending until the contract accepts a proof');
    assert.equal(snapshot.balances.RUBA, BigInt(engine.accountSnapshot(owner.address).balances.RUBA));
    assert.equal(snapshot.zkProof.account[4], 7n);
    const disclosure = await client.getDisclosure('1');
    assert.equal(disclosure.version, 2);
    assert.equal(disclosure.receipt.schemaVersion, 2);
    assert.equal(posts.filter((post) => post.zk).length, 7);
  } finally { engine.close(); }
});

for (const count of [1, 2, 3, 4]) test(`ZK client accepts and publishes a ${count}-swap batch with the actual receipt range`, async () => {
  const f = await publicationFixture({ proven: true, tradeCount: count, batchId: 7, firstTradeId: 18 });
  const ticket = await f.client.zkPublicationTicket(f.ticket);
  assert.equal(ticket.batch.batchId, '7', 'batch numbers are not derived by dividing trade IDs by four');
  assert.equal(ticket.batch.tradeCount, String(count));
  const result = await f.client.publishZkTransition(f.ticket, () => {}, f.receipt);
  assert.equal(result.status, 'published');
  assert.equal(f.ctx.sends.length, 1);
});

test('ZK client rejects mismatched partial counts and receipts for padded positions', async () => {
  const f = await publicationFixture({ proven: true, tradeCount: 2 });
  const wrong = structuredClone(f.ticket); wrong.batch.tradeCount = '3';
  await assert.rejects(f.client.zkPublicationTicket(wrong), /заголовку/);
  const padding = { ...f.receipt, tradeId: '3' };
  await assert.rejects(f.client.publishZkTransition(f.ticket, () => {}, padding), /Собственная квитанция/);
  assert.equal(f.ctx.sends.length, 0);
});
