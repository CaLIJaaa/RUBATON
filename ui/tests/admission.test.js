import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, getAddress, verifyTypedData } from 'ethers';
import { RubaClient } from '../client.js';
import { AdmissionDesk, ADMISSION_TYPES, admissionDomain } from '../../server/admission.ts';

const trader = new Wallet('0x' + '11'.repeat(32));
const deskKey = new Wallet('0x' + '77'.repeat(32));
const config = {
  chainId: '31337', vaultAddress: getAddress('0x0000000000000000000000000000000000000001'), proofMode: 'zk',
  tokens: {
    RUBA: { address: getAddress('0x0000000000000000000000000000000000000002'), decimals: 18 },
    USDT: { address: getAddress('0x0000000000000000000000000000000000000003'), decimals: 6 },
  },
  admission: { mode: 'desk-approval', signer: deskKey.address },
};

function fixture({ vaultSigner = deskKey.address, timestamp = 1000, guardian = true, readyAt = 0n } = {}) {
  const desk = new AdmissionDesk({ dbPath: ':memory:', signerPrivateKey: deskKey.privateKey, chainId: 31337n, vaultAddress: config.vaultAddress });
  const calls = [];
  const fetchImpl = async (path, init = {}) => {
    let status = 200;
    let body;
    try {
      if (path === '/admission') body = desk.publicInfo();
      else if (path === '/admission/apply') body = { result: await desk.apply(JSON.parse(init.body)) };
      else assert.fail(`Unexpected path ${path}`);
    } catch (error) { status = error.status ?? 500; body = { error: error.message }; }
    return { ok: status === 200, status, async json() { return JSON.parse(JSON.stringify(body, (_k, v) => typeof v === 'bigint' ? v.toString() : v)); } };
  };
  const tx = (name, args) => { calls.push([name, ...args]); return { hash: '0x' + 'cd'.repeat(32), async wait() { return { status: 1, hash: '0x' + 'cd'.repeat(32) }; } }; };
  const vault = {
    async admissionSigner() { return vaultSigner; },
    async admit(admission, signature) { return tx('admit', [admission, signature]); },
    async owner() { return getAddress('0x00000000000000000000000000000000000000aa'); },
    async ruba() { return config.tokens.RUBA.address; },
    async usdt() { return config.tokens.USDT.address; },
    async pauseGuardiansConfigured() { return true; },
    async isPauseGuardian() { return guardian; },
    async marketResumeStatus() { return { round: 1n, approvals: readyAt > 0n ? 2n : 1n, readyAt }; },
    async tokenWithdrawalsResumeStatus() { return { round: 1n, approvals: 0n, readyAt: 0n }; },
    async approveMarketResume() { return tx('approveMarketResume', []); },
    async executeMarketResume() { return tx('executeMarketResume', []); },
    async approveTokenWithdrawalsResume(token) { return tx('approveTokenWithdrawalsResume', [token]); },
    async setMarketPaused(paused) { return tx('setMarketPaused', [paused]); },
  };
  const provider = {
    async send(method) {
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_accounts') return [trader.address];
      if (method === 'eth_blockNumber') return '0x5';
      assert.fail(`Unexpected RPC ${method}`);
    },
    async getBlock() { return { timestamp }; },
  };
  const client = new RubaClient(config, provider, trader, {
    fetchImpl, publicationWaitMs: 50, contractFactory: (address) => (address === config.vaultAddress ? vault : {}),
  });
  return { client, calls, desk };
}

test('admission: wallet signs consent and KYC, desk approves, wallet sends admit to the vault', async () => {
  const { client, calls, desk } = fixture();
  const info = await client.getAdmissionInfo();
  assert.match(info.consentText, /санкции/);
  const result = await client.applyForAdmission('kyc-0042');
  assert.equal(calls.length, 1);
  const [name, admission, signature] = calls[0];
  assert.equal(name, 'admit');
  assert.equal(admission.account, trader.address);
  assert.equal(result.kycHash, admission.kycHash);
  assert.equal(verifyTypedData(admissionDomain(31337n, config.vaultAddress), ADMISSION_TYPES, admission, signature), deskKey.address);
  assert.equal(desk.kycOpening(trader.address)?.kycId, 'KYC-0042');
  assert.ok(desk.consentRecord(trader.address));
  desk.close();
});

test('admission: no request leaves when the vault trusts another desk key or the KYC ID is malformed', async () => {
  const other = fixture({ vaultSigner: getAddress('0x00000000000000000000000000000000000000bb') });
  await assert.rejects(other.client.applyForAdmission('KYC-0042'), /не совпадает с сервером/);
  assert.equal(other.desk.consentRecord(trader.address), undefined);
  assert.deepEqual(other.calls, []);
  other.desk.close();

  const { client, calls, desk } = fixture();
  await assert.rejects(client.applyForAdmission('x'), /Номер KYC/);
  assert.deepEqual(calls, []);
  desk.close();
});

test('admission: market without a desk keeps admin-only access', async () => {
  const { desk } = fixture();
  const client = new RubaClient({ ...config, admission: undefined }, { async send() { return '0x7a69'; } }, trader, {
    fetchImpl: async () => assert.fail('no request expected'), contractFactory: () => ({}),
  });
  assert.equal(await client.getAdmissionInfo(), null);
  await assert.rejects(client.applyForAdmission('KYC-0042'), /только администратор/);
  desk.close();
});

test('pause roles: resume from a guardian is an approval, after the delay anyone executes', async () => {
  const pending = fixture();
  await pending.client.setMarketPaused(false);
  assert.deepEqual(pending.calls, [['approveMarketResume']]);
  pending.desk.close();

  const ready = fixture({ readyAt: 900n, timestamp: 1000, guardian: false });
  await ready.client.setMarketPaused(false);
  assert.deepEqual(ready.calls, [['executeMarketResume']]);
  ready.desk.close();

  const waiting = fixture({ readyAt: 5000n, timestamp: 1000 });
  await assert.rejects(waiting.client.setMarketPaused(false), /Дождитесь окончания задержки/);
  assert.deepEqual(waiting.calls, []);
  waiting.desk.close();

  const stranger = fixture({ guardian: false });
  await assert.rejects(stranger.client.setMarketPaused(false), /одна из трёх ролей паузы/);
  assert.deepEqual(stranger.calls, []);
  stranger.desk.close();
});

test('pause roles: a guardian may pause even if it is not the owner', async () => {
  const { client, calls, desk } = fixture();
  await client.setMarketPaused(true);
  assert.deepEqual(calls, [['setMarketPaused', true]]);
  desk.close();
});
