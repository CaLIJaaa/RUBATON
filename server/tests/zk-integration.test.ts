import assert from 'node:assert/strict';
import test from 'node:test';
import { runZkDemo } from '../../scripts/zk-demo.ts';
import { deriveOwnerRecoveryKey, zkRecoveryKeyMessage } from '../../scripts/zk-local-deploy.ts';
import { Wallet, keccak256 } from 'ethers';
import { FIELD } from '../../zk/crypto.js';

test('local ZK seed derives exactly the same owner recovery key as the browser wallet', async () => {
  const { recoveryKeyMessage } = await import('../../ui/client.js' as string);
  const wallet = new Wallet('0x' + '11'.repeat(32));
  const config = { chainId: 31337n, vaultAddress: '0x0000000000000000000000000000000000000010' };
  assert.equal(zkRecoveryKeyMessage(config, wallet.address), recoveryKeyMessage(config, wallet.address));
  const browserDerived = BigInt(keccak256(await wallet.signMessage(recoveryKeyMessage(config, wallet.address)))) % FIELD;
  assert.equal(await deriveOwnerRecoveryKey(config, wallet), browserDerived);
});

test('live ZK Anvil: real Groth16 → proof-only publication → DA recovery → owner-only proven withdrawal without whitelist', {
  skip: process.env.RUBA_ZK_INTEGRATION !== '1' ? 'Run RUBA_ZK_INTEGRATION=1 after npm run zk:build; requires Anvil and local ports' : false,
  timeout: 1_800_000,
}, async () => {
  const result = await runZkDemo(() => {});
  assert.equal(result.proofMode, 'groth16-bn254-v2');
  assert.equal(result.tradeCount, 4); assert.equal(result.batchId, 1n);
  assert.ok(result.stateVersion >= 8n);
  assert.equal(result.payoutAmount, 10_000_000n);
  for (const key of ['merkleVerified', 'recoveredWithoutApi', 'publicationPaidByUser', 'operatorNonceUnchanged', 'custodyUnchangedDuringSwaps',
    'forgedProofRejected', 'forgedHeaderRejected', 'forgedOwnerRejected', 'inventedInboxRejected', 'legacyBypassRejected', 'restartVerified',
    'nonWhitelistedRegistrationRejected', 'nonWhitelistedDepositRejected', 'canonicalDepositAfterRevocation',
    'nonWhitelistedWithdrawal', 'atomicPayout', 'acceptedClaimPayout', 'operatorRotationUnaffected', 'refundRejected'] as const) assert.equal(result[key], true, key);
});
