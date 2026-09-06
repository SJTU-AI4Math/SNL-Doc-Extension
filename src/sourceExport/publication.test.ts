import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { publishSourceExport } from './publication';
const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text) });
describe('complete artifact publication', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'snl-publish-')); });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
  it('replaces one complete directory generation, removing stale files', async () => {
    const dest = path.join(root, 'site'); await fs.mkdir(dest); await fs.writeFile(path.join(dest, 'old'), 'prior');
    await publishSourceExport(dest, [file('index.html', 'new'), file('assets/font.bin', 'font')], false);
    expect(await fs.readFile(path.join(dest, 'index.html'), 'utf8')).toBe('new');
    expect(await fs.readdir(dest)).toEqual(['assets', 'index.html']);
    expect(await fs.readdir(root)).toEqual(['site']);
  });
  it('inline atomically replaces a file and never touches neighboring files', async () => {
    const dest = path.join(root, 'page.html'); await fs.writeFile(dest, 'old'); await fs.writeFile(path.join(root, 'neighbor'), 'keep');
    await publishSourceExport(dest, [file('index.html', 'new')], true);
    expect(await fs.readFile(dest, 'utf8')).toBe('new'); expect(await fs.readFile(path.join(root, 'neighbor'), 'utf8')).toBe('keep');
    await expect(publishSourceExport(dest, [file('index.html', 'x'), file('extra', 'y')], true)).rejects.toThrow();
    expect(await fs.readFile(dest, 'utf8')).toBe('new');
  });
  it('prevalidates paths, duplicates and file/directory conflicts without changing prior output', async () => {
    const dest = path.join(root, 'site'); await fs.mkdir(dest); await fs.writeFile(path.join(dest, 'prior'), 'keep');
    for (const paths of [['../escape'], ['/absolute'], ['a\\b'], ['index.html', 'index.html'], ['A', 'a'], ['x', 'x/y']]) {
      await expect(publishSourceExport(dest, paths.map(p => file(p, 'bad')), false)).rejects.toThrow();
      expect(await fs.readdir(dest)).toEqual(['prior']);
    }
    expect(await fs.readdir(root)).toEqual(['site']);
  });
  it('preserves prior output on stage write failure and rename failure, cleans only owned staging', async () => {
    const dest = path.join(root, 'site'); await fs.mkdir(dest); await fs.writeFile(path.join(dest, 'prior'), 'keep');
    const original = fs.rename.bind(fs); let failed = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === dest && !failed) { failed = true; throw Object.assign(new Error('injected publish failure'), { code: 'EIO' }); }
      return original(from, to);
    });
    await expect(publishSourceExport(dest, [file('index.html', 'new')], false)).rejects.toThrow(/injected/);
    expect(await fs.readFile(path.join(dest, 'prior'), 'utf8')).toBe('keep'); expect(await fs.readdir(root)).toEqual(['site']);
    vi.restoreAllMocks(); vi.spyOn(fs, 'open').mockRejectedValueOnce(new Error('injected staging failure'));
    await expect(publishSourceExport(dest, [file('index.html', 'new')], false)).rejects.toThrow(/injected/);
    expect(await fs.readFile(path.join(dest, 'prior'), 'utf8')).toBe('keep'); expect(await fs.readdir(root)).toEqual(['site']);
  });
  it('preserves a recoverable prior generation if rollback itself fails', async () => {
    const dest = path.join(root, 'site'); await fs.mkdir(dest); await fs.writeFile(path.join(dest, 'prior'), 'keep');
    const original = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === dest) throw new Error('injected publish and rollback failure');
      return original(from, to);
    });
    await expect(publishSourceExport(dest, [file('index.html', 'new')], false)).rejects.toThrow(/previous export retained/);
    const stage = (await fs.readdir(root)).find(name => name.startsWith('.snl-export-'))!;
    expect(await fs.readFile(path.join(root, stage, 'previous', 'prior'), 'utf8')).toBe('keep');
  });
  it('snapshots caller bytes and serializes concurrent generation publication', async () => {
    const dest = path.join(root, 'site'), bytes = Buffer.from('first');
    const first = publishSourceExport(dest, [{ path: 'index.html', bytes }], false); bytes.fill(0);
    await first; expect(await fs.readFile(path.join(dest, 'index.html'), 'utf8')).toBe('first');
    await Promise.all([publishSourceExport(dest, [file('index.html', 'second'), file('old.js', 'old')], false),
      publishSourceExport(dest, [file('index.html', 'third'), file('new.js', 'new')], false)]);
    expect(await fs.readdir(dest)).toEqual(['index.html', 'new.js']);
    expect(await fs.readFile(path.join(dest, 'index.html'), 'utf8')).toBe('third');
  });
  it('rechecks the frozen source after staging and preserves the old output on rejection', async () => {
    const dest = path.join(root, 'site'); await fs.mkdir(dest); await fs.writeFile(path.join(dest, 'prior'), 'keep');
    let sawStage = false;
    await expect(publishSourceExport(dest, [file('index.html', 'new')], false, async () => {
      sawStage = (await fs.readdir(root)).some(name => name.startsWith('.snl-export-'));
      throw new Error('source changed during staging');
    })).rejects.toThrow('source changed');
    expect(sawStage).toBe(true);
    expect(await fs.readFile(path.join(dest, 'prior'), 'utf8')).toBe('keep');
    expect(await fs.readdir(root)).toEqual(['site']);
  });
  it('rejects symlink destination without changing its target', async () => {
    const target = path.join(root, 'actual'); await fs.mkdir(target); await fs.writeFile(path.join(target, 'prior'), 'keep');
    const dest = path.join(root, 'link'); await fs.symlink(target, dest);
    await expect(publishSourceExport(dest, [file('index.html', 'new')], false)).rejects.toThrow(/symlink/);
    expect(await fs.readFile(path.join(target, 'prior'), 'utf8')).toBe('keep'); expect((await fs.lstat(dest)).isSymbolicLink()).toBe(true);
  });
});
