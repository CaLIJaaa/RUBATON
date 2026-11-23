import { getAddress, keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';

export interface ActionIntent {
  account: string;
  actionHash: string;
  nonce: string;
  deadline: string;
}

/** Economic consent for the ZK circuit; independent of HTTP/read replay nonces. */
export const ZK_OPERATION_TYPES = { PrivateOperation: [{ name: 'commitment', type: 'uint256' }] };
export function zkOperationDomain(chainId: bigint, vaultAddress: string) {
  return { name: 'RubaZkOperation', version: '2', chainId, verifyingContract: getAddress(vaultAddress) };
}

export const ACTION_TYPES = {
  Action: [
    { name: 'account', type: 'address' },
    { name: 'actionHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export const WITHDRAWAL_TYPES = {
  Withdrawal: [
    { name: 'account', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'signerEpoch', type: 'uint256' },
  ],
};

export const BATCH_PUBLICATION_TYPES = {
  BatchPublication: [
    { name: 'batchId', type: 'uint256' },
    { name: 'previousStateRoot', type: 'bytes32' },
    { name: 'newStateRoot', type: 'bytes32' },
    { name: 'receiptsRoot', type: 'bytes32' },
    { name: 'firstTradeId', type: 'uint256' },
    { name: 'tradeCount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'signerEpoch', type: 'uint256' },
  ],
};

export const BATCH_PUBLICATION_TYPEHASH = keccak256(toUtf8Bytes(
  'BatchPublication(uint256 batchId,bytes32 previousStateRoot,bytes32 newStateRoot,bytes32 receiptsRoot,uint256 firstTradeId,uint256 tradeCount,uint256 deadline,uint256 signerEpoch)',
));

export function actionDomain(chainId: bigint, vaultAddress: string) {
  return { name: 'RubaServer', version: '1', chainId, verifyingContract: getAddress(vaultAddress) };
}

export function withdrawalDomain(chainId: bigint, vaultAddress: string) {
  return { name: 'RubaVault', version: '1', chainId, verifyingContract: getAddress(vaultAddress) };
}

export const batchPublicationDomain = withdrawalDomain;

/** Canonical JSON: objects have sorted keys; amounts are decimal strings, never JSON numbers. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Invalid JSON object');
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new Error('Only strings, booleans, null, arrays and objects are allowed in signed operations');
}

export function operationHash(operation: unknown): string {
  return keccak256(toUtf8Bytes(canonicalJson(operation)));
}

export function uint(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) {
    throw new Error(`${name} must be a canonical uint256 decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed >= 1n << 256n) throw new Error(`${name} exceeds uint256`);
  return parsed;
}

export function verifyAction(
  chainId: bigint,
  vaultAddress: string,
  intent: ActionIntent,
  operation: unknown,
  signature: string,
  timestamp: bigint,
): string {
  if (!intent || typeof intent !== 'object' || Object.keys(intent).sort().join(',') !== 'account,actionHash,deadline,nonce') {
    throw new Error('Invalid action intent fields');
  }
  const account = getAddress(intent.account);
  uint(intent.nonce, 'nonce');
  const deadline = uint(intent.deadline, 'deadline');
  if (deadline < timestamp) throw new Error('Action expired');
  if (deadline > timestamp + 3_600n) throw new Error('Action deadline must be within one hour');
  if (intent.actionHash !== operationHash(operation)) throw new Error('Operation hash mismatch');
  const recovered = verifyTypedData(actionDomain(chainId, vaultAddress), ACTION_TYPES, intent, signature);
  if (recovered !== account) throw new Error('Invalid account signature');
  return account;
}
