import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { TypedDataEncoder, Wallet, keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import {
  ADMISSION_REQUEST_TYPES, ADMISSION_TYPES, AdmissionDesk, AdmissionError, CONSENT_HASH, CONSENT_TEXT, StubKycProvider,
  admissionDomain, admissionRequestDomain, kycCommitment, kycIdHash,
} from '../admission.ts';
import { RubaApi } from '../api.ts';
import type { RubaEngine } from '../engine.ts';
import type { VaultChain } from '../chain.ts';
import type { ServerConfig } from '../config.ts';

const vault = '0x1000000000000000000000000000000000000001';
const chainId = 31337n;
const deskKey = new Wallet('0x' + '44'.repeat(32));
const alice = new Wallet('0x' + '55'.repeat(32));
const mallory = new Wallet('0x' + '66'.repeat(32));
const now = 1_800_000_000n;

function desk(denied: string[] = []) {
  return new AdmissionDesk({
    dbPath: ':memory:', signerPrivateKey: deskKey.privateKey, chainId, vaultAddress: vault,
    kyc: new StubKycProvider(new Set(denied)), approvalTtl: 3600n, now: () => now,
  });
}

async function application(wallet: Wallet, kycId: string, signedAt = now, signer: Wallet = wallet) {
  const message = { account: wallet.address, consentHash: CONSENT_HASH, kycIdHash: kycIdHash(kycId), signedAt };
  const signature = await signer.signTypedData(admissionRequestDomain(chainId, vault), ADMISSION_REQUEST_TYPES, message);
  return { account: wallet.address, kycId, signedAt: signedAt.toString(), signature };
}

test('typehash matches the vault contract', () => {
  const encoded = TypedDataEncoder.from(ADMISSION_TYPES).encodeType('Admission');
  assert.equal(encoded, 'Admission(address account,bytes32 kycHash,bytes32 consentHash,uint256 deadline,uint256 nonce)');
  assert.equal(CONSENT_HASH, keccak256(toUtf8Bytes(CONSENT_TEXT)));
});

test('signed application with consent and KYC gets a desk approval for this vault', async () => {
  const d = desk();
  const result = await d.apply(await application(alice, 'KYC-0001'));
  const { admission, signature } = result;
  assert.equal(admission.account, alice.address);
  assert.equal(admission.consentHash, CONSENT_HASH);
  assert.equal(admission.deadline, (now + 3600n).toString());
  const recovered = verifyTypedData(admissionDomain(chainId, vault), ADMISSION_TYPES, admission, signature);
  assert.equal(recovered, deskKey.address);

  const opening = d.kycOpening(alice.address);
  assert.ok(opening?.approved);
  assert.equal(opening.kycId, 'KYC-0001');
  assert.equal(kycCommitment(opening.kycId, opening.salt), admission.kycHash);
  assert.ok(!JSON.stringify(result).includes(opening.salt));
  assert.ok(!JSON.stringify(result).includes('KYC-0001'));

  const consent = d.consentRecord(alice.address);
  assert.equal(consent?.consent_hash, CONSENT_HASH);
  assert.equal(consent?.consent_version, 'ruba-risk-v1');
  assert.equal(d.issuedApprovals(alice.address).length, 1);
  d.close();
});

test('two applications get different nonces and salts', async () => {
  const d = desk();
  const first = await d.apply(await application(alice, 'KYC-0001'));
  const firstSalt = d.kycOpening(alice.address)?.salt;
  const second = await d.apply(await application(alice, 'KYC-0001'));
  assert.notEqual(first.admission.nonce, second.admission.nonce);
  assert.notEqual(first.admission.kycHash, second.admission.kycHash);
  assert.notEqual(firstSalt, d.kycOpening(alice.address)?.salt);
  d.close();
});

test('application signed by another wallet is rejected', async () => {
  const d = desk();
  await assert.rejects(d.apply(await application(alice, 'KYC-0001', now, mallory)),
    (error: unknown) => error instanceof AdmissionError && error.status === 401);
  assert.equal(d.consentRecord(alice.address), undefined);
  assert.equal(d.issuedApprovals(alice.address).length, 0);
  d.close();
});

test('stale or future application signature is rejected', async () => {
  const d = desk();
  await assert.rejects(d.apply(await application(alice, 'KYC-0001', now - 601n)),
    (error: unknown) => error instanceof AdmissionError && error.status === 400);
  await assert.rejects(d.apply(await application(alice, 'KYC-0001', now + 120n)),
    (error: unknown) => error instanceof AdmissionError && error.status === 400);
  d.close();
});

test('KYC refusal records consent but issues no approval', async () => {
  const d = desk(['KYC-BAD1']);
  await assert.rejects(d.apply(await application(alice, 'KYC-BAD1')),
    (error: unknown) => error instanceof AdmissionError && error.status === 403);
  await assert.rejects(d.apply(await application(alice, 'bad id')),
    (error: unknown) => error instanceof AdmissionError && error.status === 403);
  assert.equal(d.consentRecord(alice.address)?.consent_hash, CONSENT_HASH);
  assert.equal(d.kycOpening(alice.address)?.approved, false);
  assert.equal(d.issuedApprovals(alice.address).length, 0);
  d.close();
});

test('changing the signed KYC ID breaks the application', async () => {
  const d = desk();
  const signed = await application(alice, 'KYC-0001');
  await assert.rejects(d.apply({ ...signed, kycId: 'KYC-0002' }),
    (error: unknown) => error instanceof AdmissionError && error.status === 401);
  d.close();
});

test('API serves the desk routes only for its own vault', async () => {
  const config = { chainId, vaultAddress: vault, rubaAddress: vault, usdtAddress: vault } as ServerConfig;
  const api = new RubaApi({} as RubaEngine, {} as VaultChain, config);
  assert.throws(() => api.attachAdmissionDesk(new AdmissionDesk({
    dbPath: ':memory:', signerPrivateKey: deskKey.privateKey, chainId, vaultAddress: '0x2000000000000000000000000000000000000002',
  })), /another vault/);
  const d = desk();
  api.attachAdmissionDesk(d);
  const server = api.createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const info = await (await fetch(`${base}/admission`)).json();
    assert.equal(info.consentHash, CONSENT_HASH);
    assert.equal(info.admissionSigner, deskKey.address);

    const ok = await fetch(`${base}/admission/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await application(alice, 'KYC-0001')),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(verifyTypedData(admissionDomain(chainId, vault), ADMISSION_TYPES, body.result.admission, body.result.signature), deskKey.address);

    const denied = await fetch(`${base}/admission/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await application(alice, 'KYC-0001', now, mallory)),
    });
    assert.equal(denied.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    d.close();
  }
});
