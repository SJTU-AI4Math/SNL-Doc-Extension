import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DATA_WRITE_LOCK_FILENAME, withWorkspaceDataLock } from './workspaceDataLock';

const root = async () => {
  const fsPath = await mkdtemp(join(tmpdir(), 'snl-data-lock-'));
  await mkdir(join(fsPath, '.SNL_Doc'));
  return { scheme: 'file', fsPath };
};

describe('workspace data disk lock', () => {
  it('serializes migration against another Extension process and removes the lock', async () => {
    const workspace = await root();
    let release!: () => void;
    const held = withWorkspaceDataLock(workspace, 'migration', async () => {
      await new Promise<void>((resolve) => { release = resolve; });
    });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));

    await expect(withWorkspaceDataLock(workspace, 'write', async () => undefined))
      .rejects.toThrow(/locked.*migration/i);
    release();
    await held;
    await expect(readFile(join(workspace.fsPath, '.SNL_Doc', DATA_WRITE_LOCK_FILENAME)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(withWorkspaceDataLock(workspace, 'write', async () => 7)).resolves.toBe(7);
  });

  it('allows nested operations in the same async transaction without dropping the outer lock', async () => {
    const workspace = await root();
    const value = await withWorkspaceDataLock(workspace, 'outer', async () =>
      withWorkspaceDataLock(workspace, 'inner', async () => 11)
    );
    expect(value).toBe(11);
  });

  it('never auto-unlinks a stale pathname that another process may have replaced', async () => {
    const workspace = await root();
    const lockPath = join(workspace.fsPath, '.SNL_Doc', DATA_WRITE_LOCK_FILENAME);
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      pid: 999_999_999,
      hostname: hostname(),
      token: 'stale',
      purpose: 'migration',
      createdAt: new Date(0).toISOString()
    }));
    await expect(withWorkspaceDataLock(workspace, 'write', async () => 'unsafe'))
      .rejects.toThrow(/stale.*remove/i);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ token: 'stale' });
  });

  it('releases the lock when the protected operation throws', async () => {
    const workspace = await root();
    await expect(withWorkspaceDataLock(workspace, 'write', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    await expect(withWorkspaceDataLock(workspace, 'write', async () => 'next'))
      .resolves.toBe('next');
  });
});
