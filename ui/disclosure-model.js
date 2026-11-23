import { AbiCoder, concat, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { formatAmount } from './model.js';

const UINT256_MAX = (1n << 256n) - 1n;
const SCHEMA = 'TradeReceipt(uint256 chainId,address vault,uint256 tradeId,address account,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,uint256 feeNumerator,uint256 feeDenominator,uint256 reserveRubaBefore,uint256 reserveUsdtBefore,uint256 reserveRubaAfter,uint256 reserveUsdtAfter,bytes32 salt)';
const TYPEHASH = keccak256(toUtf8Bytes(SCHEMA));
const coder = AbiCoder.defaultAbiCoder();
const UINT_FIELDS = ['chainId', 'tradeId', 'amountIn', 'amountOut', 'feeNumerator', 'feeDenominator', 'reserveRubaBefore', 'reserveUsdtBefore', 'reserveRubaAfter', 'reserveUsdtAfter'];
const ADDRESS_FIELDS = ['vault', 'account', 'tokenIn', 'tokenOut'];
const ROOT_FIELDS = ['previousStateRoot', 'newStateRoot', 'receiptsRoot'];
const ZK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
let zkCrypto;

function fieldHash(value, label) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*|0x[0-9a-fA-F]{64})$/.test(value) || BigInt(value) >= ZK_FIELD) throw new Error(`${label}: значение вне поля ZK.`);
  return '0x' + BigInt(value).toString(16).padStart(64, '0');
}

export async function inspectDisclosureText(text) {
  const bundle = parseDisclosure(text);
  if (bundle.version === 2) zkCrypto ??= await import(typeof window === 'undefined' ? '../zk/crypto.js' : '/assets/zk-crypto.js');
  return inspectDisclosure(bundle);
}

function uint(value, label, positive = false) {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) throw new Error(`${label}: требуется целое число десятичной строкой.`);
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX || (positive && parsed === 0n)) throw new Error(`${label}: число вне допустимого диапазона.`);
  return parsed;
}

function hash(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label}: требуется хеш из 32 байт.`);
  return value.toLowerCase();
}

function address(value, label) {
  try { return getAddress(value); }
  catch { throw new Error(`${label}: некорректный Ethereum-адрес.`); }
}

function tokenMetadata(value, key) {
  if (!value || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 18
    || (value.symbol !== undefined && (typeof value.symbol !== 'string' || !/^[A-Z][A-Z0-9]{0,11}$/.test(value.symbol)))) {
    throw new Error(`tokens.${key}: нужны адрес, точность от 0 до 18 и корректный символ токена.`);
  }
  return { address: address(value.address, `tokens.${key}.address`), decimals: value.decimals, symbol: value.symbol ?? key };
}

export function hashDisclosureReceipt(receipt) {
  if (receipt.version === 2) {
    if (!zkCrypto) throw new Error('Для ZK-квитанции используйте inspectDisclosureText.');
    return zkCrypto.fieldHex(zkCrypto.hashReceiptV2(receipt));
  }
  return keccak256(coder.encode(
    ['bytes32', 'uint256', 'address', 'uint256', 'address', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes32'],
    [TYPEHASH, receipt.chainId, receipt.vault, receipt.tradeId, receipt.account,
      receipt.tokenIn, receipt.tokenOut, receipt.amountIn, receipt.amountOut,
      receipt.feeNumerator, receipt.feeDenominator, receipt.reserveRubaBefore,
      receipt.reserveUsdtBefore, receipt.reserveRubaAfter, receipt.reserveUsdtAfter, receipt.salt],
  ));
}

function hashPair(left, right) {
  return keccak256(concat(BigInt(left) <= BigInt(right) ? [left, right] : [right, left]));
}

/** Parses a voluntarily supplied disclosure, never queries another user's receipt. */
export function parseDisclosure(text) {
  if (typeof text !== 'string' || text.length > 262_144) throw new Error('Размер JSON не должен превышать 256 КиБ.');
  let bundle;
  try { bundle = JSON.parse(text); }
  catch { throw new Error('Не удалось прочитать JSON. Вставьте квитанцию целиком или выберите JSON-файл.'); }
  if (!bundle || bundle.format !== 'ruba-trade-disclosure' || ![1, 2].includes(bundle.version) || !bundle.receipt || !bundle.batch) {
    throw new Error('Нужен пакет ruba-trade-disclosure версии 1 или 2 с полями receipt и batch.');
  }
  const receipt = {};
  const v2 = bundle.version === 2;
  if (v2) receipt.version = 2;
  else if (bundle.receipt.version === 2 || bundle.receipt.schemaVersion === 2) throw new Error('Версии пакета и квитанции не совпадают.');
  for (const field of UINT_FIELDS) receipt[field] = uint(bundle.receipt[field], `receipt.${field}`, ['chainId', 'tradeId', 'amountIn', 'amountOut', 'feeDenominator'].includes(field));
  for (const field of ADDRESS_FIELDS) receipt[field] = address(bundle.receipt[field], `receipt.${field}`);
  if (receipt.tokenIn === receipt.tokenOut) throw new Error('Входной и выходной токены должны различаться.');
  const rootHash = v2 ? fieldHash : hash;
  receipt.salt = rootHash(bundle.receipt.salt, 'receipt.salt');
  receipt.leaf = rootHash(bundle.receipt.leaf, 'receipt.leaf');
  receipt.batchId = uint(bundle.receipt.batchId, 'receipt.batchId', true);
  if (!Array.isArray(bundle.receipt.proof) || bundle.receipt.proof.length > 2) throw new Error('receipt.proof: нужен массив Merkle proof длиной от 0 до 2.');
  receipt.proof = bundle.receipt.proof.map((item, i) => rootHash(item, `receipt.proof[${i}]`));
  const batch = {};
  for (const field of ['batchId', 'firstTradeId', 'tradeCount']) batch[field] = uint(bundle.batch[field], `batch.${field}`, true);
  for (const field of ROOT_FIELDS) batch[field] = rootHash(bundle.batch[field], `batch.${field}`);
  if (batch.tradeCount > 4n) throw new Error('Пакет должен содержать от 1 до 4 сделок.');
  if (v2 && bundle.batch.stateVersion !== undefined) batch.stateVersion = uint(bundle.batch.stateVersion, 'batch.stateVersion', true);
  const depth = v2 ? 2 : batch.tradeCount === 1n ? 0 : batch.tradeCount === 2n ? 1 : 2;
  if (receipt.proof.length !== depth) throw new Error(`Для пакета из ${batch.tradeCount} сделок нужна длина proof ${depth}.`);
  if (receipt.batchId !== batch.batchId || receipt.tradeId < batch.firstTradeId || receipt.tradeId >= batch.firstTradeId + batch.tradeCount) {
    throw new Error('Идентификаторы сделки и пакета не согласованы.');
  }
  if (bundle.batch.publishedTxHash !== undefined) batch.publishedTxHash = hash(bundle.batch.publishedTxHash, 'batch.publishedTxHash');
  let tokens;
  if (bundle.tokens !== undefined) {
    tokens = {
      RUBA: tokenMetadata(bundle.tokens?.RUBA, 'RUBA'),
      USDT: tokenMetadata(bundle.tokens?.USDT, 'USDT'),
    };
    if (tokens.RUBA.address === tokens.USDT.address) throw new Error('Адреса RUBA и USDT должны различаться.');
    const pair = [tokens.RUBA.address, tokens.USDT.address];
    if (!pair.includes(receipt.tokenIn) || !pair.includes(receipt.tokenOut)) throw new Error('Токены квитанции не совпадают с метаданными пары.');
  }
  return { format: bundle.format, version: bundle.version, demo: bundle.demo === true, receipt, batch, tokens };
}

export function inspectDisclosure(bundle) {
  const calculatedLeaf = hashDisclosureReceipt(bundle.receipt);
  const index = Number(bundle.receipt.tradeId - bundle.batch.firstTradeId);
  const calculatedRoot = bundle.version === 2
    ? zkCrypto.fieldHex(bundle.receipt.proof.reduce((acc, sibling, level) => (index >> level) & 1 ? zkCrypto.H(sibling, acc) : zkCrypto.H(acc, sibling), BigInt(calculatedLeaf)))
    : bundle.receipt.proof.reduce(hashPair, calculatedLeaf);
  const leafMatches = calculatedLeaf.toLowerCase() === bundle.receipt.leaf;
  const proofMatches = calculatedRoot.toLowerCase() === bundle.batch.receiptsRoot;
  return { bundle, calculatedLeaf, calculatedRoot, leafMatches, proofMatches, valid: leafMatches && proofMatches };
}

export function describeToken(bundle, tokenAddress) {
  for (const key of ['RUBA', 'USDT']) {
    if (bundle.tokens?.[key].address === tokenAddress) return { symbol: bundle.tokens[key].symbol ?? key, decimals: bundle.tokens[key].decimals };
  }
  return { symbol: tokenAddress, decimals: null };
}

export function displayTokenAmount(bundle, tokenAddress, amount) {
  const token = describeToken(bundle, tokenAddress);
  return token.decimals === null ? `${amount} мин. единиц (${token.symbol})` : `${formatAmount(amount, token.decimals)} ${token.symbol}`;
}

export function displayFee(bundle) {
  const { feeNumerator, feeDenominator, tokenIn } = bundle.receipt;
  if (feeNumerator % feeDenominator === 0n) return displayTokenAmount(bundle, tokenIn, feeNumerator / feeDenominator);
  const token = describeToken(bundle, tokenIn);
  const numerator = token.decimals === null ? feeNumerator.toString() : formatAmount(feeNumerator, token.decimals);
  return `${numerator} / ${feeDenominator} ${token.decimals === null ? 'мин. единиц' : token.symbol}`;
}

/** A matching uploaded root alone is not evidence of onchain publication. */
export function comparePublication(bundle, response) {
  if (!response || typeof response !== 'object') throw new Error('Сервер вернул некорректный ответ о публикации.');
  if (uint(response.chainId, 'chainId', true) !== bundle.receipt.chainId || address(response.vault, 'vault') !== bundle.receipt.vault) {
    throw new Error('Этот сервер подключён к другой сети или другому Vault.');
  }
  if (!response.batch) throw new Error('Пакет не найден на текущем сервере.');
  for (const field of ['batchId', 'firstTradeId', 'tradeCount']) {
    if (uint(response.batch[field], `batch.${field}`, true) !== bundle.batch[field]) throw new Error('Данные пакета не совпадают с загруженной квитанцией.');
  }
  for (const field of ROOT_FIELDS) {
    if (hash(response.batch[field], `batch.${field}`) !== bundle.batch[field]) throw new Error('Корни пакета не совпадают с загруженной квитанцией.');
  }
  if (bundle.version === 2 && response.proofMode !== 'zk') throw new Error('ZK-квитанция требует подтверждения от ZK Vault.');
  let tokensVerified = false;
  if (bundle.tokens) {
    if (response.tokens) {
      for (const key of ['RUBA', 'USDT']) {
        const expected = tokenMetadata(response.tokens[key], key);
        if (expected.address !== bundle.tokens[key].address || expected.decimals !== bundle.tokens[key].decimals
          || expected.symbol !== bundle.tokens[key].symbol) {
          throw new Error('Названия или точность токенов в файле не соответствуют настроенному Vault.');
        }
      }
      tokensVerified = true;
    }
  }
  return {
    published: response.status === 'published' && response.source === 'contract' && (!bundle.tokens || tokensVerified),
    status: response.status, source: response.source, tokensVerified,
  };
}

/** Only the receipt's committed chain/Vault identify a market; file labels do not. */
export function selectDisclosureMarket(bundle, catalog) {
  if (!catalog || !Array.isArray(catalog.markets) || catalog.markets.length > 128) throw new Error('Сервер вернул некорректный каталог рынков.');
  const markets = catalog.markets.map((market) => {
    if (!market || typeof market.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(market.id)) throw new Error('В каталоге указан некорректный идентификатор рынка.');
    return { ...market, chainId: uint(market.chainId, 'market.chainId', true), vault: address(market.vault, 'market.vault') };
  });
  const matching = markets.filter((market) => market.chainId === bundle.receipt.chainId && market.vault === bundle.receipt.vault);
  if (matching.length !== 1) throw new Error(matching.length ? 'Каталог неоднозначно связывает рынок с Vault.' : 'Рынок с сетью и Vault этой квитанции не найден.');
  return matching[0];
}

export function createDemoDisclosure() {
  const zero = '0x' + '00'.repeat(32);
  const ruba = getAddress('0x0000000000000000000000000000000000000011');
  const usdt = getAddress('0x0000000000000000000000000000000000000022');
  const input = 100n * 10n ** 18n;
  let reserveRuba = 1000n * 10n ** 18n;
  let reserveUsdt = 1000n * 10n ** 6n;
  const receipts = Array.from({ length: 4 }, (_unused, index) => {
    const output = input * 997n * reserveUsdt / (reserveRuba * 1000n + input * 997n);
    const item = {
      chainId: 31337n, vault: getAddress('0x0000000000000000000000000000000000000033'), tradeId: BigInt(index + 1),
      account: getAddress('0x' + (0x44 + index).toString(16).padStart(40, '0')), tokenIn: ruba, tokenOut: usdt,
      amountIn: input, amountOut: output, feeNumerator: input * 3n, feeDenominator: 1000n,
      reserveRubaBefore: reserveRuba, reserveUsdtBefore: reserveUsdt,
      reserveRubaAfter: reserveRuba + input, reserveUsdtAfter: reserveUsdt - output,
      salt: '0x' + (0xab + index).toString(16).repeat(32), batchId: 1n,
    };
    reserveRuba = item.reserveRubaAfter;
    reserveUsdt = item.reserveUsdtAfter;
    return { ...item, leaf: hashDisclosureReceipt(item) };
  });
  const left = hashPair(receipts[0].leaf, receipts[1].leaf);
  const right = hashPair(receipts[2].leaf, receipts[3].leaf);
  const receipt = { ...receipts[0], proof: [receipts[1].leaf, right] };
  return JSON.parse(JSON.stringify({
    format: 'ruba-trade-disclosure', version: 1, demo: true,
    tokens: { RUBA: { address: ruba, decimals: 18 }, USDT: { address: usdt, decimals: 6 } }, receipt,
    batch: { batchId: 1n, previousStateRoot: zero, newStateRoot: '0x' + 'cd'.repeat(32), receiptsRoot: hashPair(left, right), firstTradeId: 1n, tradeCount: 4n },
  }, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
}
