import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, Transaction, Wallet, ZeroHash, getAddress, getCreateAddress, keccak256, parseEther, toQuantity } from 'ethers';
import { MAINNET_USDT } from '../tenderly-common.ts';
import { VNET_PRECOMPILE, fundNativeBatch, sendRecoverableBootstrap, sendRecoverableTransaction, supportsVnetPrecompile } from '../tenderly-atomic.ts';

const accounts = ['11', '22', '33', '44'].map((prefix) => getAddress(`0x${prefix.repeat(20)}`));

test('native funding batches equal targets, skips sufficient balances, and is idle on restart', async () => {
  const target = parseEther('10');
  const balances = new Map(accounts.map((account) => [account, 0n]));
  balances.set(accounts[3], parseEther('20'));
  const writes: unknown[][] = [];
  const provider = {
    getBalance: async (account: string) => balances.get(account) ?? 0n,
    send: async (method: string, parameters: [string[], string]) => {
      assert.equal(method, 'tenderly_setBalance');
      writes.push(parameters);
      for (const account of parameters[0]) balances.set(account, BigInt(parameters[1]));
      return true;
    },
  };
  const targets = accounts.map((account) => ({ account, amount: target }));
  assert.equal(await fundNativeBatch(provider as any, targets), 1);
  assert.deepEqual(writes, [[accounts.slice(0, 3), toQuantity(target)]]);
  assert.equal(balances.get(accounts[3]), parseEther('20'), 'a larger existing balance must not be lowered');
  assert.equal(await fundNativeBatch(provider as any, targets), 0);
  assert.equal(writes.length, 1, 'restarting must not consume another faucet write');
});

test('native funding groups different amounts and deduplicates an account at its largest target', async () => {
  const balances = new Map<string, bigint>();
  const writes: [string[], string][] = [];
  const provider = {
    getBalance: async (account: string) => balances.get(account) ?? 0n,
    send: async (_method: string, parameters: [string[], string]) => {
      writes.push(parameters);
      for (const account of parameters[0]) balances.set(account, BigInt(parameters[1]));
      return true;
    },
  };
  assert.equal(await fundNativeBatch(provider as any, [
    { account: accounts[0], amount: 5n }, { account: accounts[1], amount: 2n },
    { account: accounts[0], amount: 10n }, { account: accounts[2], amount: 10n },
  ]), 2);
  assert.deepEqual(writes, [[[accounts[0], accounts[2]], '0xa'], [[accounts[1]], '0x2']]);
  assert.equal(balances.get(accounts[0]), 10n);
});

test('native funding rejects a silent faucet failure instead of treating the fork as funded', async () => {
  let writes = 0;
  const provider = {
    getBalance: async () => 0n,
    send: async () => { writes += 1; return true; },
  };
  await assert.rejects(fundNativeBatch(provider as any, [{ account: accounts[0], amount: 10n }]), /не подтвердил групповое пополнение/);
  assert.equal(writes, 1, 'a failed confirmation must not issue another faucet write');
});

test('native funding propagates read and quota failures without falling back to individual writes', async () => {
  const disconnected = Object.assign(new Error('network unavailable'), { code: 'NETWORK_ERROR' });
  const quota = Object.assign(new Error('quota limit reached'), { code: 'SERVER_ERROR' });
  let writes = 0;
  await assert.rejects(fundNativeBatch({
    getBalance: async () => { throw disconnected; },
    send: async () => { writes += 1; },
  } as any, [{ account: accounts[0], amount: 10n }]), (error) => error === disconnected);
  assert.equal(writes, 0);
  await assert.rejects(fundNativeBatch({
    getBalance: async () => 0n,
    send: async () => { writes += 1; throw quota; },
  } as any, [{ account: accounts[0], amount: 10n }, { account: accounts[1], amount: 20n }]), (error) => error === quota);
  assert.equal(writes, 1, 'quota denial must not trigger per-account fallback writes');
});

test('precompile detection uses a real eth_call result even when the precompile has no bytecode', async () => {
  const abi = new Interface(['function getStorageAt(address,bytes32) view returns(bytes32)']);
  let calls = 0;
  const provider = {
    getCode: async () => { throw new Error('bytecode cannot detect precompiles'); },
    call: async (request: { to: string; data: string }) => {
      calls += 1;
      assert.equal(request.to, VNET_PRECOMPILE);
      const decoded = abi.decodeFunctionData('getStorageAt', request.data);
      assert.equal(decoded[0], MAINNET_USDT);
      assert.equal(decoded[1], ZeroHash);
      return ZeroHash;
    },
  };
  assert.equal(await supportsVnetPrecompile(provider as any), true);
  assert.equal(calls, 1);
});

test('precompile detection distinguishes an absent capability from connectivity or quota failure', async () => {
  assert.equal(await supportsVnetPrecompile({ call: async () => '0x' } as any), false);
  assert.equal(await supportsVnetPrecompile({ call: async () => '0x00' } as any), false);
  const reverted = Object.assign(new Error('precompile absent'), { code: 'CALL_EXCEPTION' });
  assert.equal(await supportsVnetPrecompile({ call: async () => { throw reverted; } } as any), false);
  for (const code of ['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT']) {
    const failure = Object.assign(new Error('service unavailable'), { code });
    await assert.rejects(supportsVnetPrecompile({ call: async () => { throw failure; } } as any), (error) => error === failure);
  }
});

async function deploymentFixture() {
  const signer = new Wallet(`0x${'12'.repeat(32)}`);
  const nonce = 7;
  const raw = await signer.signTransaction({
    type: 2, chainId: 73571n, nonce, data: '0x600060005560006000f3',
    gasLimit: 3_000_000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 1n,
  });
  const saved = {
    bootstrapRawTransaction: raw,
    bootstrapTransactionHash: keccak256(raw),
    bootstrapAddress: getCreateAddress({ from: signer.address, nonce }),
  };
  const receipt = { status: 1, contractAddress: saved.bootstrapAddress, hash: saved.bootstrapTransactionHash };
  return { saved, receipt };
}

test('an already mined bootstrap receipt is reused without broadcasting or waiting again', async () => {
  const { saved, receipt } = await deploymentFixture();
  let reads = 0;
  const provider = {
    getTransactionReceipt: async (hash: string) => { reads += 1; assert.equal(hash, saved.bootstrapTransactionHash); return receipt; },
    getTransaction: async () => { throw new Error('must not inspect a mined transaction again'); },
    broadcastTransaction: async () => { throw new Error('must not send another deployment'); },
    waitForTransaction: async () => { throw new Error('must not wait for an already mined transaction'); },
  };
  assert.equal(await sendRecoverableBootstrap(provider as any, saved), receipt);
  assert.equal(reads, 1);
});

test('an existing pending bootstrap is awaited without broadcasting or allocating a new transaction', async () => {
  const { saved, receipt } = await deploymentFixture();
  let waits = 0;
  const provider = {
    getTransactionReceipt: async () => null,
    getTransaction: async (hash: string) => { assert.equal(hash, saved.bootstrapTransactionHash); return { hash }; },
    broadcastTransaction: async () => { throw new Error('pending transactions must not be replaced'); },
    waitForTransaction: async (hash: string, confirmations: number, timeout: number) => {
      waits += 1;
      assert.equal(hash, saved.bootstrapTransactionHash);
      assert.equal(confirmations, 1);
      assert.equal(timeout, 120_000);
      return receipt;
    },
  };
  assert.equal(await sendRecoverableBootstrap(provider as any, saved), receipt);
  assert.equal(waits, 1);
});

test('a missing bootstrap is sent as the exact saved signed CREATE bytes', async () => {
  const { saved, receipt } = await deploymentFixture();
  const sent: string[] = [];
  const provider = {
    getTransactionReceipt: async () => null,
    getTransaction: async () => null,
    broadcastTransaction: async (raw: string) => { sent.push(raw); return { hash: keccak256(raw) }; },
    waitForTransaction: async (hash: string) => { assert.equal(hash, saved.bootstrapTransactionHash); return receipt; },
  };
  assert.equal(await sendRecoverableBootstrap(provider as any, saved), receipt);
  assert.deepEqual(sent, [saved.bootstrapRawTransaction]);
});

test('a lost broadcast response recovers the mined receipt without a second send', async () => {
  const { saved, receipt } = await deploymentFixture();
  const lostResponse = new Error('connection lost after deployment was accepted');
  let sends = 0;
  let receiptReads = 0;
  const provider = {
    getTransactionReceipt: async () => ++receiptReads === 1 ? null : receipt,
    getTransaction: async () => null,
    broadcastTransaction: async (raw: string) => {
      sends += 1;
      assert.equal(raw, saved.bootstrapRawTransaction);
      throw lostResponse;
    },
    waitForTransaction: async () => { throw new Error('a recovered mined receipt needs no additional wait'); },
  };
  assert.equal(await sendRecoverableBootstrap(provider as any, saved), receipt);
  assert.equal(sends, 1);
  assert.equal(receiptReads, 2);
});

test('reverted and wrongly addressed receipts stop bootstrap without a new deployment', async () => {
  const { saved, receipt } = await deploymentFixture();
  for (const [observed, expected] of [
    [{ ...receipt, status: 0 }, /откатилась целиком/],
    [{ ...receipt, contractAddress: accounts[0] }, /Адрес.*не совпадает/],
    [{ ...receipt, contractAddress: null }, /Адрес.*не совпадает/],
  ] as const) {
    let sends = 0;
    await assert.rejects(sendRecoverableBootstrap({
      getTransactionReceipt: async () => observed,
      getTransaction: async () => { throw new Error('must not replace an existing receipt'); },
      broadcastTransaction: async () => { sends += 1; },
      waitForTransaction: async () => { throw new Error('must not await a final receipt'); },
    } as any, saved), expected);
    assert.equal(sends, 0);
  }
});

test('tampered persisted transaction hash is rejected before accessing RPC', async () => {
  const { saved } = await deploymentFixture();
  let calls = 0;
  await assert.rejects(sendRecoverableBootstrap({
    getTransactionReceipt: async () => { calls += 1; return null; },
  } as any, { ...saved, bootstrapTransactionHash: ZeroHash }), /Повреждена сохранённая транзакция/);
  assert.equal(calls, 0);
});

test('a pending bootstrap timeout remains recoverable and never starts another deployment', async () => {
  const { saved, receipt } = await deploymentFixture();
  let mined = false;
  let sends = 0;
  const provider = {
    getTransactionReceipt: async () => mined ? receipt : null,
    getTransaction: async () => ({ hash: saved.bootstrapTransactionHash }),
    broadcastTransaction: async () => { sends += 1; },
    waitForTransaction: async () => null,
  };
  await assert.rejects(sendRecoverableBootstrap(provider as any, saved), /ещё не подтверждена.*та же транзакция/);
  mined = true;
  assert.equal(await sendRecoverableBootstrap(provider as any, saved), receipt);
  assert.equal(sends, 0);
});

test('RPC failures never fall back to another signed bootstrap or another nonce', async () => {
  const { saved } = await deploymentFixture();
  const failure = Object.assign(new Error('network disconnected'), { code: 'NETWORK_ERROR' });
  let sends = 0;
  await assert.rejects(sendRecoverableBootstrap({
    getTransactionReceipt: async () => { throw failure; },
    getTransaction: async () => null,
    broadcastTransaction: async () => { sends += 1; },
  } as any, saved), (error) => error === failure);
  assert.equal(sends, 0);
  await assert.rejects(sendRecoverableBootstrap({
    getTransactionReceipt: async () => null,
    getTransaction: async () => null,
    broadcastTransaction: async (raw: string) => { sends += 1; assert.equal(raw, saved.bootstrapRawTransaction); throw failure; },
  } as any, saved), (error) => error === failure);
  assert.equal(sends, 1, 'an uncertain send must not trigger a newly signed replacement');
});

async function refillFixture() {
  const owner = new Wallet(`0x${'12'.repeat(32)}`);
  const vault = accounts[2];
  const abi = new Interface(['function prepareTestWallet(address,uint256)']);
  const amount = parseEther('10000');
  const data = abi.encodeFunctionData('prepareTestWallet', [accounts[1], amount]);
  const raw = await owner.signTransaction({
    type: 2, chainId: 73571n, nonce: 8, to: vault, data,
    gasLimit: 500_000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 1n,
  });
  const saved = { bootstrapRawTransaction: raw, bootstrapTransactionHash: keccak256(raw) };
  const receipt = { status: 1, contractAddress: null, hash: saved.bootstrapTransactionHash };
  return { owner, vault, abi, amount, saved, receipt };
}

test('a mined wallet refill accepts a normal call receipt without a deployment address or another send', async () => {
  const { saved, receipt } = await refillFixture();
  const provider = {
    getTransactionReceipt: async (hash: string) => { assert.equal(hash, saved.bootstrapTransactionHash); return receipt; },
    getTransaction: async () => { throw new Error('a mined refill needs no pending lookup'); },
    broadcastTransaction: async () => { throw new Error('a mined refill must not be minted again'); },
    waitForTransaction: async () => { throw new Error('a mined refill needs no additional wait'); },
  };
  assert.equal(await sendRecoverableTransaction(provider as any, saved), receipt);
});

test('a lost wallet refill response recovers and resumes the same signed call without another mint', async () => {
  const { owner, vault, abi, amount, saved, receipt } = await refillFixture();
  let mined = false;
  let acceptedCalls = 0;
  const provider = {
    getTransactionReceipt: async () => mined ? receipt : null,
    getTransaction: async () => null,
    broadcastTransaction: async (raw: string) => {
      assert.equal(raw, saved.bootstrapRawTransaction);
      const transaction = Transaction.from(raw);
      assert.equal(transaction.from, owner.address);
      assert.equal(transaction.to, vault);
      assert.equal(transaction.nonce, 8);
      const arguments_ = abi.decodeFunctionData('prepareTestWallet', transaction.data);
      assert.equal(arguments_[0], accounts[1]);
      assert.equal(arguments_[1], amount);
      acceptedCalls += 1;
      mined = true;
      throw new Error('connection lost after refill was mined');
    },
    waitForTransaction: async () => { throw new Error('the recovered receipt is already mined'); },
  };
  assert.equal(await sendRecoverableTransaction(provider as any, saved), receipt);
  assert.equal(await sendRecoverableTransaction(provider as any, saved), receipt);
  assert.equal(acceptedCalls, 1, 'retrying a saved refill must not send a second mint call');
});
