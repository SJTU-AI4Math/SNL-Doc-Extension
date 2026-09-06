import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { constants, promises as fs, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { captureSourceSnapshot, revalidateSourceSnapshot, type SourceCaptureInput } from './archive';
import { DEFAULT_SOURCE_OPTIONS } from './types';
import { buildSourceAssets } from './transport';
import { publishSourceExport } from './publication';
import { runInNewContext } from 'node:vm';

describe('source snapshot', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'snl-archive-')); });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  function input(): SourceCaptureInput { return { rootPath: root, destinationPath: path.join(root, 'export'), inline: false,
    entries: [{ id: 'e', pointer: { file: 'src/a.lean', mode: 'lines', line: 2, beforeLines: 0, afterLines: 4 } }],
    entryRoutes: [{ entryId: 'e', hash: '#/entry/e' }], renderSnapshotId: 'render-1',
    options: { ...DEFAULT_SOURCE_OPTIONS, enabled: true, keep: [], exclude: [], companionFiles: [], allowedExternalRoots: [] } }; }
  async function put(file: string, bytes: string | Uint8Array) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), bytes);
  }
  it('revalidates after staging inside the source root without capturing exporter artifacts', async () => {
    await put('src/a.lean', 'one\ntwo'); const args = input(); args.options.scope = 'project';
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'], { cwd: root });
    const p = await captureSourceSnapshot(args);
    await fs.mkdir(path.join(root, '.snl-export-owned'));
    await fs.writeFile(path.join(root, '.snl-export-owned', 'new.html'), 'generated');
    await expect(revalidateSourceSnapshot(p, args)).resolves.toBeUndefined();
    expect((await captureSourceSnapshot(args)).manifest.files.map(f => f.displayPath)).toEqual(['src/a.lean']);
  });
  it('does not enumerate unrelated default-excluded trees for a specific deep keep rule', async () => {
    await put('src/a.lean', 'one\ntwo'); await put('node_modules/large/file', 'irrelevant');
    await put('.lake/packages/mathlib/Mathlib/X.lean', 'def x := 1');
    const args = input(); args.options.scope = 'project'; args.options.keep = ['.lake/packages/mathlib/Mathlib/**'];
    const readdir = fs.readdir.bind(fs);
    vi.spyOn(fs, 'readdir').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).includes('node_modules')) throw new Error('unrelated excluded tree enumerated');
      return (readdir as any)(p, ...rest);
    }) as any);
    const p = await captureSourceSnapshot(args);
    expect(p.manifest.files.map(f => f.displayPath)).toEqual(['.lake/packages/mathlib/Mathlib/X.lean', 'src/a.lean']);
  });
  it('captures whole exact bytes, metadata and frozen UTF-16 ranges; companions only, not keep expansion', async () => {
    const bytes = Buffer.from('\ufeffheader\r\n😀α\r\ntail\n');
    await put('src/a.lean', bytes); await put('LICENSE', 'license'); await put('src/other.lean', 'excluded by scope');
    const args = input(); args.options.keep = ['src']; args.options.companionFiles = ['LICENSE'];
    const preview = await captureSourceSnapshot(args);
    expect(preview.manifest.files.map(f => f.displayPath)).toEqual(['LICENSE', 'src/a.lean']);
    const file = preview.manifest.files[1];
    expect(file).toMatchObject({ sha256: digest(bytes), bom: true, eol: 'mixed', byteLength: bytes.length, kind: 'text' });
    expect(Buffer.from(preview.chunks[1].base64, 'base64')).toEqual(bytes);
    expect(preview.manifest.pointers[0]).toMatchObject({ status: 'ok', sourceSha256: digest(bytes), range: { startLine: 2, endColumn: 4 }, pointer: { beforeLines: 0, afterLines: 4 } });
    expect(preview.manifest.directories).toContain('src');
    await expect(revalidateSourceSnapshot(preview, args)).resolves.toBeUndefined();
    await put('src/a.lean', 'changed');
    await expect(revalidateSourceSnapshot(preview, args)).rejects.toThrow(/changed|stale/i);
  });

  it('produces and publishes real offline classic-script artifacts from the verified frozen snapshot', async () => {
    await put('src/a.lean', 'one\n😀two'); const args = input();
    const p = await captureSourceSnapshot(args), texts = buildSourceAssets(p, false).texts;
    await revalidateSourceSnapshot(p, args);
    await publishSourceExport(args.destinationPath, [{ path: 'index.html', bytes: Buffer.from('<script src="sources.js"></script>') },
      ...texts.map(t => ({ path: t.path, bytes: Buffer.from(t.source) }))], false);
    const context: Record<string, any> = {};
    runInNewContext(await fs.readFile(path.join(args.destinationPath, 'sources.js'), 'utf8'), context);
    expect(context.__snlSourceChunks.size).toBe(0);
    runInNewContext(await fs.readFile(path.join(args.destinationPath, p.manifest.files[0].chunkId), 'utf8'), context);
    expect(context.__snlSources.pointers[0].sourceSha256).toBe(p.manifest.files[0].sha256);
    expect(Buffer.from(context.__snlSourceChunks.get(p.chunks[0].fileId).base64, 'base64').toString()).toBe('one\n😀two');
  });
  it('reports real Git baseline/dirty provenance without updating the source index', async () => {
    await put('src/a.lean', 'one\ntwo'); const args = input();
    const git = (...commands: string[]) => execFileSync('git', commands, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
    const index = await fs.readFile(path.join(root, '.git/index'));
    const p = await captureSourceSnapshot(args);
    expect(p.manifest.snapshot).toEqual({ mode: 'disk', gitCommit: git('rev-parse', 'HEAD'), dirty: false });
    expect(await fs.readFile(path.join(root, '.git/index'))).toEqual(index);
    await put('untracked', 'new'); expect((await captureSourceSnapshot(args)).manifest.snapshot.dirty).toBe(true);
  });
  it('does not block opening a file replaced with a FIFO between scan and open', async () => {
    await put('src/a.lean', 'one\ntwo'); const args = input();
    const original = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (file, flags, mode) => {
      expect(Number(flags) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      await fs.unlink(file); execFileSync('mkfifo', [String(file)]);
      return original(file, flags, mode);
    });
    await expect(captureSourceSnapshot(args)).rejects.toThrow(/changed before read/);
  });
  it('treats prototype-shaped filenames/extensions as ordinary text', async () => {
    const args = input(); args.entries = []; args.entryRoutes = []; args.options.scope = 'project';
    await put('__proto__', 'x'); await put('file.constructor', 'x'); await put('file.__proto__', 'x');
    const p = await captureSourceSnapshot(args);
    expect(p.manifest.files.map(f => f.language)).toEqual(['plaintext', 'plaintext', 'plaintext']);
  });
  it('rejects FIFO before opening; output aliases remain a hard exclusion even under keep', async () => {
    const args = input(); args.entries = []; args.entryRoutes = []; args.options.scope = 'project'; args.options.keep = ['**'];
    execFileSync('mkfifo', [path.join(root, 'pipe')]);
    await expect(captureSourceSnapshot(args)).rejects.toThrow(/file type/); await fs.unlink(path.join(root, 'pipe'));
    await put('export/prior', 'secret'); await fs.symlink('export', path.join(root, 'alias'));
    expect((await captureSourceSnapshot(args)).manifest.files).toEqual([]);
  });
  it('detects same-byte inode replacement, removed files, empty directory changes and additions during capture', async () => {
    const args = input(); args.entries = []; args.entryRoutes = []; args.options.scope = 'project'; await put('a', 'same');
    const p = await captureSourceSnapshot(args); await fs.unlink(path.join(root, 'a')); await put('a', 'same');
    await expect(revalidateSourceSnapshot(p, args)).rejects.toThrow(/changed/);
    const p2 = await captureSourceSnapshot(args); await fs.mkdir(path.join(root, 'empty'));
    await expect(revalidateSourceSnapshot(p2, args)).rejects.toThrow(/changed/);
    args.onProgress = progress => { if (progress.phase === 'read') writeFileSync(path.join(root, 'new'), 'new'); };
    await expect(captureSourceSnapshot(args)).rejects.toThrow(/changed/);
  });
  it('project enumerates untracked files and empty dirs, defaults < keep < excludes; output never included', async () => {
    const args = input(); args.entries = []; args.entryRoutes = []; args.options.scope = 'project';
    args.options.keep = ['.lake/packages/mathlib/**', '.env.example'];
    args.options.exclude = ['**/.git/**', '**/node_modules/**'];
    for (const name of ['.env', '.env.example', '.ssh/key', '.SNL_Doc/private.json', 'untracked.lean',
      '.lake/build/a', '.lake/packages/mathlib/Mathlib/A.lean', '.lake/packages/mathlib/.git/config',
      '.lake/packages/mathlib/node_modules/a.js', 'export/prior.html']) await put(name, 'x');
    await fs.mkdir(path.join(root, 'empty'));
    const p = await captureSourceSnapshot(args);
    expect(p.manifest.files.map(f => f.displayPath)).toEqual(['.env.example', '.lake/packages/mathlib/Mathlib/A.lean', 'untracked.lean']);
    expect(p.manifest.directories).toContain('empty');
    expect(p.exclusions).toContainEqual({ path: '.lake/packages/mathlib/.git', reason: 'explicit exclude rule' });
    await put('new-file', 'new');
    await expect(revalidateSourceSnapshot(p, args)).rejects.toThrow(/changed/);
  });
  it('exact directory rules recurse; exact files and anchored globs do not become a whitelist', async () => {
    const args = input(); args.entries = []; args.entryRoutes = []; args.options.scope = 'project';
    args.options.keep = ['.cache', '.env.example']; args.options.exclude = ['remove', '**/temp*'];
    for (const name of ['.cache/deep/a', '.env.example', '.env', 'ordinary', 'nested/temp1', 'temp2', 'remove/a', 'nested/remove/a']) await put(name, 'x');
    expect((await captureSourceSnapshot(args)).manifest.files.map(f => f.displayPath)).toEqual(['.cache/deep/a', '.env.example', 'nested/remove/a', 'ordinary']);
  });
  it.each(['../secret', 'a/../secret', '/etc/passwd', 'C:/secret', 'a\\b', 'a\u0000b', 'a\nb'])('rejects unsafe pointer path %j', async file => {
    const args = input(); args.entries[0].pointer = { file, mode: 'lines', line: 1 }; args.options.allowMissing = true;
    await expect(captureSourceSnapshot(args)).rejects.toThrow(/Unsafe/);
  });
  it('rejects unsafe rules, invalid budgets and foreign routes before reading bytes', async () => {
    const args = input(); args.options.keep = ['../**'];
    await expect(captureSourceSnapshot(args)).rejects.toThrow(/Unsafe/);
    args.options.keep = []; args.options.maxTotalBytes = Infinity;
    await expect(captureSourceSnapshot(args)).rejects.toThrow(/budget/);
    args.options.maxTotalBytes = 100; args.entryRoutes.push({ entryId: 'outside', hash: '#/entry/outside' });
    await expect(captureSourceSnapshot(args)).rejects.toThrow(/closure/);
  });
  it('excluded/missing Pointer requires explicit acceptance and retains portable descriptions without extra fields', async () => {
    await put('src/a.lean', 'one\ntwo'); const args = input(); args.options.exclude = ['src'];
    args.entries[0].pointer = { file: 'src/a.lean', mode: 'lines', line: 2, hostPath: '/secret/host' };
    await expect(captureSourceSnapshot(args)).rejects.toMatchObject({ preview: { manifest: { pointers: [{ status: 'excluded' }] } } });
    args.options.allowMissing = true; const p = await captureSourceSnapshot(args);
    expect(p.manifest.pointers[0]).toMatchObject({ status: 'excluded', pointer: { file: 'src/a.lean', line: 2 } });
    expect(JSON.stringify(p.manifest)).not.toContain('/secret/host');
    expect(p.chunks).toEqual([]);
  });
  it('invalid UTF8 is unsupported; inert binaries roundtrip without text coordinates', async () => {
    const args = input(); args.options.allowMissing = true; args.options.companionFiles = ['image.png'];
    const invalid = Buffer.from([0xef, 0xbb, 0xbf, 0xc3, 0x28]); await put('src/a.lean', invalid);
    await put('image.png', Buffer.from([137, 80, 78, 71, 0, 255]));
    const p = await captureSourceSnapshot(args);
    expect(p.manifest.files.map(f => f.kind)).toEqual(['binary', 'unsupported']);
    expect(p.manifest.pointers[0]).toMatchObject({ status: 'unsupported' });
    expect(p.manifest.pointers[0].range).toBeUndefined();
    expect(Buffer.from(p.chunks[1].base64, 'base64')).toEqual(invalid);
  });
  it('shared async regex worker resolves exact BOM-stripped UTF16, and terminates pathological regex', async () => {
    const args = input(); args.entries[0].pointer = { file: 'src/a.lean', mode: 'regex', pattern: '😀α', beforeLines: 0 };
    await put('src/a.lean', '\ufeffbefore\r\n😀α\r\n');
    expect((await captureSourceSnapshot(args)).manifest.pointers[0]).toMatchObject({ status: 'ok', range: { startLine: 2, startColumn: 1, endColumn: 4 } });
    args.entries[0].pointer = { file: 'src/a.lean', mode: 'regex', pattern: '(a+)+$' };
    args.options.allowMissing = true; await put('src/a.lean', 'a'.repeat(100000) + '!');
    expect((await captureSourceSnapshot(args)).manifest.pointers[0]).toMatchObject({ status: 'unresolved', reason: 'regex-timeout' });
  });
  it('fails explicit per-file/total budgets without truncating', async () => {
    await put('src/a.lean', 'one\ntwo\nthree'); const args = input(); args.options.maxFileBytes = 3;
    await expect(captureSourceSnapshot(args)).rejects.toThrow(/budget exceeded/);
    args.options.maxFileBytes = 100; args.options.maxTotalBytes = 3;
    await expect(captureSourceSnapshot(args)).rejects.toThrow(/budget exceeded/);
  });
  it('rechecks held inode and lexical realpath after reads; aborts callback-driven swaps', async () => {
    await put('src/a.lean', 'one\ntwo'); const args = input();
    args.onProgress = p => { if (p.phase === 'read') writeFileSync(path.join(root, p.path!), 'one\nnew'); };
    await expect(captureSourceSnapshot(args)).rejects.toThrow(/changed during read/);
    await put('other.lean', 'one\ntwo');
    args.onProgress = p => { if (p.phase === 'read') { unlinkSync(path.join(root, p.path!)); symlinkSync('../other.lean', path.join(root, p.path!)); } };
    await expect(captureSourceSnapshot(args)).rejects.toThrow(/changed during read/);
  });
  it('detects Pointer/options/route/render changes and preview tampering', async () => {
    await put('src/a.lean', 'one\ntwo'); const args = input(); const p = await captureSourceSnapshot(args);
    args.renderSnapshotId = 'new'; await expect(revalidateSourceSnapshot(p, args)).rejects.toThrow(/stale/);
    args.renderSnapshotId = 'render-1'; args.entries[0].pointer = { file: 'src/a.lean', mode: 'lines', line: 1 };
    await expect(revalidateSourceSnapshot(p, args)).rejects.toThrow(/stale/);
    const fresh = await captureSourceSnapshot(args); fresh.chunks[0].base64 = '';
    await expect(revalidateSourceSnapshot(fresh, args)).rejects.toThrow(/modified/);
  });
  it('checks cancellation and live input mutation during capture', async () => {
    await put('src/a.lean', 'one\ntwo'); const args = input(); const controller = new AbortController(); args.signal = controller.signal;
    args.onProgress = p => { if (p.phase === 'read') controller.abort(); };
    await expect(captureSourceSnapshot(args)).rejects.toThrow(/cancelled/);
    args.signal = undefined; args.onProgress = p => { if (p.phase === 'read') args.renderSnapshotId = 'changed'; };
    await expect(captureSourceSnapshot(args)).rejects.toThrow(/inputs changed/);
  });
  it('requires specific external root authorization and keeps absolute paths host-only', async () => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'snl-external-'));
    try {
      await fs.writeFile(path.join(external, 'a.lean'), 'one\ntwo'); await fs.symlink(external, path.join(root, 'src'));
      const args = input(); args.options.allowMissing = true;
      const blocked = await captureSourceSnapshot(args);
      expect(blocked.chunks).toEqual([]); expect(blocked.externalRoots).toEqual([external]);
      expect(JSON.stringify(blocked.manifest)).not.toContain(external);
      args.options.allowedExternalRoots = [external]; const accepted = await captureSourceSnapshot(args);
      expect(accepted.manifest.files[0]).toMatchObject({ displayPath: 'src/a.lean', symlink: true });
      expect(accepted.manifest.pointers[0].status).toBe('ok');
      expect(JSON.stringify(accepted.manifest)).not.toContain(external);
    } finally { await fs.rm(external, { recursive: true, force: true }); }
  });
  it('keeps hardlink/alias virtual paths and detects cycles, dangling links and case/Unicode conflicts', async () => {
    const args = input(); args.entries = []; args.entryRoutes = []; args.options.scope = 'project';
    await put('a', 'same'); await fs.link(path.join(root, 'a'), path.join(root, 'b'));
    const p = await captureSourceSnapshot(args);
    expect(p.manifest.files.map(f => f.displayPath)).toEqual(['a', 'b']); expect(p.warnings.join()).toContain('Shared file identity');
    await fs.symlink('.', path.join(root, 'loop')); await expect(captureSourceSnapshot(args)).rejects.toThrow(/cycle/); await fs.unlink(path.join(root, 'loop'));
    await fs.symlink('absent', path.join(root, 'dangling')); expect((await captureSourceSnapshot(args)).exclusions).toContainEqual({ path: 'dangling', reason: 'missing file or dangling symlink' });
    await put('A', 'other'); await expect(captureSourceSnapshot(args)).rejects.toThrow(/collision/); await fs.unlink(path.join(root, 'A'));
    await put('é', 'x'); await put('e\u0301', 'x'); await expect(captureSourceSnapshot(args)).rejects.toThrow(/collision/);
  });

});
