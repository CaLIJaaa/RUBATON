import { DatabaseSync } from 'node:sqlite';
import { AbiCoder, getAddress, hexlify, keccak256, randomBytes, toUtf8Bytes, verifyTypedData, Wallet } from 'ethers';

export const CONSENT_VERSION = 'ruba-risk-v1';
export const CONSENT_TEXT = 'Я понимаю, что RUBA может попасть под санкции. Тогда вывод RUBA могут остановить, а мой адрес будет связан с рынком RUBA. '
  + 'Я принимаю этот риск и участвую в закрытом рынке добровольно.';
export const CONSENT_HASH = keccak256(toUtf8Bytes(CONSENT_TEXT));

export const ADMISSION_REQUEST_TYPES = {
  AdmissionRequest: [
    { name: 'account', type: 'address' },
    { name: 'consentHash', type: 'bytes32' },
    { name: 'kycIdHash', type: 'bytes32' },
    { name: 'signedAt', type: 'uint256' },
  ],
};

export const ADMISSION_TYPES = {
  Admission: [
    { name: 'account', type: 'address' },
    { name: 'kycHash', type: 'bytes32' },
    { name: 'consentHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

export function admissionRequestDomain(chainId: bigint, vaultAddress: string) {
  return { name: 'RubaAdmissionDesk', version: '1', chainId, verifyingContract: getAddress(vaultAddress) };
}

export function admissionDomain(chainId: bigint, vaultAddress: string) {
  return { name: 'RubaVault', version: '1', chainId, verifyingContract: getAddress(vaultAddress) };
}

export function kycIdHash(kycId: string): string {
  return keccak256(toUtf8Bytes(kycId));
}

export function kycCommitment(kycId: string, salt: string): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(['string', 'bytes32'], [kycId, salt]));
}

export interface KycDecision { approved: boolean; reason?: string }
export interface KycProvider { check(kycId: string, account: string): KycDecision }

/** Stand-in for a real KYC provider: accepts well-formed IDs except a deny list. */
export class StubKycProvider implements KycProvider {
  constructor(private readonly denied: ReadonlySet<string> = new Set()) {}

  check(kycId: string): KycDecision {
    if (!/^[A-Z0-9-]{4,64}$/.test(kycId)) return { approved: false, reason: 'Номер KYC не прошёл проверку формата' };
    if (this.denied.has(kycId)) return { approved: false, reason: 'KYC-провайдер отклонил проверку' };
    return { approved: true };
  }
}

export interface AdmissionApplication {
  account: string;
  kycId: string;
  signedAt: bigint | string | number;
  signature: string;
}

export interface SignedAdmission {
  admission: { account: string; kycHash: string; consentHash: string; deadline: string; nonce: string };
  signature: string;
}

export class AdmissionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface AdmissionDeskOptions {
  dbPath: string;
  signerPrivateKey: string;
  chainId: bigint;
  vaultAddress: string;
  kyc?: KycProvider;
  approvalTtl?: bigint;
  signatureWindow?: bigint;
  now?: () => bigint;
}

/**
 * Admission desk. It keeps KYC IDs and salts in its own database and signs
 * approvals with its own key, separate from the exchange server and the vault owner.
 */
export class AdmissionDesk {
  readonly db: DatabaseSync;
  readonly chainId: bigint;
  readonly vaultAddress: string;
  private readonly signer: Wallet;
  private readonly kyc: KycProvider;
  private readonly approvalTtl: bigint;
  private readonly signatureWindow: bigint;
  private readonly now: () => bigint;

  constructor(options: AdmissionDeskOptions) {
    this.signer = new Wallet(options.signerPrivateKey);
    this.chainId = options.chainId;
    this.vaultAddress = getAddress(options.vaultAddress);
    this.kyc = options.kyc ?? new StubKycProvider();
    this.approvalTtl = options.approvalTtl ?? 3600n;
    this.signatureWindow = options.signatureWindow ?? 600n;
    this.now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consents (
        account TEXT PRIMARY KEY, consent_version TEXT NOT NULL, consent_hash TEXT NOT NULL,
        signed_at TEXT NOT NULL, signature TEXT NOT NULL, recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kyc_checks (
        account TEXT PRIMARY KEY, kyc_id TEXT NOT NULL, salt TEXT NOT NULL, kyc_hash TEXT NOT NULL,
        approved INTEGER NOT NULL, reason TEXT, checked_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (
        nonce TEXT PRIMARY KEY, account TEXT NOT NULL, kyc_hash TEXT NOT NULL, consent_hash TEXT NOT NULL,
        deadline TEXT NOT NULL, signature TEXT NOT NULL, issued_at TEXT NOT NULL);
    `);
  }

  get signerAddress(): string { return this.signer.address; }

  publicInfo() {
    return {
      consentVersion: CONSENT_VERSION, consentText: CONSENT_TEXT, consentHash: CONSENT_HASH,
      requestDomain: admissionRequestDomain(this.chainId, this.vaultAddress), requestTypes: ADMISSION_REQUEST_TYPES,
      admissionSigner: this.signer.address, approvalTtl: this.approvalTtl.toString(),
    };
  }

  /** One wallet signature covers the accepted risk text and the KYC ID the participant names. */
  async apply(application: AdmissionApplication): Promise<SignedAdmission> {
    const account = getAddress(application.account);
    const kycId = String(application.kycId ?? '').trim();
    const signedAt = BigInt(application.signedAt);
    const now = this.now();
    if (signedAt > now + 60n || now - signedAt > this.signatureWindow) {
      throw new AdmissionError(400, 'Подпись заявки устарела, подпишите заново');
    }
    const message = { account, consentHash: CONSENT_HASH, kycIdHash: kycIdHash(kycId), signedAt };
    let recovered: string;
    try {
      recovered = verifyTypedData(admissionRequestDomain(this.chainId, this.vaultAddress), ADMISSION_REQUEST_TYPES, message, application.signature);
    } catch {
      throw new AdmissionError(401, 'Подпись заявки не читается');
    }
    if (getAddress(recovered) !== account) throw new AdmissionError(401, 'Заявку подписал другой кошелёк');

    this.db.prepare(`INSERT INTO consents (account, consent_version, consent_hash, signed_at, signature, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account) DO UPDATE SET consent_version = excluded.consent_version,
      consent_hash = excluded.consent_hash, signed_at = excluded.signed_at, signature = excluded.signature, recorded_at = excluded.recorded_at`)
      .run(account, CONSENT_VERSION, CONSENT_HASH, signedAt.toString(), application.signature, now.toString());

    const decision = this.kyc.check(kycId, account);
    const salt = hexlify(randomBytes(32));
    const kycHash = kycCommitment(kycId, salt);
    this.db.prepare(`INSERT INTO kyc_checks (account, kyc_id, salt, kyc_hash, approved, reason, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account) DO UPDATE SET kyc_id = excluded.kyc_id, salt = excluded.salt,
      kyc_hash = excluded.kyc_hash, approved = excluded.approved, reason = excluded.reason, checked_at = excluded.checked_at`)
      .run(account, kycId, salt, kycHash, decision.approved ? 1 : 0, decision.reason ?? null, now.toString());
    if (!decision.approved) throw new AdmissionError(403, decision.reason ?? 'KYC не пройден');

    return this.issue(account, kycHash, now);
  }

  private async issue(account: string, kycHash: string, now: bigint): Promise<SignedAdmission> {
    const nonce = BigInt(hexlify(randomBytes(31)));
    const admission = { account, kycHash, consentHash: CONSENT_HASH, deadline: now + this.approvalTtl, nonce };
    const signature = await this.signer.signTypedData(admissionDomain(this.chainId, this.vaultAddress), ADMISSION_TYPES, admission);
    this.db.prepare(`INSERT INTO approvals (nonce, account, kyc_hash, consent_hash, deadline, signature, issued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(nonce.toString(), account, kycHash, CONSENT_HASH, admission.deadline.toString(), signature, now.toString());
    return {
      admission: { account, kycHash, consentHash: CONSENT_HASH, deadline: admission.deadline.toString(), nonce: nonce.toString() },
      signature,
    };
  }

  consentRecord(account: string) {
    return this.db.prepare('SELECT consent_version, consent_hash, signed_at, signature, recorded_at FROM consents WHERE account = ?')
      .get(getAddress(account)) as { consent_version: string; consent_hash: string; signed_at: string; signature: string; recorded_at: string } | undefined;
  }

  /** For the desk admin only: the KYC ID and salt behind an on-chain KYC hash. Never served over the public API. */
  kycOpening(account: string) {
    const row = this.db.prepare('SELECT kyc_id, salt, kyc_hash, approved FROM kyc_checks WHERE account = ?')
      .get(getAddress(account)) as { kyc_id: string; salt: string; kyc_hash: string; approved: number } | undefined;
    return row && { kycId: row.kyc_id, salt: row.salt, kycHash: row.kyc_hash, approved: row.approved === 1 };
  }

  issuedApprovals(account: string) {
    return this.db.prepare('SELECT nonce, kyc_hash, deadline, issued_at FROM approvals WHERE account = ? ORDER BY issued_at')
      .all(getAddress(account)) as { nonce: string; kyc_hash: string; deadline: string; issued_at: string }[];
  }

  close(): void { this.db.close(); }
}

export function admissionDeskFromEnv(env: NodeJS.ProcessEnv, chainId: bigint, vaultAddress: string, dbPath: string): AdmissionDesk | undefined {
  const key = env.ADMISSION_SIGNER_PRIVATE_KEY;
  if (!key) return undefined;
  const denied = new Set((env.ADMISSION_KYC_DENY ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  return new AdmissionDesk({
    dbPath, signerPrivateKey: key, chainId, vaultAddress, kyc: new StubKycProvider(denied),
    approvalTtl: env.ADMISSION_TTL_SECONDS ? BigInt(env.ADMISSION_TTL_SECONDS) : undefined,
  });
}
