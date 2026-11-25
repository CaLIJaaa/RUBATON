import { AbiCoder, Contract, Interface, ZeroAddress, getAddress, keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import { canonicalJson, formatAmount } from './model.js';
import { inspectDisclosure, inspectDisclosureText, parseDisclosure } from './disclosure-model.js';

const ACTION_TYPES = { Action: [
  { name: 'account', type: 'address' }, { name: 'actionHash', type: 'bytes32' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] };
const PRIVATE_OPERATION_TYPES = { PrivateOperation: [{ name: 'commitment', type: 'uint256' }] };
const TIMED_OPERATION_TYPES = { TimedPrivateOperation: [{ name: 'commitment', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
const TIMED_OPERATION_KINDS = new Set(['swap', 'addLiquidity']);
const OPERATION_DEADLINE_SECONDS = 3600n;
function operationSigner(domain, commitment, signature) {
  if (typeof signature === 'string' && /^0x[0-9a-fA-F]{194}$/.test(signature)) {
    return verifyTypedData(domain, TIMED_OPERATION_TYPES, { commitment, deadline: BigInt('0x' + signature.slice(2, 66)) }, '0x' + signature.slice(66));
  }
  return verifyTypedData(domain, PRIVATE_OPERATION_TYPES, { commitment }, signature);
}
const ZK_PUBLICATION_TYPES = { ZkPublication: [
  { name: 'headerDigest', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'signerEpoch', type: 'uint256' },
] };
const ZK_MUTATIONS = { zkRegister: 1, swap: 3, addLiquidity: 4, removeLiquidity: 5, withdraw: 6 };
const SIGNATURE_TITLES = {
  account: 'Подписать запрос баланса',
  quote: 'Подписать запрос котировки',
  swap: 'Подписать обмен',
  addLiquidity: 'Подписать добавление ликвидности',
  removeLiquidity: 'Подписать снятие ликвидности',
  withdraw: 'Подписать резервирование средств для вывода',
  withdrawal: 'Подписать запрос сохранённой выплаты',
  expireWithdrawal: 'Подписать возврат просроченной заявки',
  receipt: 'Подписать запрос квитанции',
  disclosure: 'Подписать запрос квитанции для раскрытия',
  zkState: 'Подписать запрос доказательства баланса',
  zkRegister: 'Подписать регистрацию защищённого баланса',
};
const WITHDRAWAL_TYPES = { Withdrawal: [
  { name: 'account', type: 'address' }, { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' }, { name: 'signerEpoch', type: 'uint256' },
] };
const BATCH_PUBLICATION_TYPES = { BatchPublication: [
  { name: 'batchId', type: 'uint256' }, { name: 'previousStateRoot', type: 'bytes32' },
  { name: 'newStateRoot', type: 'bytes32' }, { name: 'receiptsRoot', type: 'bytes32' },
  { name: 'firstTradeId', type: 'uint256' }, { name: 'tradeCount', type: 'uint256' },
  { name: 'deadline', type: 'uint256' }, { name: 'signerEpoch', type: 'uint256' },
] };
const BATCH_FIELDS = ['batchId', 'previousStateRoot', 'newStateRoot', 'receiptsRoot', 'firstTradeId', 'tradeCount'];
const BATCH_ROOT_FIELDS = ['previousStateRoot', 'newStateRoot', 'receiptsRoot'];
const ZERO_ROOT = '0x' + '00'.repeat(32);
const TOKEN_ABI = [
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256)',
  'function decimals() view returns(uint8)', 'function symbol() view returns(string)',
  'function faucet() returns(uint256)', 'function FAUCET_AMOUNT() view returns(uint256)',
  'function nextFaucetAt(address) view returns(uint256)',
  'error FaucetCooldown(uint256 nextAvailableAt)',
];
const VAULT_ABI = [
  'function ruba() view returns(address)', 'function usdt() view returns(address)',
  'function owner() view returns(address)',
  'function whitelist(address) view returns(bool)', 'function marketPaused() view returns(bool)',
  'function withdrawalsPaused(address) view returns(bool)', 'function operator() view returns(address)',
  'function setWhitelist(address,bool)', 'function setMarketPaused(bool)', 'function setTokenWithdrawalsPaused(address,bool)',
  'function signerEpoch() view returns(uint256)',
  'function admissionSigner() view returns(address)', 'function kycHashOf(address) view returns(bytes32)',
  'function consentHashOf(address) view returns(bytes32)',
  'function admit((address account,bytes32 kycHash,bytes32 consentHash,uint256 deadline,uint256 nonce),bytes)',
  'function pauseGuardiansConfigured() view returns(bool)', 'function isPauseGuardian(address) view returns(bool)',
  'function approveMarketResume()', 'function executeMarketResume()',
  'function approveTokenWithdrawalsResume(address)', 'function executeTokenWithdrawalsResume(address)',
  'function marketResumeStatus() view returns(uint256 round,uint256 approvals,uint256 readyAt)',
  'function tokenWithdrawalsResumeStatus(address) view returns(uint256 round,uint256 approvals,uint256 readyAt)',
  'function usedWithdrawalNonces(address,uint256) view returns(bool)',
  'function deposit(address,uint256) returns(uint256)',
  'function withdraw((address account,address token,uint256 amount,uint256 nonce,uint256 deadline,uint256 signerEpoch),bytes)',
  'function publishSignedBatch((uint256 batchId,bytes32 previousStateRoot,bytes32 newStateRoot,bytes32 receiptsRoot,uint256 firstTradeId,uint256 tradeCount),uint256 deadline,uint256 signerEpoch,bytes signature)',
  'function lastBatchId() view returns(uint256)', 'function lastTradeId() view returns(uint256)',
  'function stateRoot() view returns(bytes32)',
  'function stateVersion() view returns(uint256)', 'function domain() view returns(uint256)',
  'function poolKeyCommit() view returns(uint256)',
  'function withdrawalMode() view returns(string)',
  'function withdrawalClaims(uint256) view returns(address owner,uint256 slot,uint256 stateVersion)',
  'function spentWithdrawalCommitments(uint256) view returns(bool)',
  'function proofMode() view returns(string)', 'function ZK_VERSION() view returns(uint256)',
  'function verifier() view returns(address)', 'function verifierCodeHash() view returns(bytes32)',
  'function poseidon2() view returns(address)', 'function poseidonCodeHash() view returns(bytes32)',
  'function inboxCursor() view returns(uint256)', 'function nextTradeId() view returns(uint256)',
  'function genesisStateRoot() view returns(bytes32)', 'function ownerSlotPlusOne(address) view returns(uint256)',
  'function transitions(uint256) view returns(uint256[13])',
  'event ZkTransitionPublished(uint256 indexed stateVersion,uint256 indexed tradeBatchId,uint256[13] publicSignals)',
  'function publishZkTransition(uint256[13] signals,(uint256 kind,uint256 slot,address owner,uint256 commitment,uint256 eventId,uint256 token,uint256 amount,uint256 referenceId,bytes signature)[8] operations,(uint256 kind,uint256 slot,address owner,uint256 newLeaf,uint256[7] ciphertext)[8] accountDA,(uint256 poolHash,uint256[6] poolCiphertext) poolDA,(uint256[2] a,uint256[2][2] b,uint256[2] c) proof,(uint256 deadline,uint256 signerEpoch,bytes signature) authorization)',
  'function publishProvenTransition(uint256[13] signals,(uint256 kind,uint256 slot,address owner,uint256 commitment,uint256 eventId,uint256 token,uint256 amount,uint256 referenceId,bytes signature)[8] operations,(uint256 kind,uint256 slot,address owner,uint256 newLeaf,uint256[7] ciphertext)[8] accountDA,(uint256 poolHash,uint256[6] poolCiphertext) poolDA,(uint256[2] a,uint256[2][2] b,uint256[2] c) proof)',
  'function publishProvenTransitionAndWithdraw(uint256[13] signals,(uint256 kind,uint256 slot,address owner,uint256 commitment,uint256 eventId,uint256 token,uint256 amount,uint256 referenceId,bytes signature)[8] operations,(uint256 kind,uint256 slot,address owner,uint256 newLeaf,uint256[7] ciphertext)[8] accountDA,(uint256 poolHash,uint256[6] poolCiphertext) poolDA,(uint256[2] a,uint256[2][2] b,uint256[2] c) proof,(address account,address token,uint256 amount,uint256 nonce,uint256 spendNonce,uint256 salt) withdrawal)',
  'function withdrawProven((address account,address token,uint256 amount,uint256 nonce,uint256 spendNonce,uint256 salt) withdrawal)',
  'function batches(uint256) view returns(uint256 batchId,bytes32 previousStateRoot,bytes32 newStateRoot,bytes32 receiptsRoot,uint256 firstTradeId,uint256 tradeCount)',
  ...['NotWhitelisted', 'MarketPaused', 'TokenWithdrawalsPaused', 'ExpiredWithdrawal', 'InvalidSignerEpoch', 'WithdrawalAlreadyUsed', 'InvalidSignature',
    'InvalidAdmission', 'ExpiredAdmission', 'AdmissionAlreadyUsed', 'AdmissionBlocked', 'UnauthorizedPauser', 'UnauthorizedGuardian',
    'ResumeRequiresGuardians', 'NothingToResume', 'ResumeAlreadyApproved', 'ResumeNotReady'].map((name) => `error ${name}()`),
];
const UINT_MAX = (1n << 256n) - 1n;
const checkedUint = (value) => {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error('Некорректная сумма или идентификатор.');
  const number = BigInt(value);
  if (number > UINT_MAX) throw new Error('Число слишком большое.');
  return number;
};

function publicationUint(value) {
  if (typeof value !== 'string' || value.length > 78) throw new Error('Поля публикации должны быть десятичными строками.');
  return checkedUint(value).toString();
}

function bytes32(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Некорректный корень пакета.');
  return value.toLowerCase();
}

function publicationTicket(ticket, config) {
  if (!ticket || typeof ticket !== 'object' || !ticket.batch || typeof ticket.signature !== 'string') {
    throw new Error('Некорректное разрешение на публикацию.');
  }
  if (Object.keys(ticket.batch).sort().join(',') !== [...BATCH_FIELDS].sort().join(',')) throw new Error('Некорректные поля пакета.');
  const chainId = publicationUint(ticket.chainId);
  const vault = getAddress(ticket.vault);
  if (BigInt(chainId) !== BigInt(config.chainId) || vault !== getAddress(config.vaultAddress)) {
    throw new Error('Публикация относится к другой сети или хранилищу.');
  }
  const batch = {};
  for (const field of BATCH_FIELDS) batch[field] = BATCH_ROOT_FIELDS.includes(field) ? bytes32(ticket.batch[field]) : publicationUint(ticket.batch[field]);
  if (BigInt(batch.batchId) === 0n || BigInt(batch.firstTradeId) === 0n || batch.tradeCount !== '4') {
    throw new Error('Публиковать можно только последовательные пакеты из четырёх сделок.');
  }
  if (batch.newStateRoot === ZERO_ROOT || batch.receiptsRoot === ZERO_ROOT) throw new Error('Корни нового состояния и квитанций не могут быть пустыми.');
  if (!/^0x[0-9a-fA-F]{130}$/.test(ticket.signature)) throw new Error('Некорректная подпись публикации.');
  const deadline = publicationUint(ticket.deadline);
  const signerEpoch = publicationUint(ticket.signerEpoch);
  if (BigInt(deadline) === 0n || BigInt(signerEpoch) === 0n) throw new Error('Некорректный срок или эпоха публикации.');
  return { chainId, vault, batch, deadline, signerEpoch, signature: ticket.signature };
}

function sameBatch(stored, expected) {
  return BATCH_FIELDS.every((field, index) => {
    const actual = stored?.[field] ?? stored?.[index];
    return BATCH_ROOT_FIELDS.includes(field) ? bytes32(actual) === expected[field] : checkedUint(actual) === BigInt(expected[field]);
  });
}

function transactionHash(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : undefined;
}

function walletRejected(error) {
  return [error?.code, error?.info?.error?.code, error?.error?.code].some((code) => code === 4001 || code === 'ACTION_REJECTED');
}

function whitelistAddress(input) {
  let address;
  try { address = getAddress(input.trim()); } catch { throw new Error('Введите корректный Ethereum-адрес кошелька.'); }
  if (address === ZeroAddress) throw new Error('Укажите адрес кошелька, отличный от нулевого.');
  return address;
}

function pendingAdminUpdate(hash, cause) {
  if (!hash) {
    throw new Error('Результат транзакции неизвестен. Проверьте транзакции в кошельке и обновите настройки Vault перед повтором.', { cause });
  }
  return { status: 'submitted', transactionHash: hash };
}

async function waitForPublication(transaction, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      transaction.wait(1, timeoutMs),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Истекло время ожидания публикации.')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function requestJson(fetchImpl, path, init = {}, timeoutMs = 20_000) {
  const uncertain = () => {
    const error = new Error('Ответ сервера не получен. Действие могло быть выполнено. Сначала обновите баланс и список запросов на вывод, прежде чем повторять действие.');
    error.uncertain = true;
    return error;
  };
  let response;
  try {
    response = await fetchImpl(path, { ...init, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (init.method === 'POST') throw uncertain();
    throw error;
  }
  let body;
  try { body = await response.json(); } catch {
    if (init.method === 'POST') throw uncertain();
    throw new Error('Сервер вернул некорректный ответ.');
  }
  if (!response.ok) {
    if (init.method === 'POST' && response.status >= 500) throw uncertain();
    const error = new Error(typeof body.error === 'string' ? body.error : 'Сервер недоступен.');
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function loadConfig(fetchImpl = globalThis.fetch.bind(globalThis)) {
  const config = await requestJson(fetchImpl, '/config');
  checkedUint(config.chainId);
  if (BigInt(config.chainId) === 0n) throw new Error('Некорректная сеть приложения.');
  config.vaultAddress = getAddress(config.vaultAddress);
  for (const token of ['RUBA', 'USDT']) {
    if (!Number.isInteger(config.tokens?.[token]?.decimals) || config.tokens[token].decimals < 0 || config.tokens[token].decimals > 18
      || (config.tokens[token].symbol !== undefined && !/^[A-Z][A-Z0-9]{0,11}$/.test(config.tokens[token].symbol))) throw new Error('Сервер настроен на неподдерживаемую пару.');
    config.tokens[token].address = getAddress(config.tokens[token].address);
  }
  if (config.tokens.RUBA.address === config.tokens.USDT.address) throw new Error('Токены пары должны отличаться.');
  return config;
}

export function recoveryKeyMessage(config, owner) {
  return `RUBA recovery key v2\nChain ID: ${config.chainId}\nVault: ${getAddress(config.vaultAddress)}\nOwner: ${getAddress(owner)}`;
}

/** Wallet authorization stays in the wallet. No private key is requested or stored. */
export class RubaClient {
  constructor(config, provider, signer, {
    fetchImpl = globalThis.fetch.bind(globalThis),
    contractFactory = (address, abi, runner) => new Contract(address, abi, runner),
    publicationWaitMs = 45_000, zkCrypto, storage = globalThis.localStorage, onWalletStep = () => {},
  } = {}) {
    this.config = config;
    this.provider = provider;
    this.signer = signer;
    this.fetchImpl = fetchImpl;
    this.onWalletStep = onWalletStep;
    this.accountPromise = signer.getAddress().then(getAddress);
    this.vault = contractFactory(config.vaultAddress, VAULT_ABI, signer);
    this.tokens = Object.fromEntries(['RUBA', 'USDT'].map((token) => [token, contractFactory(config.tokens[token].address, TOKEN_ABI, signer)]));
    this.queue = Promise.resolve();
    this.publicationQueue = Promise.resolve();
    this.publicationWaitMs = publicationWaitMs;
    this.zkCryptoPromise = zkCrypto ? Promise.resolve(zkCrypto) : null;
    this.storage = storage;
    this.recoveryKey = null;
    this.zkState = null;
    this.zkAuthorizations = [];
    this.withdrawalClaims = [];
    this.currentWithdrawalCommitments = new Set();
    this.redemptionQueue = Promise.resolve();
    this.active = true;
    this.recoveryCacheDomain = null;
  }

  get isZk() { return this.config.proofMode === 'zk'; }
  get hasProvenWithdrawals() { return this.isZk && this.config.withdrawalMode === 'proven-reservation-v1'; }
  get isProofOnly() { return this.hasProvenWithdrawals && this.config.publicationAuthorization === 'proof-only'; }
  dispose() { this.active = false; }

  async #walletStep(key, kind, title, operation) {
    const id = Symbol();
    const notify = (phase, detail) => {
      // Display failures must not interrupt wallet, chain or server actions.
      try { void Promise.resolve(this.onWalletStep({ id, key, phase, kind, title, ...(detail ? { detail } : {}) })).catch(() => {}); } catch {}
    };
    let awaitingTransaction = false;
    notify('start');
    let result;
    try {
      result = await operation((detail) => {
        awaitingTransaction = true;
        notify('update', detail);
      });
    } catch (error) {
      if (kind === 'transaction' && awaitingTransaction && (error?.code === 'TIMEOUT' || error?.message === 'Истекло время ожидания публикации.')) {
        notify('pending', 'Транзакция отправлена. Подтверждение пока не получено.');
      } else {
        notify('error', walletRejected(error) ? 'Запрос отменён в кошельке.' : undefined);
      }
      throw error;
    }
    if (kind === 'sequence' && ['waiting', 'submitted'].includes(result?.status)) {
      notify('pending', result.message || 'Подтверждение пока не получено.');
    } else if (kind === 'transaction' && result?.status === 'submitted') {
      notify('pending', result.transactionHash
        ? 'Транзакция отправлена. Подтверждение пока не получено.'
        : 'Результат отправки пока неизвестен. Проверьте кошелёк и состояние операции.');
    } else if (kind === 'transaction' && Number(result?.status) === 0) {
      notify('error', 'Транзакция отклонена контрактом.');
    } else {
      const detail = result?.status === 'already-published' ? 'Переход уже принят контрактом.'
        : result?.status === 'already-withdrawn' ? 'Выплата уже выполнена.'
          : undefined;
      notify('done', detail);
    }
    return result;
  }

  async crypto() {
    this.zkCryptoPromise ??= import(typeof window === 'undefined' ? '../zk/crypto.js' : '/assets/zk-crypto.js');
    return this.zkCryptoPromise;
  }

  async assertContext() {
    if (!this.active) throw new Error('Выбранный рынок изменился. Подключитесь к новому пулу.');
    const account = await this.accountPromise;
    const [chainId, accounts] = await Promise.all([
      this.provider.send('eth_chainId', []), this.provider.send('eth_accounts', []),
    ]);
    if (BigInt(chainId) !== BigInt(this.config.chainId)) throw new Error('Сеть кошелька изменилась. Подключитесь заново.');
    if (!accounts[0] || getAddress(accounts[0]) !== account) throw new Error('Кошелёк изменился. Подключитесь заново.');
    if (!this.active) throw new Error('Выбранный рынок изменился. Операция старого пула остановлена.');
    return account;
  }

  token(token) {
    if (token !== 'RUBA' && token !== 'USDT') throw new Error('Неизвестный токен.');
    return this.tokens[token];
  }

  #assertVaultTokens(ruba, usdt) {
    if (getAddress(ruba) !== this.config.tokens.RUBA.address || getAddress(usdt) !== this.config.tokens.USDT.address) {
      throw new Error('Адреса токенов не совпадают с хранилищем.');
    }
  }

  async #readLatestBlock() {
    // Pin reads to an explicit latest block, including immediately after a
    // fast mining receipt, to avoid reusing ethers' cached "latest" calls.
    const blockTag = await this.provider.send('eth_blockNumber', []);
    if (typeof blockTag !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(blockTag)) {
      throw new Error('Не удалось прочитать номер блока.');
    }
    return { blockTag };
  }

  async #readVaultOwner(block) {
    const [owner, ruba, usdt] = await Promise.all([this.vault.owner(block), this.vault.ruba(block), this.vault.usdt(block)]);
    this.#assertVaultTokens(ruba, usdt);
    return getAddress(owner);
  }

  async getAdminStatus() {
    const account = await this.assertContext();
    const block = await this.#readLatestBlock();
    const [owner, marketPaused, rubaPaused, usdtPaused] = await Promise.all([
      this.#readVaultOwner(block),
      this.vault.marketPaused(block),
      this.vault.withdrawalsPaused(this.config.tokens.RUBA.address, block),
      this.vault.withdrawalsPaused(this.config.tokens.USDT.address, block),
    ]);
    const pauseRoles = await this.#readPauseRoles(account, block);
    await this.assertContext();
    return {
      owner, isOwner: owner === account, marketPaused, withdrawalsPaused: { RUBA: rubaPaused, USDT: usdtPaused },
      ...(pauseRoles ? { pauseRoles } : {}),
    };
  }

  async #readPauseRoles(account, block) {
    let configured;
    try { configured = await this.vault.pauseGuardiansConfigured(block); } catch { return null; }
    if (!configured) return null;
    const [isGuardian, market, ruba, usdt] = await Promise.all([
      this.vault.isPauseGuardian(account, block), this.vault.marketResumeStatus(block),
      this.vault.tokenWithdrawalsResumeStatus(this.config.tokens.RUBA.address, block),
      this.vault.tokenWithdrawalsResumeStatus(this.config.tokens.USDT.address, block),
    ]);
    const status = (value) => ({ approvals: Number(value.approvals ?? value[1]), readyAt: BigInt(value.readyAt ?? value[2]) });
    return { isGuardian, market: status(market), withdrawals: { RUBA: status(ruba), USDT: status(usdt) } };
  }

  async getWhitelist(input) {
    const target = whitelistAddress(input);
    await this.assertContext();
    const allowed = await this.vault.whitelist(target, await this.#readLatestBlock());
    await this.assertContext();
    return allowed;
  }

  async setWhitelist(input, allowed, onProgress) {
    const target = whitelistAddress(input);
    const title = allowed ? 'Добавить кошелёк в список допуска' : 'Отозвать допуск кошелька';
    return this.#sendAdminAction('tx:whitelist', allowed, title, () => this.vault.setWhitelist(target, allowed), onProgress);
  }

  async setMarketPaused(paused, onProgress) {
    if (!paused) {
      const resume = await this.#guardianResume(() => this.vault.marketResumeStatus(), () => this.vault.approveMarketResume(), () => this.vault.executeMarketResume(), 'работы рынка');
      if (resume) return this.#sendAdminAction('tx:market-pause', false, resume.title, resume.send, onProgress, resume.access);
    }
    const title = paused ? 'Поставить рынок на паузу' : 'Возобновить работу рынка';
    return this.#sendAdminAction('tx:market-pause', paused, title, () => this.vault.setMarketPaused(paused), onProgress, paused ? 'pauser' : 'owner');
  }

  async setTokenWithdrawalsPaused(token, paused, onProgress) {
    this.token(token);
    const { address, symbol = token } = this.config.tokens[token];
    if (!paused) {
      const resume = await this.#guardianResume(() => this.vault.tokenWithdrawalsResumeStatus(address), () => this.vault.approveTokenWithdrawalsResume(address),
        () => this.vault.executeTokenWithdrawalsResume(address), `вывода ${symbol}`);
      if (resume) return this.#sendAdminAction('tx:withdrawal-pause', false, resume.title, resume.send, onProgress, resume.access);
    }
    const title = paused ? `Приостановить вывод ${symbol}` : `Возобновить вывод ${symbol}`;
    return this.#sendAdminAction('tx:withdrawal-pause', paused, title, () => this.vault.setTokenWithdrawalsPaused(address, paused), onProgress, paused ? 'pauser' : 'owner');
  }

  /** With pause roles set, resume is two guardian approvals and, after the delay, an execute call open to anyone. */
  async #guardianResume(readStatus, approve, execute, what) {
    let configured = false;
    try { configured = await this.vault.pauseGuardiansConfigured(); } catch { return null; }
    if (!configured) return null;
    const { blockTag } = await this.#readLatestBlock();
    const [status, block] = await Promise.all([readStatus(), this.provider.getBlock(blockTag)]);
    const readyAt = BigInt(status.readyAt ?? status[2]);
    if (readyAt > 0n && block && BigInt(block.timestamp) >= readyAt) {
      return { title: `Завершить возобновление ${what}`, send: execute, access: 'anyone' };
    }
    if (readyAt > 0n) throw new Error('Две роли уже одобрили возобновление. Дождитесь окончания задержки и нажмите ещё раз.');
    return { title: `Одобрить возобновление ${what} (нужно 2 из 3 ролей)`, send: approve, access: 'guardian' };
  }

  async #sendAdminAction(key, flag, title, send, onProgress = () => {}, access = 'owner') {
    if (typeof flag !== 'boolean') throw new Error('Укажите состояние настройки.');
    const checkTitle = { owner: 'Проверить право владельца Vault', pauser: 'Проверить право ставить паузу', guardian: 'Проверить роль паузы', anyone: 'Проверить готовность возобновления' }[access];
    await this.#walletStep('check:owner', 'check', checkTitle, async () => {
      const account = await this.assertContext();
      if (access === 'anyone') return;
      const block = await this.#readLatestBlock();
      const isOwner = await this.#readVaultOwner(block) === account;
      if (access === 'owner' && !isOwner) throw new Error('Изменять настройки может только владелец выбранного Vault.');
      if (access === 'owner') return;
      const roles = await this.#readPauseRoles(account, block);
      if (access === 'pauser' && !isOwner && !roles?.isGuardian) throw new Error('Ставить паузу может только владелец Vault или одна из ролей паузы.');
      if (access === 'guardian' && !roles?.isGuardian) throw new Error('Одобрить возобновление может только одна из трёх ролей паузы.');
    });

    onProgress('Подтвердите изменение настройки в кошельке.');
    await this.assertContext();
    return this.#walletStep(key, 'transaction', title, async (update) => {
      let transaction;
      try {
        transaction = await send();
      } catch (error) {
        if (walletRejected(error)) throw Object.assign(new Error('Настройка не изменена. Вы отменили транзакцию в кошельке.'), { code: 'ACTION_REJECTED' });
        if (error?.receipt?.status != null && Number(error.receipt.status) === 0) throw error;
        if (['INSUFFICIENT_FUNDS', 'CALL_EXCEPTION', 'INVALID_ARGUMENT', 'UNSUPPORTED_OPERATION'].includes(error?.code)) throw error;
        return pendingAdminUpdate(transactionHash(error?.transactionHash ?? error?.hash), error);
      }

      let hash = transactionHash(transaction?.hash);
      let receipt;
      onProgress('Транзакция отправлена. Ждём подтверждения в сети.');
      update('Транзакция отправлена. Ждём подтверждения в сети.');
      try {
        receipt = await waitForPublication(transaction, this.publicationWaitMs);
      } catch (error) {
        receipt = error?.receipt;
        if (error?.code === 'TRANSACTION_REPLACED') {
          if (error.cancelled || error.reason !== 'repriced') throw new Error('Транзакция отменена или заменена другой операцией. Обновите настройки.');
          hash = transactionHash(error.replacement?.hash ?? error.hash);
        }
      }
      if (receipt?.status != null && Number(receipt.status) === 0) {
        throw new Error('Контракт отклонил транзакцию изменения настройки.');
      }
      const receiptHash = transactionHash(receipt?.hash ?? receipt?.transactionHash);
      if (Number(receipt?.status) === 1 && hash && receiptHash?.toLowerCase() === hash.toLowerCase()) {
        return { status: 'confirmed', transactionHash: hash };
      }
      return pendingAdminUpdate(hash);
    });
  }

  async getMarketStatus({ fresh = false } = {}) {
    const account = await this.assertContext();
    const blockContext = fresh ? await this.#readLatestBlock() : null;
    const overrides = blockContext ? [blockContext] : [];
    const [whitelisted, marketPaused, rubaPaused, usdtPaused, block, ruba, usdt] = await Promise.all([
      this.vault.whitelist(account, ...overrides), this.vault.marketPaused(...overrides),
      this.vault.withdrawalsPaused(this.config.tokens.RUBA.address, ...overrides),
      this.vault.withdrawalsPaused(this.config.tokens.USDT.address, ...overrides),
      this.provider.getBlock(blockContext?.blockTag ?? 'latest'), this.vault.ruba(...overrides), this.vault.usdt(...overrides),
    ]);
    this.#assertVaultTokens(ruba, usdt);
    for (const key of ['RUBA', 'USDT']) {
      if (this.config.tokens[key].symbol !== undefined && Number(await this.tokens[key].decimals()) !== this.config.tokens[key].decimals) throw new Error('Точность токена не совпадает с выбранным рынком.');
    }
    if (!block) throw new Error('Не удалось прочитать состояние сети.');
    await this.assertContext();
    return { whitelisted, marketPaused, withdrawalsPaused: { RUBA: rubaPaused, USDT: usdtPaused }, timestamp: BigInt(block.timestamp) };
  }

  async getWalletBalances() {
    const account = await this.assertContext();
    const [RUBA, USDT] = await Promise.all([this.tokens.RUBA.balanceOf(account), this.tokens.USDT.balanceOf(account)]);
    await this.assertContext();
    return { RUBA: BigInt(RUBA), USDT: BigInt(USDT) };
  }

  get hasAdmissionDesk() { return this.config.admission?.mode === 'desk-approval'; }

  async getAdmissionInfo() {
    if (!this.hasAdmissionDesk) return null;
    const info = await requestJson(this.fetchImpl, '/admission');
    if (getAddress(info.requestDomain?.verifyingContract ?? ZeroAddress) !== this.config.vaultAddress
      || BigInt(info.requestDomain.chainId) !== BigInt(this.config.chainId)) throw new Error('Заявка на допуск относится к другому рынку.');
    if (keccak256(toUtf8Bytes(info.consentText)) !== info.consentHash) throw new Error('Текст согласия не совпадает с его хешем.');
    return info;
  }

  async applyForAdmission(rawKycId, onProgress = () => {}) {
    const kycId = String(rawKycId ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{4,64}$/.test(kycId)) throw new Error('Номер KYC: от 4 до 64 символов, латинские буквы, цифры и дефис.');
    const info = await this.getAdmissionInfo();
    if (!info) throw new Error('На этом рынке допуск выдаёт только администратор.');
    const account = await this.assertContext();
    const signer = getAddress(await this.vault.admissionSigner());
    if (signer !== getAddress(info.admissionSigner)) throw new Error('Подписант допуска в Vault не совпадает с сервером. Заявку не отправляем.');
    const signedAt = BigInt(Math.floor(Date.now() / 1000));
    const message = { account, consentHash: info.consentHash, kycIdHash: keccak256(toUtf8Bytes(kycId)), signedAt };
    const signature = await this.#walletStep('sign:admission', 'signature', 'Подписать согласие с риском RUBA и заявку',
      () => this.signer.signTypedData(info.requestDomain, info.requestTypes, message));
    const { result } = await requestJson(this.fetchImpl, '/admission/apply', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, kycId, signedAt: signedAt.toString(), signature }),
    });
    const admission = result?.admission;
    if (!admission || getAddress(admission.account) !== account || admission.consentHash !== info.consentHash) {
      throw new Error('Сервер вернул одобрение не для этого кошелька.');
    }
    const recovered = verifyTypedData({ name: 'RubaVault', version: '1', chainId: this.config.chainId, verifyingContract: this.config.vaultAddress },
      { Admission: [{ name: 'account', type: 'address' }, { name: 'kycHash', type: 'bytes32' }, { name: 'consentHash', type: 'bytes32' },
        { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'uint256' }] }, admission, result.signature);
    if (getAddress(recovered) !== signer) throw new Error('Одобрение подписано не тем ключом допуска.');
    onProgress('Одобрение получено. Подтвердите транзакцию допуска в кошельке.');
    await this.assertContext();
    return this.#walletStep('tx:admit', 'transaction', 'Отправить допуск в Vault', async (update) => {
      const transaction = await this.vault.admit(admission, result.signature);
      update('Транзакция отправлена. Ждём подтверждения допуска.');
      const receipt = await waitForPublication(transaction, this.publicationWaitMs);
      if (Number(receipt?.status) !== 1) throw new Error('Допуск не подтверждён. Проверьте кошелёк перед повтором.');
      return { receipt, kycHash: admission.kycHash };
    });
  }

  async faucet(token, onProgress = () => {}) {
    const contract = this.token(token);
    const symbol = this.config.tokens[token].symbol ?? token;
    const amount = await this.#walletStep('check:faucet', 'check', `Проверить доступность крана ${symbol}`, async () => {
      const owner = await this.assertContext();
      const [availableAt, faucetAmount, block] = await Promise.all([contract.nextFaucetAt(owner), contract.FAUCET_AMOUNT(), this.provider.getBlock('latest')]);
      if (!block || BigInt(availableAt) > BigInt(block.timestamp)) throw new Error('Кран этого тестового токена доступен раз в 60 секунд. Дождитесь окончания паузы.');
      return faucetAmount;
    });
    onProgress(`Подтвердите получение тестового ${symbol} в кошелёк. Это отдельный шаг перед пополнением Vault.`);
    await this.assertContext();
    return this.#walletStep('tx:faucet', 'transaction', `Получить тестовые ${symbol} на кошелёк`, async (update) => {
      const transaction = await contract.faucet();
      update('Транзакция отправлена. Ждём получения тестовых токенов.');
      const receipt = await waitForPublication(transaction, this.publicationWaitMs);
      if (Number(receipt?.status) !== 1) throw new Error('Получение тестовых токенов не подтверждено. Проверьте кошелёк перед повторением.');
      return { amount: BigInt(amount), receipt };
    });
  }

  signedAction(operation) {
    // Private reads consume nonces too: serialize quote/balance/actions together.
    const job = this.queue.then(() => this.executeSignedAction(operation));
    this.queue = job.catch(() => undefined);
    return job;
  }

  async executeSignedAction(operation) {
      const account = await this.assertContext();
      const timeoutMs = this.isZk || this.config.chainMode === 'tenderly' ? 120_000 : 20_000;
      let zk;
      if (this.isZk && Object.hasOwn(ZK_MUTATIONS, operation.kind)) {
        const state = await this.readZkStateUnqueued();
        const c = await this.crypto();
        const params = this.zkOperationParams(operation, state, c);
        const salt = c.randomField();
        const commitment = c.hashOperation(state.domain, ZK_MUTATIONS[operation.kind], state.slot, account,
          state.account[4], params, salt);
        zk = { commitment: commitment.toString(), nonce: state.account[4].toString(), salt: salt.toString() };
        if (this.hasProvenWithdrawals && operation.kind === 'withdraw') {
          await this.loadRecoveryCache();
          const opening = { chainId: String(this.config.chainId), vault: this.config.vaultAddress.toLowerCase(), domain: c.fieldHex(state.domain),
            slot: state.slot.toString(), commitment: c.fieldHex(commitment), stateVersion: null,
            withdrawal: { account: account.toLowerCase(), token: this.config.tokens[operation.token].address.toLowerCase(),
              amount: params[1].toString(), nonce: state.account[4].toString(), spendNonce: state.account[4].toString(), salt: salt.toString() } };
          this.withdrawalClaims.push(opening);
          await this.saveRecoveryCache(true);
        }
      }
      const nonceResponse = await requestJson(this.fetchImpl, `/nonce?account=${encodeURIComponent(account)}`, {}, timeoutMs);
      if (getAddress(nonceResponse.account) !== account) throw new Error('Сервер вернул nonce другого кошелька.');
      // Tenderly's pending block advances even when no transaction has mined.
      // Match the server's action clock without treating pending time as mined
      // evidence that a withdrawal has expired in getMarketStatus().
      // Read raw RPC: ethers cannot format pending blocks with a null number.
      const tenderly = this.config.chainMode === 'tenderly';
      const block = tenderly
        ? await this.provider.send('eth_getBlockByNumber', ['pending', false])
        : await this.provider.getBlock('latest');
      if (!block || (tenderly && (typeof block.timestamp !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(block.timestamp)))) {
        throw new Error('Не удалось прочитать время сети.');
      }
      const intent = {
        account, actionHash: keccak256(toUtf8Bytes(canonicalJson(operation))),
        nonce: checkedUint(nonceResponse.nonce).toString(), deadline: (BigInt(block.timestamp) + 600n).toString(),
      };
      const domain = { name: 'RubaServer', version: '1', chainId: BigInt(this.config.chainId), verifyingContract: this.config.vaultAddress };
      await this.assertContext();
      const title = Object.hasOwn(SIGNATURE_TITLES, operation.kind) ? SIGNATURE_TITLES[operation.kind] : 'Подписать запрос';
      const signature = await this.#walletStep(`sign:${operation.kind}`, 'signature', title, async () => {
        const operationDomain = { ...domain, name: 'RubaZkOperation', version: '2' };
        const deadline = BigInt(block.timestamp) + OPERATION_DEADLINE_SECONDS;
        const signed = !zk
          ? await this.signer.signTypedData(domain, ACTION_TYPES, intent)
          : TIMED_OPERATION_KINDS.has(operation.kind)
            ? '0x' + deadline.toString(16).padStart(64, '0') + (await this.signer.signTypedData(operationDomain, TIMED_OPERATION_TYPES, { commitment: zk.commitment, deadline })).slice(2)
            : await this.signer.signTypedData(operationDomain, PRIVATE_OPERATION_TYPES, { commitment: zk.commitment });
        await this.assertContext();
        return signed;
      });
      if (zk) {
        this.zkAuthorizations.push({ operation: structuredClone(operation), ...zk, signature, status: 'submitted' });
        if (this.hasProvenWithdrawals && operation.kind === 'withdraw') {
          this.withdrawalClaims.find((claim) => BigInt(claim.commitment) === BigInt(zk.commitment)).signature = signature;
          await this.saveRecoveryCache(true);
        } else this.saveRecoveryCache();
      }
      const response = await requestJson(this.fetchImpl, '/actions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intent, operation, signature, ...(zk ? { zk } : {}) }),
      }, timeoutMs);
      if (zk) { this.zkAuthorizations.at(-1).status = 'accepted-by-server'; this.saveRecoveryCache(); }
      if (this.hasProvenWithdrawals && operation.kind === 'withdraw') await this.validateProvenWithdrawalTicket(response.result, zk.commitment);
      return response.result;
  }

  zkOperationParams(operation, state, c) {
    const amount = (value, bits = 96n) => {
      const parsed = checkedUint(value);
      if (parsed >= 1n << bits) throw new Error('Значение превышает диапазон ZK-схемы.');
      return parsed;
    };
    const token = (symbol) => {
      if (symbol !== 'RUBA' && symbol !== 'USDT') throw new Error('Неизвестный токен.');
      return symbol === 'RUBA' ? 0n : 1n;
    };
    if (operation.kind === 'zkRegister') {
      if (state.registered || BigInt(operation.slot) !== BigInt(state.slot)) throw new Error('Слот регистрации изменился. Обновите данные.');
      return [c.keyCommit(c.field(operation.recoveryKey)), 0n, 0n, 0n];
    }
    if (!state.registered) throw new Error('Сначала зарегистрируйте защищённый баланс через пополнение.');
    if (operation.kind === 'swap') return [token(operation.tokenIn), amount(operation.amountIn), amount(operation.minOut), 0n];
    if (operation.kind === 'addLiquidity') return [amount(operation.rubaDesired), amount(operation.usdtDesired), amount(operation.rubaMin), amount(operation.usdtMin)];
    if (operation.kind === 'removeLiquidity') return [amount(operation.shares), amount(operation.rubaMin), amount(operation.usdtMin), 0n];
    if (operation.kind === 'withdraw') return [token(operation.token), amount(operation.amount), amount(this.hasProvenWithdrawals ? state.account[4] : state.withdrawalNonce ?? state.nextWithdrawalNonce ?? '0', 64n), 0n];
    throw new Error('Неизвестная ZK-операция.');
  }

  async readZkStateUnqueued() {
    const raw = await this.executeSignedAction({ kind: 'zkState' });
    return this.acceptZkState(raw);
  }

  async acceptZkState(raw) {
    const state = await this.#walletStep('check:zk-proof', 'check', 'Проверить доказательство баланса', () => this.validateZkState(raw));
    await this.recoveryStorageKey();
    this.zkState = state;
    if (this.hasProvenWithdrawals && Array.isArray(raw.provenWithdrawals)) {
      await this.loadRecoveryCache();
      this.currentWithdrawalCommitments.clear();
      for (const claim of raw.provenWithdrawals) {
        const checked = await this.validateProvenWithdrawalTicket({ ...claim, kind: 'zk-withdrawal', chainId: this.config.chainId, vault: this.config.vaultAddress });
        this.currentWithdrawalCommitments.add(BigInt(checked.commitment).toString());
      }
    }
    this.saveRecoveryCache();
    return state;
  }

  getZkState() {
    if (!this.isZk) throw new Error('Этот Vault не использует ZK-состояние.');
    const job = this.queue.then(() => this.readZkStateUnqueued());
    this.queue = job.catch(() => undefined);
    return job;
  }

  async validateZkState(raw) {
    const c = await this.crypto();
    const owner = await this.assertContext();
    if (!raw || typeof raw.registered !== 'boolean' || !Array.isArray(raw.account) || raw.account.length !== 9) throw new Error('Некорректное доказательство баланса.');
    const state = { ...raw, account: raw.account.map(c.field), path: raw.path?.map(c.field) };
    state.slot = c.field(raw.slot);
    if (state.slot >= 16n) throw new Error('Слот баланса вне диапазона.');
    for (const name of ['domain', 'accountsRoot', 'poolHash', 'inboxCursor', 'nextTradeId', 'poolKeyCommit', 'stateRoot', 'stateVersion']) state[name] = c.field(raw[name]);
    const domain = c.hashDomain(this.config.chainId, this.config.vaultAddress, this.config.tokens.RUBA.address, this.config.tokens.USDT.address, state.poolKeyCommit);
    const block = await this.provider.getBlock('latest');
    if (!block) throw new Error('Не удалось прочитать актуальный блок для проверки баланса.');
    const readAt = { blockTag: block.number ?? 'latest' };
    const [chainDomain, chainPoolKeyCommit, acceptedRoot, acceptedVersion] = await Promise.all([
      this.vault.domain(readAt), this.vault.poolKeyCommit(readAt), this.vault.stateRoot(readAt), this.vault.stateVersion(readAt),
    ]);
    await this.assertContext();
    if (state.domain !== domain || c.field(chainDomain) !== domain || c.field(chainPoolKeyCommit) !== state.poolKeyCommit) throw new Error('Доказательство относится к другому ZK Vault.');
    if (state.registered ? state.account[0] !== BigInt(owner) : state.account.some((value) => value !== 0n)) throw new Error('Доказательство принадлежит другому владельцу.');
    if (!c.verifyAccountProof(state.slot, c.hashAccount(state.slot, state.account), state.path, state.accountsRoot)
      || c.hashState(state.domain, state.accountsRoot, state.poolHash, state.inboxCursor, state.nextTradeId, state.poolKeyCommit) !== state.stateRoot) {
      throw new Error('Merkle proof баланса не соответствует корню состояния.');
    }
    for (const index of [1, 2, 3, 5, 6]) if (state.account[index] >= 1n << 96n) throw new Error('Баланс вне диапазона ZK-схемы.');
    if (state.account[4] >= 1n << 64n) throw new Error('Nonce вне диапазона ZK-схемы.');
    state.verified = c.field(acceptedRoot) === state.stateRoot && BigInt(acceptedVersion) === state.stateVersion;
    state.status = state.verified ? 'accepted' : 'pending';
    if (raw.status === 'accepted' && !state.verified) throw new Error('Сервер объявил неподтверждённый баланс принятым. Обновите данные.');
    return state;
  }

  async legacyRecoveryStorageKey() { return `ruba-recovery-v2:${this.config.chainId}:${this.config.vaultAddress.toLowerCase()}:${(await this.accountPromise).toLowerCase()}`; }

  async recoveryStorageKey() {
    const base = await this.legacyRecoveryStorageKey();
    if (!this.isZk) return base;
    const c = await this.crypto();
    const domain = c.field(await this.vault.domain());
    if (this.recoveryCacheDomain !== null && this.recoveryCacheDomain !== domain) {
      this.recoveryKey = null; this.zkState = null; this.zkAuthorizations = []; this.withdrawalClaims = [];
      this.currentWithdrawalCommitments.clear();
    }
    this.recoveryCacheDomain = domain;
    return `${base}:domain:${c.fieldHex(domain)}`;
  }

  async cachedRecoveryRecord(key) {
    const scoped = this.storage?.getItem(key);
    if (scoped != null) return JSON.parse(scoped);
    if (!this.isZk) return null;
    const legacy = JSON.parse(this.storage?.getItem(await this.legacyRecoveryStorageKey()) ?? 'null');
    const recordedDomain = legacy?.domain ?? legacy?.accountProof?.domain;
    if (recordedDomain === undefined) return null;
    const c = await this.crypto();
    // Keep the old entry intact. Migrate only evidence from this exact deployment.
    return c.field(recordedDomain) === this.recoveryCacheDomain ? legacy : null;
  }

  async saveRecoveryCache(requireDurable = false) {
    if (!this.isZk) return;
    try {
      const key = await this.recoveryStorageKey();
      const prior = await this.cachedRecoveryRecord(key);
      const authorizations = new Map([...(prior?.authorizations ?? []), ...this.zkAuthorizations].map((item) => [item.commitment, item]));
      const claims = new Map([...(prior?.withdrawalClaims ?? []), ...this.withdrawalClaims].map((item) => [BigInt(item.commitment).toString(), item]));
      if (!this.storage?.setItem && requireDurable && typeof window !== 'undefined') throw new Error('Browser storage is unavailable');
      this.storage?.setItem(key, JSON.stringify({ domain: this.recoveryCacheDomain?.toString(), recoveryKey: this.recoveryKey ?? prior?.recoveryKey ?? null, authorizations: [...authorizations.values()],
        withdrawalClaims: [...claims.values()], accountProof: this.zkState }, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
    } catch {
      if (requireDurable) throw new Error('Не удалось сохранить открытие заявки в браузере. Разрешите локальное хранение перед резервированием средств.');
    }
  }

  async loadRecoveryCache() {
    try {
      const cached = await this.cachedRecoveryRecord(await this.recoveryStorageKey());
      if (Array.isArray(cached?.authorizations)) this.zkAuthorizations = [...new Map([...cached.authorizations, ...this.zkAuthorizations].map((item) => [item.commitment, item])).values()];
      if (Array.isArray(cached?.withdrawalClaims)) this.withdrawalClaims = [...new Map([...cached.withdrawalClaims, ...this.withdrawalClaims].map((item) => [BigInt(item.commitment).toString(), item])).values()];
      return cached;
    } catch { return null; }
  }

  async loadRecoveryKey(onProgress = () => {}) {
    const owner = await this.assertContext();
    const c = await this.crypto();
    await this.recoveryStorageKey();
    if (this.recoveryKey === null) {
      try {
        const cached = await this.loadRecoveryCache();
        if (cached?.recoveryKey) this.recoveryKey = c.field(cached.recoveryKey).toString();
        if (Array.isArray(cached?.authorizations)) this.zkAuthorizations = cached.authorizations;
      } catch { /* Invalid storage does not authorize anything. */ }
    }
    if (this.recoveryKey === null) {
      onProgress('Подпишите создание ключа восстановления. Эта подпись останется в браузере.');
      const seed = await this.#walletStep('sign:recovery-key', 'signature', 'Подписать создание ключа восстановления', async () => {
        const signed = await this.signer.signMessage(recoveryKeyMessage(this.config, owner));
        await this.assertContext();
        return signed;
      });
      this.recoveryKey = (BigInt(keccak256(seed)) % c.FIELD).toString();
      await this.saveRecoveryCache();
    }
    return this.recoveryKey;
  }

  async ensureZkRegistration(onProgress = () => {}) {
    if (!this.isZk) return;
    await this.#walletStep('check:registration-admission', 'check', 'Проверить допуск к регистрации в Vault', async () => {
      const owner = await this.assertContext();
      if (!await this.vault.whitelist(owner)) throw new Error('Account is not whitelisted');
    });
    const c = await this.crypto();
    await this.loadRecoveryKey(onProgress);
    const state = await this.getZkState();
    if (state.registered) {
      if (c.keyCommit(this.recoveryKey) !== state.account[7]) throw new Error('Ключ восстановления не совпадает с зарегистрированным. Импортируйте свою резервную копию.');
      if (this.hasProvenWithdrawals) await this.ensureAcceptedRegistration(state, onProgress);
      return state;
    }
    onProgress('Подпишите регистрацию защищённого баланса.');
    await this.signedAction({ kind: 'zkRegister', recoveryKey: this.recoveryKey, slot: state.slot.toString() });
    const registered = await this.getZkState();
    if (this.hasProvenWithdrawals) await this.ensureAcceptedRegistration(registered, onProgress);
    return registered;
  }

  async ensureAcceptedRegistration(state, onProgress) {
    return this.#walletStep('sequence:registration-publication', 'sequence', 'Подтвердить регистрацию в сети', async () => {
      const owner = await this.assertContext();
      if (await this.vault.withdrawalMode() !== 'proven-reservation-v1') throw new Error('Vault использует другой режим ввода и вывода.');
      for (let i = 0; i < 32; i++) {
        const registeredSlot = BigInt(await this.vault.ownerSlotPlusOne(owner));
        if (registeredSlot) {
          if (registeredSlot !== state.slot + 1n) throw new Error('Опубликован другой слот владельца. Обновите доказательство.');
          return;
        }
        const offer = await this.getPublicationRequest();
        if (offer.status !== 'ready') throw new Error('Регистрация ещё не подтверждена. Опубликуйте готовый переход; токены пока не отправлены.');
        onProgress('Публикуем регистрацию и предшествующие доказательства перед разрешением перевода токенов.');
        const result = await this.publishZkTransition(offer.request, onProgress);
        if (result.status === 'submitted') throw new Error('Результат публикации регистрации неизвестен. Проверьте её перед пополнением; approve и перевод не отправлены.');
      }
      throw new Error('Остались более ранние переходы. Продолжите публикацию перед пополнением.');
    });
  }

  async exportZkBackup() {
    if (!this.isZk) throw new Error('Экспорт доступен для ZK Vault.');
    const proof = await this.getZkState();
    if (!proof.registered) throw new Error('Сначала зарегистрируйте защищённый баланс.');
    await this.loadRecoveryKey();
    const c = await this.crypto();
    if (c.keyCommit(this.recoveryKey) !== proof.account[7]) throw new Error('Ключ восстановления не соответствует балансу.');
    if (proof.verified) return this.backupFromAccountProof(proof);
    const withdrawalClaims = await this.validateBackupWithdrawalClaims(this.withdrawalClaims, proof);
    return { format: 'ruba-owner-backup', version: 2, chainId: this.config.chainId, vault: this.config.vaultAddress,
      owner: await this.assertContext(), recoveryKey: this.recoveryKey, accountProof: proof,
      pendingAuthorizations: this.zkAuthorizations, withdrawalClaims,
      warning: 'Содержит приватные балансы, ключ просмотра и открытия заявок. Для нового доказательства нужен prover; автономный аварийный выход не реализован.' };
  }

  async importZkBackup(text) {
    if (typeof text !== 'string' || text.length > 1_048_576) throw new Error('Резервная копия должна быть JSON размером до 1 МиБ.');
    const backup = JSON.parse(text);
    const owner = await this.assertContext();
    const c = await this.crypto();
    if (backup?.format === 'ruba-zk-account-backup') {
      const recovery = await this.recoveryModule();
      const block = await this.provider.getBlock('latest');
      if (!block) throw new Error('Не удалось закрепить блок для проверки резервной копии.');
      const readAt = { blockTag: block.number ?? 'latest' };
      const [stateVersion, stateRoot] = await Promise.all([this.vault.stateVersion(readAt), this.vault.stateRoot(readAt)]);
      const result = recovery.inspectAccountBackup(backup, { source: 'contract', chainId: this.config.chainId,
        vault: this.config.vaultAddress, stateVersion, stateRoot }, {
        chainId: this.config.chainId, vault: this.config.vaultAddress, ruba: this.config.tokens.RUBA.address,
        usdt: this.config.tokens.USDT.address, owner,
      }, { recoverSigner: verifyTypedData });
      const data = result.backup;
      const proof = await this.validateZkState({ ...data, registered: true, stateRoot: data.root, status: 'pending' });
      this.recoveryKey = c.field(data.recoveryKey).toString();
      this.zkState = proof;
      this.zkAuthorizations = data.pendingAuthorizations;
      this.withdrawalClaims = data.withdrawalClaims ?? [];
      this.saveRecoveryCache();
      return proof;
    }
    if (backup?.format !== 'ruba-owner-backup' || backup.version !== 2 || getAddress(backup.owner) !== owner
      || getAddress(backup.vault) !== getAddress(this.config.vaultAddress) || BigInt(backup.chainId) !== BigInt(this.config.chainId)) throw new Error('Резервная копия относится к другому владельцу, Vault или сети.');
    const key = c.field(backup.recoveryKey);
    const proof = await this.validateZkState({ ...backup.accountProof, status: 'pending' });
    if (!proof.registered || proof.account[7] !== c.keyCommit(key)) throw new Error('Ключ не соответствует доказательству баланса.');
    const claims = await this.validateBackupWithdrawalClaims(backup.withdrawalClaims ?? [], proof);
    this.recoveryKey = key.toString();
    this.zkState = proof;
    // Pending signatures are archived for recovery, never automatically replayed.
    this.zkAuthorizations = Array.isArray(backup.pendingAuthorizations) ? backup.pendingAuthorizations : [];
    this.withdrawalClaims = claims;
    this.saveRecoveryCache();
    return proof;
  }

  async recoveryModule() {
    return import(typeof window === 'undefined' ? '../zk/recovery.js' : '/assets/zk-recovery.js');
  }

  async validateBackupWithdrawalClaims(claims, proof) {
    const recovery = await this.recoveryModule();
    return recovery.validateWithdrawalClaims(claims, { chainId: this.config.chainId, vault: this.config.vaultAddress,
      owner: await this.assertContext(), domain: proof.domain, slot: proof.slot,
      ruba: this.config.tokens.RUBA.address, usdt: this.config.tokens.USDT.address }, { recoverSigner: verifyTypedData });
  }

  async backupFromAccountProof(proof) {
    const c = await this.crypto();
    const owner = await this.assertContext();
    const withdrawalClaims = await this.validateBackupWithdrawalClaims(this.withdrawalClaims, proof);
    return { format: 'ruba-zk-account-backup', version: 2, chainId: String(this.config.chainId), vault: this.config.vaultAddress.toLowerCase(),
      ruba: this.config.tokens.RUBA.address.toLowerCase(), usdt: this.config.tokens.USDT.address.toLowerCase(), owner: owner.toLowerCase(),
      slot: proof.slot.toString(), recoveryKey: this.recoveryKey, keyCommit: c.fieldHex(proof.account[7]), account: proof.account.map(String),
      leaf: c.fieldHex(c.hashAccount(proof.slot, proof.account)), path: proof.path.map(c.fieldHex), domain: c.fieldHex(proof.domain),
      root: c.fieldHex(proof.stateRoot), accountsRoot: c.fieldHex(proof.accountsRoot), poolHash: c.fieldHex(proof.poolHash),
      inboxCursor: proof.inboxCursor.toString(), nextTradeId: proof.nextTradeId.toString(), poolKeyCommit: c.fieldHex(proof.poolKeyCommit),
      stateVersion: proof.stateVersion.toString(), pendingAuthorizations: this.zkAuthorizations, withdrawalClaims, anchor: null };
  }

  async recoverZkFromChain(onProgress = () => {}) {
    if (!this.isZk) throw new Error('Восстановление доступно для ZK Vault.');
    const owner = await this.assertContext();
    await this.loadRecoveryKey(onProgress);
    const slotPlusOne = BigInt(await this.vault.ownerSlotPlusOne(owner));
    if (slotPlusOne === 0n) throw new Error('У владельца пока нет опубликованной регистрации.');
    onProgress('Читаем подтверждённые переходы и зашифрованные данные из блокчейна. Сервер приложения не используется.');
    const recovery = await this.recoveryModule();
    const restored = await this.#walletStep('check:recover-chain', 'check', 'Прочитать подтверждённые переходы из блокчейна', () =>
      recovery.scanAcceptedUpdates(this.provider, this.config.vaultAddress, {
        contractInterface: new Interface(recovery.RECOVERY_VAULT_ABI), fromBlock: this.config.deploymentBlockNumber ?? this.config.deploymentBlock ?? 0,
        expected: { chainId: this.config.chainId, vault: this.config.vaultAddress, ...(this.hasProvenWithdrawals ? { withdrawalMode: 'proven-reservation-v1' } : {}) },
      }));
    await this.assertContext();
    const backup = recovery.buildAccountBackup(restored, { owner, slot: slotPlusOne - 1n, recoveryKey: this.recoveryKey,
      pendingAuthorizations: this.zkAuthorizations, withdrawalClaims: this.withdrawalClaims, recoverSigner: verifyTypedData });
    const proof = await this.importZkBackup(JSON.stringify(backup));
    if (!proof.verified) throw new Error('Во время восстановления корень Vault обновился. Повторите восстановление для актуального состояния.');
    return { backup, proof };
  }

  async zkPublicationTicket(raw) {
    const c = await this.crypto();
    if (raw?.kind !== 'zk' || BigInt(raw.chainId) !== BigInt(this.config.chainId)
      || getAddress(raw.vault) !== getAddress(this.config.vaultAddress)) throw new Error('Некорректный домен ZK-публикации.');
    const vector = (values, length) => {
      if (!Array.isArray(values) || values.length !== length) throw new Error('Некорректная длина ZK-вектора.');
      return values.map((value) => c.field(value).toString());
    };
    const publicSignals = vector(raw.publicSignals, 13);
    if (!['0', '1'].includes(publicSignals[2]) || publicSignals[1] === '0') throw new Error('Некорректная версия или режим перехода.');
    const tradeMode = publicSignals[2] === '1';
    const tradeCount = BigInt(publicSignals[8]) - BigInt(publicSignals[7]);
    if (tradeMode ? tradeCount < 1n || tradeCount > 4n : tradeCount !== 0n) throw new Error('Некорректное число обменов в ZK-переходе.');
    const batchId = publicationUint(raw.batch?.batchId);
    if (tradeMode ? batchId === '0' : batchId !== '0') throw new Error('Некорректный номер ZK-пакета.');
    const batch = { batchId,
      previousStateRoot: c.fieldHex(publicSignals[3]), newStateRoot: c.fieldHex(publicSignals[4]), receiptsRoot: c.fieldHex(publicSignals[9]),
      firstTradeId: publicSignals[7], tradeCount: tradeCount.toString() };
    if (!raw.batch || Object.entries(batch).some(([name, value]) => BATCH_ROOT_FIELDS.includes(name)
      ? bytes32(raw.batch[name]) !== value : publicationUint(raw.batch[name]) !== value)) throw new Error('Описание пакета не соответствует публичному ZK-заголовку.');
    if (!Array.isArray(raw.operations) || raw.operations.length !== 8 || !Array.isArray(raw.accountDA) || raw.accountDA.length !== 8) throw new Error('Нужны восемь слотов авторизации и DA.');
    const operations = raw.operations.map((record) => {
      const parsed = { owner: getAddress(record.owner), signature: record.signature };
      for (const field of ['kind', 'slot', 'commitment', 'eventId', 'token', 'amount', 'reference']) parsed[field] = c.field(record[field]).toString();
      if (BigInt(parsed.kind) > 8n || BigInt(parsed.slot) >= 16n || typeof parsed.signature !== 'string'
        || !/^0x(?:[0-9a-fA-F]{130}|[0-9a-fA-F]{194})?$/.test(parsed.signature)) throw new Error('Некорректная авторизация ZK-операции.');
      return parsed;
    });
    const swaps = operations.filter((record) => record.kind === '3').length;
    if (!operations.some((record) => record.kind !== '0') || (tradeMode ? swaps < 1 || swaps > 4 : swaps !== 0)
      || BigInt(publicSignals[8]) !== BigInt(publicSignals[7]) + BigInt(swaps)
      || (!tradeMode && publicSignals[9] !== '0') || BigInt(publicSignals[6]) < BigInt(publicSignals[5])) throw new Error('Операции не соответствуют режиму ZK-перехода.');
    const accountDA = raw.accountDA.map((record, index) => {
      const parsed = { kind: c.field(record.kind).toString(), slot: c.field(record.slot).toString(), owner: getAddress(record.owner),
        newLeaf: c.field(record.newLeaf).toString(), ciphertext: vector(record.ciphertext, 7) };
      if (parsed.kind !== operations[index].kind || parsed.slot !== operations[index].slot || parsed.owner !== operations[index].owner) throw new Error('DA не соответствует авторизованным операциям.');
      return parsed;
    });
    const poolDA = { poolHash: c.field(raw.poolDA?.poolHash).toString(), poolCiphertext: vector(raw.poolDA?.poolCiphertext, 6) };
    if (c.hashAuthDigest(publicSignals[0], publicSignals[1], operations) !== BigInt(publicSignals[10])
      || c.hashDaDigest(publicSignals[0], publicSignals[1], accountDA, poolDA.poolHash, poolDA.poolCiphertext) !== BigInt(publicSignals[11])) throw new Error('Публичные digest не соответствуют calldata ZK-перехода.');
    const coordinate = (value) => {
      const parsed = checkedUint(value);
      if (parsed >= 21888242871839275222246405745257275088696311157297823662689037894645226208583n) throw new Error('Координата proof вне поля BN254.');
      return parsed.toString();
    };
    const point = (value) => {
      if (!Array.isArray(value) || value.length !== 2) throw new Error('Некорректный Groth16 proof.');
      return value.map(coordinate);
    };
    if (!Array.isArray(raw.proof?.b) || raw.proof.b.length !== 2) throw new Error('Некорректный Groth16 proof.');
    const proof = { a: point(raw.proof.a), b: raw.proof.b.map(point), c: point(raw.proof.c) };
    let authorization = null;
    if (this.isProofOnly) {
      if (raw.authorizationMode !== 'proof-only') throw new Error('Для этого Vault нужен публикационный пакет без разрешения оператора.');
      if (operations.some((record) => record.kind === '8')) throw new Error('Возврат резервирования запрещён для бессрочных прав выплаты.');
    } else {
      authorization = { deadline: publicationUint(raw.authorization?.deadline), signerEpoch: publicationUint(raw.authorization?.signerEpoch), signature: raw.authorization?.signature };
      if (typeof authorization.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(authorization.signature)) throw new Error('Некорректная подпись оператора ZK-публикации.');
    }
    return { ...raw, batch, publicSignals, operations, accountDA, poolDA, proof, authorization };
  }

  async zkTransitionAlreadyPublished(inputs) {
    const c = await this.crypto();
    await this.assertContext();
    if (BigInt(await this.vault.stateVersion()) < BigInt(inputs[1])) return false;
    const stored = await this.vault.transitions(inputs[1]);
    await this.assertContext();
    if (stored.length !== 13 || inputs.some((value, i) => c.field(value) !== c.field(stored[i]))) throw new Error('В контракте принят другой ZK-переход с этой версией.');
    return true;
  }

  async publishZkTransition(raw, onProgress = () => {}, ownReceipt, withdrawalClaim) {
    const ticket = await this.zkPublicationTicket(raw);
    const job = this.publicationQueue.then(() => this.publishPreparedZkTransition(ticket, onProgress, ownReceipt, withdrawalClaim));
    this.publicationQueue = job.catch(() => undefined);
    return job;
  }

  async publishPreparedZkTransition(ticket, onProgress, ownReceipt, withdrawalClaim) {
    const signals = ticket.publicSignals;
    const alreadyPublished = await this.#walletStep('check:publication', 'check', 'Проверить ZK-пакет и состояние Vault', async () => {
      const owner = await this.assertContext();
      const c = await this.crypto();
      if (await this.zkTransitionAlreadyPublished(signals)) return true;
      const block = await this.provider.getBlock('latest');
      if (!block) throw new Error('Не удалось прочитать актуальный блок для публикации.');
      const readAt = { blockTag: block.number ?? 'latest' };
      const [mode, version, domain, poolKeyCommit, currentVersion, currentRoot, cursor, tradeId] = await Promise.all([
        this.vault.proofMode(readAt), this.vault.ZK_VERSION(readAt), this.vault.domain(readAt), this.vault.poolKeyCommit(readAt), this.vault.stateVersion(readAt),
        this.vault.stateRoot(readAt), this.vault.inboxCursor(readAt), this.vault.nextTradeId(readAt),
      ]);
      await this.assertContext();
      if (mode !== 'groth16-bn254-v2' || BigInt(version) !== 2n || c.field(domain) !== BigInt(signals[0])
        || c.field(poolKeyCommit) !== BigInt(signals[12])) throw new Error('Не совпадает версия ZK Vault или домен доказательства.');
      if (BigInt(currentVersion) + 1n !== BigInt(signals[1]) || c.field(currentRoot) !== BigInt(signals[3])
        || BigInt(cursor) !== BigInt(signals[5]) || BigInt(tradeId) !== BigInt(signals[7])) throw new Error('ZK-переход устарел. Обновите готовый пакет.');
      let operator;
      if (this.isProofOnly) {
        if (await this.vault.withdrawalMode(readAt) !== 'proven-reservation-v1') throw new Error('Vault использует другой режим выплаты.');
      } else {
        const [currentOperator, epoch] = await Promise.all([this.vault.operator(readAt), this.vault.signerEpoch(readAt)]);
        operator = currentOperator;
        if (BigInt(ticket.authorization.deadline) < BigInt(block.timestamp) || BigInt(ticket.authorization.signerEpoch) !== BigInt(epoch)) throw new Error('Разрешение публикации истекло или сменилось. Обновите готовый пакет.');
      }
      // Verify immutable verifier/Poseidon code identities against actual RPC code.
      const [verifier, verifierHash, poseidon, poseidonHash] = await Promise.all([
        this.vault.verifier(), this.vault.verifierCodeHash(), this.vault.poseidon2(), this.vault.poseidonCodeHash(),
      ]);
      for (const [address, expectedHash] of [[verifier, verifierHash], [poseidon, poseidonHash]]) {
        const code = await this.provider.getCode(address);
        if (code === '0x' || keccak256(code).toLowerCase() !== expectedHash.toLowerCase()) throw new Error('Код verifier/Poseidon не совпадает с закреплённым контрактом.');
      }
      const publicationDomain = { name: 'RubaZkPublication', version: '2', chainId: BigInt(this.config.chainId), verifyingContract: this.config.vaultAddress };
      const headerDigest = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(['uint256[13]'], [signals]))).toString();
      if (!this.isProofOnly && verifyTypedData(publicationDomain, ZK_PUBLICATION_TYPES, { headerDigest,
        deadline: ticket.authorization.deadline, signerEpoch: ticket.authorization.signerEpoch }, ticket.authorization.signature) !== getAddress(operator)) throw new Error('Некорректная подпись оператора ZK-пакета.');
      const operationDomain = { ...publicationDomain, name: 'RubaZkOperation' };
      for (const record of ticket.operations) {
        if ([1, 3, 4, 5, 6, 8].includes(Number(record.kind))) {
          if (this.isProofOnly && record.kind === '8') throw new Error('Возврат резервирования запрещён.');
          const expected = Number(record.kind) === 8 ? getAddress(operator) : record.owner;
          if (operationSigner(operationDomain, record.commitment, record.signature) !== expected) throw new Error('Нет корректного согласия владельца на ZK-операцию.');
        }
        if (record.owner === owner && [1, 3, 4, 5, 6].includes(Number(record.kind))) {
          const saved = this.zkAuthorizations.find((item) => item.commitment === record.commitment);
          if (saved && saved.signature !== record.signature) throw new Error('Подпись собственной операции была подменена.');
        }
      }
      if (withdrawalClaim && (!this.isProofOnly || !ticket.operations.some((record) => record.kind === '6'
        && BigInt(record.commitment) === BigInt(withdrawalClaim.commitment) && record.owner === owner))) throw new Error('Пакет не содержит авторизованного права выплаты.');
      if (ownReceipt) {
        const leaf = c.hashReceiptV2(ownReceipt);
        let root = leaf;
        const index = Number(BigInt(ownReceipt.tradeId) - BigInt(signals[7]));
        if (index < 0 || index >= Number(ticket.batch.tradeCount) || !Array.isArray(ownReceipt.proof) || ownReceipt.proof.length !== 2
          || getAddress(ownReceipt.account ?? ownReceipt.owner) !== owner || BigInt(ownReceipt.chainId) !== BigInt(this.config.chainId)
          || getAddress(ownReceipt.vault) !== getAddress(this.config.vaultAddress) || c.field(ownReceipt.leaf) !== leaf) throw new Error('Собственная квитанция не соответствует ZK-пакету.');
        for (let i = 0; i < 2; i++) root = (index >> i) & 1 ? c.H(ownReceipt.proof[i], root) : c.H(root, ownReceipt.proof[i]);
        if (root !== BigInt(signals[9])) throw new Error('Квитанция не включена в ZK-пакет.');
      }
      return false;
    });
    if (alreadyPublished) return { status: 'already-published' };
    onProgress('Подтвердите публикацию ZK-перехода. Кошелёк оплачивает газ, контракт проверит Groth16 proof.');
    await this.assertContext();
    const title = withdrawalClaim ? 'Опубликовать доказательство и вывести средства' : 'Опубликовать ZK-переход';
    return this.#walletStep('tx:publication', 'transaction', title, async (update) => {
      let transaction;
      try {
        const args = [signals, ticket.operations.map(({ reference, ...record }) => ({ ...record, referenceId: reference })), ticket.accountDA, ticket.poolDA, ticket.proof];
        transaction = this.isProofOnly
          ? withdrawalClaim
            ? await this.vault.publishProvenTransitionAndWithdraw(...args, withdrawalClaim.withdrawal)
            : await this.vault.publishProvenTransition(...args)
          : await this.vault.publishZkTransition(...args, ticket.authorization);
      } catch (error) {
        if (walletRejected(error)) throw Object.assign(new Error('Вы отменили публикацию в кошельке.'), { code: 'ACTION_REJECTED' });
        try { if (await this.zkTransitionAlreadyPublished(signals)) return { status: 'already-published' }; } catch { /* Read did not establish acceptance. */ }
        if (['CALL_EXCEPTION', 'INSUFFICIENT_FUNDS', 'INVALID_ARGUMENT'].includes(error?.code)) throw error;
        return { status: 'submitted', transactionHash: transactionHash(error?.transactionHash ?? error?.hash) };
      }
      const hash = transactionHash(transaction?.hash);
      update('Транзакция отправлена. Ждём принятия ZK-перехода.');
      try {
        const receipt = await waitForPublication(transaction, this.publicationWaitMs);
        if (Number(receipt?.status) === 0) throw Object.assign(new Error('ZK-публикация отклонена контрактом.'), { receipt });
        if (await this.zkTransitionAlreadyPublished(signals)) {
          const minedHash = transactionHash(receipt?.hash ?? receipt?.transactionHash);
          return Number(receipt?.status) === 1 && hash && minedHash?.toLowerCase() === hash.toLowerCase()
            ? { status: 'published', transactionHash: hash } : { status: 'already-published' };
        }
        return { status: 'submitted', transactionHash: hash };
      } catch (error) {
        try { if (await this.zkTransitionAlreadyPublished(signals)) return { status: 'already-published' }; } catch { /* Unknown acceptance remains unknown. */ }
        if (Number(error?.receipt?.status) === 0) throw error;
        if (error?.code === 'TRANSACTION_REPLACED' && error.cancelled) throw Object.assign(new Error('Публикация отменена.'), { code: 'ACTION_REJECTED' });
        return { status: 'submitted', transactionHash: hash };
      }
    });
  }

  getAccount() {
    // Keep the combined read and proof/cache validation on the same nonce queue
    // as other owner actions. The old-server fallback must not enqueue itself.
    const job = this.queue.then(() => this.readAccountUnqueued());
    this.queue = job.catch(() => undefined);
    return job;
  }

  async readAccountUnqueued() {
    const snapshot = await this.executeSignedAction({ kind: 'account' });
    if (this.isZk) {
      const proof = Object.hasOwn(snapshot, 'zkProof')
        ? await this.acceptZkState(snapshot.zkProof)
        : await this.readZkStateUnqueued();
      // The verified/pending tree is authoritative for displayed balances.
      snapshot.balances = { RUBA: proof.account[1], USDT: proof.account[2] };
      snapshot.lpShares = proof.account[3];
      snapshot.zkProof = proof;
      if (this.hasProvenWithdrawals) {
        await this.loadRecoveryCache();
        snapshot.withdrawals ??= [];
        for (const claim of this.withdrawalClaims) {
          const checked = await this.validateProvenWithdrawalTicket({ kind: 'zk-withdrawal', ...claim });
          const status = await this.provenClaimStatus(checked);
          const knownReserved = status.accepted || this.currentWithdrawalCommitments.has(BigInt(checked.commitment).toString());
          const existing = snapshot.withdrawals.find((record) => BigInt(record.nonce) === BigInt(checked.withdrawal.nonce));
          if (existing && knownReserved) { existing.proven = true; existing.commitment = checked.commitment; if (status.spent) existing.status = 'settled'; }
          else if (!existing) snapshot.withdrawals.push({ account: checked.withdrawal.account, token: getAddress(checked.withdrawal.token) === getAddress(this.config.tokens.RUBA.address) ? 'RUBA' : 'USDT',
            tokenAddress: checked.withdrawal.token, amount: checked.withdrawal.amount, nonce: checked.withdrawal.nonce,
            status: status.spent ? 'settled' : knownReserved ? 'pending' : 'draft', proven: true, commitment: checked.commitment });
        }
      }
    }
    return snapshot;
  }

  async getPublicationRequest() {
    const title = this.isZk ? 'Проверить готовность доказательства к публикации' : 'Проверить очередь публикации';
    return this.#walletStep('check:publication-queue', 'check', title, async () => {
      await this.assertContext();
      const body = await requestJson(this.fetchImpl, '/publication', {}, this.isZk ? 120_000 : 20_000);
      await this.assertContext();
      if (!body || !['ready', 'waiting', 'idle'].includes(body.status)
        || body.progress?.required !== 4 || !Number.isInteger(body.progress?.collected)
        || body.progress.collected < 0 || body.progress.collected > 4) throw new Error('Сервер вернул некорректный статус публикации.');
      if (body.status === 'ready') return { ...body, request: this.isZk ? await this.zkPublicationTicket(body.request) : publicationTicket(body.request, this.config) };
      if (body.request !== null) throw new Error('Незавершённый пакет не должен содержать разрешение на публикацию.');
      return { status: body.status, request: null, progress: body.progress };
    });
  }

  async publishBatch(rawTicket, onProgress = () => {}, receipt) {
    if (this.isZk) return this.publishZkTransition(rawTicket, onProgress, receipt);
    const ticket = publicationTicket(rawTicket, this.config);
    const ownReceipt = receipt === undefined ? undefined : structuredClone(receipt);
    const job = this.publicationQueue.then(() => this.publishPreparedBatch(ticket, onProgress, ownReceipt));
    this.publicationQueue = job.catch(() => undefined);
    return job;
  }

  async batchAlreadyPublished(batch) {
    if (this.isZk && batch?.publicSignals) return this.zkTransitionAlreadyPublished(batch.publicSignals);
    await this.assertContext();
    if (BigInt(await this.vault.lastBatchId()) < BigInt(batch.batchId)) return false;
    const stored = await this.vault.batches(batch.batchId);
    await this.assertContext();
    if (!sameBatch(stored, batch)) throw new Error('В контракте уже записан другой пакет с этим номером. Обновите состояние.');
    return true;
  }

  async publishPreparedBatch(ticket, onProgress, ownReceipt) {
    const { batch, deadline, signerEpoch, signature } = ticket;
    const alreadyPublished = await this.#walletStep('check:publication', 'check', 'Проверить пакет сделок и состояние Vault', async () => {
      const account = await this.assertContext();
      if (ownReceipt !== undefined) {
        const bundle = parseDisclosure(JSON.stringify({ format: 'ruba-trade-disclosure', version: 1,
          receipt: ownReceipt, batch, tokens: this.config.tokens }, (_key, field) => typeof field === 'bigint' ? field.toString() : field));
        if (bundle.receipt.account !== account || bundle.receipt.chainId !== BigInt(this.config.chainId)
          || bundle.receipt.vault !== getAddress(this.config.vaultAddress) || !inspectDisclosure(bundle).valid) {
          throw new Error('Квитанция вашей сделки не соответствует разрешению на публикацию.');
        }
      }
      if (await this.batchAlreadyPublished(batch)) return true;
      const block = await this.provider.getBlock('latest');
      if (!block) throw new Error('Не удалось прочитать состояние сети.');
      const blockTag = block.number ?? 'latest';
      const [operator, currentEpoch, lastBatchId, lastTradeId, stateRoot] = await Promise.all([
        this.vault.operator({ blockTag }), this.vault.signerEpoch({ blockTag }),
        this.vault.lastBatchId({ blockTag }), this.vault.lastTradeId({ blockTag }), this.vault.stateRoot({ blockTag }),
      ]);
      await this.assertContext();
      if (BigInt(lastBatchId) >= BigInt(batch.batchId)) {
        if (await this.batchAlreadyPublished(batch)) return true;
      }
      if (BigInt(batch.batchId) !== BigInt(lastBatchId) + 1n || BigInt(batch.firstTradeId) !== BigInt(lastTradeId) + 1n
        || batch.previousStateRoot !== bytes32(stateRoot)) throw new Error('Состояние публикации устарело. Обновите запрос перед отправкой.');
      if (BigInt(signerEpoch) !== BigInt(currentEpoch)) throw new Error('Эпоха подписи публикации устарела. Обновите запрос.');
      if (BigInt(deadline) < BigInt(block.timestamp)) throw new Error('Срок публикации истёк. Обновите запрос.');
      const domain = { name: 'RubaVault', version: '1', chainId: BigInt(this.config.chainId), verifyingContract: this.config.vaultAddress };
      if (verifyTypedData(domain, BATCH_PUBLICATION_TYPES, { ...batch, deadline, signerEpoch }, signature) !== getAddress(operator)) {
        throw new Error('Подпись оператора не соответствует пакету публикации.');
      }
      return false;
    });
    if (alreadyPublished) return { status: 'already-published' };
    onProgress('Подтвердите публикацию пакета в кошельке. Газ оплачивается вашим кошельком.');
    await this.assertContext();
    return this.#walletStep('tx:publication', 'transaction', 'Опубликовать пакет сделок', async (update) => {
      let transaction;
      try {
        // Only this fixed ABI call is allowed; no server-provided target/value/calldata is executed.
        transaction = await this.vault.publishSignedBatch(batch, deadline, signerEpoch, signature);
      } catch (error) {
        if (walletRejected(error)) {
          if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') throw error;
          throw Object.assign(new Error('Вы отменили публикацию в кошельке.'), { code: 'ACTION_REJECTED' });
        }
        try { if (await this.batchAlreadyPublished(batch)) return { status: 'already-published' }; }
        catch { /* A failed read cannot establish publication. */ }
        if (['INSUFFICIENT_FUNDS', 'CALL_EXCEPTION', 'INVALID_ARGUMENT'].includes(error?.code)) throw error;
        return { status: 'submitted', transactionHash: transactionHash(error?.transactionHash ?? error?.hash) };
      }
      const hash = transactionHash(transaction?.hash);
      update('Транзакция отправлена. Ждём принятия пакета.');
      onProgress(hash ? `Транзакция публикации отправлена: ${hash}. Ждём подтверждения.` : 'Ожидаем подтверждения публикации в сети.');
      try {
        const result = await waitForPublication(transaction, this.publicationWaitMs);
        if (result && Number(result.status) === 0) throw Object.assign(new Error('Транзакция публикации отклонена. Обновите состояние.'), { code: 'CALL_EXCEPTION', receipt: result });
        if (await this.batchAlreadyPublished(batch)) {
          const receiptHash = transactionHash(result?.hash ?? result?.transactionHash);
          if (Number(result?.status) === 1 && hash && receiptHash?.toLowerCase() === hash.toLowerCase()) {
            return { status: 'published', transactionHash: hash };
          }
          return { status: 'already-published' };
        }
        return { status: 'submitted', transactionHash: hash };
      } catch (error) {
        try {
          if (await this.batchAlreadyPublished(batch)) return { status: 'already-published' };
        } catch { /* Unknown status is never shown as a successful publication. */ }
        if (error?.receipt && Number(error.receipt.status) === 0) throw error;
        if (error?.code === 'TRANSACTION_REPLACED' && error.cancelled) {
          throw Object.assign(new Error('Публикация отменена или заменена другой транзакцией. Обновите состояние.'), { code: 'ACTION_REJECTED' });
        }
        return { status: 'submitted', transactionHash: hash };
      }
    });
  }

  async getDisclosure(rawTradeId) {
    const tradeId = checkedUint(rawTradeId);
    if (tradeId === 0n) throw new Error('Укажите положительный номер сделки.');
    const bundle = await this.signedAction({ kind: 'disclosure', tradeId: tradeId.toString() });
    const account = await this.assertContext();
    if (bundle?.format !== 'ruba-trade-disclosure' || bundle.version !== (this.isZk ? 2 : 1)
        || !bundle.receipt || !bundle.batch) throw new Error('Сервер вернул некорректную квитанцию.');
    if (getAddress(bundle.receipt.account) !== account) throw new Error('Квитанция принадлежит другому кошельку.');
    if (checkedUint(bundle.receipt.tradeId) !== tradeId) throw new Error('Сервер вернул другую сделку.');
    if (checkedUint(bundle.receipt.chainId) !== BigInt(this.config.chainId)
        || getAddress(bundle.receipt.vault) !== this.config.vaultAddress) throw new Error('Квитанция относится к другой сети или хранилищу.');
    if (checkedUint(bundle.receipt.batchId) !== checkedUint(bundle.batch.batchId)) throw new Error('Квитанция относится к другому пакету.');
    if (Object.hasOwn(bundle.batch, 'stateSalt') || Object.hasOwn(bundle.batch, 'stateSnapshot')) {
      throw new Error('Квитанция содержит лишние приватные данные состояния.');
    }
    if (this.isZk && !(await inspectDisclosureText(JSON.stringify(bundle))).valid) throw new Error('ZK-квитанция не соответствует Poseidon-корню пакета.');
    return bundle;
  }

  async deposit(token, rawAmount, onProgress = () => {}) {
    const amount = checkedUint(rawAmount);
    if (!amount) throw new Error('Сумма должна быть больше нуля.');
    if (this.isZk && amount >= 1n << 96n) throw new Error('Сумма пополнения превышает диапазон ZK-схемы (96 бит).');
    const contract = this.token(token);
    const symbol = this.config.tokens[token].symbol ?? token;
    const amountLabel = `${formatAmount(amount, this.config.tokens[token].decimals)} ${symbol}`;
    const checkAdmission = async () => {
      const status = await this.getMarketStatus();
      if (!status.whitelisted) throw new Error('Account is not whitelisted');
      if (status.marketPaused) throw new Error('Market is paused');
    };
    await this.#walletStep('check:deposit-admission', 'check', 'Проверить допуск к пополнению и паузу рынка', checkAdmission);
    if (this.isZk) await this.ensureZkRegistration(onProgress);
    if (this.hasProvenWithdrawals) {
      await this.#walletStep('check:registered-vault', 'check', 'Проверить регистрацию баланса в Vault', async () => {
        const [registeredSlot, paused] = await Promise.all([this.vault.ownerSlotPlusOne(await this.assertContext()), this.vault.marketPaused()]);
        if (BigInt(registeredSlot) === 0n) throw new Error('Сначала подтвердите регистрацию. Разрешение и перевод токенов не отправлены.');
        if (paused) throw new Error('Market is paused');
      });
    }
    // Registration may publish a transaction. Re-read admission before any
    // approval, because the owner can revoke access while it is pending.
    await checkAdmission();
    const allowance = await this.#walletStep('check:allowance', 'check', `Проверить разрешённую сумму ${symbol}`, async () => {
      const account = await this.assertContext();
      return BigInt(await contract.allowance(account, this.config.vaultAddress));
    });
    if (allowance < amount) {
      // USDT requires resetting an existing nonzero allowance before changing it.
      if (allowance > 0n) {
        onProgress('Подтвердите сброс предыдущего разрешения в кошельке.');
        await this.assertContext();
        await this.#walletStep('tx:reset-allowance', 'transaction', `Сбросить разрешение на перевод ${symbol}`, async (update) => {
          const transaction = await contract.approve(this.config.vaultAddress, 0n);
          update('Транзакция отправлена. Ждём подтверждения сброса.');
          return transaction.wait();
        });
      }
      onProgress('Разрешите перевод указанной суммы токенов в кошельке.');
      await this.assertContext();
      await this.#walletStep('tx:approve', 'transaction', `Разрешить перевод ${amountLabel}`, async (update) => {
        const transaction = await contract.approve(this.config.vaultAddress, amount);
        update('Транзакция отправлена. Ждём подтверждения разрешения.');
        return transaction.wait();
      });
    }
    onProgress('Подтвердите пополнение в кошельке.');
    await this.assertContext();
    // An approval does not authorize a deposit after admission is revoked.
    await checkAdmission();
    return this.#walletStep('tx:deposit', 'transaction', `Пополнить баланс обменника на ${amountLabel}`, async (update) => {
      const transaction = await this.vault.deposit(this.config.tokens[token].address, amount);
      onProgress('Ждём подтверждения пополнения в сети.');
      update('Транзакция отправлена. Ждём пополнения в сети.');
      return transaction.wait();
    });
  }

  async redeemWithdrawal(ticket, onProgress = () => {}) {
    if (this.hasProvenWithdrawals) {
      const snapshot = structuredClone(ticket);
      const job = this.redemptionQueue.then(() => this.redeemProvenWithdrawal(snapshot, onProgress));
      this.redemptionQueue = job.catch(() => undefined);
      return job;
    }
    const withdrawal = await this.#walletStep('check:withdrawal', 'check', 'Проверить разрешение на вывод', async () => {
      const account = await this.assertContext();
      if (!ticket?.withdrawal || typeof ticket.signature !== 'string') throw new Error('Некорректное разрешение на вывод.');
      const withdrawal = ticket.withdrawal;
      const expectedKeys = 'account,amount,deadline,nonce,signerEpoch,token';
      if (Object.keys(withdrawal).sort().join(',') !== expectedKeys) throw new Error('Некорректные поля разрешения на вывод.');
      if (getAddress(withdrawal.account) !== account) throw new Error('Разрешение выдано другому кошельку.');
      const token = ['RUBA', 'USDT'].find((symbol) => this.config.tokens[symbol].address === getAddress(withdrawal.token));
      if (!token) throw new Error('Неизвестный токен в разрешении.');
      if (checkedUint(withdrawal.amount) === 0n) throw new Error('Сумма вывода должна быть больше нуля.');
      for (const field of ['nonce', 'deadline', 'signerEpoch']) checkedUint(withdrawal[field]);
      const [operator, epoch, used, status] = await Promise.all([
        this.vault.operator(), this.vault.signerEpoch(),
        this.vault.usedWithdrawalNonces(account, withdrawal.nonce), this.getMarketStatus(),
      ]);
      if (status.withdrawalsPaused[token]) throw new Error('Withdrawals for this token are paused');
      if (used) throw new Error('WithdrawalAlreadyUsed');
      if (BigInt(withdrawal.signerEpoch) !== BigInt(epoch)) throw new Error('Withdrawal signer epoch is obsolete');
      if (BigInt(withdrawal.deadline) < status.timestamp) throw new Error('Withdrawal expired');
      const domain = { name: 'RubaVault', version: '1', chainId: BigInt(this.config.chainId), verifyingContract: this.config.vaultAddress };
      if (verifyTypedData(domain, WITHDRAWAL_TYPES, withdrawal, ticket.signature) !== getAddress(operator)) throw new Error('Подпись оператора не соответствует разрешению.');
      return withdrawal;
    });
    onProgress('Подтвердите вывод токенов в кошельке.');
    await this.assertContext();
    return this.#walletStep('tx:withdrawal', 'transaction', 'Вывести токены на кошелёк', async (update) => {
      const transaction = await this.vault.withdraw(withdrawal, ticket.signature);
      onProgress('Ждём подтверждения вывода в сети.');
      update('Транзакция отправлена. Ждём выплаты в сети.');
      return transaction.wait();
    });
  }

  async validateProvenWithdrawalTicket(ticket, expectedCommitment) {
    const c = await this.crypto();
    const owner = await this.assertContext();
    if (!this.hasProvenWithdrawals || ticket?.kind !== 'zk-withdrawal' || BigInt(ticket.chainId) !== BigInt(this.config.chainId)
      || getAddress(ticket.vault) !== getAddress(this.config.vaultAddress)) throw new Error('Заявка относится к другому режиму, владельцу или Vault.');
    const opening = ticket.withdrawal;
    if (!opening || Object.keys(opening).sort().join(',') !== 'account,amount,nonce,salt,spendNonce,token') throw new Error('Некорректные поля открытия права выплаты.');
    if (getAddress(opening.account) !== owner) throw new Error('Право выплаты принадлежит другому владельцу.');
    const token = ['RUBA', 'USDT'].find((name) => getAddress(this.config.tokens[name].address) === getAddress(opening.token));
    if (!token) throw new Error('Неизвестный токен выплаты.');
    const amount = checkedUint(opening.amount), nonce = checkedUint(opening.nonce), spendNonce = checkedUint(opening.spendNonce), salt = c.field(opening.salt);
    if (amount === 0n || amount >= 1n << 96n || nonce !== spendNonce || nonce >= 1n << 64n || salt === 0n) throw new Error('Открытие выплаты нарушает диапазон или nonce доказанного резервирования.');
    const domain = c.field(await this.vault.domain());
    const ownerSlotPlusOne = BigInt(await this.vault.ownerSlotPlusOne(owner));
    const slot = ownerSlotPlusOne ? ownerSlotPlusOne - 1n : this.zkState?.slot;
    if (slot === undefined || slot >= 16n) throw new Error('Не удалось определить зарегистрированный слот владельца.');
    const commitment = c.hashOperation(domain, 6, slot, owner, spendNonce, [token === 'RUBA' ? 0n : 1n, amount, nonce, 0n], salt);
    if (commitment !== c.field(ticket.commitment) || (expectedCommitment !== undefined && commitment !== c.field(expectedCommitment))) throw new Error('Открытие не соответствует локально подписанному commitment выплаты.');
    const normalized = { account: owner.toLowerCase(), token: this.config.tokens[token].address.toLowerCase(), amount: amount.toString(),
      nonce: nonce.toString(), spendNonce: spendNonce.toString(), salt: salt.toString() };
    const existing = this.withdrawalClaims.find((item) => c.field(item.commitment) === commitment);
    if (existing && Object.keys(normalized).some((key) => String(existing.withdrawal[key]).toLowerCase() !== normalized[key].toLowerCase())) throw new Error('Сервер подменил сохранённое открытие выплаты.');
    const record = { chainId: String(this.config.chainId), vault: this.config.vaultAddress.toLowerCase(), domain: c.fieldHex(domain), slot: slot.toString(),
      commitment: c.fieldHex(commitment), withdrawal: normalized, stateVersion: ticket.stateVersion == null ? null : checkedUint(ticket.stateVersion).toString(),
      ...(existing?.signature ? { signature: existing.signature } : {}) };
    this.withdrawalClaims = [...this.withdrawalClaims.filter((item) => c.field(item.commitment) !== commitment), record];
    await this.saveRecoveryCache();
    return record;
  }

  getCachedWithdrawalTicket(nonce, commitment) {
    const claim = this.withdrawalClaims.findLast((record) => BigInt(record.withdrawal.nonce) === BigInt(nonce)
      && (commitment === undefined || BigInt(record.commitment) === BigInt(commitment)));
    return claim ? { kind: 'zk-withdrawal', ...structuredClone(claim) } : null;
  }

  async provenClaimStatus(claim) {
    const [spent, stored] = await Promise.all([
      this.vault.spentWithdrawalCommitments(claim.commitment), this.vault.withdrawalClaims(claim.commitment),
    ]);
    await this.assertContext();
    const owner = getAddress(stored.owner ?? stored[0]);
    const slot = BigInt(stored.slot ?? stored[1]);
    const stateVersion = BigInt(stored.stateVersion ?? stored[2]);
    if (owner !== '0x' + '00'.repeat(20) && (owner !== getAddress(claim.withdrawal.account) || slot !== BigInt(claim.slot) || stateVersion === 0n)) throw new Error('В контракте сохранено другое право выплаты.');
    return { spent, accepted: owner !== '0x' + '00'.repeat(20), stateVersion };
  }

  async redeemProvenWithdrawal(ticket, onProgress) {
    await this.loadRecoveryCache();
    const claim = await this.#walletStep('check:proven-withdrawal', 'check', 'Проверить заявку на выплату', async () => {
      const checked = await this.validateProvenWithdrawalTicket(ticket);
      if (await this.vault.withdrawalMode() !== 'proven-reservation-v1') throw new Error('Vault использует другой режим вывода.');
      return checked;
    });
    return this.#walletStep('sequence:proven-payout', 'sequence', 'Опубликовать нужные доказательства и получить выплату', async () => {
      for (let i = 0; i < 32; i++) {
        const status = await this.provenClaimStatus(claim);
        if (status.spent) return { status: 'already-withdrawn', commitment: claim.commitment };
        if (status.accepted) return this.sendAcceptedProvenWithdrawal(claim, onProgress);
        const offer = await this.getPublicationRequest();
        if (offer.status !== 'ready') return { status: 'waiting', commitment: claim.commitment,
          message: offer.progress.collected > 0
            ? `Резервирование сохранено. Ожидается подготовка закрытого пакета: ${offer.progress.collected} из 4 обменов. Не повторяйте резервирование.`
            : 'Резервирование сохранено и ожидает готового доказательства. Обновите заявку позже; повторять резервирование не нужно.' };
        const includesClaim = offer.request.operations.some((operation) => operation.kind === '6' && BigInt(operation.commitment) === BigInt(claim.commitment));
        onProgress(includesClaim ? 'Публикуем доказанное резервирование и выплату одной транзакцией.' : 'Сначала публикуем предшествующий доказанный переход.');
        const publication = await this.publishZkTransition(offer.request, onProgress, undefined, includesClaim ? claim : undefined);
        let after;
        try { after = await this.provenClaimStatus(claim); }
        catch { return { status: 'submitted', commitment: claim.commitment, ...(publication.transactionHash ? { transactionHash: publication.transactionHash } : {}) }; }
        if (after.spent) return { status: publication.status === 'published' && includesClaim ? 'withdrawn' : 'already-withdrawn', commitment: claim.commitment,
          ...(publication.status === 'published' && includesClaim && publication.transactionHash ? { transactionHash: publication.transactionHash } : {}) };
        if (publication.status === 'submitted') return { ...publication, commitment: claim.commitment };
      }
      return { status: 'waiting', commitment: claim.commitment, message: 'Предшествующие переходы опубликованы. Продолжите выплату из сохранённой заявки.' };
    });
  }

  async sendAcceptedProvenWithdrawal(claim, onProgress) {
    const spent = await this.#walletStep('check:saved-payout', 'check', 'Проверить доступность сохранённой выплаты', async () => {
      if (await this.vault.withdrawalsPaused(claim.withdrawal.token)) throw new Error('Withdrawals for this token are paused');
      return (await this.provenClaimStatus(claim)).spent;
    });
    if (spent) return { status: 'already-withdrawn', commitment: claim.commitment };
    onProgress('Подтвердите погашение доказанного права. Подпись оператора не требуется.');
    await this.assertContext();
    return this.#walletStep('tx:saved-payout', 'transaction', 'Получить выплату на кошелёк', async (update) => {
      let transaction;
      try { transaction = await this.vault.withdrawProven(claim.withdrawal); }
      catch (error) {
        if (walletRejected(error)) throw Object.assign(new Error('Вы отменили выплату в кошельке.'), { code: 'ACTION_REJECTED' });
        try { if ((await this.provenClaimStatus(claim)).spent) return { status: 'already-withdrawn', commitment: claim.commitment }; } catch { /* Unknown chain status preserves the saved opening. */ }
        if (['CALL_EXCEPTION', 'INSUFFICIENT_FUNDS', 'INVALID_ARGUMENT'].includes(error?.code)) throw error;
        return { status: 'submitted', commitment: claim.commitment, transactionHash: transactionHash(error?.transactionHash ?? error?.hash) };
      }
      const hash = transactionHash(transaction?.hash);
      update('Транзакция отправлена. Ждём выплаты в сети.');
      try {
        const receipt = await waitForPublication(transaction, this.publicationWaitMs);
        if (Number(receipt?.status) === 0) throw Object.assign(new Error('Выплата отклонена контрактом.'), { receipt });
        if ((await this.provenClaimStatus(claim)).spent) {
          const minedHash = transactionHash(receipt?.hash ?? receipt?.transactionHash);
          return Number(receipt?.status) === 1 && hash && minedHash?.toLowerCase() === hash.toLowerCase()
            ? { status: 'withdrawn', commitment: claim.commitment, transactionHash: hash }
            : { status: 'already-withdrawn', commitment: claim.commitment };
        }
        return { status: 'submitted', commitment: claim.commitment, transactionHash: hash };
      } catch (error) {
        try { if ((await this.provenClaimStatus(claim)).spent) return { status: 'already-withdrawn', commitment: claim.commitment }; } catch { /* Keep the known transaction hash on a failed RPC read. */ }
        if (Number(error?.receipt?.status) === 0) throw error;
        if (error?.code === 'TRANSACTION_REPLACED' && error.cancelled) throw Object.assign(new Error('Выплата отменена.'), { code: 'ACTION_REJECTED' });
        return { status: 'submitted', commitment: claim.commitment, transactionHash: hash };
      }
    });
  }
}
