import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getAddress } from 'ethers';
import { ACTION_TYPES, ZK_OPERATION_TYPES, ZK_TIMED_OPERATION_TYPES, actionDomain, operationHash, operationSignatureDeadline, recoverOperationSigner, uint, verifyAction, zkOperationDomain } from './auth.ts';
import type { ActionIntent } from './auth.ts';
import type { ServerConfig } from './config.ts';
import { tokenMetadata } from './config.ts';
import type { RubaEngine } from './engine.ts';
import type { VaultChain } from './chain.ts';
import type { Token } from './types.ts';
import { AdmissionDesk, AdmissionError } from './admission.ts';
import { getStaticResponse } from './static.ts';
import { disclosureBundle } from './disclosure.ts';
import type { ZkRubaEngine } from './zk/engine.ts';
import type { ZkVaultChain } from './zk/chain.ts';
import { field } from '../zk/crypto.js';

export type Operation =
  | { kind: 'account' }
  | { kind: 'quote'; tokenIn: Token; amountIn: string }
  | { kind: 'swap'; tokenIn: Token; amountIn: string; minOut: string }
  | { kind: 'addLiquidity'; rubaDesired: string; usdtDesired: string; rubaMin: string; usdtMin: string }
  | { kind: 'removeLiquidity'; shares: string; rubaMin: string; usdtMin: string }
  | { kind: 'withdraw'; token: Token; amount: string }
  | { kind: 'withdrawal'; nonce: string }
  | { kind: 'expireWithdrawal'; nonce: string }
  | { kind: 'receipt'; tradeId: string }
  | { kind: 'disclosure'; tradeId: string }
  | { kind: 'zkState' }
  | { kind: 'zkRegister'; recoveryKey: string; slot: string };
// ZK account reads keep ordinary wallet authentication; registration is economic consent.
export type ZkOperation = Extract<Operation, { kind: 'zkState' | 'zkRegister' }>;
export interface ZkAuthorizationRequest { commitment: string; nonce: string; salt: string }

export interface ActionRequest { intent: ActionIntent; operation: Operation | ZkOperation; signature: string; zk?: ZkAuthorizationRequest }
export interface InternalActionOptions {
  /** Trusted synchronous guard inside the economic transaction, never an HTTP payload field. */
  beforeApply?: () => void;
  /** Persist worker step identity atomically with the resulting economic operation. */
  onCommit?: (result: unknown) => void;
}

const OPERATION_FIELDS: Record<(Operation | ZkOperation)['kind'], string[]> = {
  account: [], quote: ['tokenIn', 'amountIn'], swap: ['tokenIn', 'amountIn', 'minOut'],
  addLiquidity: ['rubaDesired', 'usdtDesired', 'rubaMin', 'usdtMin'],
  removeLiquidity: ['shares', 'rubaMin', 'usdtMin'], withdraw: ['token', 'amount'],
  withdrawal: ['nonce'], expireWithdrawal: ['nonce'], receipt: ['tradeId'], disclosure: ['tradeId'],
  zkState: [], zkRegister: ['recoveryKey', 'slot'],
};

export function validateOperation(value: unknown): Operation | ZkOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Operation must be an object');
  const operation = value as Record<string, unknown>;
  if (typeof operation.kind !== 'string' || !Object.hasOwn(OPERATION_FIELDS, operation.kind)) throw new Error('Unknown operation');
  const fields = OPERATION_FIELDS[operation.kind as (Operation | ZkOperation)['kind']];
  if (Object.keys(operation).sort().join(',') !== ['kind', ...fields].sort().join(',')) throw new Error('Invalid operation fields');
  for (const field of fields) {
    if (field === 'token' || field === 'tokenIn') {
      if (operation[field] !== 'RUBA' && operation[field] !== 'USDT') throw new Error('Unknown token');
    } else uint(operation[field], field);
  }
  return operation as Operation | ZkOperation;
}

/** An owner deadline must leave time to seal, prove and publish the transition. */
const OPERATION_MIN_WINDOW = 600n;
/** A draft is closed early when one of its owner deadlines comes this close. */
const DEADLINE_CLOSE_MARGIN = 1200n;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function json(value: unknown): string {
  return JSON.stringify(value, (_key, field) => typeof field === 'bigint' ? field.toString() : field);
}

/** Ledger mutations, event indexing and publication observations share one queue. */
export class RubaApi {
  readonly engine: RubaEngine;
  readonly chain: VaultChain;
  readonly config: ServerConfig;
  private queue: Promise<unknown> = Promise.resolve();
  private workerError = false;
  admission?: AdmissionDesk;

  constructor(engine: RubaEngine, chain: VaultChain, config: ServerConfig) {
    this.engine = engine; this.chain = chain; this.config = config;
  }

  attachAdmissionDesk(desk: AdmissionDesk): this {
    if (desk.chainId !== this.config.chainId || desk.vaultAddress.toLowerCase() !== this.config.vaultAddress.toLowerCase()) {
      throw new Error('Admission desk belongs to another vault');
    }
    this.admission = desk;
    return this;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Stop accepting requests before draining and replacing a market instance. */
  async drain(): Promise<void> { await this.queue; }

  /** Shared by HTTP and the bot; sealing/proving must observe this market's serialized state. */
  async preparePublication() { return this.serial(() => this.chain.getPublicationRequest()); }

  /** Called only after the MarketsServer has authenticated an administrator. */
  async closeBatch() {
    return this.serial(async () => {
      if (this.config.proofMode !== 'zk') throw new Error('Manual batch closing requires the ZK ledger');
      await this.chain.sync();
      const engine = this.engine as ZkRubaEngine;
      engine.closePendingBatch();
      const closedThroughStateVersion = engine.listTransitions().filter((transition) => transition.status === 'pending').at(-1)?.stateVersion ?? null;
      try {
        return { closedThroughStateVersion, publication: await this.chain.getPublicationRequest() };
      } catch {
        // Closing is committed already. Preserve that result if proof preparation
        // fails, and allow the existing publication endpoint to retry safely.
        return { closedThroughStateVersion, publication: null,
          preparationError: 'Пакет закрыт, но доказательство пока не подготовлено. Повторите подготовку публикации.' };
      }
    });
  }

  /** Called only after the MarketsServer has authenticated an administrator.
   * Rebuilds the unpublished queue against the whitelist and pause of the latest block. */
  async rebuildQueue() {
    return this.serial(async () => {
      if (this.config.proofMode !== 'zk') throw new Error('Queue rebuild requires the ZK ledger');
      await this.chain.sync();
      const engine = this.engine as ZkRubaEngine;
      const chain = this.chain as unknown as ZkVaultChain;
      const checkpoint = engine.getAcceptedCheckpoint();
      const owners = engine.journal.operations().filter((op) => op.seq > checkpoint.journalSeq)
        .map((op) => getAddress('0x' + op.owner.toString(16).padStart(40, '0')));
      const context = await chain.queueRules(owners);
      const accepted = engine.getAcceptedCheckpoint();
      if (context.stateVersion !== accepted.stateVersion) throw new HttpError(409, 'Vault уже принял следующий переход. Дождитесь подтверждения блока и повторите пересборку.');
      const rebuild = engine.rebuildQueue(context.rule);
      const result = { ...rebuild, blockNumber: context.blockNumber };
      if (!rebuild.changed || !rebuild.pendingVersions.length) return { ...result, publication: null };
      try {
        return { ...result, publication: await this.chain.getPublicationRequest() };
      } catch {
        return { ...result, publication: null,
          preparationError: 'Очередь пересобрана, но доказательство пока не подготовлено. Повторите подготовку публикации.' };
      }
    });
  }

  async sync(): Promise<void> {
    return this.serial(async () => { await this.chain.sync(); await this.chain.publishPendingBatches(); await this.closeExpiringDraft(); this.workerError = false; });
  }
  /** Seal the draft before an owner deadline inside it runs out, so the Vault still accepts it. */
  private async closeExpiringDraft(): Promise<void> {
    if (this.config.proofMode !== 'zk') return;
    const engine = this.engine as ZkRubaEngine;
    const deadline = engine.earliestDraftDeadline();
    if (deadline !== undefined && deadline <= await this.chain.latestTimestamp() + DEADLINE_CLOSE_MARGIN) engine.closePendingBatch();
  }

  /** Used by both the HTTP adapter and the local end-to-end demo. */
  async execute(request: ActionRequest, internal?: InternalActionOptions): Promise<unknown> {
    return this.serial(async () => {
      if (!request || typeof request !== 'object' || Object.keys(request).sort().join(',') !== (request.zk ? 'intent,operation,signature,zk' : 'intent,operation,signature')) throw new Error('Invalid request fields');
      const operation = validateOperation(request.operation);
      if (this.config.proofMode === 'zk' && operation.kind === 'expireWithdrawal') {
        throw new Error('Proven withdrawals do not expire or refund; redeem the reserved claim.');
      }
      if (typeof request.signature !== 'string') throw new Error('Missing signature');
      await this.chain.sync(); // Only trusted canonical logs can credit a deposit or settle a payout.
      const timestamp = await this.chain.latestTimestamp();
      const economic = ['zkRegister', 'swap', 'addLiquidity', 'removeLiquidity', 'withdraw'].includes(operation.kind);
      const zkMode = this.config.proofMode === 'zk';
      if (request.zk && (!zkMode || !economic)) throw new Error('Unexpected ZK economic authorization');
      if (zkMode && economic && !request.zk) throw new Error('A wallet authorization for the proven economic operation is required');
      if (!zkMode && ['zkState', 'zkRegister'].includes(operation.kind)) throw new Error('This market is not using the ZK ledger');
      let account: string;
      if (request.zk) {
        if (Object.keys(request.zk).sort().join(',') !== 'commitment,nonce,salt') throw new Error('Invalid ZK authorization fields');
        if (!request.intent || Object.keys(request.intent).sort().join(',') !== 'account,actionHash,deadline,nonce') throw new Error('Invalid request intent');
        account = getAddress(request.intent.account);
        if (uint(request.intent.nonce, 'nonce') !== this.engine.getActionNonce(account)) throw new Error('Invalid action nonce');
        if (uint(request.intent.deadline, 'deadline') < timestamp || uint(request.intent.deadline, 'deadline') > timestamp + 3600n) throw new Error('Invalid submission deadline');
        if (request.intent.actionHash !== operationHash(operation)) throw new Error('Operation hash mismatch');
        const authorization = (this.engine as ZkRubaEngine).prepareAuthorization(account, operation, field(uint(request.zk.salt, 'salt')));
        if (field(uint(request.zk.commitment, 'commitment')) !== BigInt(authorization.commitment)
          || uint(request.zk.nonce, 'nonce') !== BigInt(authorization.nonce)) throw new Error('ZK operation authorization is stale or mismatched');
        const signer = recoverOperationSigner(zkOperationDomain(this.config.chainId, this.config.vaultAddress), request.zk.commitment, request.signature);
        if (getAddress(signer) !== account) throw new Error('Invalid economic owner signature');
        const ownerDeadline = operationSignatureDeadline(request.signature);
        if (ownerDeadline !== undefined && ownerDeadline < timestamp + OPERATION_MIN_WINDOW) throw new Error('Owner deadline leaves no time to publish the operation; sign it again');
      } else account = verifyAction(this.config.chainId, this.config.vaultAddress, request.intent, operation, request.signature, timestamp);
      const nonce = uint(request.intent.nonce, 'nonce');
      if (nonce !== this.engine.getActionNonce(account)) throw new Error('Invalid action nonce');
      if (operation.kind === 'zkRegister') await this.chain.assertWhitelisted(account);
      if (['quote', 'swap', 'addLiquidity'].includes(operation.kind)) await this.chain.assertNewActivity(account);

      // Network reads happen before entering the synchronous SQLite transaction.
      const withdrawalContext = operation.kind === 'withdraw' ? await this.chain.withdrawalContext(operation.token) : undefined;
      const expiryContext = operation.kind === 'expireWithdrawal' ? await this.chain.expiryContext(account, uint(operation.nonce, 'nonce')) : undefined;
      const apply = () => this.engine.executeAction(account, nonce, () => {
        internal?.beforeApply?.();
        const result = (() => { switch (operation.kind) {
          case 'zkState': return (this.engine as ZkRubaEngine).getZkAccount(account);
          case 'zkRegister': return (this.engine as ZkRubaEngine).registerZkAccount(account, field(uint(operation.recoveryKey, 'recoveryKey')), Number(uint(operation.slot, 'slot')));
          case 'account': return {
            ...this.engine.accountSnapshot(account),
            // The same owner-authenticated read returns its balance witness.
            // The browser still checks this proof against the deployed Vault.
            ...(zkMode ? { zkProof: (this.engine as ZkRubaEngine).getZkAccount(account) } : {}),
          };
          case 'quote': {
            const amountIn = uint(operation.amountIn, 'amountIn');
            return { tokenIn: operation.tokenIn, amountIn, amountOut: this.engine.quote(operation.tokenIn, amountIn) };
          }
          case 'swap': return this.engine.swap(account, operation.tokenIn, uint(operation.amountIn, 'amountIn'), uint(operation.minOut, 'minOut'));
          case 'addLiquidity': return this.engine.addLiquidity(account, uint(operation.rubaDesired, 'rubaDesired'), uint(operation.usdtDesired, 'usdtDesired'), uint(operation.rubaMin, 'rubaMin'), uint(operation.usdtMin, 'usdtMin'));
          case 'removeLiquidity': return this.engine.removeLiquidity(account, uint(operation.shares, 'shares'), uint(operation.rubaMin, 'rubaMin'), uint(operation.usdtMin, 'usdtMin'));
          case 'withdraw': return this.engine.reserveWithdrawal(account, operation.token, uint(operation.amount, 'amount'), withdrawalContext!.deadline, withdrawalContext!.signerEpoch);
          case 'withdrawal': {
            const record = this.engine.getWithdrawal(account, uint(operation.nonce, 'nonce'));
            if (!record) throw new Error('Withdrawal not found');
            return record;
          }
          case 'expireWithdrawal': {
            const withdrawalNonce = uint(operation.nonce, 'nonce');
            this.engine.expireWithdrawal(account, withdrawalNonce, expiryContext!);
            return this.engine.getWithdrawal(account, withdrawalNonce);
          }
          case 'receipt':
          case 'disclosure': {
            const receipt = this.engine.getReceipt(uint(operation.tradeId, 'tradeId'));
            if (!receipt || getAddress(receipt.account) !== account) {
              // A missing ID and another owner's ID are indistinguishable.
              throw new HttpError(404, 'Квитанция не найдена для подключённого кошелька в выбранном пуле. Проверьте номер своей сделки и выбранную пару.');
            }
            // The receipt, its salt and Merkle proof are visible only to its authenticated owner.
            if (operation.kind === 'disclosure') {
              const batch = receipt.batchId === undefined ? undefined : this.engine.getBatch(receipt.batchId);
              if (!batch) {
                const progress = this.engine.getBatchProgress();
                throw new HttpError(409, `Квитанция ещё не включена в пакет: собрано ${progress.collected} из ${progress.required} сделок. `
                  + (zkMode ? 'Повторите загрузку после автоматического закрытия, закрытия администратором или запроса на выход.' : 'После четвёртой сделки повторите загрузку.'));
              }
              return disclosureBundle(receipt, batch, this.publicConfig().tokens);
            }
            return receipt;
          }
        } })();
        // Seal pure-control LP exits in the same economic transaction as the
        // removal. A sealing error rolls back the removal and its authorization.
        if (zkMode && operation.kind === 'removeLiquidity') (this.engine as ZkRubaEngine).closePendingBatch();
        internal?.onCommit?.(result);
        return result;
      });
      const result = request.zk
        ? (this.engine as ZkRubaEngine).withZkAuthorization({ account, commitment: BigInt(request.zk.commitment), nonce: BigInt(request.zk.nonce), salt: BigInt(request.zk.salt), signature: request.signature }, apply)
        : apply();
      if (operation.kind === 'swap' || operation.kind === 'receipt') {
        const receipt = result as ReturnType<RubaEngine['swap']>;
        // The trade and any complete batch are already durable. Observing a
        // user-submitted publication must never make the swap retryable.
        let publication: { status: 'collecting' | 'pending' | 'published'; collected?: number; required?: number; transactionHash?: string }
          = receipt.batchId === undefined
            ? { status: 'collecting', ...this.engine.getBatchProgress() }
            : { status: 'pending' };
        try {
          if (operation.kind === 'swap') await this.chain.publishPendingBatches();
          if (receipt.batchId !== undefined) {
            const observed = await this.chain.getDisclosureBatch(receipt.batchId);
            if (observed?.status === 'published' && observed.source === 'contract') {
              publication = { status: 'published', transactionHash: observed.batch.publishedTxHash };
            }
          }
        } catch { this.workerError = true; }
        return { ...this.engine.getReceipt(receipt.tradeId), publication };
      }
      if (operation.kind === 'withdraw' || operation.kind === 'withdrawal') {
        const record = result as ReturnType<RubaEngine['reserveWithdrawal']>;
        if (zkMode || record.status === 'pending') return this.chain.signWithdrawal(record);
      }
      if (operation.kind === 'removeLiquidity' && zkMode) {
        return { ...(result as ReturnType<RubaEngine['removeLiquidity']>), closedThroughStateVersion:
          (this.engine as ZkRubaEngine).listTransitions().filter((transition) => transition.status === 'pending').at(-1)?.stateVersion ?? null };
      }
      return result;
    });
  }

  publicConfig() {
    const metadata = tokenMetadata(this.config);
    return {
      chainId: this.config.chainId, vaultAddress: this.config.vaultAddress,
      ...(this.config.chainMode ? { chainMode: this.config.chainMode } : {}),
      ...(this.config.marketId ? { marketId: this.config.marketId, marketLabel: this.config.marketLabel ?? this.config.marketId } : {}),
      tokens: {
        RUBA: { address: this.config.rubaAddress, decimals: metadata.RUBA.decimals, ...(this.config.tokenMetadata ? { symbol: metadata.RUBA.symbol } : {}) },
        USDT: { address: this.config.usdtAddress, decimals: metadata.USDT.decimals, ...(this.config.tokenMetadata ? { symbol: metadata.USDT.symbol } : {}) },
      },
      ...(this.config.chainMode === 'sepolia' ? { finalityPolicy: 'testnet-confirmations', confirmations: this.config.confirmations } : {}),
      domain: actionDomain(this.config.chainId, this.config.vaultAddress), types: ACTION_TYPES,
      tradesPerBatch: 4,
      ...(this.config.proofMode === 'zk' ? { minTradesPerBatch: 1, maxTradesPerBatch: 4, manualBatchClosing: true, closeBatchOnExit: true } : {}),
      publicationMode: 'user-paid',
      ...(this.config.proofMode === 'zk' ? { proofMode: 'zk', withdrawalMode: 'proven-reservation-v1', publicationAuthorization: 'proof-only', zkOperationDomain: zkOperationDomain(this.config.chainId, this.config.vaultAddress), zkOperationTypes: ZK_OPERATION_TYPES, zkTimedOperationTypes: ZK_TIMED_OPERATION_TYPES } : {}),
      operationFields: OPERATION_FIELDS,
      ...(this.admission ? { admission: { mode: 'desk-approval', signer: this.admission.signerAddress } } : {}),
    };
  }

  createHttpServer() {
    const server = createServer((request, response) => { void this.handle(request, response); });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.maxRequestsPerSocket = 100;
    return server;
  }

  startWorker(): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      this.sync().catch(() => { this.workerError = true; }).finally(() => { running = false; });
    }, this.config.syncIntervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async handle(request: IncomingMessage, response: ServerResponse, relativeUrl?: string): Promise<void> {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(json(value));
    };
    try {
      const url = new URL(relativeUrl ?? request.url ?? '/', 'http://localhost');
      const staticResponse = await getStaticResponse(url.pathname, request.method ?? 'GET');
      if (staticResponse) {
        response.writeHead(staticResponse.status, staticResponse.headers);
        response.end(staticResponse.body);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        send(this.workerError ? 503 : 200, { status: this.workerError ? 'degraded' : 'ok', mode: 'trusted-operator' }); return;
      }
      if (request.method === 'GET' && url.pathname === '/config') { send(200, this.publicConfig()); return; }
      if (request.method === 'GET' && url.pathname === '/publication') {
        // Only public commitments and an offchain operator authorization leave
        // this endpoint. The user's wallet constructs and pays for the call.
        const preparation = await this.preparePublication();
        send(200, preparation); return;
      }
      if (request.method === 'GET' && url.pathname === '/nonce') {
        const account = getAddress(url.searchParams.get('account') ?? '');
        send(200, { account, nonce: this.engine.getActionNonce(account) }); return;
      }
      const disclosureBatch = /^\/disclosure\/batches\/(0|[1-9][0-9]*)$/.exec(url.pathname);
      if (request.method === 'GET' && disclosureBatch) {
        const batchId = uint(disclosureBatch[1], 'batchId');
        if (batchId === 0n || !this.engine.getBatch(batchId)) throw new HttpError(404, 'Batch not found');
        // Public data only. Never include account receipts or state preimages.
        const publication = await this.chain.getDisclosureBatch(batchId);
        if (!publication) throw new HttpError(404, 'Batch not found');
        send(200, { ...publication, tokens: this.publicConfig().tokens, ...(this.config.proofMode === 'zk' ? { proofMode: 'zk' } : {}) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/admission') {
        if (!this.admission) throw new HttpError(404, 'Допуск через заявку не включён');
        send(200, this.admission.publicInfo()); return;
      }
      const isAdmission = request.method === 'POST' && url.pathname === '/admission/apply';
      if (!isAdmission && (request.method !== 'POST' || url.pathname !== '/actions')) throw new HttpError(404, 'Not found');
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'Use application/json');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 32_768) throw new HttpError(413, 'Request body exceeds 32 KiB');
        chunks.push(buffer);
      }
      if (isAdmission) {
        if (!this.admission) throw new HttpError(404, 'Допуск через заявку не включён');
        const application = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        try {
          send(200, { result: await this.admission.apply(application) });
        } catch (error) {
          if (error instanceof AdmissionError) throw new HttpError(error.status, error.message);
          throw error;
        }
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ActionRequest;
      send(200, { result: await this.execute(body) });
    } catch (error) {
      if (!response.headersSent) {
        // RPC errors may contain endpoint credentials. Only application-level Error messages are exposed.
        const rpcError = error && typeof error === 'object' && ('code' in error || 'info' in error || 'request' in error);
        send(error instanceof HttpError ? error.status : rpcError ? 503 : 400, { error: rpcError ? 'Blockchain operation failed; retry after synchronization' : error instanceof Error ? error.message : 'Invalid request' });
      }
    }
  }
}
