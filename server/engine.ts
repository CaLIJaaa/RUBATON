import { DatabaseSync } from "node:sqlite";
import { getAddress } from "ethers";
import { buildMerkleBatch, canonicalJson, commitState, hashReceipt, randomSalt, ZERO_ROOT } from "./merkle.ts";
import type { AccountSnapshot, EngineConfig, ReceiptBatch, Token, TokenAmounts, TradeReceipt, WithdrawalRecord } from "./types.ts";

export const MINIMUM_LIQUIDITY = 1000n;
export const BATCH_SIZE = 4;
export const MAX_BATCH_SIZE = 4;
const TOKENS: Token[] = ["RUBA", "USDT"];
const zeroAmounts = (): TokenAmounts => ({ RUBA: 0n, USDT: 0n });

export interface State {
  version: number;
  domain: { chainId: bigint; vault: string; ruba: string; usdt: string };
  custody: TokenAmounts;
  reserves: TokenAmounts;
  balances: Record<string, TokenAmounts>;
  shares: Record<string, bigint>;
  totalSupply: bigint;
  lockedLiquidity: bigint;
  actionNonces: Record<string, bigint>;
  withdrawalNonces: Record<string, bigint>;
  withdrawals: Record<string, WithdrawalRecord>;
  deposits: Record<string, { account: string; token: Token; amount: bigint }>;
  settlementEvents: Record<string, string>;
  nextTradeId: bigint;
  receipts: TradeReceipt[];
  batches: ReceiptBatch[];
}

/** Tagged JSON is private persistence encoding; canonical commitment JSON uses decimal strings. */
function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? { $bigint: item.toString() } : item);
}
function decode<T>(value: string): T {
  return JSON.parse(value, (_key, item) => item && typeof item === "object" && Object.keys(item).length === 1 && typeof item.$bigint === "string" ? BigInt(item.$bigint) : item) as T;
}
function copy<T>(value: T): T { return value === undefined ? value : decode<T>(encode(value)); }
function positive(value: bigint, name: string): void {
  if (typeof value !== "bigint" || value <= 0n) throw new Error(`${name} must be a positive bigint`);
}
function nonnegative(value: bigint, name: string): void {
  if (typeof value !== "bigint" || value < 0n) throw new Error(`${name} must be a nonnegative bigint`);
}
export function sqrt(value: bigint): bigint {
  nonnegative(value, "sqrt input");
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + value / x) / 2n; }
  return x;
}
const minimum = (a: bigint, b: bigint): bigint => a < b ? a : b;

export class RubaEngine {
  readonly db: DatabaseSync;
  readonly config: EngineConfig;
  protected activeState: State | undefined;

  constructor(config: EngineConfig) {
    if (config.chainId <= 0n) throw new Error("chainId must be positive");
    this.config = { ...config, vaultAddress: getAddress(config.vaultAddress), rubaAddress: getAddress(config.rubaAddress), usdtAddress: getAddress(config.usdtAddress) };
    if (this.config.rubaAddress === this.config.usdtAddress) throw new Error("Tokens must differ");
    this.db = new DatabaseSync(config.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS engine_state (id INTEGER PRIMARY KEY CHECK (id=1), state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS engine_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const domain = { chainId: config.chainId, vault: this.config.vaultAddress, ruba: this.config.rubaAddress, usdt: this.config.usdtAddress };
    if (!this.db.prepare("SELECT id FROM engine_state WHERE id=1").get()) {
      const initial: State = {
        version: 1, domain, custody: zeroAmounts(), reserves: zeroAmounts(), balances: {}, shares: {}, totalSupply: 0n, lockedLiquidity: 0n,
        actionNonces: {}, withdrawalNonces: {}, withdrawals: {}, deposits: {}, settlementEvents: {}, nextTradeId: 1n, receipts: [], batches: [],
      };
      this.db.prepare("INSERT INTO engine_state (id,state) VALUES (1,?)").run(encode(initial));
    }
    const state = this.read();
    if (state.version !== 1 || canonicalJson(state.domain) !== canonicalJson(domain)) throw new Error("Database belongs to another market, chain, or schema version");
    this.assertConservation(state);
  }

  close(): void { this.db.close(); }
  getMetadata(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM engine_metadata WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }
  setMetadata(key: string, value: string): void {
    this.db.prepare("INSERT INTO engine_metadata (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  tokenAddress(token: Token): string {
    this.validToken(token);
    return token === "RUBA" ? this.config.rubaAddress : this.config.usdtAddress;
  }
  tokenSymbol(address: string): Token {
    const checked = getAddress(address);
    if (checked === this.config.rubaAddress) return "RUBA";
    if (checked === this.config.usdtAddress) return "USDT";
    throw new Error("Unsupported token");
  }
  private validToken(token: Token): void {
    if (!TOKENS.includes(token)) throw new Error("Unsupported token");
  }
  protected read(): State {
    if (this.activeState) return this.activeState;
    const row = this.db.prepare("SELECT state FROM engine_state WHERE id=1").get() as { state: string };
    return decode<State>(row.state);
  }
  protected mutate<T>(fn: (state: State) => T): T {
    if (this.activeState) {
      const before = copy(this.activeState);
      try { return fn(this.activeState); }
      catch (error) { Object.assign(this.activeState, before); throw error; }
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.activeState = this.read();
      const result = fn(this.activeState);
      if (result && typeof (result as any).then === "function") throw new Error("Ledger transactions must be synchronous");
      this.assertConservation(this.activeState);
      this.db.prepare("UPDATE engine_state SET state=? WHERE id=1").run(encode(this.activeState));
      this.db.exec("COMMIT");
      return copy(result);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally { this.activeState = undefined; }
  }
  private account(state: State, address: string): { address: string; balances: TokenAmounts } {
    const account = getAddress(address);
    state.balances[account] ??= zeroAmounts();
    return { address: account, balances: state.balances[account] };
  }
  private debit(balances: TokenAmounts, token: Token, amount: bigint): void {
    if (balances[token] < amount) throw new Error(`Insufficient ${token} balance`);
    balances[token] -= amount;
  }
  getActionNonce(account: string): bigint { return this.read().actionNonces[getAddress(account)] ?? 0n; }
  getNonce(account: string): bigint { return this.getActionNonce(account); }
  executeAction<T>(account: string, nonce: bigint, callback: () => T): T {
    const checked = getAddress(account);
    nonnegative(nonce, "nonce");
    return this.mutate((state) => {
      if (nonce !== (state.actionNonces[checked] ?? 0n)) throw new Error("Invalid action nonce");
      state.actionNonces[checked] = nonce + 1n;
      const result = callback();
      if (result && typeof (result as any).then === "function") throw new Error("Ledger transactions must be synchronous");
      return result;
    });
  }
  runAuthenticated<T>(account: string, nonce: bigint, callback: () => T): T { return this.executeAction(account, nonce, callback); }

  /** Only the chain event adapter may call this; HTTP must never accept client-supplied deposits. */
  recordDeposit(depositId: bigint, account: string, token: Token, amount: bigint): boolean {
    positive(depositId, "depositId"); positive(amount, "amount"); this.validToken(token);
    const checked = getAddress(account);
    return this.mutate((state) => {
      const id = depositId.toString();
      const deposit = { account: checked, token, amount };
      if (state.deposits[id]) {
        if (canonicalJson(state.deposits[id]) !== canonicalJson(deposit)) throw new Error("Conflicting deposit replay");
        return false;
      }
      state.deposits[id] = deposit;
      this.account(state, checked).balances[token] += amount;
      state.custody[token] += amount;
      return true;
    });
  }

  quote(tokenIn: Token, amountIn: bigint): bigint {
    positive(amountIn, "amountIn"); this.validToken(tokenIn);
    return this.quoteState(this.read(), tokenIn, amountIn);
  }
  private quoteState(state: State, tokenIn: Token, amountIn: bigint): bigint {
    const tokenOut = tokenIn === "RUBA" ? "USDT" : "RUBA";
    const reserveIn = state.reserves[tokenIn];
    const reserveOut = state.reserves[tokenOut];
    if (reserveIn <= 0n || reserveOut <= 0n) throw new Error("Insufficient liquidity");
    const adjusted = amountIn * 997n;
    return adjusted * reserveOut / (reserveIn * 1000n + adjusted);
  }
  swap(account: string, tokenIn: Token, amountIn: bigint, minOut: bigint): TradeReceipt {
    positive(amountIn, "amountIn"); nonnegative(minOut, "minOut"); this.validToken(tokenIn);
    return this.mutate((state) => {
      const pendingReceipts = this.unbatchedReceipts(state);
      const actor = this.account(state, account);
      const tokenOut: Token = tokenIn === "RUBA" ? "USDT" : "RUBA";
      const before = { ...state.reserves };
      const amountOut = this.quoteState(state, tokenIn, amountIn);
      if (amountOut === 0n) throw new Error("Swap output rounds to zero");
      if (amountOut < minOut) throw new Error("Slippage limit exceeded");
      this.debit(actor.balances, tokenIn, amountIn);
      actor.balances[tokenOut] += amountOut;
      state.reserves[tokenIn] += amountIn;
      state.reserves[tokenOut] -= amountOut;
      const adjustedRuba = state.reserves.RUBA * 1000n - (tokenIn === "RUBA" ? amountIn * 3n : 0n);
      const adjustedUsdt = state.reserves.USDT * 1000n - (tokenIn === "USDT" ? amountIn * 3n : 0n);
      if (adjustedRuba * adjustedUsdt < before.RUBA * before.USDT * 1_000_000n) throw new Error("AMM invariant failed");
      const input: Omit<TradeReceipt, "leaf"> = {
        chainId: this.config.chainId, vault: this.config.vaultAddress, tradeId: state.nextTradeId++, account: actor.address,
        tokenIn: this.tokenAddress(tokenIn), tokenOut: this.tokenAddress(tokenOut), amountIn, amountOut,
        feeNumerator: amountIn * 3n, feeDenominator: 1000n,
        reserveRubaBefore: before.RUBA, reserveUsdtBefore: before.USDT,
        reserveRubaAfter: state.reserves.RUBA, reserveUsdtAfter: state.reserves.USDT, salt: randomSalt(),
      };
      const receipt: TradeReceipt = { ...input, leaf: hashReceipt(input) };
      state.receipts.push(receipt);
      if (pendingReceipts.length + 1 === BATCH_SIZE) this.enqueueBatch(state, [...pendingReceipts, receipt]);
      return receipt;
    });
  }

  addLiquidity(account: string, rubaDesired: bigint, usdtDesired: bigint, rubaMin = 0n, usdtMin = 0n): { rubaAmount: bigint; usdtAmount: bigint; shares: bigint } {
    positive(rubaDesired, "rubaDesired"); positive(usdtDesired, "usdtDesired"); nonnegative(rubaMin, "rubaMin"); nonnegative(usdtMin, "usdtMin");
    return this.mutate((state) => {
      const actor = this.account(state, account);
      let rubaAmount = rubaDesired;
      let usdtAmount = usdtDesired;
      let shares: bigint;
      if (state.totalSupply === 0n) {
        shares = sqrt(rubaAmount * usdtAmount) - MINIMUM_LIQUIDITY;
        if (shares <= 0n) throw new Error("Insufficient initial liquidity");
        state.lockedLiquidity = MINIMUM_LIQUIDITY;
        state.totalSupply = MINIMUM_LIQUIDITY;
      } else {
        const usdtOptimal = rubaDesired * state.reserves.USDT / state.reserves.RUBA;
        if (usdtOptimal <= usdtDesired) usdtAmount = usdtOptimal;
        else rubaAmount = usdtDesired * state.reserves.RUBA / state.reserves.USDT;
        shares = minimum(rubaAmount * state.totalSupply / state.reserves.RUBA, usdtAmount * state.totalSupply / state.reserves.USDT);
      }
      if (rubaAmount === 0n || usdtAmount === 0n || shares <= 0n) throw new Error("Liquidity rounds to zero");
      if (rubaAmount < rubaMin || usdtAmount < usdtMin) throw new Error("Liquidity slippage limit exceeded");
      this.debit(actor.balances, "RUBA", rubaAmount); this.debit(actor.balances, "USDT", usdtAmount);
      state.reserves.RUBA += rubaAmount; state.reserves.USDT += usdtAmount;
      state.shares[actor.address] = (state.shares[actor.address] ?? 0n) + shares;
      state.totalSupply += shares;
      return { rubaAmount, usdtAmount, shares };
    });
  }

  removeLiquidity(account: string, shares: bigint, rubaMin = 0n, usdtMin = 0n): { rubaAmount: bigint; usdtAmount: bigint } {
    positive(shares, "shares"); nonnegative(rubaMin, "rubaMin"); nonnegative(usdtMin, "usdtMin");
    return this.mutate((state) => {
      const actor = this.account(state, account);
      if ((state.shares[actor.address] ?? 0n) < shares) throw new Error("Insufficient LP shares");
      const rubaAmount = shares * state.reserves.RUBA / state.totalSupply;
      const usdtAmount = shares * state.reserves.USDT / state.totalSupply;
      if (rubaAmount === 0n || usdtAmount === 0n) throw new Error("Liquidity removal rounds to zero");
      if (rubaAmount < rubaMin || usdtAmount < usdtMin) throw new Error("Liquidity slippage limit exceeded");
      state.shares[actor.address] -= shares;
      state.totalSupply -= shares;
      state.reserves.RUBA -= rubaAmount; state.reserves.USDT -= usdtAmount;
      actor.balances.RUBA += rubaAmount; actor.balances.USDT += usdtAmount;
      return { rubaAmount, usdtAmount };
    });
  }

  reserveWithdrawal(account: string, token: Token, amount: bigint, deadline: bigint, signerEpoch: bigint): WithdrawalRecord {
    positive(amount, "amount"); positive(deadline, "deadline"); nonnegative(signerEpoch, "signerEpoch"); this.validToken(token);
    return this.mutate((state) => {
      const actor = this.account(state, account);
      this.debit(actor.balances, token, amount);
      const nonce = state.withdrawalNonces[actor.address] ?? 0n;
      state.withdrawalNonces[actor.address] = nonce + 1n;
      const withdrawal: WithdrawalRecord = { account: actor.address, token, tokenAddress: this.tokenAddress(token), amount, nonce, deadline, signerEpoch, status: "pending" };
      state.withdrawals[this.withdrawalKey(actor.address, nonce)] = withdrawal;
      return withdrawal;
    });
  }
  getWithdrawal(account: string, nonce: bigint): WithdrawalRecord | undefined {
    return copy(this.read().withdrawals[this.withdrawalKey(getAddress(account), nonce)]);
  }
  getPendingWithdrawal(account: string, nonce: bigint): WithdrawalRecord | undefined {
    const withdrawal = this.getWithdrawal(account, nonce);
    return withdrawal?.status === "pending" ? withdrawal : undefined;
  }
  settleWithdrawal(account: string, nonce: bigint, token: Token, amount: bigint, eventId: string): boolean {
    this.validToken(token); positive(amount, "amount"); nonnegative(nonce, "nonce");
    if (!eventId) throw new Error("Settlement requires a chain event identity");
    const checked = getAddress(account);
    return this.mutate((state) => {
      const key = this.withdrawalKey(checked, nonce);
      const withdrawal = state.withdrawals[key];
      if (!withdrawal || withdrawal.token !== token || withdrawal.amount !== amount) throw new Error("Unknown or mismatched withdrawal settlement");
      if (state.settlementEvents[eventId]) {
        if (state.settlementEvents[eventId] !== key || withdrawal.settlementEventId !== eventId) throw new Error("Conflicting settlement replay");
        return false;
      }
      if (withdrawal.status !== "pending") throw new Error("Withdrawal is no longer pending");
      withdrawal.status = "settled"; withdrawal.settlementEventId = eventId;
      state.settlementEvents[eventId] = key;
      state.custody[token] -= amount;
      return true;
    });
  }

  /** Adapter must obtain BOTH values at the SAME canonical finalized block. Never use wall-clock time. */
  expireWithdrawal(account: string, nonce: bigint, evidence: { finalizedTimestamp: bigint; nonceUsed: boolean }): void {
    nonnegative(nonce, "nonce"); nonnegative(evidence.finalizedTimestamp, "finalizedTimestamp");
    if (typeof evidence.nonceUsed !== "boolean") throw new Error("Missing chain nonce evidence");
    this.mutate((state) => {
      const checked = getAddress(account);
      const withdrawal = state.withdrawals[this.withdrawalKey(checked, nonce)];
      if (!withdrawal || withdrawal.status !== "pending") throw new Error("Withdrawal is not pending");
      if (evidence.finalizedTimestamp <= withdrawal.deadline || evidence.nonceUsed) throw new Error("Withdrawal expiry is not finalized or nonce has been used");
      withdrawal.status = "expired";
      this.account(state, checked).balances[withdrawal.token] += withdrawal.amount;
    });
  }
  private withdrawalKey(account: string, nonce: bigint): string { return `${account}:${nonce}`; }

  protected commitmentSnapshot(state: State): string {
    return canonicalJson({ version: state.version, domain: state.domain, custody: state.custody, reserves: state.reserves,
      balances: state.balances, shares: state.shares, totalSupply: state.totalSupply, lockedLiquidity: state.lockedLiquidity,
      actionNonces: state.actionNonces, withdrawalNonces: state.withdrawalNonces, withdrawals: state.withdrawals,
      deposits: state.deposits, settlementEvents: state.settlementEvents, nextTradeId: state.nextTradeId });
  }
  protected enqueueBatch(state: State, receipts: TradeReceipt[]): void {
    const previous = state.batches.at(-1);
    const firstTradeId = previous ? previous.firstTradeId + previous.tradeCount : 1n;
    if (receipts.length !== BATCH_SIZE
      || receipts.some((receipt, index) => receipt.tradeId !== firstTradeId + BigInt(index) || receipt.batchId !== undefined)) {
      throw new Error("Receipt batch must extend the journal without overlapping trades");
    }
    const tree = buildMerkleBatch(receipts.map((receipt) => receipt.leaf));
    const batchId = BigInt(state.batches.length + 1);
    const stateSalt = randomSalt();
    const stateSnapshot = this.commitmentSnapshot(state);
    const batch: ReceiptBatch = {
      batchId, previousStateRoot: state.batches.at(-1)?.newStateRoot ?? ZERO_ROOT,
      newStateRoot: commitState(this.config.chainId, this.config.vaultAddress, stateSnapshot, stateSalt), receiptsRoot: tree.root,
      firstTradeId: receipts[0].tradeId, tradeCount: BigInt(receipts.length), stateSalt, stateSnapshot, tradeIds: receipts.map((receipt) => receipt.tradeId),
    };
    receipts.forEach((receipt, index) => { receipt.batchId = batchId; receipt.proof = tree.proofs[index]; });
    state.batches.push(batch);
  }
  protected unbatchedReceipts(state: State): TradeReceipt[] {
    const previous = state.batches.at(-1);
    const firstTradeId = previous ? previous.firstTradeId + previous.tradeCount : 1n;
    const receipts = state.receipts.filter((receipt) => receipt.tradeId >= firstTradeId);
    if (state.receipts.some((receipt) => receipt.tradeId < firstTradeId && receipt.batchId === undefined)
      || receipts.some((receipt, index) => receipt.tradeId !== firstTradeId + BigInt(index) || receipt.batchId !== undefined)
      || firstTradeId + BigInt(receipts.length) !== state.nextTradeId) {
      throw new Error("Unbatched receipts differ from the sequential server journal");
    }
    if (receipts.length >= BATCH_SIZE) {
      throw new Error("Unbatched trades have no saved four-trade boundary snapshot; restore/reconcile the journal instead of recreating historical state commitments");
    }
    return receipts;
  }
  /** Compatibility name: validate the buffer without ever publishing a partial or reconstructed batch. */
  flushUnbatchedReceipts(): number {
    this.unbatchedReceipts(this.read());
    return 0;
  }
  getBatchProgress(): { collected: number; required: 4 } {
    return { collected: this.unbatchedReceipts(this.read()).length, required: BATCH_SIZE };
  }
  getReceipt(tradeId: bigint): TradeReceipt | undefined { return copy(this.read().receipts.find((receipt) => receipt.tradeId === tradeId)); }
  getBatch(batchId: bigint): ReceiptBatch | undefined { return copy(this.read().batches.find((batch) => batch.batchId === batchId)); }
  listPendingBatches(): ReceiptBatch[] { return copy(this.read().batches.filter((batch) => !batch.publishedTxHash)); }
  markBatchPublished(batchId: bigint, txHash: string): void {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("Invalid publication transaction hash");
    this.mutate((state) => {
      const batch = state.batches.find((candidate) => candidate.batchId === batchId);
      if (!batch) throw new Error("Unknown batch");
      if (batch.publishedTxHash && batch.publishedTxHash !== txHash) throw new Error("Batch already published with another transaction");
      batch.publishedTxHash = txHash;
    });
  }
  accountSnapshot(account: string): AccountSnapshot {
    const checked = getAddress(account); const state = this.read();
    return copy({ account: checked, balances: state.balances[checked] ?? zeroAmounts(), lpShares: state.shares[checked] ?? 0n,
      actionNonce: state.actionNonces[checked] ?? 0n, withdrawals: Object.values(state.withdrawals).filter((withdrawal) => withdrawal.account === checked) });
  }
  snapshot(): { custody: TokenAmounts; reserves: TokenAmounts; totalSupply: bigint; lockedLiquidity: bigint; available: TokenAmounts; pending: TokenAmounts; nextTradeId: bigint } {
    const state = this.read(); const totals = this.totals(state);
    return copy({ custody: state.custody, reserves: state.reserves, totalSupply: state.totalSupply, lockedLiquidity: state.lockedLiquidity,
      available: totals.available, pending: totals.pending, nextTradeId: state.nextTradeId });
  }
  private totals(state: State): { available: TokenAmounts; pending: TokenAmounts } {
    const available = zeroAmounts(); const pending = zeroAmounts();
    for (const balances of Object.values(state.balances)) for (const token of TOKENS) available[token] += balances[token];
    for (const withdrawal of Object.values(state.withdrawals)) if (withdrawal.status === "pending") pending[withdrawal.token] += withdrawal.amount;
    return { available, pending };
  }
  private assertConservation(state: State): void {
    const totals = this.totals(state);
    for (const token of TOKENS) {
      if (state.custody[token] < 0n || state.reserves[token] < 0n || totals.available[token] < 0n || totals.pending[token] < 0n) throw new Error("Negative accounting balance");
      if (state.custody[token] !== state.reserves[token] + totals.available[token] + totals.pending[token]) throw new Error(`Custody conservation failed for ${token}`);
    }
    for (const balances of Object.values(state.balances)) for (const token of TOKENS) if (balances[token] < 0n) throw new Error("Negative user balance");
    const shareSum = Object.values(state.shares).reduce((sum, shares) => { if (shares < 0n) throw new Error("Negative LP shares"); return sum + shares; }, state.lockedLiquidity);
    if (state.totalSupply !== shareSum || state.lockedLiquidity < 0n) throw new Error("LP share conservation failed");
  }
}
