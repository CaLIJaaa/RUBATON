import { randomBytes } from "node:crypto";
import { AbiCoder, concat, keccak256, toUtf8Bytes } from "ethers";
import type { TradeReceipt } from "./types.ts";

const coder = AbiCoder.defaultAbiCoder();
export const ZERO_ROOT = "0x" + "00".repeat(32);
export const RECEIPT_SCHEMA = "TradeReceipt(uint256 chainId,address vault,uint256 tradeId,address account,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,uint256 feeNumerator,uint256 feeDenominator,uint256 reserveRubaBefore,uint256 reserveUsdtBefore,uint256 reserveRubaAfter,uint256 reserveUsdtAfter,bytes32 salt)";
export const RECEIPT_TYPEHASH = keccak256(toUtf8Bytes(RECEIPT_SCHEMA));

export function randomSalt(): string {
  return "0x" + randomBytes(32).toString("hex");
}

/** Matches keccak256(abi.encode(TYPEHASH, ...receipt fields)) in Solidity. */
export function hashReceipt(receipt: Omit<TradeReceipt, "leaf">): string {
  return keccak256(coder.encode(
    ["bytes32", "uint256", "address", "uint256", "address", "address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes32"],
    [RECEIPT_TYPEHASH, receipt.chainId, receipt.vault, receipt.tradeId, receipt.account,
      receipt.tokenIn, receipt.tokenOut, receipt.amountIn, receipt.amountOut,
      receipt.feeNumerator, receipt.feeDenominator, receipt.reserveRubaBefore,
      receipt.reserveUsdtBefore, receipt.reserveRubaAfter, receipt.reserveUsdtAfter,
      receipt.salt],
  ));
}

export function hashPair(left: string, right: string): string {
  return keccak256(concat(BigInt(left) <= BigInt(right) ? [left, right] : [right, left]));
}

/** One to four leaves; sorted pairs match OpenZeppelin MerkleProof. Odd nodes duplicate themselves. */
export function buildMerkleBatch(leaves: string[]): { root: string; proofs: string[][] } {
  if (leaves.length < 1 || leaves.length > 4) throw new Error("A receipt batch must contain one to four trades");
  if (leaves.some((leaf) => !/^0x[0-9a-fA-F]{64}$/.test(leaf))) throw new Error("Invalid receipt leaf");
  const levels = [leaves.slice()];
  while (levels.at(-1)!.length > 1) {
    const level = levels.at(-1)!;
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) next.push(hashPair(level[index], level[index + 1] ?? level[index]));
    levels.push(next);
  }
  const proofs = leaves.map((_leaf, leafIndex) => {
    const proof: string[] = [];
    let index = leafIndex;
    for (const level of levels.slice(0, -1)) {
      proof.push(level[index ^ 1] ?? level[index]);
      index = Math.floor(index / 2);
    }
    return proof;
  });
  return { root: levels.at(-1)![0], proofs };
}

export function verifyMerkleProof(leaf: string, proof: string[], root: string): boolean {
  return proof.reduce(hashPair, leaf).toLowerCase() === root.toLowerCase();
}

export function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value as object).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => JSON.stringify(key) + ":" + canonicalJson((value as Record<string, unknown>)[key])).join(",") + "}";
}

/** Versioned offchain commitment, NOT a ZK proof or a solvency proof. */
export function commitState(chainId: bigint, vault: string, snapshot: string, salt: string): string {
  return keccak256(coder.encode(["uint256", "uint256", "address", "bytes32", "bytes32"],
    [1n, chainId, vault, keccak256(toUtf8Bytes(snapshot)), salt]));
}
