/** Owner-only recovery from published ZK DA. No server API, wallet access, or transaction submission. */
import {
  field, fieldHex, H, ACCOUNT_FIELDS, PUBLIC_SIGNAL_FIELDS, buildAccountTree,
  emptyAccount, emptyPool, hashAccount, hashPool, hashState, hashDomain,
  hashAuthDigest, hashDaDigest, hashOperation, keyCommit as hashKey, decryptAccount, decryptPool,
  verifyAccountProof,
} from './crypto.js';

export const BACKUP_FORMAT = 'ruba-zk-account-backup';
export const BACKUP_VERSION = 2;
export const PROVEN_WITHDRAWAL_MODE = 'proven-reservation-v1';
const LIMIT96 = 1n << 96n;
const LIMIT64 = 1n << 64n;
const LIMIT160 = 1n << 160n;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HASH_FIELDS = ['domain', 'keyCommit', 'leaf', 'root', 'accountsRoot', 'poolHash', 'poolKeyCommit'];

function requireValue(condition, message) { if (!condition) throw new Error(message); }
function integer(value, limit, label) {
  const parsed = field(value);
  requireValue(parsed < limit, `${label} is out of range`);
  return parsed;
}
function counter(value, label) { return integer(value, LIMIT64, label); }
function address(value, label, allowZero = false) {
  const parsed = integer(value, LIMIT160, label);
  requireValue(allowZero || parsed !== 0n, `${label} cannot be zero`);
  return parsed;
}
function addressHex(value) { return `0x${address(value, 'Address').toString(16).padStart(40, '0')}`; }
function items(value, length, label) {
  requireValue(Array.isArray(value) && value.length === length, `${label} needs exactly ${length} fields`);
  return value;
}
function record(value, label) { requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`); return value; }
function treeFromLeaves(leaves) {
  const levels = [items(leaves, 16, 'Account leaves').map(field)];
  while (levels.at(-1).length > 1) {
    const layer = levels.at(-1); const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(H(layer[i], layer[i + 1]));
    levels.push(next);
  }
  const proofs = levels[0].map((_, slot) => {
    const path = [];
    for (const layer of levels.slice(0, -1)) { path.push(layer[slot ^ 1]); slot >>= 1; }
    return path;
  });
  return { root: levels.at(-1)[0], leaves: levels[0], proofs };
}
function parseSignals(value) {
  const vector = Array.isArray(value) ? items(value, 13, 'Public signals') : PUBLIC_SIGNAL_FIELDS.map((name) => record(value, 'Public signals')[name]);
  return Object.fromEntries(PUBLIC_SIGNAL_FIELDS.map((name, i) => [name, field(vector[i])]));
}
function parseMetadata(value) {
  record(value, 'Operation metadata');
  if (value.reference !== undefined && value.referenceId !== undefined) requireValue(field(value.reference) === field(value.referenceId), 'Conflicting reference fields');
  const result = {
    kind: integer(value.kind, 9n, 'Operation kind'), slot: integer(value.slot, 16n, 'Account slot'),
    owner: address(value.owner, 'Operation owner', true), commitment: field(value.commitment),
    eventId: counter(value.eventId, 'Event ID'), token: integer(value.token, 2n, 'Token index'),
    amount: integer(value.amount, LIMIT96, 'Bridge amount'), reference: counter(value.reference ?? value.referenceId, 'Reference'),
    signature: value.signature ?? '0x',
  };
  requireValue(typeof result.signature === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(result.signature), 'Invalid metadata signature encoding');
  return result;
}
function parseDa(value) {
  record(value, 'Account DA');
  return { kind: integer(value.kind, 9n, 'DA kind'), slot: integer(value.slot, 16n, 'DA slot'),
    owner: address(value.owner, 'DA owner', true), newLeaf: field(value.newLeaf),
    ciphertext: items(value.ciphertext, 7, 'Account ciphertext').map(field) };
}
function parsePoolDa(value) {
  record(value, 'Pool DA');
  return { poolHash: field(value.poolHash), poolCiphertext: items(value.poolCiphertext, 6, 'Pool ciphertext').map(field) };
}
function validateAccount(value) {
  const account = items(value, 9, 'Account').map(field);
  address(account[0], 'Account owner');
  for (const i of [1, 2, 3, 5, 6]) integer(account[i], LIMIT96, ACCOUNT_FIELDS[i]);
  counter(account[4], 'spendNonce');
  requireValue(account[4] > 0n, 'Registered account nonce cannot be zero');
  return account;
}
function parseAnchor(value, config, signals) {
  record(value, 'Separately obtained chain checkpoint');
  requireValue(value.source === 'contract', 'A checkpoint read from the contract is required');
  requireValue(field(value.chainId) === config.chainId && address(value.vault, 'Checkpoint vault') === config.vault, 'Checkpoint chain or Vault mismatch');
  requireValue(counter(value.stateVersion, 'Checkpoint version') === signals.stateVersion, 'Checkpoint version mismatch');
  requireValue(field(value.stateRoot ?? value.root) === signals.newRoot, 'Checkpoint does not accept this state root');
  for (const name of ['blockHash', 'transactionHash']) requireValue(typeof value[name] === 'string' && HEX32.test(value[name]), `Invalid checkpoint ${name}`);
  return { source: 'contract', chainId: config.chainId, vault: config.vault, stateVersion: signals.stateVersion,
    stateRoot: signals.newRoot, blockNumber: counter(value.blockNumber, 'Block number'),
    blockHash: value.blockHash.toLowerCase(), transactionHash: value.transactionHash.toLowerCase(),
    logIndex: counter(value.logIndex ?? 0n, 'Log index'),
    ...(value.tradeBatchId === undefined ? {} : { tradeBatchId: counter(value.tradeBatchId, 'Trade batch ID') }) };
}
function checkedRecoveryTree(state) {
  requireValue(hashDomain(state.config.chainId, state.config.vault, state.config.ruba, state.config.usdt, state.config.poolKeyCommit) === state.domain,
    'Recovery deployment is inconsistent');
  counter(state.stateVersion, 'Recovery version'); counter(state.inboxCursor, 'Recovery cursor');
  requireValue(counter(state.nextTradeId, 'Recovery next trade ID') > 0n, 'Recovery trade ID cannot be zero');
  const tree = treeFromLeaves(state.leaves);
  requireValue(tree.root === state.accountsRoot && hashState(state.domain, state.accountsRoot, state.poolHash,
    state.inboxCursor, state.nextTradeId, state.config.poolKeyCommit) === state.root, 'Recovery tree is inconsistent');
  if (state.anchor) parseAnchor(state.anchor, state.config, { stateVersion: state.stateVersion, newRoot: state.root });
  return tree;
}

/** Config is anchored to a known deployment, not taken on trust from an uploaded backup. */
export function createRecoveryState(config) {
  record(config, 'Recovery config');
  const parsed = { chainId: field(config.chainId), vault: address(config.vault, 'Vault'),
    ruba: address(config.ruba, 'RUBA'), usdt: address(config.usdt, 'USDT'), poolKeyCommit: field(config.poolKeyCommit) };
  requireValue(parsed.chainId > 0n && parsed.ruba !== parsed.usdt, 'Invalid recovery deployment');
  const domain = hashDomain(parsed.chainId, parsed.vault, parsed.ruba, parsed.usdt, parsed.poolKeyCommit);
  if (config.domain !== undefined) requireValue(field(config.domain) === domain, 'Recovery domain mismatch');
  const tree = buildAccountTree(); const poolHash = hashPool(emptyPool());
  const root = hashState(domain, tree.root, poolHash, 0n, 1n, parsed.poolKeyCommit);
  if (config.genesisStateRoot !== undefined) requireValue(field(config.genesisStateRoot) === root, 'Genesis root mismatch');
  requireValue(config.withdrawalMode === undefined || config.withdrawalMode === PROVEN_WITHDRAWAL_MODE || config.withdrawalMode === 'legacy', 'Unsupported recovery withdrawal mode');
  return { config: parsed, withdrawalMode: config.withdrawalMode ?? 'legacy', domain, root, accountsRoot: tree.root, poolHash, poolCiphertext: null,
    inboxCursor: 0n, nextTradeId: 1n, stateVersion: 0n, tradeBatchId: 0n,
    leaves: tree.leaves, owners: Array(16).fill(0n), latestDa: Array(16).fill(null), anchor: null };
}

/**
 * Replay one accepted transition. chainCheckpoint MUST be obtained independently from a
 * canonical contract event/receipt/read. A checkpoint embedded in untrusted JSON is not evidence.
 * This verifies DA/state linkage; Solidity's accepted Groth16 transition supplies economic validity.
 */
export function applyAcceptedUpdate(state, update, chainCheckpoint) {
  record(update, 'Accepted update');
  checkedRecoveryTree(state);
  const s = parseSignals(update.publicSignals ?? update.signals);
  const metadata = items(update.metadata ?? update.operations, 8, 'Operation metadata').map(parseMetadata);
  const da = items(update.da ?? update.accountDA, 8, 'Account DA records').map(parseDa);
  const pool = parsePoolDa(update.pool ?? update.poolDA);
  requireValue(s.domain === state.domain && s.poolKeyCommit === state.config.poolKeyCommit, 'Transition deployment/domain mismatch');
  requireValue(s.stateVersion === state.stateVersion + 1n, 'State version gap or duplicate');
  counter(s.stateVersion, 'State version');
  requireValue(s.previousRoot === state.root, 'Previous root mismatch');
  requireValue(s.previousInboxCursor === state.inboxCursor && s.previousTradeId === state.nextTradeId, 'Previous cursor or trade ID mismatch');
  counter(s.newInboxCursor, 'Inbox cursor'); counter(s.newTradeId, 'Next trade ID');
  requireValue(s.mode === 0n || s.mode === 1n, 'Unsupported transition mode');
  requireValue(s.authDigest === hashAuthDigest(s.domain, s.stateVersion, metadata), 'Authorization digest mismatch');
  requireValue(s.daDigest === hashDaDigest(s.domain, s.stateVersion, da, pool.poolHash, pool.poolCiphertext), 'DA digest mismatch');
  const anchor = parseAnchor(chainCheckpoint, state.config, s);
  const leaves = state.leaves.slice(); const owners = state.owners.slice(); const latestDa = state.latestDa.slice();
  let cursor = state.inboxCursor; let swaps = 0; let active = 0;
  for (let i = 0; i < 8; ++i) {
    const m = metadata[i]; const d = da[i];
    requireValue(m.kind === d.kind && m.slot === d.slot && m.owner === d.owner, 'DA and metadata operation mismatch');
    if (m.kind === 0n) {
      requireValue([m.slot, m.owner, m.commitment, m.eventId, m.token, m.amount, m.reference, d.newLeaf, ...d.ciphertext].every((v) => v === 0n), 'NOP padding must be zero');
      continue;
    }
    ++active;
    requireValue(state.withdrawalMode !== PROVEN_WITHDRAWAL_MODE || m.kind !== 8n, 'Refund operations are disabled for proven withdrawals');
    requireValue(m.owner !== 0n, 'Active operation owner cannot be zero');
    const slot = Number(m.slot);
    if (m.kind === 1n) {
      requireValue(owners[slot] === 0n && leaves[slot] === hashAccount(slot, emptyAccount()), 'Registration slot collision');
      requireValue(!owners.includes(m.owner), 'Owner is already registered in another slot');
      owners[slot] = m.owner;
    } else requireValue(owners[slot] === m.owner, 'Operation does not match registered slot owner');
    if (m.kind === 2n || m.kind === 7n) {
      ++cursor;
      requireValue(m.eventId === cursor && m.amount > 0n, 'Inbox records are not a consecutive prefix');
    } else requireValue([m.eventId, m.token, m.amount, m.reference].every((v) => v === 0n), 'Private operation exposes unexpected bridge metadata');
    if (m.kind === 3n) ++swaps;
    leaves[slot] = d.newLeaf; latestDa[slot] = d;
  }
  requireValue(active > 0, 'Empty transitions are not accepted');
  requireValue(cursor === s.newInboxCursor, 'Final inbox cursor mismatch');
  requireValue((s.mode === 0n && swaps === 0 && s.receiptsRoot === 0n) || (s.mode === 1n && swaps >= 1 && swaps <= 4 && s.receiptsRoot !== 0n), 'Mode, swap count, or receipts root mismatch');
  requireValue(s.newTradeId === state.nextTradeId + BigInt(swaps), 'Final next trade ID mismatch');
  const tree = treeFromLeaves(leaves);
  requireValue(hashState(state.domain, tree.root, pool.poolHash, cursor, s.newTradeId, state.config.poolKeyCommit) === s.newRoot, 'Reconstructed state root mismatch');
  const tradeBatchId = state.tradeBatchId + (s.mode === 1n ? 1n : 0n);
  if (anchor.tradeBatchId !== undefined) requireValue(anchor.tradeBatchId === tradeBatchId, 'Trade batch ID mismatch');
  return { ...state, root: s.newRoot, accountsRoot: tree.root, poolHash: pool.poolHash, poolCiphertext: pool.poolCiphertext,
    inboxCursor: cursor, nextTradeId: s.newTradeId, stateVersion: s.stateVersion, tradeBatchId,
    leaves, owners, latestDa, anchor };
}

export function recoverOwnedAccount(state, credentials) {
  record(credentials, 'Owner credentials');
  const tree = checkedRecoveryTree(state);
  const owner = address(credentials.owner, 'Owner'); const slot = Number(integer(credentials.slot, 16n, 'Account slot'));
  const recoveryKey = field(credentials.recoveryKey); requireValue(recoveryKey > 0n, 'Recovery key cannot be zero');
  const keyCommit = hashKey(recoveryKey);
  if (credentials.keyCommit !== undefined) requireValue(field(credentials.keyCommit) === keyCommit, 'Recovery key commitment mismatch');
  requireValue(state.owners[slot] === owner && state.latestDa[slot] !== null, 'Owner has no accepted account in this slot');
  const d = state.latestDa[slot];
  const plaintext = decryptAccount(recoveryKey, d.newLeaf, d.ciphertext);
  const account = validateAccount([owner, ...plaintext.slice(0, 6), keyCommit, plaintext[6]]);
  requireValue(hashAccount(slot, account) === state.leaves[slot], 'Wrong recovery key or corrupted account ciphertext');
  return { owner, slot, recoveryKey, keyCommit, account, leaf: state.leaves[slot], path: tree.proofs[slot],
    root: state.root, accountsRoot: tree.root, poolHash: state.poolHash, inboxCursor: state.inboxCursor,
    nextTradeId: state.nextTradeId, poolKeyCommit: state.config.poolKeyCommit, domain: state.domain,
    stateVersion: state.stateVersion, anchor: state.anchor, status: state.anchor ? 'chain-anchored' : 'snapshot-only' };
}

/** Optional operator/viewing-key recovery. An owner's key cannot decrypt the pool. */
export function recoverPool(state, poolRecoveryKey) {
  checkedRecoveryTree(state);
  const key = field(poolRecoveryKey);
  requireValue(hashKey(key) === state.config.poolKeyCommit, 'Pool recovery key mismatch');
  requireValue(state.poolCiphertext !== null, 'No accepted pool ciphertext');
  const pool = decryptPool(key, state.poolHash, state.poolCiphertext);
  for (const value of pool) integer(value, LIMIT96, 'Pool value');
  requireValue(hashPool(pool) === state.poolHash, 'Pool ciphertext does not match committed pool');
  return pool;
}

function wireAnchor(value) {
  if (!value) return null;
  return { source: 'contract', chainId: value.chainId.toString(), vault: addressHex(value.vault),
    stateVersion: value.stateVersion.toString(), stateRoot: fieldHex(value.stateRoot),
    blockNumber: value.blockNumber.toString(), blockHash: value.blockHash, transactionHash: value.transactionHash,
    logIndex: value.logIndex.toString(), ...(value.tradeBatchId === undefined ? {} : { tradeBatchId: value.tradeBatchId.toString() }) };
}

function canonicalDecimal(value, label) {
  requireValue(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), `${label} must be a canonical decimal string`);
  return value;
}
function canonicalAddress(value, label) {
  requireValue(typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value), `${label} must be a canonical address`);
  return address(value, label);
}
function canonicalHash(value, label) {
  requireValue(typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value), `${label} must be a canonical field hash`);
  return field(value);
}

/**
 * Validate owner-held openings, NOT onchain claim acceptance. An opening is needed in
 * addition to encrypted aggregate pending balances. Missing nonce/salt cannot be recovered
 * from account DA. A signature may be absent because the draft must be saved before signing.
 * recoverSigner optionally injects ethers.verifyTypedData without importing ethers here.
 */
export function validateWithdrawalClaims(value, context, options = {}) {
  requireValue(Array.isArray(value), 'Withdrawal claims must be an array');
  requireValue(value.length <= 10000, 'Too many withdrawal claim openings');
  record(context, 'Withdrawal claim context');
  const expected = { chainId: field(context.chainId), vault: address(context.vault, 'Claim Vault'),
    domain: field(context.domain), slot: integer(context.slot, 16n, 'Claim slot'), owner: address(context.owner, 'Claim owner'),
    ruba: address(context.ruba, 'Claim RUBA'), usdt: address(context.usdt, 'Claim USDT') };
  requireValue(expected.chainId > 0n && expected.ruba !== expected.usdt, 'Invalid withdrawal claim deployment');
  const seen = new Set();
  return value.map((input) => {
    const claim = record(input, 'Withdrawal claim'); const w = record(claim.withdrawal, 'Withdrawal opening');
    for (const name of ['chainId', 'slot']) canonicalDecimal(claim[name], `Claim ${name}`);
    for (const name of ['amount', 'nonce', 'spendNonce', 'salt']) canonicalDecimal(w[name], `Withdrawal ${name}`);
    const vault = canonicalAddress(claim.vault, 'Claim Vault'); const domain = canonicalHash(claim.domain, 'Claim domain');
    const commitment = canonicalHash(claim.commitment, 'Claim commitment');
    const owner = canonicalAddress(w.account, 'Withdrawal account'); const token = canonicalAddress(w.token, 'Withdrawal token');
    const chainId = field(claim.chainId); const slot = integer(claim.slot, 16n, 'Claim slot');
    requireValue(chainId === expected.chainId && vault === expected.vault && domain === expected.domain && slot === expected.slot && owner === expected.owner,
      'Withdrawal claim belongs to another owner, slot or deployment');
    requireValue(token === expected.ruba || token === expected.usdt, 'Unsupported withdrawal token');
    const amount = integer(w.amount, LIMIT96, 'Withdrawal amount'); const nonce = counter(w.nonce, 'Withdrawal nonce');
    const spendNonce = counter(w.spendNonce, 'Withdrawal spend nonce'); const salt = field(w.salt);
    requireValue(amount > 0n && salt > 0n && nonce > 0n && nonce === spendNonce, 'Invalid withdrawal amount, salt or nonce equality');
    requireValue(hashOperation(domain, 6n, slot, owner, spendNonce, [token === expected.ruba ? 0n : 1n, amount, nonce, 0n], salt) === commitment,
      'Withdrawal opening commitment mismatch');
    requireValue(!seen.has(claim.commitment), 'Duplicate withdrawal claim commitment'); seen.add(claim.commitment);
    if (claim.stateVersion !== null) {
      canonicalDecimal(claim.stateVersion, 'Claim state version');
      requireValue(counter(claim.stateVersion, 'Claim state version') > 0n, 'Claim state version cannot be zero');
    }
    let signature;
    if (claim.signature !== undefined) {
      requireValue(typeof claim.signature === 'string' && /^0x[0-9a-f]{130}$/.test(claim.signature), 'Claim signature must be a canonical 65-byte signature');
      signature = claim.signature;
      if (options.recoverSigner) {
        const recovered = options.recoverSigner({ name: 'RubaZkOperation', version: '2', chainId, verifyingContract: addressHex(vault) },
          { PrivateOperation: [{ name: 'commitment', type: 'uint256' }] }, { commitment }, signature);
        requireValue(address(recovered, 'Claim signature signer') === owner, 'Withdrawal claim signature is not from its owner');
      }
    }
    // Never retain uploaded spent/accepted/status flags; only an RPC mapping read establishes those.
    return { chainId: chainId.toString(), vault: addressHex(vault), domain: fieldHex(domain), slot: slot.toString(), commitment: fieldHex(commitment),
      withdrawal: { account: addressHex(owner), token: addressHex(token), amount: amount.toString(), nonce: nonce.toString(), spendNonce: spendNonce.toString(), salt: salt.toString() },
      ...(signature === undefined ? {} : { signature }), stateVersion: claim.stateVersion };
  });
}

export function buildAccountBackup(state, credentials) {
  const owned = recoverOwnedAccount(state, credentials);
  const withdrawalClaims = validateWithdrawalClaims(credentials.withdrawalClaims ?? [], { ...state.config,
    domain: state.domain, owner: owned.owner, slot: owned.slot }, { recoverSigner: credentials.recoverSigner });
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION,
    chainId: state.config.chainId.toString(), vault: addressHex(state.config.vault),
    ruba: addressHex(state.config.ruba), usdt: addressHex(state.config.usdt), owner: addressHex(owned.owner),
    slot: owned.slot.toString(), recoveryKey: owned.recoveryKey.toString(), keyCommit: fieldHex(owned.keyCommit),
    account: owned.account.map(String), leaf: fieldHex(owned.leaf), path: owned.path.map(fieldHex),
    domain: fieldHex(owned.domain), root: fieldHex(owned.root), accountsRoot: fieldHex(owned.accountsRoot),
    poolHash: fieldHex(owned.poolHash), inboxCursor: owned.inboxCursor.toString(), nextTradeId: owned.nextTradeId.toString(),
    poolKeyCommit: fieldHex(owned.poolKeyCommit), stateVersion: owned.stateVersion.toString(), anchor: wireAnchor(owned.anchor),
    pendingAuthorizations: credentials.pendingAuthorizations ?? [], withdrawalClaims };
}

/** Validate a local snapshot; its embedded anchor never proves chain acceptance or freshness. */
export function parseAccountBackup(input, expected = {}, options = {}) {
  if (typeof input === 'string') { requireValue(input.length <= 2 * 1024 * 1024, 'Backup exceeds 2 MiB'); input = JSON.parse(input); }
  const b = record(input, 'Account backup');
  requireValue(b.format === BACKUP_FORMAT && b.version === BACKUP_VERSION, 'Unsupported account backup format/version');
  for (const name of ['chainId', 'slot', 'recoveryKey', 'inboxCursor', 'nextTradeId', 'stateVersion']) requireValue(typeof b[name] === 'string' && /^(0|[1-9][0-9]*)$/.test(b[name]), `Backup ${name} must be a canonical decimal string`);
  for (const name of ['vault', 'ruba', 'usdt', 'owner']) requireValue(typeof b[name] === 'string' && /^0x[0-9a-f]{40}$/.test(b[name]), `Backup ${name} must be a canonical address`);
  for (const name of HASH_FIELDS) requireValue(typeof b[name] === 'string' && /^0x[0-9a-f]{64}$/.test(b[name]), `Backup ${name} must be a canonical field hash`);
  for (const v of items(b.account, 9, 'Backup account')) requireValue(typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v), 'Backup account fields must be canonical decimal strings');
  for (const v of items(b.path, 4, 'Backup path')) requireValue(typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v), 'Backup path fields must be canonical field hashes');
  const config = createRecoveryState(b).config;
  const owner = address(b.owner, 'Backup owner'); const slot = Number(integer(b.slot, 16n, 'Backup slot'));
  const recoveryKey = field(b.recoveryKey); requireValue(recoveryKey > 0n && hashKey(recoveryKey) === field(b.keyCommit), 'Backup recovery key commitment mismatch');
  const account = validateAccount(b.account);
  requireValue(account[0] === owner && account[7] === field(b.keyCommit), 'Backup account owner/key mismatch');
  requireValue(hashAccount(slot, account) === field(b.leaf), 'Backup account leaf mismatch');
  requireValue(verifyAccountProof(slot, field(b.leaf), b.path, b.accountsRoot), 'Backup account path mismatch');
  counter(b.inboxCursor, 'Backup cursor'); counter(b.nextTradeId, 'Backup next trade ID'); counter(b.stateVersion, 'Backup state version');
  requireValue(BigInt(b.nextTradeId) >= 1n && BigInt(b.stateVersion) >= 1n, 'Backup counters are invalid');
  requireValue(hashDomain(config.chainId, config.vault, config.ruba, config.usdt, config.poolKeyCommit) === field(b.domain), 'Backup domain mismatch');
  requireValue(hashState(b.domain, b.accountsRoot, b.poolHash, b.inboxCursor, b.nextTradeId, b.poolKeyCommit) === field(b.root), 'Backup state root mismatch');
  for (const name of ['chainId', 'vault', 'ruba', 'usdt', 'owner']) if (expected[name] !== undefined) requireValue(field(b[name]) === field(expected[name]), `Backup expected ${name} mismatch`);
  requireValue(Array.isArray(b.pendingAuthorizations ?? []), 'Backup pending authorizations must be an array');
  const withdrawalClaims = validateWithdrawalClaims(b.withdrawalClaims ?? [], { ...config, domain: b.domain, owner, slot }, options);
  requireValue(b.anchor === null || (b.anchor && typeof b.anchor === 'object' && !Array.isArray(b.anchor)), 'Backup anchor must be an object or null');
  if (b.anchor !== null) {
    for (const name of ['chainId', 'stateVersion', 'blockNumber', 'logIndex', ...(b.anchor.tradeBatchId === undefined ? [] : ['tradeBatchId'])]) {
      requireValue(typeof b.anchor[name] === 'string' && /^(0|[1-9][0-9]*)$/.test(b.anchor[name]), `Backup anchor ${name} must be a canonical decimal string`);
    }
    requireValue(typeof b.anchor.vault === 'string' && /^0x[0-9a-f]{40}$/.test(b.anchor.vault), 'Backup anchor Vault must be a canonical address');
    for (const name of ['stateRoot', 'blockHash', 'transactionHash']) requireValue(typeof b.anchor[name] === 'string' && /^0x[0-9a-f]{64}$/.test(b.anchor[name]), `Backup anchor ${name} must be canonical hex`);
    parseAnchor(b.anchor, config, { stateVersion: field(b.stateVersion), newRoot: field(b.root) });
  }
  // Return a new object. Pending authorizations are archival data, never sent by this module.
  return { ...b, pendingAuthorizations: b.pendingAuthorizations ?? [], withdrawalClaims, status: 'snapshot-only', current: false };
}

/**
 * A current checkpoint distinguishes an older self-consistent snapshot from the current root.
 * 'historical' is NOT a claim that this old root was once accepted: that needs a separate
 * transitions(backup.stateVersion) read. Only 'chain-anchored' confirms the supplied checkpoint.
 */
export function inspectAccountBackup(input, checkpoint, expected = {}, options = {}) {
  const backup = parseAccountBackup(input, expected, options);
  if (!checkpoint) return { backup, status: 'snapshot-only', current: false };
  record(checkpoint, 'Independent contract checkpoint');
  requireValue(checkpoint.source === 'contract', 'Independent contract checkpoint required');
  requireValue(field(checkpoint.chainId) === field(backup.chainId) && field(checkpoint.vault) === field(backup.vault), 'Checkpoint deployment mismatch');
  const version = counter(checkpoint.stateVersion, 'Checkpoint version');
  if (BigInt(backup.stateVersion) < version) return { backup, status: 'historical', current: false };
  if (BigInt(backup.stateVersion) > version) return { backup, status: 'not-accepted', current: false };
  requireValue(field(checkpoint.stateRoot ?? checkpoint.root) === field(backup.root), 'Backup root differs from accepted checkpoint');
  return { backup, status: 'chain-anchored', current: true };
}

// The interface is deliberately supplied by the caller, from the application's pinned ABI.
// There are no ethers, Node, HTTP API, private-key, wallet, or transaction-send dependencies.
const PUBLICATION_INPUTS = 'uint256[13] signals,tuple(uint256 kind,uint256 slot,address owner,uint256 commitment,uint256 eventId,uint256 token,uint256 amount,uint256 referenceId,bytes signature)[8] operations,tuple(uint256 kind,uint256 slot,address owner,uint256 newLeaf,uint256[7] ciphertext)[8] accountDA,tuple(uint256 poolHash,uint256[6] poolCiphertext) poolDA,tuple(uint256[2] a,uint256[2][2] b,uint256[2] c) proof';
const WITHDRAWAL_INPUT = 'tuple(address account,address token,uint256 amount,uint256 nonce,uint256 spendNonce,uint256 salt) withdrawal';
export const RECOVERY_VAULT_ABI = Object.freeze([
  'event ZkTransitionPublished(uint256 indexed stateVersion,uint256 indexed tradeBatchId,uint256[13] publicSignals)',
  `function publishZkTransition(${PUBLICATION_INPUTS},tuple(uint256 deadline,uint256 signerEpoch,bytes signature) authorization)`,
  `function publishProvenTransition(${PUBLICATION_INPUTS})`,
  `function publishProvenTransitionAndWithdraw(${PUBLICATION_INPUTS},${WITHDRAWAL_INPUT})`,
  `function withdrawProven(${WITHDRAWAL_INPUT})`,
  ...['domain', 'poolKeyCommit', 'stateVersion', 'inboxCursor', 'nextTradeId', 'ZK_VERSION'].map((name) => `function ${name}() view returns(uint256)`),
  ...['stateRoot', 'genesisStateRoot'].map((name) => `function ${name}() view returns(bytes32)`),
  ...['ruba', 'usdt'].map((name) => `function ${name}() view returns(address)`),
  'function proofMode() view returns(string)',
  'function withdrawalMode() view returns(string)',
  'function withdrawalClaims(uint256 commitment) view returns(address owner,uint256 slot,uint256 stateVersion)',
  'function spentWithdrawalCommitments(uint256 commitment) view returns(bool)',
  'function usedWithdrawalNonces(address account,uint256 nonce) view returns(bool)',
  'function transitions(uint256 version) view returns(uint256[13])',
]);

const PUBLISH_SIGNATURE = 'publishZkTransition(uint256[13],(uint256,uint256,address,uint256,uint256,uint256,uint256,uint256,bytes)[8],(uint256,uint256,address,uint256,uint256[7])[8],(uint256,uint256[6]),(uint256[2],uint256[2][2],uint256[2]),(uint256,uint256,bytes))';
const PROVEN_SIGNATURE = 'publishProvenTransition(uint256[13],(uint256,uint256,address,uint256,uint256,uint256,uint256,uint256,bytes)[8],(uint256,uint256,address,uint256,uint256[7])[8],(uint256,uint256[6]),(uint256[2],uint256[2][2],uint256[2]))';
const ATOMIC_SIGNATURE = 'publishProvenTransitionAndWithdraw(uint256[13],(uint256,uint256,address,uint256,uint256,uint256,uint256,uint256,bytes)[8],(uint256,uint256,address,uint256,uint256[7])[8],(uint256,uint256[6]),(uint256[2],uint256[2][2],uint256[2]),(address,address,uint256,uint256,uint256,uint256))';
const EVENT_SIGNATURE = 'ZkTransitionPublished(uint256,uint256,uint256[13])';

function logIndex(log) { return counter(log.index ?? log.logIndex, 'Log index'); }
function sameHex(left, right) { return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase(); }
function decodeCall(args) {
  return { publicSignals: Array.from(args[0]),
    metadata: Array.from(args[1], (m) => ({ kind: m[0], slot: m[1], owner: m[2], commitment: m[3], eventId: m[4], token: m[5], amount: m[6], reference: m[7], signature: m[8] })),
    da: Array.from(args[2], (d) => ({ kind: d[0], slot: d[1], owner: d[2], newLeaf: d[3], ciphertext: Array.from(d[4]) })),
    pool: { poolHash: args[3][0], poolCiphertext: Array.from(args[3][1]) } };
}

/**
 * Replay accepted DA using ONLY a chain provider and a pinned contract interface.
 * RPC is the trust boundary: use a trusted provider/chain, not an application server's JSON.
 * Pins one block and verifies logs against successful receipts, calldata, transitions(version),
 * and final Vault getters. Supports historical signed and current proof-only/atomic publications;
 * nested calls are rejected because their calldata requires execution traces.
 */
export async function scanAcceptedUpdates(provider, vault, options) {
  record(options, 'Recovery scanner options');
  const iface = options.contractInterface;
  requireValue(iface && [PUBLISH_SIGNATURE, PROVEN_SIGNATURE, ATOMIC_SIGNATURE].some((signature) => iface.getFunction(signature)?.format('sighash') === signature) &&
    iface.getEvent(EVENT_SIGNATURE)?.format('sighash') === EVENT_SIGNATURE, 'Pinned ZkRubaVault interface is required');
  const vaultAddress = addressHex(vault);
  const network = await provider.getNetwork();
  const chainId = field(network.chainId);
  const tip = await provider.getBlock(options.toBlock ?? 'latest');
  requireValue(tip && typeof tip.hash === 'string' && HEX32.test(tip.hash), 'Cannot pin a canonical recovery block');
  const toBlock = counter(tip.number, 'Recovery block');
  const fromBlock = counter(options.fromBlock ?? 0n, 'Deployment block');
  requireValue(fromBlock <= toBlock, 'Recovery deployment block is after selected block');
  const blockTag = `0x${toBlock.toString(16)}`;
  const read = async (name, args = []) => {
    const data = iface.encodeFunctionData(name, args);
    const result = await provider.call({ to: vaultAddress, data, blockTag });
    return iface.decodeFunctionResult(name, result);
  };
  const names = ['domain', 'poolKeyCommit', 'stateVersion', 'stateRoot', 'genesisStateRoot', 'ruba', 'usdt', 'inboxCursor', 'nextTradeId', 'proofMode', 'ZK_VERSION'];
  const values = Object.fromEntries(await Promise.all(names.map(async (name) => [name, (await read(name))[0]])));
  requireValue(values.proofMode === 'groth16-bn254-v2' && field(values.ZK_VERSION) === 2n, 'Vault does not support the pinned ZK recovery format');
  // Historical deployments do not expose withdrawalMode(). They remain readable;
  // a caller expecting the new mode must explicitly pin it instead of accepting fallback.
  let withdrawalMode = 'legacy';
  try { withdrawalMode = (await read('withdrawalMode'))[0]; } catch (error) {
    if (options.expected?.withdrawalMode === PROVEN_WITHDRAWAL_MODE) throw new Error('Vault does not expose the required proven withdrawal mode', { cause: error });
  }
  requireValue(withdrawalMode === 'legacy' || withdrawalMode === PROVEN_WITHDRAWAL_MODE, 'Unsupported Vault withdrawal mode');
  if (options.expected?.withdrawalMode !== undefined) requireValue(options.expected.withdrawalMode === withdrawalMode, 'Unexpected recovery withdrawalMode');
  let state = createRecoveryState({ chainId, vault: vaultAddress, ruba: values.ruba, usdt: values.usdt,
    poolKeyCommit: values.poolKeyCommit, domain: values.domain, genesisStateRoot: values.genesisStateRoot, withdrawalMode });
  for (const name of ['chainId', 'vault', 'ruba', 'usdt', 'poolKeyCommit', 'domain']) {
    if (options.expected?.[name] !== undefined) requireValue(field(options.expected[name]) === (name === 'domain' ? state.domain : state.config[name]), `Unexpected recovery ${name}`);
  }
  const range = integer(options.blockRange ?? 2000n, 100001n, 'Log scan block range');
  requireValue(range > 0n, 'Log scan block range must be positive');
  const topic = iface.getEvent(EVENT_SIGNATURE).topicHash;
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += range) {
    const end = start + range - 1n < toBlock ? start + range - 1n : toBlock;
    logs.push(...await provider.getLogs({ address: vaultAddress, topics: [topic], fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }));
  }
  logs.sort((a, b) => {
    const blocks = counter(a.blockNumber, 'Event block') - counter(b.blockNumber, 'Event block');
    if (blocks) return blocks < 0n ? -1 : 1;
    const indexes = logIndex(a) - logIndex(b); return indexes < 0n ? -1 : indexes > 0n ? 1 : 0;
  });
  for (const log of logs) {
    requireValue(!log.removed && sameHex(log.address, vaultAddress), 'Removed or foreign recovery event');
    const height = counter(log.blockNumber, 'Event block');
    requireValue(height >= fromBlock && height <= toBlock, 'Event outside pinned block range');
    const [tx, receipt, block] = await Promise.all([
      provider.getTransaction(log.transactionHash), provider.getTransactionReceipt(log.transactionHash), provider.getBlock(`0x${height.toString(16)}`),
    ]);
    requireValue(tx && receipt && (receipt.status === 1 || receipt.status === 1n) && block, 'Accepted transition requires a successful chain receipt');
    requireValue(sameHex(tx.to, vaultAddress), 'Recovery currently requires a direct Vault publication; nested calls require traces');
    requireValue(sameHex(tx.hash, log.transactionHash) && sameHex(receipt.hash ?? receipt.transactionHash, log.transactionHash), 'Transaction hash mismatch');
    requireValue(sameHex(log.blockHash, block.hash) && sameHex(receipt.blockHash, block.hash) && counter(receipt.blockNumber, 'Receipt block') === height, 'Transition block is no longer canonical');
    requireValue(receipt.logs.some((r) => sameHex(r.address, vaultAddress) && logIndex(r) === logIndex(log) &&
      sameHex(r.data, log.data) && r.topics.length === log.topics.length && r.topics.every((t, i) => sameHex(t, log.topics[i]))), 'Event does not occur in successful transaction receipt');
    const event = iface.parseLog({ topics: log.topics, data: log.data });
    const call = iface.parseTransaction({ data: tx.data, value: tx.value ?? 0n });
    const allowed = withdrawalMode === PROVEN_WITHDRAWAL_MODE ? [PROVEN_SIGNATURE, ATOMIC_SIGNATURE] : [PUBLISH_SIGNATURE];
    requireValue(event && event.name === 'ZkTransitionPublished' && call && allowed.includes(call.signature), 'Unexpected publication calldata/event or withdrawal mode');
    const update = decodeCall(call.args);
    const signals = update.publicSignals.map(field);
    requireValue(signals.every((v, i) => v === field(event.args[2][i])) && signals[1] === field(event.args[0]), 'Event and calldata signals differ');
    const accepted = (await read('transitions', [signals[1]]))[0];
    requireValue(signals.every((v, i) => v === field(accepted[i])), 'Transition is not recorded in the pinned Vault');
    state = applyAcceptedUpdate(state, update, { source: 'contract', chainId, vault: vaultAddress,
      stateVersion: signals[1], stateRoot: signals[4], blockNumber: height, blockHash: block.hash,
      transactionHash: tx.hash, logIndex: logIndex(log), tradeBatchId: event.args[1] });
  }
  requireValue(state.stateVersion === field(values.stateVersion) && state.root === field(values.stateRoot) &&
    state.inboxCursor === field(values.inboxCursor) && state.nextTradeId === field(values.nextTradeId), 'Recovery log history is incomplete or does not match latest accepted Vault state');
  const latestBlock = await provider.getBlock(blockTag);
  requireValue(latestBlock && sameHex(latestBlock.hash, tip.hash), 'Recovery chain reorganized; retry from the canonical chain');
  return { ...state, scannedThrough: { blockNumber: toBlock, blockHash: tip.hash.toLowerCase() } };
}

/** Independently read perpetual claim acceptance/spending. This function never sends a transaction. */
export async function inspectWithdrawalClaims(provider, vault, options) {
  record(options, 'Claim inspection options');
  const claims = validateWithdrawalClaims(options.claims, options.context, options);
  const iface = options.contractInterface; const vaultAddress = addressHex(vault);
  requireValue(address(vaultAddress, 'Claim Vault') === address(options.context.vault, 'Expected Vault'), 'Claim inspection Vault mismatch');
  requireValue(field((await provider.getNetwork()).chainId) === field(options.context.chainId), 'Claim inspection chain mismatch');
  const block = await provider.getBlock(options.toBlock ?? 'latest');
  requireValue(block && typeof block.hash === 'string' && HEX32.test(block.hash), 'Cannot pin claim inspection block');
  const blockNumber = counter(block.number, 'Claim inspection block'); const blockTag = `0x${blockNumber.toString(16)}`;
  const read = async (name, args = []) => iface.decodeFunctionResult(name,
    await provider.call({ to: vaultAddress, data: iface.encodeFunctionData(name, args), blockTag }));
  const [mode, domain, ruba, usdt, version] = await Promise.all(['withdrawalMode', 'domain', 'ruba', 'usdt', 'stateVersion'].map((name) => read(name)));
  requireValue(mode[0] === PROVEN_WITHDRAWAL_MODE, 'Vault does not support proven withdrawal claims');
  requireValue(field(domain[0]) === field(options.context.domain) && address(ruba[0], 'Vault RUBA') === address(options.context.ruba, 'Expected RUBA') &&
    address(usdt[0], 'Vault USDT') === address(options.context.usdt, 'Expected USDT'), 'Claim inspection deployment/domain mismatch');
  const stateVersion = counter(version[0], 'Accepted state version');
  const inspected = await Promise.all(claims.map(async (claim) => {
    const [accepted, spentResult, nonceResult] = await Promise.all([
      read('withdrawalClaims', [claim.commitment]), read('spentWithdrawalCommitments', [claim.commitment]),
      read('usedWithdrawalNonces', [claim.withdrawal.account, claim.withdrawal.nonce]),
    ]);
    requireValue(typeof spentResult[0] === 'boolean' && typeof nonceResult[0] === 'boolean', 'Invalid claim spending flags');
    const owner = address(accepted[0], 'Accepted claim owner', true);
    const slot = integer(accepted[1], 16n, 'Accepted claim slot'); const claimVersion = counter(accepted[2], 'Accepted claim version');
    const spent = spentResult[0]; const nonceUsed = nonceResult[0];
    if (owner === 0n) {
      requireValue(slot === 0n && claimVersion === 0n && !spent, 'Missing claim has inconsistent contract metadata');
      return { claim, source: 'contract', status: nonceUsed ? 'nonce-used' : 'unpublished', accepted: false, spent, nonceUsed, stateVersion: null };
    }
    requireValue(owner === address(claim.withdrawal.account, 'Claim owner') && slot === field(claim.slot) && claimVersion > 0n && claimVersion <= stateVersion,
      'Accepted claim does not match this owner, slot or state version');
    requireValue(spent === nonceUsed, 'Accepted claim spent and nonce flags disagree');
    return { claim: { ...claim, stateVersion: claimVersion.toString() }, source: 'contract', status: spent ? 'spent' : 'claimable',
      accepted: true, spent, nonceUsed, stateVersion: claimVersion };
  }));
  const canonical = await provider.getBlock(blockTag);
  requireValue(canonical && sameHex(canonical.hash, block.hash), 'Claim inspection chain reorganized; retry');
  return { claims: inspected, checkedAt: { blockNumber, blockHash: block.hash.toLowerCase() } };
}
