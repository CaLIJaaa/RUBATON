import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildPoseidon } from 'circomlibjs';
import { FIELD, TAGS, ACCOUNT_FIELDS, POOL_FIELDS, PUBLIC_SIGNAL_FIELDS, field, fieldHex, H, fold,
  hashAccount, hashPool, hashState, hashDomain, hashOperation, hashReceiptV2, buildAccountTree, verifyAccountProof,
  buildReceiptTreeV2, keyCommit, encrypt, decrypt, encryptAccount, decryptAccount, encryptPool, decryptPool,
  hashAuthDigest, hashDaDigest, emptyAccount, emptyPool } from '../crypto.js';

test('synchronous browser Poseidon(2) matches installed circomlibjs for ordinary and boundary field values', async () => {
  const reference = await buildPoseidon();
  const pairs = [[0n, 0n], [1n, 2n], [101n, 2n], [FIELD - 1n, FIELD - 1n], [FIELD - 1n, 0n],
    [0n, FIELD - 1n], [(1n << 160n) - 1n, (1n << 96n) - 1n]];
  for (let i = 0n; i < 12n; ++i) pairs.push([i ** 5n + 999n, i ** 9n + 12345n]);
  for (const [left, right] of pairs) assert.equal(H(left, right), BigInt(reference.F.toString(reference([left, right]))));
});

test('external field parsing rejects reductions, negative values and unsafe JS numbers', () => {
  assert.equal(field('0x0001'), 1n);
  assert.equal(field('42'), 42n);
  assert.equal(fieldHex(FIELD - 1n), `0x${(FIELD - 1n).toString(16).padStart(64, '0')}`);
  for (const invalid of [FIELD, FIELD + 1n, -1n, '-1', Number.MAX_SAFE_INTEGER + 1, 0.1, '01', '1.0', ' 1', true, null]) {
    assert.throws(() => field(invalid));
  }
  assert.throws(() => H(FIELD, 1n));
  assert.throws(() => fold(TAGS.STATE, [FIELD]));
});

test('hash schema preserves exact field orders and operation private binding', () => {
  const account = [123n, 10n, 20n, 30n, 1n, 3n, 4n, keyCommit(777n), 888n];
  const named = Object.fromEntries(ACCOUNT_FIELDS.map((name, i) => [name, account[i]]));
  assert.equal(hashAccount(5n, named), fold(TAGS.ACCOUNT, [5n, ...account]));
  assert.equal(hashAccount(5n, account), hashAccount(5n, named));
  assert.notEqual(hashAccount(6n, account), hashAccount(5n, account));
  const pool = [100n, 200n, 300n, 1000n, 500n, 600n];
  assert.equal(hashPool(Object.fromEntries(POOL_FIELDS.map((name, i) => [name, pool[i]]))), fold(TAGS.POOL, pool));
  const domain = hashDomain(31337n, 22n, 33n, 44n, keyCommit(1n));
  assert.equal(domain, fold(TAGS.DOMAIN, [2n, 31337n, 22n, 33n, 44n, keyCommit(1n)]));
  const state = { domain, accountsRoot: 2n, poolHash: hashPool(pool), inboxCursor: 3n, nextTradeId: 4n, poolKeyCommit: keyCommit(1n) };
  assert.equal(hashState(state), fold(TAGS.STATE, Object.values(state)));
  const operation = { domain, kind: 3n, slot: 5n, owner: 123n, oldSpendNonce: 1n, params: [0n, 5n, 4n, 0n], newSalt: 999n };
  const digest = hashOperation(operation);
  assert.equal(digest, hashOperation(domain, 3n, 5n, 123n, 1n, operation.params, 999n));
  for (const change of [{ owner: 124n }, { oldSpendNonce: 2n }, { params: [1n, 5n, 4n, 0n] }, { newSalt: 1000n }]) {
    assert.notEqual(hashOperation({ ...operation, ...change }), digest);
  }
  assert.equal(PUBLIC_SIGNAL_FIELDS.length, 13);
});

test('16-account ordered tree uses slot-specific empties and exact four-sibling proofs', () => {
  const accounts = Array.from({ length: 16 }, () => emptyAccount());
  accounts[3] = [11n, 99n, 88n, 77n, 1n, 0n, 0n, keyCommit(55n), 66n];
  const tree = buildAccountTree(accounts);
  assert.notEqual(tree.leaves[0], tree.leaves[1]);
  for (let slot = 0; slot < 16; ++slot) assert.equal(verifyAccountProof(slot, tree.leaves[slot], tree.proofs[slot], tree.root), true);
  assert.equal(verifyAccountProof(2, tree.leaves[3], tree.proofs[3], tree.root), false);
  const changedPath = tree.proofs[3].slice(); changedPath[0] = (changedPath[0] + 1n) % FIELD;
  assert.equal(verifyAccountProof(3, tree.leaves[3], changedPath, tree.root), false);
  assert.throws(() => verifyAccountProof(3, tree.leaves[3], [], tree.root));
  assert.throws(() => buildAccountTree(Array(17).fill(emptyAccount())));
  assert.throws(() => hashAccount(16, emptyAccount()));
  assert.equal(buildAccountTree().root, buildAccountTree(Array.from({ length: 16 }, () => emptyAccount())).root);
});

test('account and pool encryption exactly follows field stream encoding and survives modulo wrap', () => {
  const account = [123n, (1n << 96n) - 1n, 20n, 30n, 11n, 3n, 4n, keyCommit(777n), FIELD - 1n];
  const leaf = hashAccount(3, account);
  const cipher = encryptAccount(777n, leaf, account);
  assert.equal(cipher.length, 7);
  assert.deepEqual(decryptAccount(777n, leaf, cipher), [account[1], account[2], account[3], account[4], account[5], account[6], account[8]]);
  assert.equal(cipher[0], (account[1] + fold(TAGS.STREAM, [777n, leaf, 0n])) % FIELD);
  assert.notDeepEqual(decryptAccount(778n, leaf, cipher), decryptAccount(777n, leaf, cipher));
  assert.notDeepEqual(encryptAccount(777n, leaf + 1n, account), cipher);
  const pool = [1n, 2n, 3n, 4n, 5n, 6n]; const poolHash = hashPool(pool);
  assert.deepEqual(decryptPool(888n, poolHash, encryptPool(888n, poolHash, pool)), pool);
  assert.deepEqual(decrypt(1n, 2n, encrypt(1n, 2n, [FIELD - 1n, 0n, 1n])), [FIELD - 1n, 0n, 1n]);
  assert.throws(() => decryptPool(1n, 2n, Array(5).fill(0n)));
  assert.deepEqual(emptyPool(), Array(6).fill(0n));
});

test('receipt v2 tree uses ordered Poseidon and binds every receipt field', () => {
  const receipt = { chainId: 31337n, vault: 22n, tradeId: 1n, owner: 123n, tokenIn: 33n, tokenOut: 44n,
    amountIn: 100n, amountOut: 90n, feeNumerator: 300n, feeDenominator: 1000n,
    reserveRubaBefore: 1000n, reserveUsdtBefore: 1000n, reserveRubaAfter: 1100n, reserveUsdtAfter: 910n, salt: 999n };
  const leaf = hashReceiptV2(receipt);
  assert.equal(hashReceiptV2({ ...receipt, owner: undefined, account: 123n }), leaf);
  assert.equal(leaf, fold(TAGS.RECEIPT, [2n, ...Object.values(receipt)]));
  for (const key of Object.keys(receipt)) assert.notEqual(hashReceiptV2({ ...receipt, [key]: receipt[key] + 1n }), leaf);
  const leaves = [leaf, hashReceiptV2({ ...receipt, tradeId: 2n }), hashReceiptV2({ ...receipt, tradeId: 3n }), hashReceiptV2({ ...receipt, tradeId: 4n })];
  assert.equal(buildReceiptTreeV2(leaves).root, H(H(leaves[0], leaves[1]), H(leaves[2], leaves[3])));
  assert.notEqual(buildReceiptTreeV2([leaves[1], leaves[0], leaves[2], leaves[3]]).root, buildReceiptTreeV2(leaves).root);
});

test('partial receipt trees keep four ordered leaves and zero-pad only missing receipts', () => {
  for (let count = 1; count <= 4; ++count) {
    const leaves = Array.from({ length: count }, (_, index) => BigInt(index + 101));
    const padded = [...leaves, ...Array(4 - count).fill(0n)];
    const tree = buildReceiptTreeV2(leaves);
    assert.deepEqual(tree.leaves, padded);
    assert.equal(tree.root, H(H(padded[0], padded[1]), H(padded[2], padded[3])));
    for (let index = 0; index < count; ++index) {
      let node = leaves[index]; let position = index;
      assert.equal(tree.proofs[index].length, 2);
      for (const sibling of tree.proofs[index]) {
        node = position & 1 ? H(sibling, node) : H(node, sibling);
        position >>= 1;
      }
      assert.equal(node, tree.root);
    }
  }
  assert.throws(() => buildReceiptTreeV2([]), /1\.\.4/);
  assert.throws(() => buildReceiptTreeV2([1n, 2n, 3n, 4n, 5n]), /1\.\.4/);
});

test('AUTH and DA digest metadata are fully ordered and padded to eight operations', () => {
  const auth = Array.from({ length: 8 }, () => ({ kind: 0n, slot: 0n, owner: 0n, commitment: 0n, eventId: 0n, token: 0n, amount: 0n, reference: 0n }));
  auth[0] = { kind: 2n, slot: 3n, owner: 123n, commitment: 456n, eventId: 1n, token: 0n, amount: 99n, reference: 1n };
  const digest = hashAuthDigest(11n, 1n, auth);
  assert.equal(digest, fold(TAGS.AUTH, [11n, 1n, ...auth.flatMap(Object.values)]));
  for (const key of Object.keys(auth[0])) {
    const changed = auth.map((row) => ({ ...row })); changed[0][key] += 1n;
    assert.notEqual(hashAuthDigest(11n, 1n, changed), digest);
  }
  const da = Array.from({ length: 8 }, () => ({ kind: 0n, slot: 0n, owner: 0n, newLeaf: 0n, ciphertext: Array(7).fill(0n) }));
  da[0] = { kind: 2n, slot: 3n, owner: 123n, newLeaf: 999n, ciphertext: Array(7).fill(55n) };
  const poolCipher = [1n, 2n, 3n, 4n, 5n, 6n];
  assert.equal(hashDaDigest(11n, 1n, da, 777n, poolCipher), fold(TAGS.DA, [11n, 1n, ...da.flatMap((r) => [r.kind, r.slot, r.owner, r.newLeaf, ...r.ciphertext]), 777n, ...poolCipher]));
  assert.throws(() => hashAuthDigest(1n, 1n, auth.slice(1)));
  assert.throws(() => hashDaDigest(1n, 1n, da.slice(1), 1n, poolCipher));
});

test('browser module has no runtime imports, Node references, or dynamic code execution', async () => {
  const source = await readFile(new URL('../crypto.js', import.meta.url), 'utf8');
  assert.equal(/^\s*import\s/m.test(source), false);
  assert.equal(/\b(?:require\s*\(|process\.|Buffer\.|eval\s*\(|new Function)/.test(source), false);
});
