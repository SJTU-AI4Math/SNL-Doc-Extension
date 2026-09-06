import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';

const transactions = new Map<string, Promise<void>>();
const same = (a: Stats | undefined, b: Stats | undefined) => !a || !b ? a === b : a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function existing(file: string): Promise<Stats | undefined> {
  try { return await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function validate(files: Array<{ path: string; bytes: Uint8Array }>, inline: boolean): void {
  if (!files.length || (inline && files.length !== 1)) throw new Error('Inline publication requires exactly one complete HTML file');
  const paths = new Set<string>();
  for (const file of files) {
    if (!file.path || /[\u0000-\u001f\u007f-\u009f\\:]/u.test(file.path) || file.path.split('/').some(p => !p || p === '.' || p === '..') || !(file.bytes instanceof Uint8Array)) throw new Error('Unsafe publication path or bytes');
    const key = file.path.normalize('NFC').toLowerCase(); if (paths.has(key)) throw new Error('Duplicate publication path'); paths.add(key);
  }
  for (const name of paths) {
    const parts = name.split('/'); for (let n = 1; n < parts.length; n++) if (paths.has(parts.slice(0, n).join('/'))) throw new Error('Publication file/directory conflict');
  }
  if (!inline && !paths.has('index.html')) throw new Error('Complete directory export must contain index.html');
}

/** Publish a complete generation in a private same-filesystem stage. Files are fsynced before
 * rename. In-process callers serialize; the destination parent must be trusted against hostile
 * same-UID namespace writers. Directory replacement uses backup+rename+rollback (there can be a
 * brief absent-directory interval, never a mixed generation). This is not power-loss atomicity. */
export async function publishSourceExport(destinationPath: string, files: Array<{ path: string; bytes: Uint8Array }>, inline: boolean, beforeCommit?: () => Promise<void>): Promise<void> {
  validate(files, inline);
  // Copy before the first await, so caller mutation cannot change the staged generation.
  const frozen = files.map(f => ({ path: f.path, bytes: Buffer.from(f.bytes) }));
  const requested = path.resolve(destinationPath);
  if (path.dirname(requested) === requested) throw new Error('Refusing to publish over filesystem root');
  const parent = await fs.realpath(path.dirname(requested));
  const destination = path.join(parent, path.basename(requested));
  const previous = transactions.get(destination) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const parentReal = await fs.realpath(parent), parentStat = await fs.stat(parent);
    if (!parentStat.isDirectory()) throw new Error('Publication parent is not a directory');
    const old = await existing(destination);
    if (old?.isSymbolicLink()) throw new Error('Refusing symlink publication destination');
    if (old && (inline ? !old.isFile() : !old.isDirectory())) throw new Error('Publication destination type mismatch');
    const stage = await fs.mkdtemp(path.join(parent, '.snl-export-'));
    const tree = path.join(stage, 'new'), backup = path.join(stage, 'previous');
    let backedUp = false, committed = false, preserveStage = false;
    let primary: unknown;
    try {
      await fs.mkdir(tree);
      for (const file of frozen) {
        const output = inline ? path.join(tree, 'index.html') : path.join(tree, file.path);
        await fs.mkdir(path.dirname(output), { recursive: true });
        const handle = await fs.open(output, 'wx', 0o600);
        try { await handle.writeFile(file.bytes); await handle.sync(); } finally { await handle.close(); }
      }
      await beforeCommit?.();
      const nowParent = await fs.stat(parent);
      if (await fs.realpath(parent) !== parentReal || nowParent.dev !== parentStat.dev || nowParent.ino !== parentStat.ino) throw new Error('Publication parent changed');
      if (!same(old, await existing(destination))) throw new Error('Publication destination changed during staging');
      if (old && !inline) { await fs.rename(destination, backup); backedUp = true; }
      try {
        await fs.rename(inline ? path.join(tree, 'index.html') : tree, destination);
        committed = true;
      } catch (error) {
        if (backedUp) {
          if (await existing(destination)) { preserveStage = true; throw new AggregateError([error], `Publication failed; concurrent destination preserved; previous export retained at ${backup}`); }
          try { await fs.rename(backup, destination); backedUp = false; }
          catch (rollback) { preserveStage = true; throw new AggregateError([error, rollback], `Publication and rollback failed; previous export retained at ${backup}`); }
        }
        throw error;
      }
    } catch (error) { primary = error; throw error; } finally {
      if (!preserveStage) {
        try { await fs.rm(stage, { recursive: true, force: true }); }
        catch (cleanup) {
          if (committed) process.emitWarning(`Source export published; staging cleanup failed: ${stage}`, { code: 'SNL_EXPORT_CLEANUP' });
          else throw new AggregateError(primary === undefined ? [cleanup] : [primary, cleanup], 'Source publication failed and staging cleanup failed');
        }
      }
    }
  });
  transactions.set(destination, task);
  try { await task; } finally { if (transactions.get(destination) === task) transactions.delete(destination); }
}
