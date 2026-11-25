import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, Wallet, getAddress } from 'ethers';
import { RubaApi } from '../api.ts';
import { RubaEngine } from '../engine.ts';
import { ACTION_TYPES, actionDomain, operationHash } from '../auth.ts';
import { MarketsServer, MARKET_CONTROL_TYPES, canonicalControlJson, controlActionHash, marketControlDomain } from '../markets.ts';
import type { ArbitrageController, MarketRuntime } from '../market-types.ts';
import type { ServerConfig } from '../config.ts';
import type { VaultChain } from '../chain.ts';
import { ZK_VAULT_ABI } from '../zk/chain.ts';
import { buildAccountTree, domainHash, hashPool, hashState, keyCommit } from '../../zk/crypto.js';
import type { AcceptedCheckpoint, PoolFields, ZkState, ZkTransition } from '../zk/journal.ts';

const admin = new Wallet('0x' + '11'.repeat(32));
const other = new Wallet('0x' + '22'.repeat(32));
const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const address = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const prices = { RUBA: '2', USDT: '1', WETH: '3000', WBTC: '90000' };
const abi = new Interface(ZK_VAULT_ABI);
const accountsRoot = buildAccountTree().root;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ruba-markets-'));
  const definitions = [
    ['ruba-usdt', 'RUBA', 18, 'USDT', 6, 1, 2],
    ['ruba-weth', 'RUBA', 18, 'WETH', 18, 1, 3],
    ['weth-wbtc', 'WETH', 18, 'WBTC', 8, 3, 4],
  ] as const;
  const data: { checkpoint: AcceptedCheckpoint; current: ZkState; transitions: ZkTransition[]; fatal: boolean;
    badHeader: boolean; badReceipt: boolean; changedBlock: boolean; }[] = [];
  const makeState = (pool: PoolFields, domain: bigint, poolKeyCommit: bigint): ZkState => {
    const poolHash = hashPool(pool);
    return { accounts: Array.from({ length: 16 }, () => Array<bigint>(9).fill(0n) as ZkState['accounts'][number]), pool,
      inboxCursor: 0n, nextTradeId: 1n, accountsRoot, poolHash, root: hashState(domain, accountsRoot, poolHash, 0n, 1n, poolKeyCommit) };
  };
  const runtimes = definitions.map(([id, base, d0, quote, d1, asset0, asset1], index) => {
    const config: ServerConfig = { rpcUrl: 'http://127.0.0.1:8545', chainId: 31337n, vaultAddress: address(10 + index),
      rubaAddress: address(asset0), usdtAddress: address(asset1), operatorPrivateKey: other.privateKey,
      deploymentBlock: 1, confirmations: 0, withdrawalTtl: 900n, dbPath: join(directory, `${id}.sqlite`),
      host: '127.0.0.1', port: 3001, syncIntervalMs: 2000, proofMode: 'legacy', marketId: id, marketLabel: `${base}/${quote}`,
      tokenMetadata: { RUBA: { symbol: base, decimals: d0 }, USDT: { symbol: quote, decimals: d1 } } };
    const engine = new RubaEngine(config);
    const poolKey = keyCommit(100n + BigInt(index));
    const domain = domainHash(config.chainId, BigInt(config.vaultAddress), BigInt(config.rubaAddress), BigInt(config.usdtAddress), poolKey);
    const genesis = makeState([0n, 0n, 0n, 0n, 0n, 0n], domain, poolKey);
    const state = { checkpoint: { stateVersion: 0n, root: genesis.root, inboxCursor: 0n, nextTradeId: 1n, tradeBatchId: 0n,
      journalSeq: 0, state: genesis } as AcceptedCheckpoint, current: genesis, transitions: [] as ZkTransition[], fatal: false,
      badHeader: false, badReceipt: false, changedBlock: false };
    data.push(state);
    const originalSnapshot = engine.snapshot.bind(engine);
    Object.assign(engine, {
      getDomain: () => domain, getPoolKeyCommit: () => poolKey,
      getAcceptedCheckpoint: () => structuredClone(state.checkpoint), listTransitions: () => structuredClone(state.transitions),
      journal: { current: () => ({ ...state.current, privateUserBalances: 'PRIVATE-USER-BALANCES' }) },
      snapshot: () => ({ ...originalSnapshot(), reserves: { RUBA: state.current.pool[0], USDT: state.current.pool[1] }, privateKey: 'PRIVATE-KEY' }),
    });
    const block = (number: number) => ({ number, timestamp: 1000 + number, hash: hash(number + (state.changedBlock ? 50000 : 1000)) });
    const chain = {
      engine, config, zkAbi: abi,
      sync: async () => {}, publishPendingBatches: async () => {}, latestTimestamp: async () => 10000n,
      assertHealthy() { if (state.fatal) throw new Error('PRIVATE-RPC-URL reconciliation'); },
      confirmedBlock: async () => block(10000),
      zkVault: { async transitions(version: bigint) {
        const transition = state.transitions.find((item) => item.stateVersion === version)!;
        const header = [...transition.publicSignals]; if (state.badHeader) header[4]++;
        return header;
      } },
      provider: {
        getBlock: async (number: number) => block(number),
        async getTransactionReceipt(txHash: string) {
          const transition = state.transitions.find((item) => item.txHash === txHash)!;
          const encoded = abi.encodeEventLog(abi.getEvent('ZkTransitionPublished')!, [transition.stateVersion, 0n, transition.publicSignals]);
          return { status: state.badReceipt ? 0 : 1, blockNumber: transition.blockNumber!, blockHash: hash(transition.blockNumber! + 1000),
            to: config.vaultAddress, logs: [{ address: config.vaultAddress, ...encoded }] };
        },
      },
    };
    const api = new RubaApi(engine, chain as unknown as VaultChain, config);
    return { id, label: `${base}/${quote}`, config, engine, chain, api } as unknown as MarketRuntime;
  });
  const options = { markets: runtimes, adminAddress: admin.address, settingsPath: join(directory, 'controls.sqlite'),
    network: { name: 'Anvil demo', explorerUrl: '' } };
  let server = new MarketsServer(options);
  function accept(index: number, version: bigint, reserve0: bigint, reserve1: bigint) {
    const runtime = runtimes[index], state = data[index];
    const snapshot = makeState([reserve0, reserve1, 1000n, 1000n, reserve0, reserve1], runtime.engine.getDomain(), runtime.engine.getPoolKeyCommit());
    const signals = [runtime.engine.getDomain(), version, 0n, state.checkpoint.root, snapshot.root, 0n, 0n, 1n, 1n, 0n, 1n, 2n, runtime.engine.getPoolKeyCommit()];
    const transition = { stateVersion: version, status: 'accepted', endingState: snapshot, newRoot: snapshot.root,
      publicSignals: signals, blockNumber: Number(version), txHash: hash(90000 + index * 1000 + Number(version)),
      witness: { privateKey: 'PRIVATE-WITNESS' }, operations: [{ privateAmount: 'PRIVATE-PLAN-AMOUNT' }] } as unknown as ZkTransition;
    state.transitions.push(transition);
    state.checkpoint = { stateVersion: version, root: snapshot.root, inboxCursor: 0n, nextTradeId: 1n,
      tradeBatchId: 0n, journalSeq: Number(version), state: snapshot, blockNumber: Number(version), txHash: transition.txHash };
    state.current = snapshot;
  }
  async function signed(command: unknown, nonce = server.catalog().control.nonce, signer = admin, deadline = 10600n,
    domain = marketControlDomain(31337n, runtimes[0].config.vaultAddress)) {
    return { command, nonce: nonce.toString(), deadline: deadline.toString(),
      signature: await signer.signTypedData(domain, MARKET_CONTROL_TYPES, { actionHash: controlActionHash(command), nonce, deadline }) };
  }
  async function listen() {
    const http = server.createHttpServer(); await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  }
  return { get server() { return server; }, options, runtimes, data, accept, signed, listen,
    async restart() { await server.close(); server = new MarketsServer(options); },
    async close() { await server.close(); for (const runtime of runtimes) runtime.engine.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('catalog isolates Vaults/assets/decimals and never serializes private runtime material', async () => {
  const f = fixture();
  try {
    const catalog = f.server.catalog();
    assert.equal(catalog.defaultMarketId, 'ruba-usdt'); assert.equal(catalog.markets.length, 3);
    assert.deepEqual(catalog.markets.map((entry) => [entry.base.symbol, entry.base.decimals, entry.quote.symbol, entry.quote.decimals]),
      [['RUBA', 18, 'USDT', 6], ['RUBA', 18, 'WETH', 18], ['WETH', 18, 'WBTC', 8]]);
    assert.equal(catalog.control.domain.verifyingContract, getAddress(f.runtimes[0].config.vaultAddress));
    const wire = JSON.stringify(catalog, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
    assert.ok(!wire.includes(other.privateKey)); assert.ok(!wire.includes('sqlite')); assert.ok(!wire.includes('rpcUrl'));
  } finally { await f.close(); }
});

test('dashboard prices use accepted raw reserves and real decimals, while monitor alone can see current private reserves', async () => {
  const f = fixture();
  try {
    f.accept(0, 1n, 3000n * 10n ** 18n, 3000n * 10n ** 6n);
    f.accept(1, 1n, 3000n * 10n ** 18n, 10n ** 18n);
    f.accept(2, 1n, 3n * 10n ** 18n, 10n ** 7n);
    f.data[0].current = { ...f.data[0].current, pool: [999n * 10n ** 18n, 666n * 10n ** 6n, 1000n, 1000n, 0n, 0n] };
    const a = await f.server.dashboard('ruba-usdt');
    const b = await f.server.dashboard('ruba-weth');
    const c = await f.server.dashboard('weth-wbtc');
    assert.equal(a.accepted!.spot, '1'); assert.equal(a.accepted!.deviationBps, 0n);
    assert.equal(b.accepted!.spot, '0.000333333333333333'); assert.equal(b.accepted!.target, b.accepted!.spot);
    assert.equal(c.accepted!.spot, '0.033333333333333333'); assert.equal(c.accepted!.target, c.accepted!.spot);
    assert.equal(a.accepted!.reserve0, 3000n * 10n ** 18n);
    const wire = JSON.stringify(a, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
    for (const secret of ['PRIVATE', 'privateAmount', 'witness', 'recoveryKey']) assert.ok(!wire.includes(secret));
    const monitor = await f.server.control(await f.signed({ kind: 'monitor', marketId: 'ruba-usdt' }));
    assert.equal((monitor.result as { reserve0: bigint }).reserve0, 999n * 10n ** 18n);
    assert.equal((monitor.result as { accepted: boolean }).accepted, false);
    assert.equal(monitor.nonce, 1n); assert.equal(monitor.revision, 0n);
  } finally { await f.close(); }
});

test('unaccepted liquidity is never shown and canonical/fatal failures close the accepted dashboard', async () => {
  const f = fixture();
  try {
    f.data[0].current = { ...f.data[0].current, pool: [100n, 200n, 0n, 0n, 0n, 0n] };
    assert.equal((await f.server.dashboard('ruba-usdt')).accepted, null);
    f.accept(0, 1n, 100n * 10n ** 18n, 100n * 10n ** 6n);
    f.data[0].badHeader = true; await assert.rejects(f.server.dashboard('ruba-usdt'), /canonical Vault/); f.data[0].badHeader = false;
    f.data[0].badReceipt = true; await assert.rejects(f.server.dashboard('ruba-usdt'), /no longer canonical/); f.data[0].badReceipt = false;
    f.data[0].changedBlock = true; await assert.rejects(f.server.dashboard('ruba-usdt'), /no longer canonical/); f.data[0].changedBlock = false;
    f.data[0].fatal = true; await assert.rejects(f.server.dashboard('ruba-usdt'), /reconciliation/); f.data[0].fatal = false;
    assert.equal(f.server.settings.getHistory(`31337:${f.runtimes[0].config.vaultAddress}:ruba-usdt`).length, 0);
    assert.equal((await f.server.dashboard('ruba-usdt')).accepted!.spot, '1');
  } finally { await f.close(); }
});

test('signed global controls bind command, default Vault, chain, nonce and time across restart', async () => {
  const f = fixture();
  try {
    const command = { kind: 'prices', prices };
    await assert.rejects(f.server.control(await f.signed(command, 0n, other)), /Unauthorized/);
    await assert.rejects(f.server.control(await f.signed(command, 0n, admin, 10601n)), /600-second/);
    await assert.rejects(f.server.control(await f.signed(command, 0n, admin, 9999n)), /expired/);
    await assert.rejects(f.server.control(await f.signed(command, 0n, admin, 10600n, marketControlDomain(1n, f.runtimes[0].config.vaultAddress))), /Unauthorized/);
    await assert.rejects(f.server.control(await f.signed(command, 0n, admin, 10600n, marketControlDomain(31337n, f.runtimes[1].config.vaultAddress))), /Unauthorized/);
    const signed = await f.signed(command);
    await assert.rejects(f.server.control({ ...signed, command: { kind: 'prices', prices: { ...prices, RUBA: '3' } } }), /Unauthorized/);
    const applied = await f.server.control(signed); assert.equal(applied.nonce, 1n); assert.equal(applied.revision, 1n);
    await f.restart();
    assert.equal(f.server.catalog().control.nonce, 1n); assert.equal(f.server.getSettings().prices.RUBA, '2');
    await assert.rejects(f.server.control(signed), /nonce/);
    const arb = { kind: 'arbitrage', marketId: 'weth-wbtc', enabled: true, delaySeconds: 30 };
    assert.equal(canonicalControlJson(arb), '{"delaySeconds":30,"enabled":true,"kind":"arbitrage","marketId":"weth-wbtc"}');
    await f.server.control(await f.signed(arb));
    assert.equal(f.server.getSettings().arbitrage['weth-wbtc'].enabled, true);
    assert.equal(f.server.getSettings().arbitrage['ruba-usdt'].enabled, false);
    const one = await f.signed({ kind: 'monitor', marketId: 'ruba-usdt' });
    const results = await Promise.allSettled([f.server.control(one), f.server.control(one)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(f.server.catalog().control.nonce, 3n); assert.equal(f.server.getSettings().revision, 2n);
  } finally { await f.close(); }
});

test('administrator closeBatch is signed, scoped and returns a bounded wallet-publication request', async () => {
  const f = fixture();
  try {
    const selected = f.runtimes[1]; selected.config.proofMode = 'zk';
    let closes = 0, syncs = 0, prepares = 0;
    const transitions = [{ status: 'pending', stateVersion: 2n }, { status: 'pending', stateVersion: 3n }];
    Object.assign(selected.engine, { closePendingBatch() { closes++; }, listTransitions: () => transitions });
    Object.assign(selected.chain, { async sync() { syncs++; }, async getPublicationRequest() {
      prepares++; assert.equal(closes, 1); return { status: 'waiting', request: null, progress: { collected: 0, required: 4 } };
    } });
    const command = { kind: 'closeBatch', marketId: 'ruba-weth' };
    await assert.rejects(f.server.control(await f.signed(command, 0n, other)), /Unauthorized/);
    assert.equal(closes, 0); assert.equal(f.server.catalog().control.nonce, 0n);
    const signed = await f.signed(command);
    const response = await f.server.control(signed);
    assert.deepEqual(response, { result: { marketId: 'ruba-weth', closedThroughStateVersion: 3n,
      publication: { status: 'waiting', request: null, progress: { collected: 0, required: 4 } } }, nonce: 1n, revision: 0n });
    assert.equal(syncs, 1); assert.equal(prepares, 1); assert.equal(closes, 1);
    await assert.rejects(f.server.control(signed), /nonce/);
    assert.equal(closes, 1);
    assert.equal(f.runtimes[0].engine.getActionNonce(admin.address), 0n);
    assert.equal(selected.api.publicConfig().minTradesPerBatch, 1);
    assert.equal(selected.api.publicConfig().maxTradesPerBatch, 4);
    assert.equal(f.runtimes[0].api.publicConfig().manualBatchClosing, undefined);
  } finally { await f.close(); }
});

test('an empty administrator close creates no transition and preparation failure keeps an audited retryable closure', async () => {
  const f = fixture();
  try {
    const selected = f.runtimes[0]; selected.config.proofMode = 'zk';
    let closes = 0, failProof = false;
    const transitions: { status: string; stateVersion: bigint }[] = [];
    Object.assign(selected.engine, { closePendingBatch() { closes++; }, listTransitions: () => transitions });
    Object.assign(selected.chain, { async getPublicationRequest() {
      if (failProof) throw new Error('PRIVATE-PROVER-RPC-KEY');
      return { status: 'idle', request: null, progress: { collected: 0, required: 4 } };
    } });
    const command = { kind: 'closeBatch', marketId: 'ruba-usdt' };
    const empty = await f.server.control(await f.signed(command));
    assert.deepEqual(empty.result, { marketId: 'ruba-usdt', closedThroughStateVersion: null,
      publication: { status: 'idle', request: null, progress: { collected: 0, required: 4 } } });
    assert.equal(transitions.length, 0);
    transitions.push({ status: 'pending', stateVersion: 1n }); failProof = true;
    const request = await f.signed(command);
    const failed = await f.server.control(request);
    const result = failed.result as { publication: unknown; closedThroughStateVersion: bigint; preparationError: string };
    assert.equal(result.publication, null); assert.equal(result.closedThroughStateVersion, 1n);
    assert.match(result.preparationError, /Пакет закрыт/);
    assert.ok(!result.preparationError.includes('PRIVATE'));
    assert.equal(failed.nonce, 2n); assert.equal(failed.revision, 0n);
    assert.equal(transitions.length, 1);
    await assert.rejects(f.server.control(request), /nonce/);
    failProof = false;
    assert.equal((await selected.api.preparePublication()).status, 'idle');
    assert.equal(closes, 2, 'retrying proof preparation must not reseal economic operations');
  } finally { await f.close(); }
});

test('closeBatch refuses legacy markets before consuming its administrator nonce', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.server.control(await f.signed({ kind: 'closeBatch', marketId: 'ruba-usdt' })), /ZK ledger/);
    assert.equal(f.server.catalog().control.nonce, 0n);
  } finally { await f.close(); }
});

test('administrator rebuildQueue is signed, refuses a Vault that moved ahead and returns the rebuilt publication', async () => {
  const f = fixture();
  try {
    const selected = f.runtimes[1]; selected.config.proofMode = 'zk';
    let rebuilds = 0, chainVersion = 1n;
    const checkpoint = { stateVersion: 1n, journalSeq: 2 };
    const owner = BigInt(other.address);
    Object.assign(selected.engine, {
      getAcceptedCheckpoint: () => checkpoint,
      journal: { operations: () => [{ seq: 1, owner }, { seq: 3, owner }] },
      rebuildQueue(rule: (op: { kind: number; owner: string }) => string | undefined) {
        rebuilds++;
        assert.equal(rule({ kind: 3, owner: other.address }), 'owner is not whitelisted');
        assert.equal(rule({ kind: 2, owner: other.address }), undefined);
        return { changed: true, fromStateVersion: 1n, kept: 1, dropped: [{ seq: 3, kind: 3, owner: other.address, reason: 'owner is not whitelisted' }], trades: [], pendingVersions: [2n] };
      },
    });
    let owners: string[] = [];
    Object.assign(selected.chain, {
      async sync() {},
      async queueRules(list: string[]) {
        owners = list;
        return { stateVersion: chainVersion, blockNumber: 77, rule: ({ kind }: { kind: number }) => kind === 3 ? 'owner is not whitelisted' : undefined };
      },
      async getPublicationRequest() { return { status: 'waiting', request: null, progress: { collected: 1, required: 4 } }; },
    });
    const command = { kind: 'rebuildQueue', marketId: 'ruba-weth' };
    await assert.rejects(f.server.control(await f.signed(command, 0n, other)), /Unauthorized/);
    assert.equal(rebuilds, 0);
    const response = await f.server.control(await f.signed(command));
    assert.deepEqual(owners, [other.address]);
    assert.equal(rebuilds, 1);
    const result = response.result as { marketId: string; changed: boolean; blockNumber: number; dropped: unknown[]; publication: { status: string } };
    assert.equal(result.marketId, 'ruba-weth'); assert.equal(result.changed, true); assert.equal(result.blockNumber, 77);
    assert.equal(result.dropped.length, 1); assert.equal(result.publication.status, 'waiting');
    chainVersion = 2n;
    await assert.rejects(f.server.control(await f.signed(command)), /Vault уже принял/);
    assert.equal(rebuilds, 1);
  } finally { await f.close(); }
});

test('rebuildQueue refuses legacy markets before consuming its administrator nonce', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.server.control(await f.signed({ kind: 'rebuildQueue', marketId: 'ruba-usdt' })), /ZK ledger/);
    assert.equal(f.server.catalog().control.nonce, 0n);
  } finally { await f.close(); }
});

test('reference changes update the current target without inventing or rewriting accepted history points', async () => {
  const f = fixture();
  try {
    f.accept(0, 1n, 100n * 10n ** 18n, 100n * 10n ** 6n);
    const original = await f.server.dashboard('ruba-usdt');
    await f.server.control(await f.signed({ kind: 'prices', prices }));
    const updated = await f.server.dashboard('ruba-usdt');
    assert.equal(updated.accepted!.stateVersion, original.accepted!.stateVersion);
    assert.equal(updated.accepted!.target, '2'); assert.equal(updated.accepted!.deviationBps, -5000n);
    assert.equal(updated.accepted!.history.length, 1); assert.equal(updated.accepted!.history[0].target, '1');
    await f.restart(); assert.equal((await f.server.dashboard('ruba-usdt')).accepted!.history.length, 1);
  } finally { await f.close(); }
});

test('router scopes signed actions/nonces/config without rewriting the original request URL', async () => {
  const f = fixture();
  try {
    const origin = await f.listen();
    const config = await (await fetch(`${origin}/markets/weth-wbtc/config`)).json() as { tokens: { RUBA: { symbol: string }; USDT: { decimals: number } } };
    assert.equal(config.tokens.RUBA.symbol, 'WETH'); assert.equal(config.tokens.USDT.decimals, 8);
    const defaultConfig = await (await fetch(`${origin}/config`)).json() as { marketId: string }; assert.equal(defaultConfig.marketId, 'ruba-usdt');
    const operation = { kind: 'account' } as const;
    const intent = { account: other.address, actionHash: operationHash(operation), nonce: '0', deadline: '10600' };
    const signature = await other.signTypedData(actionDomain(31337n, f.runtimes[1].config.vaultAddress), ACTION_TYPES, intent);
    const body = JSON.stringify({ intent, operation, signature });
    assert.equal((await fetch(`${origin}/markets/ruba-weth/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 200);
    assert.equal(f.runtimes[1].engine.getActionNonce(other.address), 1n); assert.equal(f.runtimes[0].engine.getActionNonce(other.address), 0n);
    assert.equal((await fetch(`${origin}/markets/ruba-usdt/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 400);
    assert.equal((await fetch(`${origin}/markets/not-found/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 404);
    assert.equal((await fetch(`${origin}/markets/ruba-usdt%2Factions/config`)).status, 404);
    const nonce = await (await fetch(`${origin}/markets/ruba-usdt/nonce?account=${other.address}`)).json() as { nonce: string }; assert.equal(nonce.nonce, '0');
  } finally { await f.close(); }
});

test('HTTP administrator access stays signed, bounded and private while public errors redact RPC details', async () => {
  const f = fixture();
  try {
    const origin = await f.listen();
    const post = (body: unknown) => fetch(`${origin}/admin/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ command: { kind: 'monitor', marketId: 'ruba-usdt' }, nonce: '0', deadline: '10600', signature: '0x' })).status, 403);
    assert.equal(f.server.catalog().control.nonce, 0n);
    const response = await post(await f.signed({ kind: 'monitor', marketId: 'ruba-usdt' })); assert.equal(response.status, 200);
    const result = await response.json() as { nonce: string; revision: string; result: { source: string } };
    assert.equal(result.result.source, 'private-current'); assert.equal(result.nonce, '1'); assert.equal(result.revision, '0');
    assert.equal((await fetch(`${origin}/admin/action`)).status, 405);
    assert.equal((await fetch(`${origin}/admin/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(32769) })).status, 413);
    f.data[0].fatal = true;
    const failed = await fetch(`${origin}/markets/ruba-usdt/dashboard`); assert.equal(failed.status, 503);
    assert.ok(!(await failed.text()).includes('PRIVATE-RPC'));
  } finally { await f.close(); }
});

test('duplicate Vaults/databases and wrong deployments are rejected before settings are reused', async () => {
  const f = fixture();
  try {
    assert.throws(() => new MarketsServer({ ...f.options, markets: [f.runtimes[0], { ...f.runtimes[0], id: 'duplicate' }] }), /Vault/);
    assert.throws(() => new MarketsServer({ ...f.options, markets: [f.runtimes[0], { ...f.runtimes[1], config: { ...f.runtimes[1].config, dbPath: f.runtimes[0].config.dbPath } }] }), /SQLite/);
    assert.throws(() => new MarketsServer({ ...f.options, settingsPath: f.runtimes[0].config.dbPath }), /separate/);
    assert.throws(() => new MarketsServer({ ...f.options, markets: [f.runtimes[0], { ...f.runtimes[1], id: 'BAD/ID' }] }), /IDs/);
    assert.throws(() => new MarketsServer({ ...f.options, defaultMarketId: 'missing' }), /Default/);
    assert.throws(() => new MarketsServer({ ...f.options, adminAddress: other.address }), /another deployment/);
  } finally { await f.close(); }
});

test('public arbitrage status allowlists fields and never returns private plans or raw errors', async () => {
  const f = fixture();
  try {
    f.server.setArbitrageController({ getStatus: () => ({ status: 'waiting', nextRunAt: 1000, error: 'PRIVATE-RPC-KEY', message: 'Waiting for liquidity',
      privatePlan: { amount: 'PRIVATE-PLAN' } }), stop() {}, async drain() {}, async runOnce() {}, start() { return () => {}; } } as unknown as ArbitrageController);
    const dashboard = await f.server.dashboard('ruba-usdt');
    assert.equal(dashboard.arbitrage.status, 'waiting'); assert.equal(dashboard.arbitrage.nextRunAt, 1000);
    assert.ok(!JSON.stringify(dashboard.arbitrage).includes('PRIVATE'));
    assert.ok(!('privatePlan' in dashboard.arbitrage));
  } finally { await f.close(); }
});
