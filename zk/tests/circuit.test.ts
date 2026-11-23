import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIELD, buildReceiptTreeV2 } from '../crypto.js';
import { PUBLIC_SIGNAL_NAMES, type TransitionWitness } from '../schema.ts';
import { economicFixtures, registrationFixture } from './fixtures.ts';

const clone = (value: TransitionWitness): TransitionWitness => JSON.parse(JSON.stringify(value)) as TransitionWitness;

test('real circuit witnesses prove registration and enabled economic kinds, rejecting forged transitions', { timeout: 300_000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'ruba-zk-circuit-'));
  try {
    const compilerOutput = execFileSync(process.execPath, [
      'node_modules/circom2/cli.js', 'zk/circuits/transition.circom', '--r1cs', '--wasm', '--sym',
      '-l', 'node_modules', '-o', directory,
    ], { cwd: resolve('.'), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.match(compilerOutput, /written|successfully/i);
    const wasm = join(directory, 'transition_js', 'transition.wasm');
    const r1cs = join(directory, 'transition.r1cs');
    // Runtime import avoids claiming package-owned TypeScript declarations that snarkjs does not ship.
    const { wtns } = await import('snarkjs' as string);
    const fixture = registrationFixture();

    await context.test('valid REGISTER witness satisfies the compiled R1CS and exposes exactly the 13 specified inputs', async () => {
      const witnessPath = join(directory, 'register.wtns');
      await wtns.calculate(fixture.witness, wasm, witnessPath);
      const checked = execFileSync(process.execPath, ['node_modules/snarkjs/build/cli.cjs', 'wtns', 'check', r1cs, witnessPath],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      assert.match(checked, /WITNESS IS CORRECT|WITNESS CHECKING FINISHED SUCCESSFULLY/i);
      const witnessJson = join(directory, 'register-witness.json');
      execFileSync(process.execPath, ['node_modules/snarkjs/build/cli.cjs', 'wtns', 'export', 'json', witnessPath, witnessJson]);
      const wires = JSON.parse(readFileSync(witnessJson, 'utf8')) as string[];
      assert.equal(wires[0], '1');
      assert.deepEqual(wires.slice(1, 14), fixture.publicSignals);
      assert.deepEqual(PUBLIC_SIGNAL_NAMES.map((name) => fixture.witness[name]), fixture.publicSignals);
    });

    const mutations: Array<[string, (witness: TransitionWitness) => void]> = [
      ['forged owner in the updated leaf', (w) => { w.newAccounts[0][0] = (BigInt(w.newAccounts[0][0]) + 1n).toString(); }],
      ['forged registration nonce', (w) => { w.newAccounts[0][4] = '2'; }],
      ['forged old account membership sibling', (w) => { w.accountPaths[0][0] = ((BigInt(w.accountPaths[0][0]) + 1n) % FIELD).toString(); }],
      ['forged account recovery key', (w) => { w.recoveryKeys[0] = (BigInt(w.recoveryKeys[0]) + 1n).toString(); }],
      ['forged updated leaf encryption', (w) => { w.accountCiphertexts[0][0] = ((BigInt(w.accountCiphertexts[0][0]) + 1n) % FIELD).toString(); }],
      ['forged pool recovery key', (w) => { w.poolRecoveryKey = (BigInt(w.poolRecoveryKey) + 1n).toString(); }],
      ['forged pool encryption', (w) => { w.poolCiphertext[0] = ((BigInt(w.poolCiphertext[0]) + 1n) % FIELD).toString(); }],
      ['forged private registration parameters', (w) => { w.params[0][0] = ((BigInt(w.params[0][0]) + 1n) % FIELD).toString(); }],
      ['forged operation commitment', (w) => { w.metadata[0][3] = ((BigInt(w.metadata[0][3]) + 1n) % FIELD).toString(); }],
      ['forged updated leaf commitment', (w) => { w.newLeaves[0] = ((BigInt(w.newLeaves[0]) + 1n) % FIELD).toString(); }],
      ['forged final state root', (w) => { w.newRoot = ((BigInt(w.newRoot) + 1n) % FIELD).toString(); }],
      ['forged starting state root', (w) => { w.previousRoot = ((BigInt(w.previousRoot) + 1n) % FIELD).toString(); }],
      ['forged AUTH digest', (w) => { w.authDigest = ((BigInt(w.authDigest) + 1n) % FIELD).toString(); }],
      ['forged DA digest', (w) => { w.daDigest = ((BigInt(w.daDigest) + 1n) % FIELD).toString(); }],
      ['fabricated inbox consumption', (w) => { w.newInboxCursor = '1'; }],
      ['fabricated trade increment', (w) => { w.newTradeId = '2'; }],
      ['receipt root on control transition', (w) => { w.receiptsRoot = '1'; }],
      ['trade mode without any swaps', (w) => { w.mode = '1'; }],
      ['nonzero NOP metadata', (w) => { w.metadata[1][2] = '1'; }],
      ['nonzero NOP ciphertext', (w) => { w.accountCiphertexts[1][0] = '1'; }],
      ['nonzero NOP hidden balance', (w) => { w.newAccounts[1][1] = '1'; }],
    ];
    for (const [description, mutate] of mutations) {
      await context.test(`rejects ${description}`, async () => {
        const forged = clone(fixture.witness); mutate(forged);
        await assert.rejects(async () => wtns.calculate(forged, wasm, { type: 'mem' }));
      });
    }

    const economic = await economicFixtures();
    assert.deepEqual(economic.map((value) => value.kinds), [[1, 2, 2, 4, 4, 4, 5, 6], [3, 3, 3, 3], [7, 6, 7]]);
    for (const value of economic) {
      await context.test(`real engine stateVersion ${value.stateVersion}: kinds ${value.kinds.join(',')} satisfies R1CS`, async () => {
        const path = join(directory, `economic-${value.stateVersion}.wtns`);
        await wtns.calculate(value.witness, wasm, path);
        const checked = execFileSync(process.execPath, ['node_modules/snarkjs/build/cli.cjs', 'wtns', 'check', r1cs, path],
          { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
        assert.match(checked, /WITNESS IS CORRECT|WITNESS CHECKING FINISHED SUCCESSFULLY/i);
      });
    }
    for (const swapCount of [1, 2, 3] as const) {
      const partial = (await economicFixtures({ swapCount })).find((value) => value.mode === 1)!;
      await context.test(`partial trade packet with ${swapCount} real swaps satisfies R1CS`, async () => {
        const path = join(directory, `partial-${swapCount}.wtns`);
        await wtns.calculate(partial.witness, wasm, path);
        const checked = execFileSync(process.execPath, ['node_modules/snarkjs/build/cli.cjs', 'wtns', 'check', r1cs, path],
          { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
        assert.match(checked, /WITNESS IS CORRECT|WITNESS CHECKING FINISHED SUCCESSFULLY/i);
        assert.equal(BigInt(partial.witness.newTradeId) - BigInt(partial.witness.previousTradeId), BigInt(swapCount));
      });
      await context.test(`partial packet with ${swapCount} swaps rejects an invented receipt in zero padding`, async () => {
        const forged = clone(partial.witness);
        const leaves = Array.from({ length: 4 }, (_, index) => BigInt(partial.receiptLeaves[index] ?? 0n));
        leaves[swapCount] = 1n;
        forged.receiptsRoot = buildReceiptTreeV2(leaves).root.toString();
        await assert.rejects(async () => wtns.calculate(forged, wasm, { type: 'mem' }));
      });
      await context.test(`partial packet with ${swapCount} swaps rejects four-trade public numbering`, async () => {
        const forged = clone(partial.witness);
        forged.newTradeId = (BigInt(forged.previousTradeId) + 4n).toString();
        await assert.rejects(async () => wtns.calculate(forged, wasm, { type: 'mem' }));
      });
    }
    const control = economic[0].witness; const trade = economic[1].witness; const settlement = economic[2].witness;
    const economicMutations: Array<[string, TransitionWitness, (witness: TransitionWitness) => void]> = [
      ['wrong square-root floor for initial LP mint', control, (w) => { w.sqrtFloors[3] = (BigInt(w.sqrtFloors[3]) + 1n).toString(); }],
      ['wrong existing-LP ratio branch', control, (w) => { w.addDirections[4] = '0'; }],
      ['wrong LP mint quotient', control, (w) => { w.quotients[4][2] = (BigInt(w.quotients[4][2]) + 1n).toString(); }],
      ['wrong LP removal output', control, (w) => { w.quotients[6][4] = (BigInt(w.quotients[6][4]) + 1n).toString(); }],
      ['bridge event skipped', control, (w) => { w.metadata[1][4] = '2'; w.params[1][2] = '2'; }],
      ['deposit credited to another token', control, (w) => { w.metadata[1][5] = '1'; w.params[1][0] = '1'; }],
      ['private balance larger than 96 bits', control, (w) => { w.newAccounts[1][1] = (1n << 96n).toString(); }],
      ['wrong AMM floor output', trade, (w) => { w.quotients[0][0] = (BigInt(w.quotients[0][0]) + 1n).toString(); }],
      ['negative modular AMM remainder', trade, (w) => { w.remainders[0][0] = (FIELD - 1n).toString(); }],
      ['forged swap nonce', trade, (w) => { w.newAccounts[0][4] = w.oldAccounts[0][4]; }],
      ['forged receipt salt while keeping published receipt root', trade, (w) => { w.receiptSalts[0] = (BigInt(w.receiptSalts[0]) + 1n).toString(); }],
      ['settlement invents unowned pending funds', settlement, (w) => { w.newAccounts[0][5] = (BigInt(w.oldAccounts[0][5]) + 1n).toString(); }],
      ['settlement increases custody', settlement, (w) => { w.pools[3][5] = (BigInt(w.pools[3][5]) + 1n).toString(); }],
    ];
    for (const [description, source, mutate] of economicMutations) {
      await context.test(`rejects ${description}`, async () => {
        const forged = clone(source); mutate(forged);
        await assert.rejects(async () => wtns.calculate(forged, wasm, { type: 'mem' }));
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
