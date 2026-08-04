import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { open, readFile, unlink, type FileHandle } from 'node:fs/promises';
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
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
      return { handle, path, record };
    } catch (error) {
      await handle.close();
      try {
        await unlink(path);
      } catch (unlinkError) {
        if (errorCode(unlinkError) !== 'ENOENT') throw unlinkError;
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
        `After confirming no writer is active, remove ${path} and retry.`
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
    await acquired.handle.close();
    const current = await readLock(acquired.path);
    if (current?.token === acquired.record.token) {
      try {
        await unlink(acquired.path);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
  }
}
