import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { lstat, open, readFile, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

export const DATA_WRITE_LOCK_FILENAME = '.data-write.lock';

export interface FileWorkspaceRoot {
  scheme: string;
  fsPath: string;
}

interface LockRecord {
  version: 1;
  pid: number;
  hostname: string;
  token: string;
  purpose: string;
  createdAt: string;
}

interface HeldLockContext {
  active: boolean;
}

const heldLocks = new AsyncLocalStorage<ReadonlyMap<string, HeldLockContext>>();

function dataLockPath(root: FileWorkspaceRoot): string {
  return join(root.fsPath, '.SNL_Doc', DATA_WRITE_LOCK_FILENAME);
}

async function assertNoBatchRecovery(root: FileWorkspaceRoot): Promise<void> {
  const journal = join(root.fsPath, '.snl-batch-transaction.json');
  try {
    // lstat deliberately blocks even malformed journals and dangling symlinks.
    await lstat(journal);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  throw new Error(
    `SNL batch transaction requires recovery: ${journal}. ` +
    'Stop all writers and preserve the journal and transaction trees for recovery with a compatible Toolkit. ' +
    'Removing only a stale data lock is not recovery; retry only after the transaction is safely resolved.'
  );
}

async function ownsCanonicalLock(
  handle: FileHandle, path: string, token: string, allowIncomplete = false
): Promise<boolean> {
  const identity = await handle.stat({ bigint: true });
  const matches = async (): Promise<boolean> => {
    try {
      const current = await lstat(path, { bigint: true });
      return current.isFile() && identity.isFile() &&
        current.dev === identity.dev && current.ino === identity.ino;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  };
  if (!await matches()) return false;
  const current = await readLock(path);
  if (current ? current.token !== token : !allowIncomplete) return false;
  // Do not trust a token read through a pathname that changed during the read.
  return matches();
}

async function removeOwnedLock(
  handle: FileHandle, path: string, token: string, allowIncomplete = false
): Promise<void> {
  // Keep the FD open through the identity checks (no inode reuse after close).
  // This is a cooperative-writer protocol, not an OS atomic conditional unlink.
  if (!await ownsCanonicalLock(handle, path, token, allowIncomplete)) return;
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isLockRecord(value: unknown): value is LockRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<LockRecord>;
  return record.version === 1 && Number.isInteger(record.pid) &&
    typeof record.hostname === 'string' && typeof record.token === 'string' &&
    typeof record.purpose === 'string' && typeof record.createdAt === 'string';
}

function localProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

async function readLock(path: string): Promise<LockRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isLockRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function acquireLock(
  root: FileWorkspaceRoot,
  purpose: string
): Promise<{ handle: FileHandle; path: string; record: LockRecord }> {
  if (root.scheme !== 'file' || !root.fsPath) {
    throw new Error(`Workspace data locking requires a local file workspace, not ${root.scheme}.`);
  }
  await assertNoBatchRecovery(root);
  const path = dataLockPath(root);
  const record: LockRecord = {
    version: 1,
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
    purpose,
    createdAt: new Date().toISOString()
  };

  try {
    const handle = await open(path, 'wx', 0o600);
    let initialized = false;
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      initialized = true;
      await handle.sync();
      await assertNoBatchRecovery(root);
      if (!await ownsCanonicalLock(handle, path, record.token)) {
        throw new Error('SNL workspace data lock ownership changed during acquisition; no write was admitted.');
      }
      return { handle, path, record };
    } catch (error) {
      try {
        // A failed initial write may not have left a readable token. Its open FD
        // still proves which inode we created; never unlink a replacement inode.
        await removeOwnedLock(handle, path, record.token, !initialized);
      } finally {
        await handle.close();
      }
      throw error;
    }
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    const existing = await readLock(path);
    const stale = existing !== null && existing.hostname === hostname() &&
      !localProcessIsAlive(existing.pid);
    if (stale) {
      throw new Error(
        `SNL workspace data has a stale ${existing.purpose} lock from pid ${existing.pid}. ` +
        `After confirming no writer is active and no batch transaction requires recovery, remove ${path} and retry.`
      );
    }
    const owner = existing
      ? `${existing.purpose} by pid ${existing.pid} on ${existing.hostname}`
      : 'an unreadable lock (remove it only after confirming no writer is active)';
    throw new Error(`SNL workspace data is locked for ${owner}.`);
  }
}

export async function withWorkspaceDataLock<T>(
  root: FileWorkspaceRoot,
  purpose: string,
  task: () => Promise<T>
): Promise<T> {
  const path = dataLockPath(root);
  const currentLocks = heldLocks.getStore();
  if (currentLocks?.get(path)?.active) return task();

  const acquired = await acquireLock(root, purpose);
  const lockContext: HeldLockContext = { active: true };
  const nextLocks = new Map(currentLocks ?? []);
  nextLocks.set(path, lockContext);
  try {
    return await heldLocks.run(nextLocks, task);
  } finally {
    lockContext.active = false;
    try {
      await removeOwnedLock(acquired.handle, acquired.path, acquired.record.token);
    } finally {
      await acquired.handle.close();
    }
  }
}
