import { Interface, Transaction, getAddress, keccak256, toUtf8Bytes, type TransactionRequest } from 'ethers';
import { operationHash, ZK_OPERATION_TYPES, zkOperationDomain } from './auth.ts';
import type { ActionRequest } from './api.ts';
import { tokenMetadata } from './config.ts';
import type { ArbitrageController, ArbitrageDependencies, ArbitrageSettings, ArbitrageStatus, MarketRuntime, MarketSettings } from './market-types.ts';
import { findCorrection, targetPrice } from './price-math.ts';
import { ZK_VAULT_ABI } from './zk/chain.ts';
import type { ZkSignedPublication } from './zk/types.ts';
import { randomField } from '../zk/crypto.js';

const STATE_KEY = 'arb:state:v1';
const TRANSACTION_KEY = 'arb:publication:v1';
const BLOCKED_PUBLICATION_KEY = 'arb:publication:blocked:v1';
const abi = new Interface(ZK_VAULT_ABI);
type Stage = ArbitrageStatus['status'];
interface Step {
  id: string; amountIn: string; amountOut: string; request?: ActionRequest;
  beforeRoot?: string; tradeId?: string; afterRoot?: string;
}
interface Plan {
  id: string; revision: string; expectedRoot: string; direction: 'RUBA' | 'USDT'; next: number; steps: Step[];
}
interface DurableState {
  version: 1; marketId: string; vault: string; bot: string;
  observedRoot: string; revision: string; nextRunAt: number | null; plan?: Plan;
}
interface StepCommit { commitment: string; tradeId: string; afterRoot: string }
interface PublicationIntent {
  version: 1; marketId: string; vault: string; sender: string; chainId: string;
  stateVersion: string; previousRoot: string; newRoot: string;
  nonce: number; hash: string; raw: string; preparedAt: number;
}
class StalePlan extends Error {}

/** External-reference market maker. It signs only its own swaps and serializes all gas transactions. */
export class ArbitrageWorker implements ArbitrageController {
  private readonly dependencies: ArbitrageDependencies;
  private readonly statuses = new Map<string, ArbitrageStatus>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopping = false;
  private readonly botAddress: Promise<string>;
  private readonly transactionAddress: Promise<string>;

  constructor(dependencies: ArbitrageDependencies) {
    this.dependencies = dependencies;
    const ids = new Set<string>();
    for (const market of dependencies.markets) {
      if (ids.has(market.id) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(market.id)) throw new Error('Duplicate or invalid arbitrage market');
      ids.add(market.id); this.statuses.set(market.id, { status: 'idle', nextRunAt: null });
    }
    this.botAddress = dependencies.botSigner.getAddress().then(getAddress);
    this.transactionAddress = dependencies.transactionSigner.getAddress().then(getAddress);
  }

  getStatus(marketId: string): ArbitrageStatus {
    if (!this.statuses.has(marketId)) throw new Error('Unknown market');
    if (!this.dependencies.settings().arbitrage[marketId]?.enabled) return { status: 'disabled', nextRunAt: null };
    return { ...this.statuses.get(marketId)! };
  }
  private status(market: MarketRuntime, status: Stage, message?: string, nextRunAt: number | null = null) {
    this.statuses.set(market.id, { status, nextRunAt, ...(message ? { message } : {}) });
  }
  private settings(market: MarketRuntime): { snapshot: MarketSettings; options: ArbitrageSettings } {
    const snapshot = this.dependencies.settings(); const options = snapshot.arbitrage[market.id];
    if (!options || typeof options.enabled !== 'boolean' || !Number.isInteger(options.delaySeconds) || options.delaySeconds < 5 || options.delaySeconds > 3600
      || !Number.isInteger(options.maxTradeBps) || options.maxTradeBps < 1 || options.maxTradeBps > 10_000
      || !Number.isInteger(options.minDeviationBps) || options.minDeviationBps < 0 || options.minDeviationBps > 10_000) throw new Error('Invalid arbitrage settings');
    return { snapshot, options };
  }
  private load(market: MarketRuntime, bot: string, now: number, root: string): DurableState {
    const encoded = market.engine.getMetadata(STATE_KEY);
    if (!encoded) return { version: 1, marketId: market.id, vault: market.config.vaultAddress, bot,
      observedRoot: root, revision: this.dependencies.settings().revision.toString(),
      nextRunAt: now + this.settings(market).options.delaySeconds * 1000 };
    const value = JSON.parse(encoded) as DurableState;
    if (value.version !== 1 || value.marketId !== market.id || getAddress(value.vault) !== getAddress(market.config.vaultAddress)
      || getAddress(value.bot) !== bot || typeof value.observedRoot !== 'string' || typeof value.revision !== 'string'
      || (value.nextRunAt !== null && !Number.isSafeInteger(value.nextRunAt))) throw new Error('Arbitrage journal differs from this market');
    return value;
  }
  private save(market: MarketRuntime, state: DurableState) { market.engine.setMetadata(STATE_KEY, JSON.stringify(state)); }
  private currentRoot(market: MarketRuntime, bot: string) { return BigInt(market.engine.getZkAccount(bot).stateRoot).toString(); }
  private marker(plan: Plan, step: Step) { return `arb:${plan.id}:${step.id}`; }

  runOnce(nowMs = (this.dependencies.now ?? Date.now)()): Promise<void> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) return Promise.reject(new Error('Invalid worker clock'));
    if (this.running) return this.running;
    if (this.stopping) return Promise.resolve();
    this.running = Promise.all(this.dependencies.markets.map(async (market) => {
      try { await this.runMarket(market, nowMs); }
      catch {
        // RPC/provider exceptions may contain credentials or private request data.
        this.statuses.set(market.id, { status: 'error', nextRunAt: null, error: 'Market maker paused; synchronize the market and retry.' });
      }
    })).then(() => undefined).finally(() => { this.running = undefined; });
    return this.running;
  }
  start(intervalMs = 1000): () => void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) throw new Error('Invalid arbitrage polling interval');
    if (this.timer) return () => this.stop();
    this.stopping = false;
    this.timer = setInterval(() => { void this.runOnce(); }, intervalMs); this.timer.unref();
    void this.runOnce();
    return () => this.stop();
  }
  stop(): void { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async drain(): Promise<void> { await this.running; }

  private async runMarket(market: MarketRuntime, now: number): Promise<void> {
    // Ordinary API workers own synchronization while this market maker is disabled.
    if (!this.settings(market).options.enabled || this.stopping) { this.status(market, 'disabled'); return; }
    const bot = await this.botAddress;
    await market.api.sync();
    const { snapshot, options } = this.settings(market);
    const account = market.engine.getZkAccount(bot);
    if (!account.registered) {
      this.status(market, options.enabled ? 'waiting' : 'disabled', options.enabled ? 'Register and fund this bot in the selected Vault.' : undefined); return;
    }
    let root = BigInt(account.stateRoot).toString();
    let state = this.load(market, bot, now, root);
    this.recoverCommittedSteps(market, state, bot);
    state = this.load(market, bot, now, root);
    if (state.observedRoot !== root || state.revision !== snapshot.revision.toString()) {
      state.observedRoot = root; state.revision = snapshot.revision.toString(); state.plan = undefined;
      state.nextRunAt = now + options.delaySeconds * 1000;
    }
    this.save(market, state);
    if (!options.enabled || this.stopping) { this.status(market, 'disabled'); return; }

    // Already committed transitions may be published while waiting for the next correction.
    if (await this.publishReady(market, now)) return;
    if (state.nextRunAt !== null && now < state.nextRunAt) { this.status(market, 'scheduled', 'Waiting after market activity or reference change.', state.nextRunAt); return; }
    if (!state.plan) {
      const tokens = tokenMetadata(market.config);
      const base = snapshot.prices[tokens.RUBA.symbol as keyof typeof snapshot.prices];
      const quote = snapshot.prices[tokens.USDT.symbol as keyof typeof snapshot.prices];
      if (!base || !quote) throw new Error('Missing manual reference');
      const pool = market.engine.snapshot(); const balances = market.engine.accountSnapshot(bot).balances;
      const remaining = 4 - market.engine.getBatchProgress().collected;
      const correction = findCorrection({ reserve0: pool.reserves.RUBA, reserve1: pool.reserves.USDT,
        decimals0: tokens.RUBA.decimals, decimals1: tokens.USDT.decimals, target: targetPrice(base, quote),
        balance0: balances.RUBA, balance1: balances.USDT, maxTradeBps: options.maxTradeBps,
        minDeviationBps: options.minDeviationBps, swaps: remaining });
      if (!correction) { this.status(market, 'waiting', 'No sufficient correcting volume or available bot balance; no filler swaps are sent.'); return; }
      const id = keccak256(toUtf8Bytes(`${market.id}:${market.config.vaultAddress}:${root}:${snapshot.revision}:${pool.nextTradeId}`));
      state.plan = { id, revision: snapshot.revision.toString(), expectedRoot: root, direction: correction.direction, next: 0,
        steps: correction.swaps.map((swap, index) => ({ id: String(index), amountIn: swap.amountIn.toString(), amountOut: swap.amountOut.toString() })) };
      state.nextRunAt = null; this.save(market, state);
    }
    while (state.plan && state.plan.next < state.plan.steps.length && !this.stopping) {
      if (!this.settings(market).options.enabled) { this.status(market, 'disabled'); return; }
      this.status(market, 'executing', 'Applying an authorized correcting swap.');
      try { await this.executeStep(market, state, bot, now); }
      catch (error) {
        // An action may commit before response processing fails. The SQL marker wins.
        state = this.load(market, bot, now, this.currentRoot(market, bot));
        const plan = state.plan;
        const step = plan?.steps[plan.next];
        if (step && market.engine.getMetadata(this.marker(plan!, step))) { this.recoverCommittedSteps(market, state, bot); continue; }
        if (error instanceof StalePlan || (plan && (plan.expectedRoot !== this.currentRoot(market, bot)
          || plan.revision !== this.settings(market).snapshot.revision.toString()))) {
          state.observedRoot = this.currentRoot(market, bot); state.revision = this.settings(market).snapshot.revision.toString();
          state.plan = undefined; state.nextRunAt = now + this.settings(market).options.delaySeconds * 1000; this.save(market, state);
          this.status(market, 'scheduled', 'Market changed; the unfinished correction will be recalculated.', state.nextRunAt); return;
        }
        throw error;
      }
      state = this.load(market, bot, now, this.currentRoot(market, bot));
    }
    if (state.plan && state.plan.next === state.plan.steps.length) { state.plan = undefined; state.nextRunAt = null; this.save(market, state); }
    if (!this.settings(market).options.enabled || this.stopping) { this.status(market, 'disabled'); return; }
    if (!await this.publishReady(market, now)) this.status(market, 'idle', 'Correction applied; waiting for new market activity.');
  }

  private recoverCommittedSteps(market: MarketRuntime, state: DurableState, bot: string) {
    const plan = state.plan; if (!plan) return;
    let changed = false;
    for (let index = plan.next; index < plan.steps.length; ++index) {
      const step = plan.steps[index]; if (!step.request?.zk) break;
      const key = this.marker(plan, step); let marker = market.engine.getMetadata(key);
      const commitment = BigInt(step.request.zk.commitment);
      const operation = market.engine.journal.operations().find((op) => op.kind === 3 && op.owner === BigInt(bot) && BigInt(op.metadata.commitment) === commitment);
      if (!marker) {
        if (!operation?.receipt) break;
        const recovered: StepCommit = { commitment: commitment.toString(), tradeId: operation.receipt.tradeId.toString(), afterRoot: operation.afterState.root.toString() };
        marker = JSON.stringify(recovered); market.engine.setMetadata(key, marker);
      }
      const value = JSON.parse(marker) as StepCommit;
      if (value.commitment !== step.request.zk.commitment || operation?.receipt?.tradeId.toString() !== value.tradeId
        || operation.afterState.root.toString() !== value.afterRoot || !market.engine.getReceipt(BigInt(value.tradeId))) throw new Error('Arbitrage recovery commitment differs');
      step.tradeId = value.tradeId; step.afterRoot = value.afterRoot; plan.expectedRoot = value.afterRoot; plan.next = index + 1;
      state.observedRoot = value.afterRoot; changed = true;
    }
    if (changed) this.save(market, state);
  }

  private async executeStep(market: MarketRuntime, state: DurableState, bot: string, now: number) {
    const plan = state.plan!; const step = plan.steps[plan.next];
    const latest = this.settings(market);
    if (!latest.options.enabled || this.stopping || latest.snapshot.revision.toString() !== plan.revision
      || this.currentRoot(market, bot) !== plan.expectedRoot) throw new StalePlan();
    if (market.engine.getMetadata(this.marker(plan, step))) { this.recoverCommittedSteps(market, state, bot); return; }
    const operation = { kind: 'swap' as const, tokenIn: plan.direction, amountIn: step.amountIn, minOut: step.amountOut };
    const timestamp = await market.chain.latestTimestamp();
    if (!step.request) {
      const salt = randomField();
      const prepared = market.engine.prepareAuthorization(bot, operation, salt);
      const signature = await this.dependencies.botSigner.signTypedData(zkOperationDomain(market.config.chainId, market.config.vaultAddress),
        ZK_OPERATION_TYPES, { commitment: prepared.commitment });
      step.request = {
        intent: { account: bot, nonce: market.engine.getActionNonce(bot).toString(), deadline: (timestamp + 600n).toString(), actionHash: operationHash(operation) },
        operation, signature, zk: { commitment: prepared.commitment.toString(), nonce: prepared.nonce.toString(), salt: salt.toString() },
      };
      step.beforeRoot = plan.expectedRoot;
    } else {
      // HTTP replay metadata is independent of the already signed spend commitment.
      step.request.intent.nonce = market.engine.getActionNonce(bot).toString();
      step.request.intent.deadline = (timestamp + 600n).toString();
    }
    this.save(market, state); // Signed intent is durable before the economic call begins.
    const index = plan.next;
    await market.api.execute(step.request, {
      beforeApply: () => {
        const current = this.settings(market);
        if (!current.options.enabled || this.stopping || current.snapshot.revision.toString() !== plan.revision
          || this.currentRoot(market, bot) !== step.beforeRoot || market.engine.getMetadata(this.marker(plan, step))) throw new StalePlan();
      },
      onCommit: (result) => {
        if (!result || typeof result !== 'object' || !('tradeId' in result)) throw new Error('Missing committed bot trade');
        const tradeId = BigInt((result as { tradeId: bigint }).tradeId).toString();
        const afterRoot = this.currentRoot(market, bot);
        const marker: StepCommit = { commitment: step.request!.zk!.commitment, tradeId, afterRoot };
        market.engine.setMetadata(this.marker(plan, step), JSON.stringify(marker));
        step.tradeId = tradeId; step.afterRoot = afterRoot; plan.next = index + 1; plan.expectedRoot = afterRoot;
        state.observedRoot = afterRoot; state.nextRunAt = null; this.save(market, state);
      },
    });
  }

  private async publishReady(market: MarketRuntime, now: number): Promise<boolean> {
    if (!this.settings(market).options.enabled || this.stopping) return false;
    const handled = await this.dependencies.transactionQueue.run(async () => this.recoverTransactions(now));
    if (handled) { this.status(market, 'publishing', 'Waiting for a previously prepared publication.'); return true; }
    const preparation = await market.api.preparePublication();
    if (preparation.status === 'waiting') { this.status(market, 'publishing', 'Waiting for publication confirmation.'); return true; }
    if (preparation.status !== 'ready' || preparation.request?.kind !== 'zk') return false;
    const blocked = market.engine.getMetadata(BLOCKED_PUBLICATION_KEY);
    if (blocked) {
      const value = JSON.parse(blocked) as { stateVersion: string; revision: string; newRoot: string };
      if (value.stateVersion === BigInt(preparation.request.publicSignals[1]).toString()
        && value.newRoot === BigInt(preparation.request.publicSignals[4]).toString()
        && value.revision === this.dependencies.settings().revision.toString()) {
        this.status(market, 'waiting', 'Publication reverted; resolve the cause and update market settings before retrying.'); return true;
      }
    }
    this.status(market, 'publishing', 'Publishing an existing proof-checked transition.');
    await this.dependencies.transactionQueue.run(async () => {
      if (!this.settings(market).options.enabled || this.stopping) return;
      if (await this.recoverTransactions(now)) return;
      const request = preparation.request as ZkSignedPublication;
      const blockedNow = market.engine.getMetadata(BLOCKED_PUBLICATION_KEY);
      if (blockedNow) {
        const blocked = JSON.parse(blockedNow) as { stateVersion: string; revision: string; newRoot: string };
        if (blocked.stateVersion === BigInt(request.publicSignals[1]).toString()
          && blocked.newRoot === BigInt(request.publicSignals[4]).toString()
          && blocked.revision === this.dependencies.settings().revision.toString()) {
          this.status(market, 'waiting', 'Publication reverted; resolve the cause and update market settings before retrying.'); return;
        }
      }
      if (request.authorizationMode !== 'proof-only' || request.chainId !== market.config.chainId
        || getAddress(request.vault) !== getAddress(market.config.vaultAddress)) throw new Error('Invalid publication scope');
      const version = BigInt(request.publicSignals[1]);
      const currentVersion = BigInt(await market.chain.zkVault.stateVersion());
      if (currentVersion >= version) { await market.chain.publishPendingBatches(); return; }
      if (currentVersion + 1n !== version || BigInt(await market.chain.vault.stateRoot()) !== BigInt(request.publicSignals[3])) return;
      const signer = this.dependencies.transactionSigner; const provider = signer.provider;
      if (!provider || (await provider.getNetwork()).chainId !== market.config.chainId) throw new Error('Transaction signer is on another network');
      const sender = await this.transactionAddress;
      const nonce = await provider.getTransactionCount(sender, 'pending');
      // Positional tuples also match generated Solidity ABIs naming referenceId.
      const operations = request.operations.map((op) => [op.kind, op.slot, op.owner, op.commitment, op.eventId, op.token, op.amount, op.reference, op.signature]);
      const data = abi.encodeFunctionData('publishProvenTransition', [request.publicSignals, operations, request.accountDA, request.poolDA, request.proof]);
      const transaction: TransactionRequest = await signer.populateTransaction({ to: request.vault, data, value: 0n, chainId: request.chainId, nonce });
      const raw = await signer.signTransaction(transaction);
      const decoded = Transaction.from(raw); const hash = keccak256(raw);
      if (decoded.from !== sender || decoded.chainId !== market.config.chainId || decoded.nonce !== nonce
        || decoded.to !== getAddress(request.vault) || decoded.data !== data || decoded.value !== 0n) throw new Error('Signed publication differs from prepared intent');
      if (!this.settings(market).options.enabled || this.stopping) return;
      const intent: PublicationIntent = { version: 1, marketId: market.id, vault: request.vault, sender,
        chainId: request.chainId.toString(), stateVersion: version.toString(), previousRoot: request.publicSignals[3].toString(),
        newRoot: request.publicSignals[4].toString(), nonce, hash, raw, preparedAt: now };
      market.engine.setMetadata(TRANSACTION_KEY, JSON.stringify(intent));
      await provider.broadcastTransaction(raw); // An unknown response retains the exact same signed transaction.
    });
    return true;
  }

  /** A single unresolved signed intent blocks new nonce allocation across every Vault. */
  private async recoverTransactions(_now: number): Promise<boolean> {
    const sender = await this.transactionAddress;
    for (const market of this.dependencies.markets) {
      const encoded = market.engine.getMetadata(TRANSACTION_KEY); if (!encoded) continue;
      const intent = JSON.parse(encoded) as PublicationIntent;
      const provider = this.dependencies.transactionSigner.provider;
      if (!provider || intent.version !== 1 || intent.marketId !== market.id || getAddress(intent.vault) !== getAddress(market.config.vaultAddress)
        || intent.sender !== sender || intent.chainId !== market.config.chainId.toString() || keccak256(intent.raw) !== intent.hash) throw new Error('Publication recovery journal differs');
      const decoded = Transaction.from(intent.raw);
      if (decoded.from !== sender || decoded.nonce !== intent.nonce || decoded.chainId !== market.config.chainId
        || decoded.to !== getAddress(intent.vault) || decoded.value !== 0n) throw new Error('Publication recovery signature differs');
      const call = abi.parseTransaction({ data: decoded.data });
      if (call?.name !== 'publishProvenTransition' || BigInt(call.args.publicSignals[1]).toString() !== intent.stateVersion
        || BigInt(call.args.publicSignals[3]).toString() !== intent.previousRoot
        || BigInt(call.args.publicSignals[4]).toString() !== intent.newRoot) throw new Error('Publication recovery calldata differs');
      const receipt = await provider.getTransactionReceipt(intent.hash);
      if (receipt) {
        if ((await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) throw new Error('Publication receipt changed chain');
        await market.chain.publishPendingBatches();
        if (market.engine.getAcceptedCheckpoint().stateVersion >= BigInt(intent.stateVersion)) {
          market.engine.setMetadata(`${TRANSACTION_KEY}:completed:${intent.hash}`, encoded);
          market.engine.setMetadata(TRANSACTION_KEY, ''); continue;
        }
        if (receipt.status !== 1) {
          market.engine.setMetadata(BLOCKED_PUBLICATION_KEY, JSON.stringify({ stateVersion: intent.stateVersion,
            newRoot: intent.newRoot, revision: this.dependencies.settings().revision.toString() }));
          market.engine.setMetadata(`${TRANSACTION_KEY}:failed:${intent.hash}`, encoded);
          market.engine.setMetadata(TRANSACTION_KEY, '');
          throw new Error('Publication reverted before acceptance');
        }
        return true;
      }
      const known = await provider.getTransaction(intent.hash);
      if (known) return true;
      if (await provider.getTransactionCount(sender, 'latest') > intent.nonce) throw new Error('An unrelated transaction consumed the prepared nonce');
      if (await provider.getTransactionCount(sender, 'pending') > intent.nonce) throw new Error('An unknown pending transaction occupies the prepared nonce');
      if (!this.settings(market).options.enabled || this.stopping) return true;
      await provider.broadcastTransaction(intent.raw);
      return true;
    }
    return false;
  }
}
