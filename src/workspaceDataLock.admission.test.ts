import * as native from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({
  open: undefined as undefined | ((path: string) => Promise<import('node:fs/promises').FileHandle>),
  journalError: false
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: (path: string, ...args: Parameters<typeof fs.open> extends [unknown, ...infer R] ? R : never) =>
      seam.open && path.endsWith('.data-write.lock') ? seam.open(path) : fs.open(path, ...args),
    lstat: (path: string, ...args: unknown[]) => {
      if (seam.journalError && path.endsWith('.snl-batch-transaction.json')) {
        return Promise.reject(Object.assign(new Error('journal permission denied'), { code: 'EACCES' }));
      }
      return Reflect.apply(fs.lstat, fs, [path, ...args]);
    }
  };
});
import { DATA_WRITE_LOCK_FILENAME, withWorkspaceDataLock } from './workspaceDataLock';

// Only the scheduling seam is substituted. All file handles, directory renames,
// inode identities and on-disk bytes are real native filesystem operations.
let fs: typeof native;
beforeAll(async () => { fs = await vi.importActual<typeof native>('node:fs/promises'); });
const foreign = JSON.stringify({ version: 1, pid: process.pid, hostname: hostname(),
  token: 'foreign', purpose: 'other writer', createdAt: new Date(0).toISOString() });
async function fixture() {
  const fsPath = await fs.mkdtemp(join(tmpdir(), 'snl-admission-'));
  const dir = join(fsPath, '.SNL_Doc');
  await fs.mkdir(dir);
  return { root: { scheme: 'file', fsPath }, dir,
    lock: join(dir, DATA_WRITE_LOCK_FILENAME), journal: join(fsPath, '.snl-batch-transaction.json') };
}
afterEach(() => { seam.open = undefined; seam.journalError = false; vi.restoreAllMocks(); });

describe('workspace lock generation admission (native I/O seam, not kernel parentwalk reproduction)', () => {
  it.skipIf(process.platform !== 'linux')('rejects a late open through a retained old dirfd after tree rename', async () => {
    const f = await fixture();
    const oldDir = await fs.open(f.dir, 'r');
    let returnedIdentity: Awaited<ReturnType<typeof fs.stat>> | undefined;
    seam.open = async () => {
      await fs.rename(f.dir, `${f.dir}.retired`);
      await fs.mkdir(f.dir);
      await fs.writeFile(f.lock, foreign);
      const handle = await fs.open(`/proc/self/fd/${oldDir.fd}/${DATA_WRITE_LOCK_FILENAME}`, 'wx', 0o600);
      returnedIdentity = await handle.stat();
      return handle;
    };
    const task = vi.fn(async () => 'unsafe');
    try {
      await expect(withWorkspaceDataLock(f.root, 'late writer', task)).rejects.toThrow(/lock.*(ownership|identity|changed)/i);
      expect(returnedIdentity?.ino).not.toBe((await fs.stat(f.lock)).ino);
      expect(task).not.toHaveBeenCalled();
      expect(await fs.readFile(f.lock, 'utf8')).toBe(foreign);
    } finally { await oldDir.close(); }
  });

  it('rejects a detached FD even when the replacement copies this attempt token', async () => {
    const f = await fixture();
    seam.open = async (path) => {
      const handle = await fs.open(path, 'wx', 0o600);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        const bytes = await fs.readFile(path);
        await fs.rename(path, `${path}.retired`);
        await fs.writeFile(path, bytes);
      };
      return handle;
    };
    const task = vi.fn(async () => undefined);
    await expect(withWorkspaceDataLock(f.root, 'write', task)).rejects.toThrow(/lock.*(ownership|identity|changed)/i);
    expect(task).not.toHaveBeenCalled();
    expect(await fs.readFile(f.lock, 'utf8')).toContain('"purpose":"write"');
  });

  it.each(['writeFile', 'sync'] as const)('never unlinks a foreign canonical lock after %s failure', async (method) => {
    const f = await fixture();
    seam.open = async (path) => {
      const handle = await fs.open(path, 'wx', 0o600);
      handle[method] = async () => {
        await fs.rename(path, `${path}.retired`);
        await fs.writeFile(path, foreign);
        throw new Error('injected I/O failure');
      };
      return handle;
    };
    const task = vi.fn(async () => undefined);
    await expect(withWorkspaceDataLock(f.root, 'write', task)).rejects.toThrow('injected I/O failure');
    expect(task).not.toHaveBeenCalled();
    expect(await fs.readFile(f.lock, 'utf8')).toBe(foreign);
  });

  it('preserves a foreign token on the same inode after an initial write failure', async () => {
    const f = await fixture();
    seam.open = async (path) => {
      const handle = await fs.open(path, 'wx', 0o600);
      handle.writeFile = async () => {
        await fs.writeFile(path, foreign);
        throw new Error('injected I/O failure');
      };
      return handle;
    };
    await expect(withWorkspaceDataLock(f.root, 'write', async () => undefined)).rejects.toThrow('injected I/O failure');
    expect(await fs.readFile(f.lock, 'utf8')).toBe(foreign);
  });

  it('rejects changed ownership on the same inode before task admission', async () => {
    const f = await fixture();
    seam.open = async (path) => {
      const handle = await fs.open(path, 'wx', 0o600);
      handle.sync = async () => { await fs.writeFile(path, foreign); };
      return handle;
    };
    const task = vi.fn(async () => undefined);
    await expect(withWorkspaceDataLock(f.root, 'write', task)).rejects.toThrow(/lock.*ownership/i);
    expect(task).not.toHaveBeenCalled();
    expect(await fs.readFile(f.lock, 'utf8')).toBe(foreign);
  });

  it.each(['writeFile', 'sync'] as const)('cleans its own incomplete lock after %s failure', async (method) => {
    const f = await fixture();
    seam.open = async (path) => {
      const handle = await fs.open(path, 'wx', 0o600);
      handle[method] = async () => { throw new Error('injected I/O failure'); };
      return handle;
    };
    await expect(withWorkspaceDataLock(f.root, 'write', async () => undefined)).rejects.toThrow('injected I/O failure');
    await expect(fs.lstat(f.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['file', 'directory', 'dangling symlink'] as const)('blocks before open on a pre-existing journal %s', async (kind) => {
    const f = await fixture();
    if (kind === 'file') await fs.writeFile(f.journal, '{}');
    if (kind === 'directory') await fs.mkdir(f.journal);
    if (kind === 'dangling symlink') await fs.symlink('missing-target', f.journal);
    const open = vi.fn(async (path: string) => fs.open(path, 'wx', 0o600));
    seam.open = open;
    const task = vi.fn(async () => undefined);
    await expect(withWorkspaceDataLock(f.root, 'write', task)).rejects.toThrow(/batch.*recover/i);
    expect(open).not.toHaveBeenCalled();
    expect(task).not.toHaveBeenCalled();
    await expect(fs.lstat(f.journal)).resolves.toBeDefined();
  });

  it('blocks a journal appearing during lock acquisition and cleans only its lock', async () => {
    const f = await fixture();
    seam.open = async (path) => {
      const handle = await fs.open(path, 'wx', 0o600);
      await fs.writeFile(f.journal, 'needs recovery');
      return handle;
    };
    const task = vi.fn(async () => undefined);
    await expect(withWorkspaceDataLock(f.root, 'write', task)).rejects.toThrow(/batch.*recover/i);
    expect(task).not.toHaveBeenCalled();
    expect(await fs.readFile(f.journal, 'utf8')).toBe('needs recovery');
    await expect(fs.lstat(f.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not treat journal permission errors as absence', async () => {
    const f = await fixture();
    seam.journalError = true;
    const task = vi.fn(async () => undefined);
    await expect(withWorkspaceDataLock(f.root, 'write', task)).rejects.toMatchObject({ code: 'EACCES' });
    expect(task).not.toHaveBeenCalled();
    await expect(fs.lstat(f.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires journal recovery even if a stale lock was manually removed', async () => {
    const f = await fixture();
    await fs.writeFile(f.lock, JSON.stringify({ ...JSON.parse(foreign), pid: 999_999_999 }));
    await fs.writeFile(f.journal, '{}');
    await expect(withWorkspaceDataLock(f.root, 'write', async () => undefined)).rejects.toThrow(/batch.*recover/i);
    await fs.unlink(f.lock); // Replays operator action, not recommended recovery.
    await expect(withWorkspaceDataLock(f.root, 'write', async () => undefined)).rejects.toThrow(/batch.*recover/i);
  });

  it('release preserves a different inode even with the same token', async () => {
    const f = await fixture();
    await withWorkspaceDataLock(f.root, 'write', async () => {
      const bytes = await fs.readFile(f.lock);
      await fs.rename(f.lock, `${f.lock}.retired`);
      await fs.writeFile(f.lock, bytes);
    });
    await expect(fs.readFile(f.lock, 'utf8')).resolves.toContain('"purpose":"write"');
  });

  it('retired AsyncLocalStorage descendants must acquire again', async () => {
    const f = await fixture();
    let resume!: () => void;
    let late!: Promise<unknown>;
    await withWorkspaceDataLock(f.root, 'outer', async () => {
      late = new Promise<void>((resolve) => { resume = resolve; })
        .then(() => withWorkspaceDataLock(f.root, 'late child', async () => 'unsafe'));
      await expect(withWorkspaceDataLock(f.root, 'active nested', async () => 'nested')).resolves.toBe('nested');
    });
    await fs.writeFile(f.lock, foreign);
    const rejected = expect(late).rejects.toThrow(/locked/);
    resume();
    await rejected;
    expect(await fs.readFile(f.lock, 'utf8')).toBe(foreign);
  });

  it('rejects a non-file root before native I/O', async () => {
    const task = vi.fn(async () => undefined);
    await expect(withWorkspaceDataLock({ scheme: 'mem', fsPath: '/unused' }, 'write', task))
      .rejects.toThrow(/local file workspace/);
    expect(task).not.toHaveBeenCalled();
  });
});
