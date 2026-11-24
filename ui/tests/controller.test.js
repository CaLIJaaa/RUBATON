import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { getAddress, ZeroAddress } from 'ethers';
import * as model from '../model.js';
import * as marketModel from '../markets.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
// Run the real controller body with a small DOM/wallet boundary. The production
// model helpers stay real; only imports for browser transport are substituted.
const controller = readFileSync(new URL('../app.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '');

test('controller confirms entry without a wallet, gates operations and rejects stale wallet responses', { timeout: 5_000 }, async (t) => {
  const createdElements = [];

  class Element {
    constructor(tag = 'div', attributes = '') {
      this.tagName = tag;
      this.attributes = attributes;
      this.attributeMap = new Map([...attributes.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)]
        .map((match) => [match[1], match[2] ?? '']));
      this.listeners = {};
      this.dataset = {};
      for (const [name, value] of this.attributeMap) {
        if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_all, character) => character.toUpperCase())] = value;
      }
      this.children = [];
      this.textContent = '';
      this.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] ?? '';
      this.hidden = /\bhidden\b/.test(attributes);
      this.disabled = /\bdisabled\b/.test(attributes);
      this.inert = /\binert\b/.test(attributes);
      this.open = this.attributeMap.has('open');
      this.checked = false;
      createdElements.push(this);
    }

    addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
    async fire(type, options = {}) {
      const event = { type, target: this, currentTarget: this, ...options, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
      for (const callback of this.listeners[type] ?? []) await callback(event);
      const href = this.getAttribute('href');
      if (type === 'click' && !event.defaultPrevented && href?.startsWith('#/')) {
        context.location.hash = href;
        windowEvents.hashchange?.();
      }
      await flush();
      return event;
    }
    hasAttribute(name) { return this.attributeMap.has(name); }
    getAttribute(name) { return this.attributeMap.get(name) ?? null; }
    setAttribute(name, value) {
      this.attributeMap.set(name, String(value));
      if (name === 'tabindex') this.tabIndex = Number(value);
    }
    removeAttribute(name) { this.attributeMap.delete(name); }
    replaceChildren(...children) { this.children = [...children]; this.textContent = ''; }
    append(...children) { this.children.push(...children); }
    click() { downloads.push({ href: this.href, name: this.download }); }
    showModal() { this.open = true; }
    close() {
      if (!this.open) return;
      this.open = false;
      void this.fire('close');
    }
    remove() { this.removed = true; }
  }

  const elements = new Map([...html.matchAll(/<([a-z0-9]+)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)]
    .map((match) => [match[3], new Element(match[1], match[2])]));
  const element = (id) => {
    const result = elements.get(id);
    assert.ok(result, `The HTML must contain #${id}`);
    return result;
  };
  const pages = ['entry', 'swap', 'liquidity', 'account', 'disclosure', 'admin'].map((page) => {
    const section = element(`page-${page}`);
    section.dataset.page = page;
    return section;
  });
  const fieldsets = [...html.matchAll(/<fieldset\b([^>]*)>/gi)]
    .map((match) => {
      const id = match[1].match(/\bid="([^"]+)"/)?.[1];
      return id ? element(id) : new Element('fieldset', match[1]);
    });
  const walletFieldsets = fieldsets.filter((fieldset) => fieldset.hasAttribute('data-requires-wallet'));
  const inputFieldsets = walletFieldsets.filter((fieldset) => !fieldset.getAttribute('id'));
  const navigation = [...html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i)[1].matchAll(/<a\b([^>]*)>/gi)]
    .map((match) => {
      const id = match[1].match(/\bid="([^"]+)"/)?.[1];
      return id ? element(id) : new Element('a', match[1]);
    });
  const protectedNavigation = navigation.filter((anchor) => anchor.hasAttribute('data-requires-entry'));
  const tradeNavigation = protectedNavigation.filter((anchor) => anchor.dataset.route !== 'admin');
  for (const [id, value] of Object.entries({
    'swap-token-in': 'RUBA', 'swap-slippage': '0.5',
    'withdraw-token': 'USDT', 'deposit-token': 'RUBA',
  })) element(id).value = value;

  const wallet = '0x0000000000000000000000000000000000000001';
  const config = {
    chainId: '31337', vaultAddress: '0x0000000000000000000000000000000000000010',
    tokens: { RUBA: { decimals: 18 }, USDT: { decimals: 6 } },
  };
  const snapshot = {
    account: wallet, balances: { RUBA: '100000000000000000000', USDT: '100000000' },
    lpShares: '1000000000000', withdrawals: [],
  };
  let rejectNextRefresh = false;
  let uncertainNextSwap = false;
  let deferredAccount;
  let deferredContext;
  let deferredConfig;
  let swaps = 0;
  let privateReads = 0;
  let walletBalanceReads = 0;
  let marketReads = 0;
  let disclosureReads = 0;
  let disclosureMounts = 0;
  let disclosureCollecting = true;
  let publicationOffer = { status: 'idle', request: null, progress: { collected: 0, required: 4 } };
  let nextSwapReceipt;
  let rejectNextPublication = false;
  let publicationResult = { status: 'published', transactionHash: '0x' + '34'.repeat(32) };
  let submittedReceipt = null;
  let confirmedPublication = false;
  let marketsCatalog = null;
  const marketConfigs = {};
  const marketSnapshots = {};
  const adminCommands = [];
  const vaultPolicies = new Map();
  const whitelistReads = [];
  const vaultAdminWrites = [];
  let nextAdminTx;
  let adminCloseResult;
  let publicationReads = 0;
  let reservations = 0;
  let payouts = 0;
  const publications = [];
  const downloads = [];
  const downloadedBlobs = [];
  const revokedUrls = [];

  function vaultPolicy(vault) {
    if (!vaultPolicies.has(vault)) vaultPolicies.set(vault, {
      owner: '0x0000000000000000000000000000000000000002',
      addresses: new Map([[wallet.toLowerCase(), true]]),
      marketPaused: false,
      withdrawalsPaused: { RUBA: false, USDT: false },
    });
    return vaultPolicies.get(vault);
  }

  function vaultAdminWrite(vault, operation, applyChange) {
    vaultAdminWrites.push({ vault, ...operation });
    const result = nextAdminTx ?? { status: 'confirmed', transactionHash: `0x${'aa'.repeat(32)}` };
    nextAdminTx = null;
    if (result.status === 'confirmed') applyChange(vaultPolicy(vault));
    return result;
  }

  const windowEvents = {};
  let selectedProvider;
  const providers = [];
  function makeProvider(label) {
    const listeners = new Map();
    const provider = {
      label,
      async request({ method }) { return method === 'eth_chainId' ? '0x7a69' : [wallet]; },
      on(type, callback) { (listeners.get(type) ?? (listeners.set(type, new Set()), listeners.get(type))).add(callback); windowEvents[type] = callback; },
      removeListener(type, callback) { listeners.get(type)?.delete(callback); if (windowEvents[type] === callback) delete windowEvents[type]; },
      emit(type, payload) { for (const callback of [...listeners.get(type) ?? []]) callback(payload); },
    };
    providers.push(provider);
    return provider;
  }
  selectedProvider = makeProvider('Test wallet A');
  let connectorResult;
  let connectorError;
  let connectorCancels = 0;
  let connectorDisconnects = 0;
  const connector = {
    async connect() {
      if (connectorError) { const error = connectorError; connectorError = null; throw error; }
      return connectorResult === undefined ? { provider: selectedProvider, label: selectedProvider.label } : await connectorResult;
    },
    cancel() { connectorCancels++; },
    async disconnect() { connectorDisconnects++; },
  };
  class BrowserProvider {
    constructor(provider) { this.transport = provider; }
    async send(method) { return this.transport.request({ method }); }
    async getNetwork() { return { chainId: 31337n }; }
    async getSigner() { return { getAddress: async () => wallet }; }
    async getTransactionReceipt() { return submittedReceipt; }
  }

  class RubaClient {
    constructor(clientConfig, _provider, _signer, { onWalletStep } = {}) {
      this.config = clientConfig;
      this.onWalletStep = onWalletStep;
    }
    dispose() { this.disposed = true; }
    async assertContext() { if (deferredContext) await deferredContext; return wallet; }
    async getMarketStatus() {
      marketReads += 1;
      const policy = vaultPolicy(this.config.vaultAddress);
      return { whitelisted: policy.addresses.get(wallet.toLowerCase()) ?? false,
        marketPaused: policy.marketPaused, withdrawalsPaused: { ...policy.withdrawalsPaused }, timestamp: 1_000n };
    }
    async getAdminStatus() {
      const { owner, marketPaused, withdrawalsPaused } = vaultPolicy(this.config.vaultAddress);
      return { owner, isOwner: owner.toLowerCase() === wallet.toLowerCase(), marketPaused, withdrawalsPaused: { ...withdrawalsPaused } };
    }
    async getWhitelist(address) {
      const vault = this.config.vaultAddress;
      whitelistReads.push({ vault, address });
      return vaultPolicy(vault).addresses.get(address.toLowerCase()) ?? false;
    }
    async setWhitelist(address, allowed) {
      return vaultAdminWrite(this.config.vaultAddress, { kind: 'whitelist', address, allowed }, (policy) => policy.addresses.set(address.toLowerCase(), allowed));
    }
    async setMarketPaused(paused) {
      return vaultAdminWrite(this.config.vaultAddress, { kind: 'market', paused }, (policy) => { policy.marketPaused = paused; });
    }
    async setTokenWithdrawalsPaused(token, paused) {
      return vaultAdminWrite(this.config.vaultAddress, { kind: 'withdrawals', token, paused }, (policy) => { policy.withdrawalsPaused[token] = paused; });
    }
    async getWalletBalances() { walletBalanceReads += 1; return { RUBA: 100n * 10n ** 18n, USDT: 10n * 10n ** BigInt(this.config.tokens.USDT.decimals) }; }
    async getAccount() {
      privateReads += 1;
      if (deferredAccount) return deferredAccount;
      if (rejectNextRefresh) {
        rejectNextRefresh = false;
        const error = new Error('user rejected');
        error.code = 4001;
        throw error;
      }
      return structuredClone(marketSnapshots[this.config?.marketId] ?? snapshot);
    }
    async getDisclosure(tradeId) {
      disclosureReads += 1;
      if (disclosureCollecting) {
        const error = new Error('Квитанция ещё не включена в пакет: собрано 1 из 4 сделок. После четвёртой сделки повторите загрузку.');
        error.status = 409;
        throw error;
      }
      return {
        format: 'ruba-trade-disclosure', version: 1,
        receipt: { tradeId, account: wallet, chainId: config.chainId, vault: config.vaultAddress, batchId: '1' },
        batch: { batchId: '1', receiptsRoot: '0x' + '12'.repeat(32) }, tokens: config.tokens,
      };
    }
    async getPublicationRequest() { publicationReads += 1; return structuredClone(publicationOffer); }
    async batchAlreadyPublished() { return confirmedPublication; }
    async publishBatch(ticket, onProgress, receipt) {
      publications.push({ ticket: structuredClone(ticket), receipt: receipt ? structuredClone(receipt) : undefined });
      onProgress('Подтвердите публикацию пакета в кошельке.');
      if (rejectNextPublication) {
        rejectNextPublication = false;
        const error = new Error('user rejected');
        error.code = 4001;
        throw error;
      }
      return structuredClone(publicationResult);
    }
    async redeemWithdrawal() { payouts++; return { status: 'waiting', message: 'Резервирование сохранено. Пакет содержит 2 из 4 обменов; повторять резервирование не нужно.' }; }
    async signedAction(operation) {
      if (operation.kind === 'withdraw') { reservations++; return { kind: 'zk-withdrawal', withdrawal: { nonce: '7' } }; }
      if (operation.kind === 'withdrawal') return { kind: 'zk-withdrawal', withdrawal: { nonce: operation.nonce } };
      if (operation.kind === 'quote') return { amountOut: '996006' };
      if (operation.kind === 'swap') {
        swaps += 1;
        if (uncertainNextSwap) {
          uncertainNextSwap = false;
          const error = new Error('Ответ потерян: операция могла выполниться.');
          error.uncertain = true;
          throw error;
        }
        if (nextSwapReceipt) {
          const receipt = nextSwapReceipt;
          nextSwapReceipt = null;
          return structuredClone(receipt);
        }
        return { amountOut: '996006', tradeId: '1', publication: { status: 'collecting', collected: 1, required: 4 } };
      }
      throw new Error(`Unexpected operation ${operation.kind}`);
    }
  }

  // A consent flag left by the previous UI version must not bypass the explicit
  // entry button when the wallet reconnects.
  const storage = new Map([[`ruba-entry:31337:${config.vaultAddress.toLowerCase()}:${wallet.toLowerCase()}`, 'confirmed']]);
  const context = vm.createContext({
    console, Date, BigInt, Blob, setTimeout, clearTimeout,
    URL: {
      createObjectURL(blob) { downloadedBlobs.push(blob); return `blob:test-${downloadedBlobs.length}`; },
      revokeObjectURL(url) { revokedUrls.push(url); },
    },
    document: {
      body: new Element('body'),
      getElementById: element,
      createElement: (tag) => new Element(tag),
      createElementNS: (_namespace, tag) => new Element(tag),
      querySelectorAll: (selector) => {
        if (selector === 'fieldset[data-requires-wallet]') return walletFieldsets;
        if (selector === '[data-page]') return pages;
        if (selector === '[data-pending-action]') return createdElements.filter((item) => item.dataset.pendingAction);
        if (selector === 'nav a[href^="#/"]') return navigation.filter((anchor) => anchor.getAttribute('href')?.startsWith('#/'));
        if (selector === 'nav a') return navigation;
        if (selector === 'nav a[data-requires-entry]') return navigation.filter((anchor) => anchor.hasAttribute('data-requires-entry'));
        if (selector === '[data-disclosure-link]') return createdElements.filter((item) => item.hasAttribute('data-disclosure-link'));
        return [];
      },
    },
    window: {
      ethereum: { on: (type, callback) => { windowEvents[type] = callback; } },
      addEventListener: (type, callback) => { windowEvents[type] = callback; },
    },
    location: { hash: '#/swap' },
    sessionStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    BrowserProvider, getAddress, ZeroAddress, RubaClient, createWalletConnector: () => connector, loadConfig: async (fetch) => { if (deferredConfig) await deferredConfig; return marketConfigs[fetch?.marketId] ?? config; }, ...model, ...marketModel,
    loadMarkets: async () => structuredClone(marketsCatalog),
    loadEmbeddedDisclosure: async () => { disclosureMounts++; },
    scopedMarketFetch: (id) => Object.assign(async () => {}, { marketId: id }),
    loadDashboard: async (id) => ({ marketId: id, accepted: null, settingsRevision: '0', progress: { collected: 0, required: 4 }, arbitrage: { enabled: false, delaySeconds: 30, status: 'disabled', nextRunAt: null } }),
    sendControl: async ({ command }) => { adminCommands.push(structuredClone(command)); return { result: command.kind === 'monitor'
      ? { marketId: command.marketId, source: 'private-current', accepted: false, reserve0: '1000000000000000000', reserve1: '100000000', spot: '1', target: '1', deviationBps: '0' } : command.kind === 'closeBatch' ? structuredClone(adminCloseResult) : {}, nonce: '1', revision: '1' }; },
  });
  const read = (expression) => vm.runInContext(expression, context);
  async function flush() {
    for (let iteration = 0; iteration < 15; iteration += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  function assertEntryLocked() {
    assert.equal(read('ready()'), false);
    assert.equal(element('page-entry').hidden, false);
    for (const page of pages.filter((section) => section.dataset.page !== 'entry')) {
      assert.equal(page.hidden, true);
      assert.equal(page.inert, true);
    }
    assert.ok(walletFieldsets.every((fieldset) => fieldset.disabled));
    assert.equal(protectedNavigation.length, 4);
    for (const anchor of protectedNavigation) {
      assert.equal(anchor.getAttribute('href'), null);
      assert.equal(anchor.getAttribute('aria-disabled'), 'true');
      assert.equal(anchor.getAttribute('tabindex'), '-1');
    }
    assert.equal(element('load-private-balances').hidden, true);
    assert.equal(element('load-private-balances').disabled, true);
    assert.equal(element('refresh-balances').disabled, true);
    assert.equal(element('disconnect-wallet').hidden, !read('state.account'), 'disconnect remains available before entry when a wallet is connected');
    assert.equal(element('receipt-load').disabled, true);
    assert.equal(element('receipt-download').disabled, true);
    assert.equal(element('publication-refresh').disabled, true);
    assert.equal(element('publication-submit').disabled, true);
  }

  vm.runInContext(controller, context, { filename: 'ui/app.js' });
  await flush();
  assert.equal(element('operation-dialog').open, false);
  assertEntryLocked();
  assert.equal(element('disclosure-link').getAttribute('href'), '#/disclosure');
  assert.equal(element('disclosure-link').hasAttribute('data-requires-entry'), false);
  await element('disclosure-link').fire('click');
  assert.equal(element('page-disclosure').hidden, false, 'disclosure remains available before entry');
  assert.equal(element('page-disclosure').inert, false);
  assert.equal(disclosureMounts, 1);
  context.location.hash = '#/swap';
  windowEvents.hashchange();
  assertEntryLocked();
  await element('receipt-download').fire('click');
  assert.equal(disclosureReads, 0, 'receipt export must respect the entry guard');
  await element('publication-refresh').fire('click');
  assert.equal(publicationReads, 0, 'publication controls must respect the entry guard');
  assert.equal(element('consent').disabled, false, 'entry confirmation must be selectable before connecting a wallet');
  assert.equal(element('enter-app').disabled, true, 'Continue must remain disabled until consent is selected');
  await element('enter-app').fire('click');
  assertEntryLocked();
  assert.equal(read('state.consent'), false, 'the entry handler must also reject unconfirmed consent');
  element('consent').checked = true;
  await element('consent').fire('change');
  assertEntryLocked();
  assert.equal(element('enter-app').disabled, false, 'selecting consent must enable Continue before a wallet is connected');
  assert.deepEqual([privateReads, walletBalanceReads, marketReads], [0, 0, 0]);
  assert.equal(context.location.hash, '#/swap', 'confirmation protects the view while keeping the direct route');
  for (const anchor of protectedNavigation) {
    const event = await anchor.fire('click');
    assert.equal(event.defaultPrevented, true);
    assert.equal(context.location.hash, '#/entry');
  }

  // Entry is a separate step from wallet authorization: checkbox + Continue
  // opens every section, while all financial actions still require a wallet.
  await element('enter-app').fire('click');
  assert.equal(read('state.consent'), true);
  assert.equal(read('ready()'), false, 'entry alone must not authorize wallet operations');
  assert.equal(context.location.hash, '#/swap');
  assert.equal(element('page-swap').hidden, false);
  assert.equal(element('disconnect-wallet').hidden, true);
  assert.ok(inputFieldsets.every((fieldset) => !fieldset.disabled), 'after entry, amounts remain editable before wallet authorization');
  assert.equal(element('quote-swap').disabled, true);
  assert.equal(element('submit-swap').disabled, true);
  assert.equal(element('submit-liquidity-add').disabled, true);
  assert.equal(element('submit-liquidity-remove').disabled, true);
  assert.equal(element('page-entry').hidden, true, 'entry screen disappears after Continue');
  for (const anchor of tradeNavigation) {
    assert.equal(anchor.getAttribute('href'), `#/${anchor.dataset.route}`);
    assert.notEqual(anchor.getAttribute('aria-disabled'), 'true');
    const event = await anchor.fire('click');
    assert.equal(event.defaultPrevented, false);
    assert.equal(context.location.hash, `#/${anchor.dataset.route}`);
    assert.equal(element(`page-${anchor.dataset.route}`).hidden, false);
    assert.equal(element(`page-${anchor.dataset.route}`).inert, false);
    assert.ok(inputFieldsets.every((fieldset) => !fieldset.disabled));
    assert.equal(element('submit-swap').disabled, true);
  }
  await element('load-private-balances').fire('click');
  await element('quote-swap').fire('click');
  assert.deepEqual([privateReads, walletBalanceReads, marketReads], [0, 0, 0]);
  assert.equal(read('state.quote'), null);
  await element('connect-wallet').fire('click');
  assert.equal(read('state.consent'), true, 'connecting after Continue must preserve the confirmed entry');
  assert.equal(element('operation-dialog').open, false, 'wallet connection uses its own selector and background reads stay silent');
  assert.equal(read('ready()'), true);
  assert.equal(read('state.needsRefresh'), true);
  assert.equal(element('page-account').hidden, false, 'connecting must preserve the selected section');
  assert.equal(privateReads, 0, 'connecting must not silently request a private signature');
  assert.equal(walletBalanceReads, 1, 'public wallet balances load independently from private authorization');
  assert.equal(marketReads, 1, 'public whitelist status loads without a private signature');
  assert.ok(inputFieldsets.every((fieldset) => !fieldset.disabled));
  assert.equal(element('quote-swap').disabled, false, 'an admitted wallet can request a quote before loading its balance');
  assert.equal(element('submit-swap').disabled, true);
  assert.equal(element('account-readiness').hidden, false);
  assert.equal(element('load-private-balances').disabled, false);
  await element('load-private-balances').fire('click');
  assert.equal(read('state.needsRefresh'), false);
  assert.ok(inputFieldsets.every((fieldset) => !fieldset.disabled));
  assert.deepEqual([privateReads, walletBalanceReads, marketReads], [1, 2, 2]);
  await element('disclosure-link').fire('click');
  assert.equal(disclosureMounts, 1, 'disclosure state is retained within the same app');
  assert.equal(element('page-disclosure').hidden, false);
  assert.equal(element('page-disclosure').inert, false);
  assert.equal(read('state.account'), wallet);
  assert.equal(read('state.consent'), true);
  await protectedNavigation.find((anchor) => anchor.dataset.route === 'account').fire('click');
  assert.equal(element('page-account').hidden, false, 'returning from disclosure does not repeat entry or lose balance');
  assert.equal(element('internal-ruba').textContent, '100');
  await element('disconnect-wallet').fire('click');
  assert.equal(element('page-account').hidden, false, 'disconnect keeps the confirmed page open');
  assert.equal(element('internal-ruba').textContent, '—');
  assert.equal(read('state.consent'), true);

  // Keep the opposite order covered as well: connecting first must not silently
  // confirm entry or fetch private data, even with a legacy stored consent flag.
  privateReads = 0;
  walletBalanceReads = 0;
  marketReads = 0;
  element('consent').checked = false;
  await element('consent').fire('change');
  element('consent').checked = true;
  await element('consent').fire('change');
  await element('connect-wallet').fire('click');
  assertEntryLocked();
  assert.equal(element('consent').disabled, false);
  assert.equal(element('consent').checked, true, 'connecting must preserve a confirmation selected beforehand');
  assert.equal(element('enter-app').disabled, false);
  assert.equal(privateReads, 0);
  assert.equal(walletBalanceReads, 1, 'connecting may read public token balances');
  assert.equal(marketReads, 1, 'connecting may read public access status');
  await element('load-private-balances').fire('click');
  assert.equal(privateReads, 0, 'calling a disabled refresh handler must still respect the entry guard');
  context.location.hash = '#/liquidity';
  windowEvents.hashchange();
  assertEntryLocked();
  assert.equal(context.location.hash, '#/liquidity');
  element('consent').checked = true;
  await element('consent').fire('change');
  assertEntryLocked();
  assert.equal(element('enter-app').disabled, false);
  await element('enter-app').fire('click');
  assert.equal(read('ready()'), true);
  assert.equal(read('state.needsRefresh'), true);
  assert.equal(privateReads, 0, 'Continue must not silently request another wallet signature');
  await element('load-private-balances').fire('click');
  assert.equal(read('state.needsRefresh'), false);
  assert.equal(privateReads, 1);
  assert.ok(walletBalanceReads >= 2);
  assert.ok(marketReads >= 2);
  for (const anchor of protectedNavigation) {
    assert.equal(anchor.getAttribute('href'), `#/${anchor.dataset.route}`);
    assert.notEqual(anchor.getAttribute('aria-disabled'), 'true');
    assert.notEqual(anchor.getAttribute('tabindex'), '-1');
  }
  assert.equal(element('load-private-balances').hidden, true);
  assert.equal(element('disconnect-wallet').hidden, false);

  element('swap-amount').value = '1';
  await element('quote-swap').fire('click');
  assert.equal(read('state.quote.minOut'), 991025n);
  await element('swap-amount').fire('input');
  assert.equal(read('state.quote'), null);
  assert.equal(element('submit-swap').disabled, true);

  // The swap already committed: cancelling the subsequent private balance read
  // must preserve success and must not invite the user to submit the swap again.
  await element('quote-swap').fire('click');
  rejectNextRefresh = true;
  await element('swap-form').fire('submit');
  assert.equal(swaps, 1);
  assert.match(element('status').textContent, /Обмен выполнен/);
  assert.equal(element('error').hidden, false);
  assert.equal(read('state.needsRefresh'), true);
  assert.equal(element('receipt-trade-id').value, '1');
  assert.match(element('receipt-summary').textContent, /сделки №1/);
  assert.match(element('receipt-publication').textContent, /1 из 4/);
  assert.match(element('status').textContent, /Публикация ожидает закрытия пакета/);
  assert.equal(element('receipt-download').disabled, true, 'a failed account refresh must keep export locked too');
  assert.match(element('publication-status').textContent, /1 из 4/);
  assert.equal(element('publication-submit').disabled, true);
  assert.equal(element('publication-refresh').disabled, false, 'publication refresh is independent of private balance refresh');
  await element('load-private-balances').fire('click');
  assert.equal(element('receipt-download').disabled, true, 'an unfinished batch cannot be exported');
  await element('receipt-export-form').fire('submit');
  assert.equal(disclosureReads, 1);
  assert.equal(element('error').hidden, true, 'an unfinished batch is not a failed swap');
  assert.match(element('status').textContent, /Сделка уже выполнена/);
  assert.match(element('status').textContent, /1 из 4/);
  assert.equal(element('receipt-download').disabled, true);
  // Other trades complete the batch. Loading the original trade must replace
  // its cached collecting state, even if the bundle has no publication field.
  disclosureCollecting = false;
  await element('receipt-export-form').fire('submit');
  assert.equal(disclosureReads, 2);
  assert.equal(element('receipt-download').disabled, false);
  assert.match(element('receipt-publication').textContent, /Пакет сформирован/);
  assert.doesNotMatch(element('receipt-publication').textContent, /1 из 4/);
  await element('receipt-download').fire('click');
  assert.equal(disclosureReads, 2);
  assert.deepEqual(downloads, [{ href: 'blob:test-1', name: 'ruba-trade-1.json' }]);
  assert.deepEqual(revokedUrls, ['blob:test-1']);
  const downloaded = JSON.parse(await downloadedBlobs[0].text());
  assert.equal(downloaded.format, 'ruba-trade-disclosure');
  assert.equal(downloaded.receipt.tradeId, '1');
  assert.equal(downloaded.receipt.account, wallet);
  // A loaded bundle can be downloaded again without requesting another signature.
  await element('receipt-download').fire('click');
  assert.equal(disclosureReads, 2);
  element('receipt-trade-id').value = '7';
  await element('receipt-trade-id').fire('input');
  await element('receipt-export-form').fire('submit');
  assert.equal(disclosureReads, 3);
  assert.equal(read('state.disclosure.receipt.tradeId'), '7');
  assert.match(element('receipt-summary').textContent, /сделки №7/);

  // A lost POST response has an unknown result. Trading stays locked until a
  // signed account refresh succeeds; the old quote cannot be reused.
  await element('quote-swap').fire('click');
  uncertainNextSwap = true;
  await element('swap-form').fire('submit');
  assert.equal(swaps, 2);
  assert.match(element('status').textContent, /Результат неизвестен/);
  assert.equal(read('state.needsRefresh'), true);
  assert.equal(read('state.quote'), null);
  assert.equal(element('submit-swap').disabled, true);
  await element('load-private-balances').fire('click');
  assert.equal(read('state.needsRefresh'), false);

  const readyOffer = (batchId) => ({
    status: 'ready',
    request: {
      chainId: config.chainId, vault: config.vaultAddress,
      batch: { batchId, tradeCount: 4, firstTradeId: '1', previousStateRoot: '0x' + '11'.repeat(32), newStateRoot: '0x' + '22'.repeat(32), receiptsRoot: '0x' + '33'.repeat(32) },
      deadline: '9999999999', signerEpoch: '1', signature: '0xab',
    },
    progress: { collected: 0, required: 4 },
  });
  const pendingSwap = (tradeId, batchId) => ({
    amountOut: '996006', tradeId, batchId,
    leaf: '0x' + '55'.repeat(32), proof: ['0x' + '66'.repeat(32), '0x' + '77'.repeat(32)],
    publication: { status: 'pending' },
  });

  // The fourth ledger swap succeeds before publication is proposed. Refusing
  // its wallet transaction must expose a publication retry, never a swap retry.
  publicationOffer = readyOffer('1');
  nextSwapReceipt = pendingSwap('4', '1');
  rejectNextPublication = true;
  rejectNextRefresh = true;
  await element('quote-swap').fire('click');
  await element('swap-form').fire('submit');
  assert.equal(swaps, 3);
  assert.equal(publications.length, 1);
  assert.equal(publications[0].ticket.batch.batchId, '1');
  assert.equal(publications[0].receipt.tradeId, '4', 'own receipt must reach client verification before the wallet');
  assert.equal(read('state.lastReceipt.tradeId'), '4');
  assert.equal(read('state.lastReceipt.publication.status'), 'pending');
  assert.equal(read('state.busy'), false);
  assert.equal(read('state.needsRefresh'), true);
  assert.match(element('status').textContent, /Обмен выполнен/);
  assert.match(element('publication-status').textContent, /Повторите только публикацию/);
  assert.equal(element('publication-submit').disabled, false, 'publication retry survives a rejected private balance refresh');
  assert.equal(element('submit-swap').disabled, true);
  await element('publication-submit').fire('click');
  assert.equal(publications.length, 2);
  assert.equal(swaps, 3, 'retrying publication must never execute another swap');
  assert.equal(read('state.lastReceipt.publication.status'), 'published');
  assert.match(element('receipt-publication').textContent, /подтверждена/);
  assert.equal(element('publication-submit').disabled, true);
  await element('load-private-balances').fire('click');

  // Do not automatically charge the fourth trader for someone else's earlier
  // queued batch. A connected non-whitelisted wallet can publish it manually.
  publicationOffer = readyOffer('1');
  nextSwapReceipt = pendingSwap('8', '2');
  await element('quote-swap').fire('click');
  await element('swap-form').fire('submit');
  assert.equal(swaps, 4);
  assert.equal(publications.length, 2, 'an earlier head batch needs an explicit publication click');
  assert.match(element('publication-status').textContent, /более ранний пакет №1/);
  read('state.market.whitelisted = false; state.market.marketPaused = true; updateControls()');
  assert.equal(element('publication-controls').disabled, false);
  assert.equal(element('publication-refresh').disabled, false);
  assert.equal(element('publication-submit').disabled, false, 'publishing an existing batch is not gated by market access');
  await element('publication-submit').fire('click');
  assert.equal(publications.length, 3);
  assert.equal(publications[2].receipt, undefined, 'another batch must not be verified against the new own receipt');
  assert.equal(read('state.lastReceipt.publication.status'), 'pending', 'publishing an earlier batch cannot mark the own batch published');
  assert.equal(swaps, 4);

  // Unknown send/wait results are not confirmations and are never automatically
  // retried. A known pending hash stays locked until its mined result is read.
  publicationOffer = readyOffer('2');
  publicationResult = { status: 'submitted', transactionHash: '0x' + 'ab'.repeat(32) };
  await element('publication-refresh').fire('click');
  await element('publication-submit').fire('click');
  assert.equal(publications.length, 4);
  assert.equal(read('state.lastReceipt.publication.status'), 'pending');
  assert.match(element('publication-status').textContent, /пока не подтверждена/);
  assert.equal(element('publication-submit').disabled, true);
  await element('publication-submit').fire('click');
  assert.equal(publications.length, 4, 'the handler must also refuse a pending transaction retry');
  await element('publication-refresh').fire('click');
  assert.equal(element('publication-submit').disabled, true);
  assert.match(element('publication-status').textContent, /уже отправлена/);
  submittedReceipt = { status: 0 };
  await element('publication-refresh').fire('click');
  assert.equal(element('publication-submit').disabled, false, 'a reverted publication can be retried without a new swap');
  submittedReceipt = null;
  publicationResult = { status: 'submitted' };
  await element('publication-submit').fire('click');
  assert.equal(publications.length, 5);
  assert.equal(element('publication-submit').disabled, true);
  assert.match(element('publication-status').textContent, /Результат отправки неизвестен/);
  await element('publication-refresh').fire('click');
  assert.equal(element('publication-submit').disabled, false);
  assert.match(element('publication-status').textContent, /Проверьте кошелёк перед повторной/);
  publicationResult = { status: 'submitted', transactionHash: '0x' + 'cd'.repeat(32) };
  await element('publication-submit').fire('click');
  submittedReceipt = { status: 1 };
  await element('publication-refresh').fire('click');
  assert.equal(read('state.lastReceipt.publication.status'), 'pending', 'a successful arbitrary transaction cannot confirm the expected batch');
  assert.match(element('publication-status').textContent, /нужный пакет ещё не подтверждён/);
  await element('publication-submit').fire('click');
  // A competing sender can publish matching roots while our own transaction
  // reverts. The roots confirm the batch, without attributing their hash to us.
  submittedReceipt = { status: 0 };
  confirmedPublication = true;
  publicationOffer = { status: 'idle', request: null, progress: { collected: 0, required: 4 } };
  await element('publication-refresh').fire('click');
  assert.equal(read('state.lastReceipt.publication.status'), 'published');
  assert.equal(read('state.lastReceipt.publication.transactionHash'), undefined);
  assert.equal(read('state.publicationResult.transactionHash'), undefined);
  assert.match(element('receipt-publication').textContent, /подтверждена/);
  assert.doesNotMatch(element('receipt-publication').textContent, /0xcdcd/);
  assert.doesNotMatch(element('publication-status').textContent, /0xcdcd/);
  assert.equal(element('publication-submit').disabled, true);
  assert.equal(swaps, 4);
  publicationOffer = { status: 'waiting', request: null, progress: { collected: 0, required: 4 } };
  await element('publication-refresh').fire('click');
  assert.match(element('publication-status').textContent, /уже принят сетью/);
  assert.doesNotMatch(element('publication-status').textContent, /собрано 0 из 4/);

  // Revoking confirmation closes workspace pages and clears private balances.
  element('consent').checked = false;
  await element('consent').fire('change');
  assertEntryLocked();
  assert.equal(element('internal-ruba').textContent, '—');
  assert.equal(read('state.walletBalances'), null);
  assert.equal(read('state.disclosure'), null);
  assert.equal(read('state.lastReceipt'), null);
  assert.equal(read('state.publicationRequest'), null);
  assert.equal(read('state.publicationResult'), null);
  assert.equal(element('receipt-trade-id').value, '');
  element('consent').checked = true;
  await element('consent').fire('change');
  await element('enter-app').fire('click');
  await element('disconnect-wallet').fire('click');
  assert.equal(element('page-liquidity').hidden, false);
  assert.equal(read('state.consent'), true);
  const readsBeforeReconnect = [privateReads, walletBalanceReads, marketReads];
  await element('connect-wallet').fire('click');
  assert.equal(element('page-liquidity').hidden, false);
  assert.equal(read('ready()'), true);
  assert.equal(privateReads, readsBeforeReconnect[0]);
  assert.ok(walletBalanceReads > readsBeforeReconnect[1]);
  assert.ok(marketReads > readsBeforeReconnect[2]);
  element('consent').checked = true;
  await element('consent').fire('change');
  await element('enter-app').fire('click');

  // A request started for the old network must not repopulate balances after
  // the wallet context changes while its response is in flight.
  let resolveAccount;
  deferredAccount = new Promise((resolve) => { resolveAccount = resolve; });
  const refresh = element('load-private-balances').fire('click');
  await flush();
  assert.equal(read('state.busy'), true);
  assert.equal(element('disconnect-wallet').disabled, false, 'a pending private read must never disable disconnect');
  selectedProvider.emit('chainChanged', '0x1');
  assert.equal(read('state.busy'), false, 'network changes immediately release the old request lock');
  assert.equal(read('state.account'), '');
  resolveAccount(snapshot);
  await refresh;
  assert.equal(read('state.account'), '');
  assert.equal(element('internal-ruba').textContent, '—');
  assert.equal(element('page-entry').hidden, true, 'changing network clears wallet data while preserving entry');
  assert.equal(read('state.busy'), false);

  // The ZK mode labels pending balances honestly and keeps chain-only recovery
  // usable after an API failure. Control transitions do not require four swaps.
  deferredAccount = undefined;
  config.proofMode = 'zk';
  snapshot.zkProof = { registered: true, verified: false, stateVersion: '1', stateRoot: '123',
    account: ['1', '100', '200', '300', '1', '0', '0', '10', '11'] };
  await element('connect-wallet').fire('click');
  element('consent').checked = true;
  await element('consent').fire('change');
  await element('enter-app').fire('click');
  await element('load-private-balances').fire('click');
  assert.equal(element('zk-balance-panel').hidden, false);
  assert.match(element('zk-balance-status').textContent, /Предварительное состояние/);
  read('state.needsRefresh = true; updateControls()');
  assert.equal(element('zk-balance-panel').disabled, false);
  assert.equal(element('zk-recover-chain').disabled, false);
  const privateReadsBeforeRecovery = privateReads;
  let recoveries = 0;
  RubaClient.prototype.recoverZkFromChain = async () => {
    recoveries++;
    return { backup: { format: 'ruba-zk-account-backup', version: 2 }, proof: { ...snapshot.zkProof, verified: true } };
  };
  await element('zk-recover-chain').fire('click');
  assert.equal(recoveries, 1);
  assert.equal(privateReads, privateReadsBeforeRecovery, 'chain recovery must not trigger a private API refresh');
  assert.match(element('zk-balance-status').textContent, /текущему принятому корню/);
  assert.equal(downloads.at(-1).name, 'ruba-zk-account-backup.json');
  assert.match(element('status').textContent, /Сервер не использовался/);
  publicationOffer = readyOffer('0');
  publicationOffer.request.kind = 'zk';
  publicationOffer.request.batch.tradeCount = '0';
  publicationOffer.request.publicSignals = ['1', '2', '0', '3', '4', '0', '0', '1', '1', '0', '5', '6', '7'];
  await element('publication-refresh').fire('click');
  assert.match(element('publication-status').textContent, /ZK-переход состояния №2/);
  assert.match(element('publication-status').textContent, /регистрация, пополнение/);
  assert.equal(element('publication-submit').disabled, false);
  publicationResult = { status: 'published' };
  await element('publication-submit').fire('click');
  assert.match(element('publication-status').textContent, /ZK-переход №2 опубликован/);
  assert.equal(publications.at(-1).ticket.kind, 'zk');
  assert.deepEqual(Object.keys(read('state.publicationResult.batch')), ['publicSignals']);

  config.withdrawalMode = 'proven-reservation-v1';
  config.publicationAuthorization = 'proof-only';
  snapshot.withdrawals = [{ token: 'USDT', amount: '1000000', nonce: '7', status: 'pending', deadline: '1' }];
  await element('load-private-balances').fire('click');
  read('state.market.whitelisted = false; renderAccount(); renderWallet(); updateControls()');
  assert.match(element('entry-policy').textContent, /пополнению, обмену и добавлению ликвидности/);
  assert.match(element('access-status').textContent, /Нет допуска к новым операциям/);
  assert.match(element('withdrawal-help').textContent, /бессрочны/);
  const depositFieldset = fieldsets.find((fieldset) => fieldset.hasAttribute('data-deposit'));
  assert.equal(depositFieldset.disabled, false, 'deposit amounts remain editable without whitelist');
  assert.equal(element('submit-deposit').disabled, true, 'proven deposit submission requires whitelist');
  assert.equal(element('zk-register').disabled, true, 'registration requires whitelist while recovery controls remain usable');
  assert.equal(element('zk-proof-refresh').disabled, false);
  assert.equal(element('zk-backup-export').disabled, false);
  assert.equal(element('zk-recover-chain').disabled, false);
  assert.equal(element('submit-swap').disabled, true);
  let registrations = 0;
  RubaClient.prototype.ensureZkRegistration = async () => { registrations++; };
  await element('zk-register').fire('click');
  assert.equal(registrations, 0, 'the registration handler must also reject programmatically dispatched clicks');
  assert.match(element('error').textContent, /допущен/);
  read('state.market.whitelisted = true; state.market.marketPaused = true; updateControls()');
  assert.equal(element('zk-register').disabled, false, 'registration retains its whitelist-only admission check');
  assert.equal(depositFieldset.disabled, false, 'a paused market does not make the amount field inert');
  assert.equal(element('submit-deposit').disabled, true, 'a paused market still blocks deposit submission');
  read('state.market.marketPaused = false; updateControls()');
  assert.equal(depositFieldset.disabled, false);
  assert.equal(element('submit-deposit').disabled, false, 'granting whitelist enables deposit submission in an active market');
  read('state.market.whitelisted = false; updateControls()');
  const payoutButtons = createdElements.filter((item) => item.dataset.pendingAction === 'redeem');
  assert.ok(payoutButtons.length > 0);
  assert.equal(createdElements.filter((item) => item.dataset.pendingAction === 'expire').length, 0);
  element('withdraw-amount').value = '1';
  await element('withdraw-form').fire('submit');
  assert.equal(reservations, 1);
  assert.equal(payouts, 1);
  assert.match(element('status').textContent, /2 из 4/);
  assert.doesNotMatch(element('status').textContent, /Выплата отправлена/);
  await createdElements.filter((item) => item.dataset.pendingAction === 'redeem').at(-1).fire('click');
  assert.equal(reservations, 1, 'continuing a saved right must never reserve a second time');
  assert.equal(payouts, 2);

  const assets = { RUBA: { symbol: 'RUBA', decimals: 18, address: '0x' + '21'.repeat(20) }, USDT: { symbol: 'USDT', decimals: 6, address: '0x' + '22'.repeat(20) },
    WETH: { symbol: 'WETH', decimals: 18, address: '0x' + '23'.repeat(20) }, WBTC: { symbol: 'WBTC', decimals: 8, address: '0x' + '24'.repeat(20) } };
  const descriptors = [['ruba-usdt', 'RUBA', 'USDT'], ['ruba-weth', 'RUBA', 'WETH'], ['weth-wbtc', 'WETH', 'WBTC']].map(([id, base, quote], i) => ({ id, chainId: '31337',
    vault: '0x' + String(31 + i).repeat(20), base: assets[base], quote: assets[quote] }));
  marketsCatalog = { network: { name: 'Local Anvil', chainId: '31337' }, defaultMarketId: 'ruba-usdt', markets: descriptors,
    control: { admin: wallet, prices: { RUBA: '1', USDT: '1', WETH: '3000', WBTC: '90000' } } };
  for (const market of descriptors) {
    marketConfigs[market.id] = { ...config, marketId: market.id, chainId: '31337', vaultAddress: market.vault, tokens: { RUBA: market.base, USDT: market.quote } };
    marketSnapshots[market.id] = { account: wallet, balances: { RUBA: '1000000000000000000', USDT: market.quote.decimals === 8 ? '125000000' : '5000000' }, lpShares: '1000', withdrawals: [], zkProof: snapshot.zkProof };
  }
  context.testCatalog = marketsCatalog;
  read('state.catalog = testCatalog');
  await read('selectMarket("ruba-usdt")');
  assert.equal(read('state.needsRefresh'), true);
  assert.equal(read('state.marketButtons.length'), 3);
  assert.equal(read('state.marketButtons[1].children[1].textContent'), 'RUBA / Wrapped Ether');
  assert.equal(read('state.marketButtons[2].children[1].textContent'), 'Wrapped Ether / Wrapped BTC');
  await element('load-private-balances').fire('click');
  assert.equal(element('internal-usdt').textContent, '5');
  const oldClient = read('state.client');
  const oldProvider = read('state.provider');
  read('state.busy = true');
  await read('state.marketButtons.find((button) => button.dataset.marketId === "weth-wbtc").fire("click")');
  assert.equal(read('state.selectedMarketId'), 'ruba-usdt', 'a wallet operation locks the market selector');
  assert.equal(elements.has('market-select'), false, 'market cards are the only selector');
  read('state.busy = false; state.quote = { amountIn: 1n }; state.lastReceipt = { tradeId: "9" }; state.publicationResult = { status: "submitted" }');
  element('swap-amount').value = '9'; element('deposit-amount').value = '9';
  let resolveOldMarket;
  deferredAccount = new Promise((resolve) => { resolveOldMarket = resolve; });
  let staleError;
  const staleMarketRead = read('refreshAccount(state.version)').catch((error) => { staleError = error; });
  await flush(); deferredAccount = undefined;
  await read('selectMarket("weth-wbtc")');
  assert.equal(read('state.needsRefresh'), true);
  assert.equal(element('internal-usdt').textContent, '—', 'switching markets must clear old private data before explicit refresh');
  await element('load-private-balances').fire('click');
  assert.equal(oldClient.disposed, true);
  assert.equal(read('state.provider'), oldProvider, 'changing pool keeps the same connected Ethereum wallet');
  assert.equal(read('state.account'), wallet);
  assert.equal(read('state.selectedMarketId'), 'weth-wbtc');
  assert.match(html, /<h1 id="market-title">Solid<\/h1>/);
  assert.equal(element('wallet-address').textContent, 'Кошелёк подключён');
  assert.equal(element('internal-usdt').textContent, '1.25');
  assert.equal(element('swap-amount').value, ''); assert.equal(element('deposit-amount').value, '');
  assert.equal(read('state.quote'), null); assert.equal(read('state.lastReceipt'), null); assert.equal(read('state.publicationResult'), null);
  resolveOldMarket({ balances: { RUBA: '1', USDT: '999999999999999999' }, withdrawals: [], lpShares: '1' });
  await staleMarketRead;
  assert.ok(staleError, 'the old market response must be rejected by the version guard');
  assert.equal(element('internal-usdt').textContent, '1.25');
  assert.equal(element('own-price-preview').textContent, '');
  await element('arbitrage-form').fire('submit');
  assert.equal(adminCommands.at(-1).marketId, 'weth-wbtc');
  await element('private-monitor').fire('click');
  assert.match(element('admin-monitor-result').textContent, /Приватный текущий снимок.*WETH.*WBTC/);
  assert.equal(read('state.dashboard.accepted'), null, 'private monitor must never turn into a public accepted point');
  await protectedNavigation.find((anchor) => anchor.dataset.route === 'swap').fire('click');
  await element('swap-demo-tab').fire('click');
  assert.equal(element('swap-trade-panel').hidden, true);
  assert.equal(element('swap-demo-panel').hidden, false);
  assert.equal(element('account-readiness').hidden, true);
  assert.equal(element('demo-market-label').textContent, 'WETH / WBTC');
  await protectedNavigation.find((anchor) => anchor.dataset.route === 'liquidity').fire('click');
  assert.equal(element('page-liquidity').hidden, false);
  assert.equal(element('page-swap').hidden, true, 'the demo panel stays inside the exchange page');
  assert.equal(element('close-current-batch').disabled, false);
  const priorPublications = publications.length;
  adminCloseResult = { marketId: 'weth-wbtc', closedThroughStateVersion: null, publication: { status: 'idle', request: null } };
  await element('close-current-batch').fire('click');
  assert.deepEqual(adminCommands.at(-1), { kind: 'closeBatch', marketId: 'weth-wbtc' });
  assert.equal(publications.length, priorPublications, 'an empty close does not send a transaction');
  assert.match(element('batch-close-result').textContent, /закрывать и публиковать нечего/);

  const closedOffer = readyOffer('7'); closedOffer.request.kind = 'zk'; closedOffer.request.batch.tradeCount = '2';
  closedOffer.request.publicSignals = ['1', '9', '1', '3', '4', '0', '0', '18', '20', '5', '6', '7', '8'];
  adminCloseResult = { marketId: 'weth-wbtc', closedThroughStateVersion: '9', publication: closedOffer };
  publicationOffer = readyOffer('8'); publicationResult = { status: 'published' };
  const priorReads = publicationReads;
  await element('close-current-batch').fire('click');
  assert.equal(publications.length, priorPublications + 1);
  assert.equal(publications.at(-1).ticket.batch.tradeCount, '2');
  assert.equal(publicationReads, priorReads, 'the close boundary prevents fetching or charging for newer packages');
  assert.match(element('batch-close-result').textContent, /до №9 опубликованы/);

  adminCloseResult = { marketId: 'weth-wbtc', closedThroughStateVersion: '10', publication: null, preparationError: 'Proof unavailable' };
  await element('close-current-batch').fire('click');
  assert.equal(publications.length, priorPublications + 1);
  assert.match(element('batch-close-result').textContent, /Пакет закрыт.*Обновить готовый пакет/);

  const beforeUnauthorizedClose = adminCommands.length;
  read('state.catalog.control.admin = "0x0000000000000000000000000000000000000002"; updateControls()');
  assert.equal(element('close-current-batch').disabled, true);
  await element('close-current-batch').fire('click');
  assert.equal(adminCommands.length, beforeUnauthorizedClose, 'programmatic clicks cannot bypass the admin check');
  read('state.catalog.control.admin = state.account; updateControls()');

  let removeRequests = 0;
  const previousAction = RubaClient.prototype.signedAction;
  const additions = [];
  let rejectLiquidity = false;
  RubaClient.prototype.signedAction = async function(operation) {
    if (operation.kind === 'addLiquidity') {
      additions.push(structuredClone(operation));
      if (rejectLiquidity) throw new Error('Insufficient USDT balance (required 150000000, available 125000000)');
      return { rubaAmount: '1000000000000000000', usdtAmount: '50000000', shares: '1000' };
    }
    if (operation.kind === 'removeLiquidity') { removeRequests++; return { rubaAmount: '1', usdtAmount: '1', closedThroughStateVersion: '10' }; }
    return previousAction.call(this, operation);
  };
  assert.equal(element('liquidity-available-ruba').textContent, '1 WETH');
  assert.equal(element('liquidity-available-usdt').textContent, '1.25 WBTC');
  element('liquidity-ruba').value = '1000';
  element('liquidity-usdt').value = '1000';
  await element('liquidity-add-form').fire('submit');
  assert.equal(additions.length, 0, 'two unaffordable maxima must fail before requesting a signature');
  assert.match(element('operation-dialog-error').textContent, /1 WETH и 1\.25 WBTC.*Мой баланс/);
  element('liquidity-ruba').value = '1';
  await element('liquidity-add-form').fire('submit');
  assert.equal(additions.length, 1, 'the unused part of one large maximum can be left on the internal balance');
  assert.match(element('status').textContent, /1 WETH и 0\.5 WBTC.*опубликуйте/);
  rejectLiquidity = true;
  await element('liquidity-add-form').fire('submit');
  assert.equal(additions.length, 2);
  assert.match(element('error').textContent, /не хватает WBTC.*нужно 1\.5 WBTC, доступно 1\.25 WBTC/i);
  await protectedNavigation.find((anchor) => anchor.dataset.route === 'account').fire('click');
  assert.equal(element('error').textContent, '', 'a previous form error must not look like a failure of the new section');
  assert.match(element('operation-dialog-error').textContent, /не хватает WBTC/, 'the operation dialog retains the error details');
  await protectedNavigation.find((anchor) => anchor.dataset.route === 'liquidity').fire('click');

  const exitOffer = readyOffer('0'); exitOffer.request.kind = 'zk'; exitOffer.request.batch.tradeCount = '0';
  exitOffer.request.publicSignals = ['1', '10', '0', '3', '4', '0', '0', '20', '20', '0', '6', '7', '8'];
  publicationOffer = exitOffer;
  element('liquidity-shares').value = '1';
  await element('liquidity-remove-form').fire('submit');
  assert.equal(removeRequests, 0);
  assert.match(element('error').textContent, /Доступно 0\.000000000000001 LP-долей/);
  element('liquidity-shares').value = '0.000000000000001';
  await element('liquidity-remove-form').fire('submit');
  assert.equal(removeRequests, 1);
  assert.equal(publications.length, priorPublications + 2, 'LP removal publishes its closed transition without a fourth swap');
  assert.match(element('status').textContent, /Снятие LP подтверждено/);
  RubaClient.prototype.signedAction = previousAction;

  const firstChartTimestamp = Date.UTC(2026, 10, 23, 10) / 1000;
  const acceptedHistory = [
    { stateVersion: '1', blockNumber: '121', timestamp: String(firstChartTimestamp), spot: '0.98', target: '0.99', deviationBps: '-101' },
    { stateVersion: '2', blockNumber: '122', timestamp: String(firstChartTimestamp + 60), spot: '1.02', target: '1.25', deviationBps: '-1840' },
    { stateVersion: '3', blockNumber: '123', timestamp: String(firstChartTimestamp + 360), spot: '1', target: '1.01', deviationBps: '-99' },
  ];
  const { timestamp: _timestamp, ...checkpoint } = acceptedHistory.at(-1);
  context.acceptedChartFixture = { ...checkpoint, history: acceptedHistory };
  read('state.consent = false; state.dashboard.accepted = acceptedChartFixture; renderDashboard(); route()');
  assert.equal(element('market-dashboard').hidden, true);
  element('consent').checked = true;
  await element('enter-app').fire('click');
  assert.equal(element('market-dashboard').hidden, false, 'Continue must immediately show the cached dashboard without a poll or market switch');
  assert.match(element('dashboard-spot').textContent, /1 WBTC за 1 WETH/);

  await t.test('AMM chart reads accepted block history by time and keeps the current guide separate', async () => {
    const svg = element('market-chart');
    const reading = element('market-chart-reading');
    const rect = { left: 140, top: 50, width: 440, height: 220 };
    svg.getBoundingClientRect = () => rect;
    read('renderDashboard()');

    const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
    const withClass = (className) => descendants(svg).filter((node) => (node.getAttribute('class') ?? '').split(' ').includes(className));
    const guide = withClass('target-line')[0];
    assert.equal(withClass('amm-line')[0]?.tagName, 'path');
    assert.equal(guide?.tagName, 'line');
    assert.equal(guide.getAttribute('y1'), guide.getAttribute('y2'), 'the current manual guide stays flat across historical prices');
    const xs = withClass('chart-point').map((node) => Number(node.getAttribute('cx')));
    assert.equal(xs.length, acceptedHistory.length);
    assert.ok(xs[1] > xs[0] && xs[2] - xs[1] > 4 * (xs[1] - xs[0]), 'horizontal spacing reflects the one-minute then five-minute intervals');
    assert.match(element('market-chart-note').textContent, /МСК/);
    assert.match(reading.textContent, /13:06/, 'the last confirmed publication is selected initially');

    const homeKey = await svg.fire('keydown', { key: 'Home' });
    assert.equal(homeKey.defaultPrevented, true);
    assert.match(reading.textContent, /13:00/);
    assert.match(reading.textContent, /0[.,]98/);
    await svg.fire('keydown', { key: 'ArrowRight' });
    assert.match(reading.textContent, /13:01/);
    assert.match(reading.textContent, /1[.,]02/);
    assert.doesNotMatch(reading.textContent, /1[.,]25/, 'historical snapshots of the manual price are not presented as a feed');
    await svg.fire('keydown', { key: 'End' });
    assert.match(reading.textContent, /13:06/);

    const [, , viewWidth] = svg.getAttribute('viewBox').split(/\s+/).map(Number);
    const betweenPublications = xs[1] + (xs[2] - xs[1]) * 0.8;
    const clientX = rect.left + betweenPublications * rect.width / viewWidth;
    await svg.fire('pointerdown', { pointerType: 'touch', clientX });
    assert.match(reading.textContent, /1[.,]02/, 'touch between publications reads the last confirmed price at that time');
    await svg.fire('pointermove', { pointerType: 'touch', clientX: rect.left + rect.width });
    assert.match(reading.textContent, /1[.,]02/, 'touch scrolling leaves the chosen readout in place');
    await svg.fire('pointermove', { pointerType: 'mouse', clientX: rect.left + rect.width });
    assert.match(reading.textContent, /13:06/);

    context.privateChartReceipt = { tradeId: '45', publication: { status: 'collecting' },
      reserveRubaBefore: '1000000000000000000', reserveUsdtBefore: '100000000',
      reserveRubaAfter: '1000000000000000000', reserveUsdtAfter: '121000000' };
    read('state.lastReceipt = privateChartReceipt; renderDashboard()');
    assert.match(element('own-price-preview').textContent, /1[.,]21/);
    assert.equal(withClass('chart-point').length, acceptedHistory.length);
    assert.equal(withClass('own-price-line').length, 0, 'the private preview remains in the receipt text rather than the history');
    context.olderChartPoint = { ...acceptedHistory[0], stateVersion: '0', timestamp: String(firstChartTimestamp - 3_600) };
    read('state.dashboard.accepted = { ...acceptedChartFixture, history: [olderChartPoint, ...acceptedChartFixture.history] }; renderDashboard()');
    assert.equal(withClass('chart-point').length, acceptedHistory.length, 'the initial period zooms to recent publications');
    const period = element('market-chart-period');
    period.value = 'all';
    await period.fire('change');
    assert.equal(withClass('chart-point').length, acceptedHistory.length + 1);
    period.value = '900';
    read('state.lastReceipt = null; state.dashboard.accepted = null; renderDashboard()');
    assert.equal(svg.hidden, true);
    assert.equal(reading.hidden, true);
    assert.match(element('market-chart-note').textContent, /Подтверждённых цен пока нет/);
    read('state.dashboard.accepted = acceptedChartFixture; renderDashboard()');
  });

  // Rejected wallet authorization and an already-open extension request must
  // leave a usable connector instead of an indefinitely disabled page.
  await element('disconnect-wallet').fire('click');
  for (const code of [4001, -32002]) {
    connectorError = Object.assign(new Error(code === 4001 ? 'user rejected' : 'request already pending'), { code });
    await element('connect-wallet').fire('click');
    assert.equal(read('state.busy'), false);
    assert.equal(read('state.connecting'), false);
    assert.equal(read('state.account'), '');
    assert.equal(element('connect-wallet').disabled, false);
    assert.equal(element('error').hidden, false);
  }

  // A user may cancel a never-resolving wallet prompt. Its late result cannot
  // replace a newer selected provider or re-authorize the cancelled session.
  let resolveOldConnection;
  connectorResult = new Promise((resolve) => { resolveOldConnection = resolve; });
  const cancelledConnection = element('connect-wallet').fire('click');
  await flush();
  assert.equal(read('state.connecting'), true);
  assert.equal(element('cancel-wallet-connect').hidden, false);
  assert.equal(element('cancel-wallet-connect').disabled, false);
  const cancelsBefore = connectorCancels;
  await element('cancel-wallet-connect').fire('click');
  assert.ok(connectorCancels > cancelsBefore);
  assert.equal(read('state.busy'), false);
  assert.equal(read('state.connecting'), false);
  assert.equal(read('state.account'), '');
  const oldTransport = selectedProvider;
  selectedProvider = makeProvider('Test wallet B');
  connectorResult = undefined;
  await element('connect-wallet').fire('click');
  assert.equal(read('state.walletTransport'), selectedProvider);
  resolveOldConnection({ provider: oldTransport, label: oldTransport.label });
  await cancelledConnection;
  assert.equal(read('state.walletTransport'), selectedProvider);
  assert.equal(read('state.account'), wallet);
  assert.equal(read('state.busy'), false);

  // A pending private signature is cancellable by disconnect. The old run's
  // finally block must not unlock a new read that has started in a new session.
  element('consent').checked = true;
  await element('enter-app').fire('click');
  let resolveOldRead;
  deferredAccount = new Promise((resolve) => { resolveOldRead = resolve; });
  const oldRead = element('load-private-balances').fire('click');
  await flush();
  assert.equal(read('state.busy'), true);
  assert.equal(element('disconnect-wallet').disabled, false);
  const disconnectsBefore = connectorDisconnects;
  await element('disconnect-wallet').fire('click');
  assert.ok(connectorDisconnects > disconnectsBefore);
  assert.equal(read('state.busy'), false);
  assert.equal(element('connect-wallet').disabled, false);
  await element('connect-wallet').fire('click');
  element('consent').checked = true;
  await element('enter-app').fire('click');
  let resolveNewRead;
  deferredAccount = new Promise((resolve) => { resolveNewRead = resolve; });
  const newRead = element('load-private-balances').fire('click');
  await flush();
  assert.equal(read('state.busy'), true);
  resolveOldRead(snapshot);
  await oldRead;
  assert.equal(read('state.busy'), true, 'a stale finally block must not release the new session lock');
  assert.equal(read('state.snapshot'), null, 'a stale balance response must not repopulate the new session');
  resolveNewRead(snapshot);
  await newRead;
  deferredAccount = undefined;
  assert.equal(read('state.busy'), false);
  assert.equal(read('state.account'), wallet);

  // Provider events follow the selected wallet. A removed provider is inert,
  // but account changes on the selected provider immediately clear the session.
  oldTransport.emit('accountsChanged', []);
  assert.equal(read('state.account'), wallet);
  selectedProvider.emit('accountsChanged', ['0x0000000000000000000000000000000000000002']);
  assert.equal(read('state.account'), '');
  assert.equal(read('state.snapshot'), null);
  assert.equal(read('state.busy'), false);

  // The selected provider is observed before context validation completes.
  // Changing its network while connecting invalidates that attempt too.
  let resolveContext;
  deferredContext = new Promise((resolve) => { resolveContext = resolve; });
  const contextConnection = element('connect-wallet').fire('click');
  await flush();
  assert.equal(read('state.connecting'), true);
  selectedProvider.emit('accountsChanged', [wallet]);
  assert.equal(read('state.connecting'), true, 'the wallet can repeat its current account during connection');
  selectedProvider.emit('chainChanged', '0x1');
  assert.equal(read('state.busy'), false);
  assert.equal(read('state.connecting'), false);
  resolveContext();
  await contextConnection;
  deferredContext = undefined;
  assert.equal(read('state.account'), '');
  assert.equal(element('connect-wallet').disabled, false);

  await t.test('Vault admin uses the selected on-chain owner, verifies changes and protects pending transactions', async () => {
    const [ownedMarket, , otherMarket] = descriptors;
    const target = getAddress(`0x${'ab'.repeat(20)}`);
    const ownerPolicy = vaultPolicy(ownedMarket.vault);
    const otherPolicy = vaultPolicy(otherMarket.vault);
    ownerPolicy.owner = wallet;
    const adminControls = ['admin-wallet-controls', 'admin-pause-controls'].map(element);

    await element('admin-link').fire('click');
    assert.equal(element('page-admin').hidden, false);
    assert.equal(element('page-admin').inert, false);
    assert.ok(adminControls.every((fieldset) => fieldset.disabled));

    await element('connect-wallet').fire('click');
    assert.equal(read('state.catalog.control.admin'), wallet, 'the demo admin wallet is connected');
    assert.equal(read('state.selectedMarketId'), otherMarket.id);
    assert.ok(adminControls.every((fieldset) => fieldset.disabled), 'the demo admin cannot administer another owner’s Vault');
    await element('admin-market-toggle').fire('click');
    assert.equal(vaultAdminWrites.length, 0, 'even direct event dispatch must respect Vault ownership');

    await read(`selectMarket('${ownedMarket.id}')`);
    await flush();
    assert.equal(read('state.account'), wallet, 'pool switching preserves the owner’s wallet');
    assert.ok(adminControls.every((fieldset) => !fieldset.disabled));
    const previousPrivateReads = privateReads;
    const addressField = element('admin-wallet-address');
    addressField.value = ZeroAddress;
    await addressField.fire('input');
    await element('admin-wallet-form').fire('submit');
    assert.equal(whitelistReads.length, 0, 'the zero address cannot be used for access changes');

    addressField.value = target.toLowerCase();
    await addressField.fire('input');
    await element('admin-wallet-form').fire('submit');
    assert.deepEqual(whitelistReads.at(-1), { vault: ownedMarket.vault, address: target });
    assert.equal(element('admin-wallet-allow').disabled, false);
    await element('admin-wallet-allow').fire('click');
    assert.deepEqual(vaultAdminWrites.at(-1), { vault: ownedMarket.vault, kind: 'whitelist', address: target, allowed: true });
    assert.equal(ownerPolicy.addresses.get(target.toLowerCase()), true);
    assert.equal(otherPolicy.addresses.get(target.toLowerCase()), undefined);
    assert.deepEqual(whitelistReads.at(-1), { vault: ownedMarket.vault, address: target });
    await element('admin-wallet-deny').fire('click');
    assert.deepEqual(vaultAdminWrites.at(-1), { vault: ownedMarket.vault, kind: 'whitelist', address: target, allowed: false });

    await element('admin-market-toggle').fire('click');
    assert.deepEqual(vaultAdminWrites.at(-1), { vault: ownedMarket.vault, kind: 'market', paused: true });
    assert.equal(read('state.market.marketPaused'), true, 'public operation controls use refreshed on-chain flags');
    assert.equal(otherPolicy.marketPaused, false);
    await element('admin-withdrawals-usdt-toggle').fire('click');
    assert.deepEqual(vaultAdminWrites.at(-1), { vault: ownedMarket.vault, kind: 'withdrawals', token: 'USDT', paused: true });
    assert.equal(read('state.market.withdrawalsPaused.USDT'), true);
    assert.equal(read('state.market.withdrawalsPaused.RUBA'), false);
    assert.equal(otherPolicy.withdrawalsPaused.USDT, false);

    const pendingHash = `0x${'bb'.repeat(32)}`;
    submittedReceipt = null;
    nextAdminTx = { status: 'submitted', transactionHash: pendingHash };
    await element('admin-withdrawals-ruba-toggle').fire('click');
    assert.deepEqual(vaultAdminWrites.at(-1), { vault: ownedMarket.vault, kind: 'withdrawals', token: 'RUBA', paused: true });
    assert.equal(read('state.market.withdrawalsPaused.RUBA'), false, 'an unconfirmed write must not change displayed policy');
    assert.match(element('admin-tx-status').textContent, /ожидает подтверждения/);
    assert.equal(element('admin-pause-controls').disabled, true);
    assert.equal(element('admin-wallet-allow').disabled, true, 'pending writes lock the whitelist changes too');
    const writesBeforeRetry = vaultAdminWrites.length;
    await element('admin-withdrawals-ruba-toggle').fire('click');
    await element('admin-vault-refresh').fire('click');
    assert.equal(vaultAdminWrites.length, writesBeforeRetry, 'a pending transaction can be checked without another write');

    submittedReceipt = { hash: pendingHash, status: 1 };
    ownerPolicy.withdrawalsPaused.RUBA = true;
    await element('admin-vault-refresh').fire('click');
    assert.equal(element('admin-pause-controls').disabled, false);
    assert.equal(read('state.market.withdrawalsPaused.RUBA'), true);
    assert.equal(privateReads, previousPrivateReads, 'admin reads and writes never request a private balance signature');
  });

  await t.test('wallet progress shows its complete checklist upfront and checks off finished steps in place', async () => {
    const dialog = element('operation-dialog');
    const closeDialog = element('operation-dialog-close');
    const openDialog = element('operation-dialog-open');
    const textOf = (node) => [node.textContent, ...node.children.map(textOf)].join(' ');
    const rows = () => element('operation-dialog-steps').children;
    const stepText = () => rows().map(textOf).join(' ');
    const statusOf = (row) => row.dataset.state;
    const completed = (row) => row.children[0].textContent === '✓';
    const signature = 'Подписать запрос баланса';
    const proofRequest = 'Подписать запрос доказательства баланса';
    const verification = 'Проверить доказательство баланса';
    const originalGetAccount = RubaClient.prototype.getAccount;
    const originalSetMarketPaused = RubaClient.prototype.setMarketPaused;
    const originalDeposit = RubaClient.prototype.deposit;
    let finishRead;
    let finishProofRequest;
    let deferredProofRequest;
    let finishDepositAdmission;
    let finishApproval;
    let request;

    async function emitStep(client, key, kind, title, operation, detail) {
      const id = Symbol(title);
      const step = { id, key, kind, title };
      client.onWalletStep({ ...step, phase: 'start' });
      try {
        const result = await operation();
        const phase = result?.status === 'submitted' ? 'pending' : 'done';
        client.onWalletStep({ ...step, phase, detail: detail?.(result) });
        return result;
      } catch (error) {
        client.onWalletStep({ ...step, phase: 'error', detail: 'Подпись отменена' });
        throw error;
      }
    }

    RubaClient.prototype.getAccount = async function () {
      const account = await emitStep(this, 'sign:account', 'signature', signature, () => originalGetAccount.call(this));
      if (deferredProofRequest) {
        await emitStep(this, 'sign:zkState', 'signature', proofRequest, () => deferredProofRequest);
      }
      await emitStep(this, 'check:zk-proof', 'check', verification, () => {});
      return account;
    };
    RubaClient.prototype.setMarketPaused = async function (paused) {
      await emitStep(this, 'check:owner', 'check', 'Проверить право владельца Vault', () => {});
      const title = paused ? 'Поставить рынок на паузу' : 'Возобновить работу рынка';
      return emitStep(this, 'tx:market-pause', 'transaction', title,
        () => originalSetMarketPaused.call(this, paused), (result) => result.transactionHash);
    };

    try {
      if (dialog.open) await closeDialog.fire('click');
      await element('admin-vault-refresh').fire('click');
      assert.equal(dialog.open, false, 'unsigned checks never open the wallet progress dialog');
      await tradeNavigation.find((anchor) => anchor.dataset.route === 'account').fire('click');
      deferredAccount = new Promise((resolve) => { finishRead = resolve; });
      deferredProofRequest = new Promise((resolve) => { finishProofRequest = resolve; });
      assert.equal(element('load-private-balances').hidden, false);
      request = element('load-private-balances').fire('click');
      await flush();
      assert.equal(dialog.open, true);
      assert.ok(element('operation-dialog-title').textContent);
      const planned = [...rows()];
      assert.equal(planned.length, 3, 'the later signature and verification are visible before the first signature');
      assert.match(textOf(planned[0]), /запрос баланса/i);
      assert.match(textOf(planned[1]), /запрос доказательства баланса/i);
      assert.match(textOf(planned[2]), /проверить доказательство баланса/i);
      assert.deepEqual(planned.map(statusOf), ['active', 'waiting', 'waiting']);
      assert.deepEqual(planned.map(completed), [false, false, false]);
      assert.equal(planned[0].getAttribute('aria-current'), 'step');
      await closeDialog.fire('click');
      assert.equal(dialog.open, false);
      assert.equal(read('state.busy'), true, 'closing progress does not cancel the wallet operation');
      assert.equal(openDialog.hidden, false);
      await openDialog.fire('click');
      assert.equal(dialog.open, true);
      await closeDialog.fire('click');
      finishRead(marketSnapshots[descriptors[0].id]);
      await flush();
      assert.deepEqual(rows().map(statusOf), ['done', 'active', 'waiting']);
      assert.deepEqual(rows().map(completed), [true, false, false]);
      finishProofRequest();
      await request;
      deferredAccount = undefined;
      deferredProofRequest = undefined;
      assert.equal(dialog.open, false, 'a completed signature must not reopen a dialog the user dismissed');
      assert.equal(read('state.needsRefresh'), false);
      await openDialog.fire('click');
      assert.equal(rows().length, planned.length);
      rows().forEach((row, index) => assert.equal(row, planned[index], 'existing rows are updated in place'));
      assert.deepEqual(rows().map(statusOf), ['done', 'done', 'done']);
      assert.deepEqual(rows().map(completed), [true, true, true]);
      assert.match(element('operation-dialog-status').textContent, /Балансы обновлены/);
      await closeDialog.fire('click');

      await element('refresh-balances').fire('click');
      assert.deepEqual(rows().map(statusOf), ['done', 'skipped', 'done']);
      assert.deepEqual(rows().map(completed), [true, false, true]);
      await closeDialog.fire('click');

      rejectNextRefresh = true;
      await element('refresh-balances').fire('click');
      assert.equal(dialog.open, true, 'a failed wallet operation remains visible for the user');
      assert.match(element('operation-dialog-error').textContent, /отмен/i);
      assert.match(stepText(), /Подпись отменена/);
      assert.equal(statusOf(rows()[0]), 'error');
      assert.deepEqual(rows().map(completed), [false, false, false]);
      await closeDialog.fire('click');

      await element('admin-link').fire('click');
      await element('admin-market-toggle').fire('click');
      assert.equal(dialog.open, true, 'the result of a signed transaction remains visible until closed');
      assert.match(stepText(), /Проверить право владельца Vault.*Возобновить работу рынка/);
      assert.match(stepText(), /0x[a-f0-9]{64}/i);
      assert.deepEqual(rows().map(completed), [true, true]);
      await closeDialog.fire('click');

      await tradeNavigation.find((anchor) => anchor.dataset.route === 'account').fire('click');
      await element('refresh-balances').fire('click');
      await closeDialog.fire('click');
      const admission = new Promise((resolve) => { finishDepositAdmission = resolve; });
      const approval = new Promise((resolve) => { finishApproval = resolve; });
      RubaClient.prototype.deposit = async function () {
        await emitStep(this, 'check:deposit-admission', 'check', 'Проверить допуск к пополнению и паузу рынка', () => admission);
        await emitStep(this, 'check:registration-admission', 'check', 'Проверить допуск к регистрации в Vault', () => {});
        await emitStep(this, 'sign:zkState', 'signature', proofRequest, () => {});
        await emitStep(this, 'check:zk-proof', 'check', verification, () => {});
        await emitStep(this, 'sequence:registration-publication', 'sequence', 'Подтвердить регистрацию в сети', () => {});
        await emitStep(this, 'check:registered-vault', 'check', 'Проверить регистрацию баланса в Vault', () => {});
        await emitStep(this, 'check:allowance', 'check', 'Проверить разрешённую сумму RUBA', () => {});
        await emitStep(this, 'tx:approve', 'transaction', 'Разрешить перевод 1 RUBA', () => approval);
        await emitStep(this, 'tx:deposit', 'transaction', 'Пополнить баланс обменника на 1 RUBA', () => {});
      };
      element('deposit-amount').value = '1';
      assert.equal(element('submit-deposit').disabled, false);
      request = element('deposit-form').fire('submit');
      await flush();
      const depositSteps = [...rows()];
      const reset = depositSteps.find((row) => /сбросить разрешение/i.test(row.children[1].textContent));
      const approve = depositSteps.find((row) => /разрешить перевод/i.test(row.children[1].textContent));
      const deposit = depositSteps.find((row) => /пополнить баланс/i.test(row.children[1].textContent));
      const balance = depositSteps.find((row) => /подписать запрос баланса/i.test(row.children[1].textContent));
      assert.ok(reset && approve && deposit && balance, 'optional approvals, the deposit and balance refresh are visible before wallet requests');
      assert.match(textOf(reset), /при необходимости/i);
      assert.match(textOf(approve), /при необходимости/i);
      assert.equal(statusOf(depositSteps[0]), 'active');
      assert.ok(depositSteps.every((row) => !completed(row)));
      finishDepositAdmission();
      await flush();
      assert.equal(statusOf(reset), 'skipped', 'zero existing allowance skips the reset');
      assert.equal(statusOf(approve), 'active');
      assert.equal(statusOf(deposit), 'waiting');
      assert.equal(statusOf(balance), 'waiting');
      assert.equal(completed(approve), false);
      finishApproval();
      await request;
      await flush();
      assert.equal(rows().length, depositSteps.length);
      assert.ok(rows().every((row, index) => row === depositSteps[index]));
      assert.deepEqual([reset, approve, deposit, balance].map(completed), [false, true, true, true]);
      assert.match(element('operation-dialog-status').textContent, /пополнения подтверждена/i);
      await closeDialog.fire('click');

      await element('admin-link').fire('click');
      submittedReceipt = null;
      nextAdminTx = { status: 'submitted', transactionHash: `0x${'fa'.repeat(32)}` };
      await element('admin-market-toggle').fire('click');
      assert.deepEqual(rows().map(statusOf), ['done', 'pending']);
      assert.deepEqual(rows().map(completed), [true, false], 'a sent transaction is checked only after confirmation');
      await closeDialog.fire('click');
    } finally {
      finishRead?.(snapshot);
      finishProofRequest?.();
      finishDepositAdmission?.();
      finishApproval?.();
      await request;
      await flush();
      deferredAccount = undefined;
      RubaClient.prototype.getAccount = originalGetAccount;
      RubaClient.prototype.setMarketPaused = originalSetMarketPaused;
      RubaClient.prototype.deposit = originalDeposit;
    }
  });
});
