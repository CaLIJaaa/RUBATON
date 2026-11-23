import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Shared CLI lock; never remove a surviving lock without reconciling its process. */
export function acquireDeploymentLock(directory: string): () => void {
  const path = join(directory, 'deployment-operation.lock');
  let descriptor: number;
  try { descriptor = openSync(path, 'wx', 0o600); }
  catch { throw new Error('Another deployment/budget operation holds the local lock; stop it first. Reconcile a crashed process before removing its stale lock.'); }
  writeFileSync(descriptor, `${process.pid}\n`);
  closeSync(descriptor);
  return () => unlinkSync(path);
}
