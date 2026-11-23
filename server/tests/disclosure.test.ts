import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Wallet, keccak256, parseUnits, toUtf8Bytes, verifyTypedData } from 'ethers';
import { RubaApi } from '../api.ts';
import type { Operation } from '../api.ts';
import { ACTION_TYPES, BATCH_PUBLICATION_TYPES, actionDomain, operationHash, withdrawalDomain } from '../auth.ts';
import type { VaultChain } from '../chain.ts';
import type { ServerConfig } from '../config.ts';
import { RubaEngine } from '../engine.ts';
import { disclosureBundle, publicReceiptBatch } from '../disclosure.ts';

function fixture() {
  const owner = Wallet.createRandom();
  const other = Wallet.createRandom();
  const config: ServerConfig = {
    rpcUrl: 'http://127.0.0.1:1', chainId: 31337n,
    vaultAddress: Wallet.createRandom().address,
    rubaAddress: Wallet.createRandom().address, usdtAddress: Wallet.createRandom().address,
    operatorPrivateKey: Wallet.createRandom().privateKey,
    deploymentBlock: 0, confirmations: 0, withdrawalTtl: 900n,
    dbPath: ':memory:', host: '127.0.0.1', port: 3001, syncIntervalMs: 2000,
  };
  const engine = new RubaEngine(config);
  engine.recordDeposit(1n, owner.address, 'RUBA', parseUnits('1100', 18));
  engine.recordDeposit(2n, owner.address, 'USDT', parseUnits('1000', 6));
  engine.addLiquidity(owner.address, parseUnits('1000', 18), parseUnits('1000', 6));
  const operator = new Wallet(config.operatorPrivateKey);
  const accepted = new Map<bigint, { transactionHash: string; confirmed: boolean }>();
  let failPublicationReads = false;
  function reconcilePublications() {
    if (failPublicationReads) throw new Error('RPC unavailable');
    for (const batch of engine.listPendingBatches()) {
      const observed = accepted.get(batch.batchId);
      if (observed?.confirmed) engine.markBatchPublished(batch.batchId, observed.transactionHash);
    }
  }
  const chain = {
    async sync() {},
    async latestTimestamp() { return 1000n; },
    async assertNewActivity() {},
    async publishPendingBatches() { reconcilePublications(); },
    async getPublicationRequest() {
      reconcilePublications();
      const progress = engine.getBatchProgress();
      const batch = engine.listPendingBatches()[0];
      if (!batch) return { status: 'idle', request: null, progress };
      if (accepted.has(batch.batchId)) return { status: 'waiting', request: null, progress };
      const publicBatch = publicReceiptBatch(batch);
      const deadline = 1600n;
      const signerEpoch = 1n;
      const signature = await operator.signTypedData(
        withdrawalDomain(config.chainId, config.vaultAddress), BATCH_PUBLICATION_TYPES,
        { ...publicBatch, deadline, signerEpoch },
      );
      return {
        status: 'ready', progress,
        request: { chainId: config.chainId, vault: config.vaultAddress, batch: publicBatch, deadline, signerEpoch, signature },
      };
    },
    async getDisclosureBatch(batchId: bigint) {
      if (failPublicationReads) throw new Error('RPC unavailable');
      const batch = engine.getBatch(batchId);
      if (!batch) throw new Error('Batch not found');
      return {
        chainId: config.chainId, vault: config.vaultAddress,
        status: batch.publishedTxHash ? 'published' : 'pending',
        source: batch.publishedTxHash ? 'contract' : 'server',
        batch: publicReceiptBatch(batch),
      };
    },
  };
  const api = new RubaApi(engine, chain as unknown as VaultChain, config);
  async function signedRequest(wallet: typeof owner, operation: Operation) {
    const intent = {
      account: wallet.address, actionHash: operationHash(operation),
      nonce: engine.getActionNonce(wallet.address).toString(), deadline: '1600',
    };
    const signature = await wallet.signTypedData(actionDomain(config.chainId, config.vaultAddress), ACTION_TYPES, intent);
    return { intent, operation, signature };
  }
  async function act(wallet: typeof owner, operation: Operation) {
    return api.execute(await signedRequest(wallet, operation)) as Promise<any>;
  }
  const server = api.createHttpServer();
  function http(path: string) {
    const request = new PassThrough() as any;
    request.url = path; request.method = 'GET'; request.headers = {};
    return new Promise<{ status: number; body: string; data: any }>((resolve) => {
      let status = 0;
      const response = {
        headersSent: false,
        writeHead(code: number) { status = code; this.headersSent = true; },
        end(body: string) { resolve({ status, body, data: JSON.parse(body) }); },
      };
      server.emit('request', request, response as any);
      request.end();
    });
  }
  function acceptExternalPublication(batchId = 1n) {
    assert.ok(engine.getBatch(batchId), 'a user can only publish an existing sealed batch');
    assert.equal(accepted.has(batchId), false, 'external submission must be explicit and one-use');
    const transactionHash = keccak256(toUtf8Bytes(`user-publication:${batchId}`));
    accepted.set(batchId, { transactionHash, confirmed: false });
    return transactionHash;
  }
  function confirmExternalPublication(batchId = 1n) {
    const publication = accepted.get(batchId);
    assert.ok(publication, 'confirmation requires an externally submitted publication');
    publication.confirmed = true;
  }
  return {
    owner, other, config, engine, chain, api, act, signedRequest, http, accepted,
    acceptExternalPublication, confirmExternalPublication,
    setFailure(value: boolean) { failPublicationReads = value; },
  };
}

test('disclosure export includes actual generic token metadata through an explicit public allowlist', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 4; i++) await f.act(f.owner, { kind: 'swap', tokenIn: 'RUBA', amountIn: parseUnits('1', 18).toString(), minOut: '1' });
    const receipt = f.engine.getReceipt(1n)!;
    const batch = f.engine.getBatch(1n)!;
    const tokens = {
      RUBA: { address: f.config.rubaAddress, decimals: 18, symbol: 'WETH', recoveryKey: 'private' },
      USDT: { address: f.config.usdtAddress, decimals: 8, symbol: 'WBTC', witness: 'private' },
    };
    const bundle = disclosureBundle(receipt, batch, tokens);
    assert.deepEqual(bundle.tokens, {
      RUBA: { address: f.config.rubaAddress, decimals: 18, symbol: 'WETH' },
      USDT: { address: f.config.usdtAddress, decimals: 8, symbol: 'WBTC' },
    });
    assert.equal(JSON.stringify(bundle.tokens).includes('private'), false);
  } finally { f.engine.close(); }
});

test('API collects four swaps and exports an owner proof while user publication remains pending', async () => {
  const f = fixture();
  try {
    for (let collected = 1; collected <= 3; collected++) {
      const early = await f.act(f.owner, { kind: 'swap', tokenIn: 'RUBA', amountIn: parseUnits('10', 18).toString(), minOut: '1' });
      assert.equal(early.batchId, undefined);
      assert.deepEqual(early.publication, { status: 'collecting', collected, required: 4 });
      await f.api.sync();
      assert.equal(f.engine.getBatch(1n), undefined, 'worker must not seal an incomplete batch');
      const publication = await f.http('/publication');
      assert.equal(publication.status, 200);
      assert.deepEqual(publication.data, { status: 'idle', request: null, progress: { collected, required: 4 } });
    }
    const nonceBeforeExport = f.engine.getActionNonce(f.owner.address);
    await assert.rejects(f.act(f.owner, { kind: 'disclosure', tradeId: '1' }), (error: any) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /собрано 3 из 4/);
      return true;
    });
    assert.equal(f.engine.getActionNonce(f.owner.address), nonceBeforeExport);
    const earlyReceipt = await f.act(f.owner, { kind: 'receipt', tradeId: '1' });
    assert.deepEqual(earlyReceipt.publication, { status: 'collecting', collected: 3, required: 4 });
    const trade = await f.act(f.owner, { kind: 'swap', tokenIn: 'RUBA', amountIn: parseUnits('10', 18).toString(), minOut: '1' });
    assert.equal(trade.batchId, 1n);
    assert.equal(trade.proof.length, 2);
    assert.deepEqual(trade.publication, { status: 'pending' });
    assert.equal(f.accepted.size, 0, 'executing swaps must not submit an operator-paid transaction');
    await f.api.sync();
    assert.equal(f.engine.listPendingBatches().length, 1, 'worker reconciles observations without sending a publication');
    assert.equal((await f.http('/publication')).data.status, 'ready');
    const bundle = await f.act(f.owner, { kind: 'disclosure', tradeId: '1' });
    assert.equal(bundle.format, 'ruba-trade-disclosure');
    assert.equal(bundle.version, 1);
    assert.equal(bundle.receipt.account, f.owner.address);
    assert.equal(bundle.batch.tradeCount, 4n);
    assert.equal(bundle.receipt.proof.length, 2);
    assert.notEqual(bundle.batch.receiptsRoot, bundle.receipt.leaf);
    assert.equal(bundle.tokens.USDT.decimals, 6);
    assert.equal('stateSnapshot' in bundle.batch, false);
    assert.equal('stateSalt' in bundle.batch, false);
    assert.equal('tradeIds' in bundle.batch, false);
    const nonce = f.engine.getActionNonce(f.other.address);
    await assert.rejects(f.act(f.other, { kind: 'disclosure', tradeId: '1' }), /not found/);
    assert.equal(f.engine.getActionNonce(f.other.address), nonce);
  } finally { f.engine.close(); }
});

test('publication read failure cannot roll back a swap or make refetching replay it', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 3; i++) {
      await f.act(f.owner, { kind: 'swap', tokenIn: 'RUBA', amountIn: parseUnits('10', 18).toString(), minOut: '1' });
    }
    f.setFailure(true);
    const before = f.engine.accountSnapshot(f.owner.address).balances.RUBA;
    const request = await f.signedRequest(f.owner, { kind: 'swap', tokenIn: 'RUBA', amountIn: parseUnits('10', 18).toString(), minOut: '1' });
    const trade = await f.api.execute(request) as any;
    assert.equal(trade.publication.status, 'pending');
    assert.equal(f.engine.getActionNonce(f.owner.address), 4n);
    assert.equal(f.engine.accountSnapshot(f.owner.address).balances.RUBA, before - parseUnits('10', 18));
    assert.equal(f.engine.listPendingBatches().length, 1);
    assert.equal((await f.http('/publication')).status >= 400, true);
    assert.equal(f.engine.getActionNonce(f.owner.address), 4n);
    f.setFailure(false);
    const committed = f.engine.snapshot();
    const firstRequest = await f.http('/publication');
    const retryRequest = await f.http('/publication');
    assert.equal(firstRequest.data.status, 'ready');
    assert.deepEqual(retryRequest.data, firstRequest.data);
    assert.deepEqual(f.engine.snapshot(), committed, 'declining to send a publication and refetching it must not change the ledger');
    await assert.rejects(f.api.execute(request), /nonce/);
    assert.deepEqual(f.engine.snapshot(), committed, 'the already executed signed swap cannot be replayed');
    await f.api.sync();
    assert.equal(f.engine.listPendingBatches().length, 1);
    assert.equal(f.accepted.size, 0);
    assert.equal(f.engine.snapshot().nextTradeId, 5n);
  } finally { f.engine.close(); }
});

test('public publication request contains only signed commitments and waits for external confirmation', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 4; i++) {
      await f.act(f.owner, { kind: 'swap', tokenIn: 'RUBA', amountIn: parseUnits('10', 18).toString(), minOut: '1' });
    }
    const before = f.engine.snapshot();
    const publication = await f.http('/publication');
    assert.equal(publication.status, 200);
    assert.equal(publication.data.status, 'ready');
    assert.deepEqual(Object.keys(publication.data).sort(), ['progress', 'request', 'status']);
    assert.deepEqual(publication.data.progress, { collected: 0, required: 4 });
    assert.deepEqual(Object.keys(publication.data.request).sort(), ['batch', 'chainId', 'deadline', 'signature', 'signerEpoch', 'vault']);
    assert.deepEqual(Object.keys(publication.data.request.batch).sort(), [
      'batchId', 'firstTradeId', 'newStateRoot', 'previousStateRoot', 'receiptsRoot', 'tradeCount',
    ]);
    assert.equal(publication.data.request.chainId, f.config.chainId.toString());
    assert.equal(publication.data.request.vault, f.config.vaultAddress);
    assert.match(publication.data.request.signature, /^0x[0-9a-f]{130}$/i);
    const authorization = publication.data.request;
    assert.equal(verifyTypedData(
      withdrawalDomain(f.config.chainId, f.config.vaultAddress), BATCH_PUBLICATION_TYPES,
      { ...authorization.batch, deadline: authorization.deadline, signerEpoch: authorization.signerEpoch }, authorization.signature,
    ), new Wallet(f.config.operatorPrivateKey).address);
    for (const secret of [f.owner.address, f.other.address, f.config.operatorPrivateKey, 'stateSnapshot', 'stateSalt', 'tradeIds', 'account', 'amountIn', 'amountOut', 'proof']) {
      assert.ok(!publication.body.includes(secret), `public publication must not disclose ${secret}`);
    }
    assert.deepEqual(f.engine.snapshot(), before);
    const transactionHash = f.acceptExternalPublication();
    await f.api.sync();
    assert.equal(f.engine.listPendingBatches().length, 1, 'an unconfirmed user transaction is not publication evidence');
    assert.deepEqual((await f.http('/publication')).data, { status: 'waiting', request: null, progress: { collected: 0, required: 4 } });
    const pendingReceipt = await f.act(f.owner, { kind: 'receipt', tradeId: '1' });
    assert.deepEqual(pendingReceipt.publication, { status: 'pending' });
    f.confirmExternalPublication();
    await f.api.sync();
    assert.equal(f.engine.listPendingBatches().length, 0);
    const receipt = await f.act(f.owner, { kind: 'receipt', tradeId: '1' });
    assert.deepEqual(receipt.publication, { status: 'published', transactionHash });
    assert.deepEqual((await f.http('/publication')).data, { status: 'idle', request: null, progress: { collected: 0, required: 4 } });
    const { status, body, data } = await f.http('/disclosure/batches/1');
    assert.equal(status, 200);
    assert.equal(data.source, 'contract');
    assert.equal(data.status, 'published');
    assert.equal(data.batch.tradeCount, '4');
    assert.equal(data.batch.batchId, '1');
    assert.ok(!body.includes(f.owner.address));
    for (const secret of ['stateSnapshot', 'stateSalt', 'account', 'amountIn', 'amountOut']) {
      assert.equal(Object.hasOwn(data.batch, secret), false);
    }
    assert.equal(f.engine.getActionNonce(f.owner.address), 6n, 'only authenticated receipt reads consume additional action nonces');
  } finally { f.engine.close(); }
});
