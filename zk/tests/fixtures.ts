import {
  buildAccountTree, emptyAccount, emptyPool, encryptAccount, encryptPool,
  hashAccount, hashAuthDigest, hashDaDigest, hashDomain, hashOperation, hashPool, hashState, keyCommit,
} from '../crypto.js';
import {
  buildWitness, OperationKind, publicSignals,
  type BuildWitnessInput, type DaRecord, type Fields4, type Fields6, type Fields9,
  type PublicationMetadata, type TransitionPublicSignals, type ZkOperationRecord, type ZkState,
} from '../schema.ts';

export interface RegistrationFixtureOptions {
  chainId?: bigint; vault?: bigint; ruba?: bigint; usdt?: bigint; owner?: bigint; slot?: number;
  recoveryKey?: bigint; poolRecoveryKey?: bigint; salt?: bigint;
}

/** Deterministic, fully calculated REGISTER fixture starting at the specified empty genesis. */
export function registrationFixture(options: RegistrationFixtureOptions = {}) {
  const chainId = options.chainId ?? 31337n;
  const vault = options.vault ?? 0x1000000000000000000000000000000000000001n;
  const ruba = options.ruba ?? 0x2000000000000000000000000000000000000002n;
  const usdt = options.usdt ?? 0x3000000000000000000000000000000000000003n;
  const owner = options.owner ?? 0x4000000000000000000000000000000000000004n;
  const slot = options.slot ?? 3;
  const recoveryKey = options.recoveryKey ?? 111222333n;
  const poolRecoveryKey = options.poolRecoveryKey ?? 444555666n;
  const salt = options.salt ?? 777888999n;
  const poolKeyCommit = keyCommit(poolRecoveryKey);
  const domain = hashDomain(chainId, vault, ruba, usdt, poolKeyCommit);
  const accounts = Array.from({ length: 16 }, () => emptyAccount() as Fields9);
  const pool = emptyPool() as Fields6;
  const initialTree = buildAccountTree(accounts);
  const initialPoolHash = hashPool(pool);
  const startingState: ZkState = {
    accounts: accounts.map((value) => [...value] as Fields9), pool: [...pool] as Fields6,
    inboxCursor: 0n, nextTradeId: 1n,
    root: hashState(domain, initialTree.root, initialPoolHash, 0n, 1n, poolKeyCommit),
  };
  const newAccount: Fields9 = [owner, 0n, 0n, 0n, 1n, 0n, 0n, keyCommit(recoveryKey), salt];
  const params: Fields4 = [keyCommit(recoveryKey), 0n, 0n, 0n];
  const commitment = hashOperation(domain, OperationKind.REGISTER, slot, owner, 0n, params, salt);
  const newLeaf = hashAccount(slot, newAccount);
  const metadata: PublicationMetadata = {
    kind: OperationKind.REGISTER, slot, owner, commitment,
    eventId: 0n, token: 0n, amount: 0n, reference: 0n, signature: '0x',
  };
  const da: DaRecord = {
    kind: OperationKind.REGISTER, slot, owner, newLeaf,
    ciphertext: encryptAccount(recoveryKey, newLeaf, newAccount),
  };
  const finalAccounts = accounts.map((value) => [...value] as Fields9);
  finalAccounts[slot] = [...newAccount] as Fields9;
  const finalTree = buildAccountTree(finalAccounts);
  const endingState: ZkState = {
    accounts: finalAccounts, pool: [...pool] as Fields6, inboxCursor: 0n, nextTradeId: 1n,
    root: hashState(domain, finalTree.root, initialPoolHash, 0n, 1n, poolKeyCommit),
  };
  const operation: ZkOperationRecord = {
    kind: OperationKind.REGISTER, slot, owner, params, oldAccount: [...accounts[slot]] as Fields9,
    newAccount, path: initialTree.proofs[slot] as Fields4,
    oldPool: [...pool] as Fields6, newPool: [...pool] as Fields6, recoveryKey,
    metadata, da, receiptSalt: 0n, beforeState: startingState, afterState: endingState,
  };
  const authorizationRecords: PublicationMetadata[] = Array.from({ length: 8 }, (_, index) => index === 0 ? metadata : {
    kind: 0n, slot: 0n, owner: 0n, commitment: 0n, eventId: 0n, token: 0n, amount: 0n, reference: 0n, signature: '0x',
  });
  const daRecords: DaRecord[] = Array.from({ length: 8 }, (_, index) => index === 0 ? da : {
    kind: 0n, slot: 0n, owner: 0n, newLeaf: 0n, ciphertext: Array<bigint>(7).fill(0n),
  });
  const poolDa = { poolHash: initialPoolHash, poolCiphertext: encryptPool(poolRecoveryKey, initialPoolHash, pool) };
  const signals: TransitionPublicSignals = {
    domain, stateVersion: 1n, mode: 0n, previousRoot: startingState.root, newRoot: endingState.root,
    previousInboxCursor: 0n, newInboxCursor: 0n, previousTradeId: 1n, newTradeId: 1n,
    receiptsRoot: 0n,
    authDigest: hashAuthDigest(domain, 1n, authorizationRecords),
    daDigest: hashDaDigest(domain, 1n, daRecords, poolDa.poolHash, poolDa.poolCiphertext),
    poolKeyCommit,
  };
  const input: BuildWitnessInput = {
    chainId, vault, ruba, usdt, domain, poolKeyCommit, poolRecoveryKey, stateVersion: 1n, mode: 0n,
    startingState, endingState, operations: [operation], publicSignals: signals, poolDa,
  };
  return {
    input, witness: buildWitness(input), publicSignals: publicSignals(signals), signals,
    startingState, endingState, operation, authorizationRecords, daRecords, poolDa,
    chainId, vault, ruba, usdt, domain, owner, slot, recoveryKey, poolRecoveryKey, poolKeyCommit,
  };
}

/** Real-engine fixtures cover every enabled economic kind; chain acceptance is mocked here. */
export async function economicFixtures(options: { swapCount?: 1 | 2 | 3 | 4 } = {}) {
  const { ZkRubaEngine } = await import('../../server/zk/engine.ts');
  const { Wallet } = await import('ethers');
  const wallet = new Wallet(`0x${'1'.padStart(64, '0')}`);
  const config = {
    dbPath: ':memory:', chainId: 31337n,
    vaultAddress: '0x1000000000000000000000000000000000000001',
    rubaAddress: '0x2000000000000000000000000000000000000002',
    usdtAddress: '0x3000000000000000000000000000000000000003', operatorPrivateKey: wallet.privateKey,
  };
  const engine = new ZkRubaEngine(config, 444555666n);
  let salt = 777888999n;
  const authorize = async <T>(operation: object, callback: () => T) => {
    const prepared = engine.prepareAuthorization(wallet.address, operation, ++salt);
    const signature = await wallet.signTypedData(
      { name: 'RubaZkOperation', version: '2', chainId: config.chainId, verifyingContract: config.vaultAddress },
      { PrivateOperation: [{ name: 'commitment', type: 'uint256' }] }, { commitment: prepared.commitment },
    );
    return engine.withZkAuthorization({ account: wallet.address, commitment: prepared.commitment, nonce: prepared.nonce, salt, signature }, callback);
  };
  try {
    await authorize({ kind: 'zkRegister', slot: '0', recoveryKey: '111222333' }, () => engine.registerZkAccount(wallet.address, 111222333n, 0));
    const deposits: Array<[bigint, 'RUBA' | 'USDT', bigint]> = [[1n, 'RUBA', 10n ** 23n], [2n, 'USDT', 10n ** 13n]];
    for (const [eventId, token, amount] of deposits) engine.applyInboxRecord({
      eventId, kind: 2, owner: wallet.address, token, amount, reference: eventId, legacyEventId: `fixture-deposit-${eventId}`,
    });
    for (const [ruba, usdt] of [[10n ** 21n, 10n ** 11n], [2n * 10n ** 20n, 3n * 10n ** 10n], [3n * 10n ** 20n, 10n ** 10n]]) {
      await authorize({ kind: 'addLiquidity', rubaDesired: String(ruba), usdtDesired: String(usdt), rubaMin: '0', usdtMin: '0' },
        () => engine.addLiquidity(wallet.address, ruba, usdt));
    }
    await authorize({ kind: 'removeLiquidity', shares: '1000000000000', rubaMin: '0', usdtMin: '0' },
      () => engine.removeLiquidity(wallet.address, 1000000000000n));
    const firstWithdrawal = await authorize({ kind: 'withdraw', token: 'RUBA', amount: String(10n ** 18n) },
      () => engine.reserveWithdrawal(wallet.address, 'RUBA', 10n ** 18n, (1n << 64n) - 1n, 0n));
    const swapCount = options.swapCount ?? 4;
    for (let i = 0; i < swapCount; ++i) {
      const token = i % 2 ? 'USDT' : 'RUBA'; const amount = i % 2 ? 10n ** 8n : 10n ** 18n;
      await authorize({ kind: 'swap', tokenIn: token, amountIn: String(amount), minOut: '0' },
        () => engine.swap(wallet.address, token, amount, 0n));
    }
    if (swapCount < 4) engine.closePendingBatch();
    // Advance only the local mocked checkpoint so another control fixture can be sealed.
    for (const transition of engine.listTransitions()) engine.markTransitionAccepted(transition.stateVersion,
      `0x${transition.stateVersion.toString(16).padStart(64, '0')}`, Number(transition.stateVersion));
    engine.applyInboxRecord({ eventId: 3n, kind: 7, owner: wallet.address, token: 'RUBA', amount: 10n ** 18n,
      reference: firstWithdrawal.nonce, legacyEventId: 'fixture-settlement-first' });
    const secondWithdrawal = await authorize({ kind: 'withdraw', token: 'USDT', amount: '1000' },
      () => engine.reserveWithdrawal(wallet.address, 'USDT', 1000n, (1n << 64n) - 1n, 0n));
    engine.applyInboxRecord({ eventId: 4n, kind: 7, owner: wallet.address, token: 'USDT', amount: 1000n,
      reference: secondWithdrawal.nonce, legacyEventId: 'fixture-settlement-second' });
    engine.getPendingTransition();
    return engine.listTransitions().map((transition) => ({
      witness: transition.witness as unknown as import('../schema.ts').TransitionWitness,
      publicSignals: transition.publicSignals.map(String), kinds: transition.operations.map((op) => op.kind),
      stateVersion: transition.stateVersion, mode: transition.mode,
      receiptLeaves: transition.operations.filter((op) => op.kind === 3).map((op) => op.receipt!.leaf),
      update: { publicSignals: transition.publicSignals.map(String), metadata: transition.metadata,
        da: transition.accountDA, pool: transition.poolDA },
    }));
  } finally { engine.close(); }
}
