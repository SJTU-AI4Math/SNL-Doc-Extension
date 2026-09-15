import { createHash } from 'node:crypto';
import * as childProcess from 'node:child_process';
import { chmodSync, fstatSync, promises as fs, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Native ESM namespace properties are immutable. Expose a configurable facade,
// retaining the real spawnSync implementation (including the real /bin/ln).
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>()
}));

vi.mock('vscode', async () => {
  const nodeFs = await import('node:fs/promises');
  return {
    Uri: {
      joinPath: (base: TestUri, ...parts: string[]): TestUri => uri(join(base.fsPath, ...parts))
    },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
      fs: {
        stat: async (target: TestUri) => {
          const value = await nodeFs.lstat(target.fsPath);
          return {
            type: (value.isSymbolicLink() ? 64 : 0) | (value.isFile() ? 1 : 0) | (value.isDirectory() ? 2 : 0),
            size: value.size,
            ctime: value.ctimeMs,
            mtime: value.mtimeMs
          };
        }
      }
    }
  };
});

interface TestUri { scheme: string; fsPath: string; path: string; toString(): string }
function uri(fsPath: string): TestUri {
  return { scheme: 'file', fsPath, path: fsPath.replace(/\\/g, '/'), toString: () => `file:${fsPath}` };
}

import { writeWorkspaceSvgMacroAssets } from './svgMacroAssets';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<TestUri> {
  const root = await fs.mkdtemp(join(tmpdir(), 'snl-svg-editor-'));
  roots.push(root);
  await fs.mkdir(join(root, '.SNL_Doc'), { recursive: true });
  return uri(root);
}

const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h1"/></svg>';
const template = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g data-snl-slot="0" transform="translate(1 2)"/></svg>';

describe('writeWorkspaceSvgMacroAssets', () => {
  // IG-TEST-PHASE: .source./.next are not writable paths with O_TMPFILE.
  // The wrapper brackets the real kernel open, not merely the API invocation.
  it.each([
    ['svg', 'before', false], ['svg', 'after', false],
    ['svg', 'before', true], ['svg', 'after', true],
    ['ancestor', 'before', true], ['ancestor', 'after', true], ['svg', 'control', true]
  ] as const)('phase-faithful %s swap %s physical anonymous open (foreign=%s)', async (scope, phase, foreign) => {
    const root = await workspace();
    const snlDoc = join(root.fsPath, '.SNL_Doc');
    const assets = join(snlDoc, 'assets');
    const svgRoot = join(assets, 'svg');
    await fs.mkdir(svgRoot, { recursive: true });
    const outside = await fs.mkdtemp(join(tmpdir(), 'snl-svg-phase-'));
    roots.push(outside);
    const foreignRoot = scope === 'svg' ? outside : join(outside, 'assets', 'svg');
    await fs.mkdir(foreignRoot, { recursive: true });
    const sourceName = `phase.source.${createHash('sha256').update(source).digest('hex')}.svg`;
    const foreignFile = join(foreignRoot, sourceName);
    if (foreign) await fs.writeFile(foreignFile, 'foreign bytes: do not unlink, rename, or overwrite');
    const identity = (stat: { dev: bigint; ino: bigint }) => `${stat.dev}:${stat.ino}`;
    const originalPaths = [root.fsPath, snlDoc, assets, svgRoot];
    const originalIdentities = await Promise.all(originalPaths.map(async (path) => identity(await fs.stat(path, { bigint: true }))));
    const foreignIdentity = foreign ? identity(await fs.stat(foreignFile, { bigint: true })) : undefined;
    const foreignParent = identity(await fs.stat(foreignRoot, { bigint: true }));
    const swapPath = scope === 'svg' ? svgRoot : snlDoc;
    const movedPath = `${swapPath}-phase-held`;
    const heldSvg = scope === 'svg' ? movedPath : join(movedPath, 'assets', 'svg');
    const events: string[] = [];
    const physicalParents: string[] = [];
    const authorityIdentities: string[] = [];
    const anonymousLinks: bigint[] = [];
    const publications: Array<{ command: string; name: string; parent: string; status: number | null }> = [];
    let physicalOpens = 0;
    let anonymousCloses = 0;
    let writes = 0;
    let swapped = false;
    const originalOpen = fs.open.bind(fs);
    const originalSpawn = childProcess.spawnSync;
    const linkSpy = vi.spyOn(childProcess, 'spawnSync').mockImplementation(((...args: Parameters<typeof childProcess.spawnSync>) => {
      const [command, argv, options] = args;
      const stdio = (options as { stdio: number[] }).stdio;
      const result = originalSpawn(...args);
      publications.push({ command: String(command), name: String((argv as string[])[3]),
        parent: identity(fstatSync(stdio[4], { bigint: true })), status: result.status });
      events.push('link');
      return result;
    }) as typeof childProcess.spawnSync);
    const swap = async () => {
      await fs.rename(swapPath, movedPath);
      swapped = true;
      await fs.symlink(outside, swapPath, 'dir');
      events.push('swap');
    };
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const anonymous = (Number(flags) & 0o20000000) !== 0;
      const first = anonymous && physicalOpens === 0;
      if (first && phase === 'before') await swap();
      if (anonymous) events.push('physical-open:start');
      const handle = await originalOpen(path, flags, mode);
      if (anonymous) {
        physicalOpens += 1;
        events.push('physical-open:end');
        const stat = await handle.stat({ bigint: true });
        anonymousLinks.push(stat.nlink);
        // /proc describes the inode actually opened, not the path we hoped to open.
        const actualPath = await fs.readlink(`/proc/self/fd/${handle.fd}`);
        const actualParent = actualPath.slice(0, actualPath.lastIndexOf('/'));
        physicalParents.push(identity(await fs.stat(actualParent, { bigint: true })));
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...args: Parameters<typeof handle.writeFile>) => {
          writes += 1;
          events.push('write');
          return write(...args);
        };
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); anonymousCloses += 1; events.push('close'); };
        if (first && phase === 'after') await swap();
      } else if ((Number(flags) & fs.constants.O_DIRECTORY) !== 0) {
        authorityIdentities.push(identity(await handle.stat({ bigint: true })));
      }
      return handle;
    });
    try {
      const outcome = await writeWorkspaceSvgMacroAssets({
        workspaceRoot: root as never, slug: 'phase', sourceSvg: source, templateSvg: template,
        accessibilityLabel: 'x', operations: []
      }).then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
      const outsideEntries = await fs.readdir(foreignRoot);
      console.info('IG-TEST-PHASE', JSON.stringify({ scope, phase, foreign, events, originalIdentities,
        foreignParent, physicalParents, authorityIdentities, publications, physicalOpens,
        anonymousCloses, writes, outsideEntries, error: String(outcome.error) }));
      expect(authorityIdentities).toEqual(originalIdentities);
      expect(swapped).toBe(phase !== 'control');
      expect(outsideEntries).toEqual(foreign ? [sourceName] : []);
      if (foreign) {
        expect(identity(await fs.stat(foreignFile, { bigint: true }))).toBe(foreignIdentity);
        expect(await fs.readFile(foreignFile, 'utf8')).toBe('foreign bytes: do not unlink, rename, or overwrite');
      }
      if (phase === 'control') {
        expect(outcome.error).toBeUndefined();
        expect(outcome.value?.sourcePath).toBe(`svg/${sourceName}`);
        expect(physicalOpens).toBe(3);
        expect(linkSpy).toHaveBeenCalledTimes(3);
        expect(publications.map((entry) => entry.command)).toEqual(['/bin/ln', '/bin/ln', '/bin/ln']);
        expect(publications.map((entry) => entry.status)).toEqual([0, 0, 0]);
        expect(publications.every((entry) => entry.parent === originalIdentities[3])).toBe(true);
        expect(publications.map((entry) => entry.name.split('.')[1])).toEqual(['source', 'template', 'manifest']);
        expect(await fs.readFile(join(svgRoot, sourceName), 'utf8')).toBe(source);
      } else {
        expect(outcome.error).toBeInstanceOf(Error);
        expect(String(outcome.error)).toMatch(/changed|identity|preserved/i);
        expect(physicalOpens).toBe(1);
        expect(events.slice(0, 3)).toEqual(phase === 'before'
          ? ['swap', 'physical-open:start', 'physical-open:end']
          : ['physical-open:start', 'physical-open:end', 'swap']);
        expect(linkSpy).not.toHaveBeenCalled();
        expect(publications).toEqual([]);
        expect(await fs.readdir(heldSvg)).toEqual([]);
        expect(identity(await fs.stat(movedPath, { bigint: true }))).toBe(originalIdentities[scope === 'svg' ? 3 : 1]);
        expect(identity(await fs.stat(heldSvg, { bigint: true }))).toBe(originalIdentities[3]);
      }
      expect(anonymousCloses).toBe(physicalOpens);
      expect(writes).toBe(physicalOpens);
      expect(anonymousLinks).toEqual(Array(physicalOpens).fill(0n));
      expect(physicalParents).toEqual(Array(physicalOpens).fill(originalIdentities[3]));
    } finally {
      if (swapped) {
        await fs.unlink(swapPath);
        await fs.rename(movedPath, swapPath);
      }
    }
  });
  it('phase-faithful corruption immediately after the real manifest link rolls back publication', async () => {
    const root = await workspace();
    const originalSpawn = childProcess.spawnSync;
    const events: string[] = [];
    let corrupted = false;
    vi.spyOn(childProcess, 'spawnSync').mockImplementation(((...args: Parameters<typeof childProcess.spawnSync>) => {
      const [command, argv, options] = args;
      const result = originalSpawn(...args);
      expect(command).toBe('/bin/ln');
      expect(result.status).toBe(0);
      const name = String((argv as string[])[3]).split('/').pop()!;
      const kind = name.split('.')[1];
      events.push(`linked:${kind}`);
      if (kind === 'manifest') {
        const stdio = (options as { stdio: number[] }).stdio;
        const target = join(`/proc/self/fd/${stdio[4]}`, name);
        expect(fstatSync(stdio[3]).nlink).toBe(1);
        chmodSync(target, 0o600);
        writeFileSync(target, '{"corrupt":true}\n');
        chmodSync(target, 0o400);
        corrupted = true;
        events.push('corrupt:manifest');
      }
      return result;
    }) as typeof childProcess.spawnSync);
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'phase-corrupt', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/bytes|size|verification/i);
    expect(corrupted).toBe(true);
    expect(events).toEqual(['linked:source', 'linked:template', 'linked:manifest', 'corrupt:manifest']);
    const entries = await fs.readdir(join(root.fsPath, '.SNL_Doc', 'assets', 'svg'));
    expect(entries.filter((name) => name.startsWith('phase-corrupt.'))).toEqual([]);
    expect(entries.filter((name) => name.startsWith('.snl-quarantine-'))).toHaveLength(3);
    console.info('IG-TEST-PHASE-LINK', JSON.stringify({ events, corrupted, entries }));
  });

  it('writes content-addressed source/template files and commits the manifest last', async () => {
    const root = await workspace();
    const result = await writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never,
      slug: 'universal-property', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'Universal property', operations: [{ type: 'slot', index: 0 }]
    });
    expect(result.projection).toMatchObject({
      asset: {
        source: expect.stringMatching(/^svg\/universal-property\.template\.[a-f0-9]{64}\.svg$/),
        base_identity: 'workspace:.SNL_Doc/assets',
        revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), request_epoch: 0
      },
      generation: 1, producer_revision: 'snl-doc-extension-svg-editor:v1',
      accessibility: { label: 'Universal property' }
    });
    const assetRoot = join(root.fsPath, '.SNL_Doc', 'assets');
    expect(result.projection).toMatchObject({
      editor: { source: result.sourcePath, manifest: result.manifestPath }
    });
    expect(await fs.readFile(join(assetRoot, result.projection.asset.source), 'utf8')).toBe(template);
    expect(await fs.readFile(join(assetRoot, result.sourcePath), 'utf8')).toBe(source);
    const manifest = JSON.parse(await fs.readFile(join(assetRoot, result.manifestPath), 'utf8'));
    expect(manifest).toMatchObject({ version: 1, source: result.sourcePath, output: result.projection.asset.source });
    for (const relativePath of [result.sourcePath, result.projection.asset.source, result.manifestPath]) {
      expect((await fs.stat(join(assetRoot, relativePath))).mode & 0o222).toBe(0);
    }
  });

  it('surfaces authority close failures instead of silently discarding them', async () => {
    const root = await workspace();
    const originalOpen = fs.open.bind(fs);
    let injected = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (!injected && (Number(flags) & fs.constants.O_DIRECTORY) !== 0) {
        injected = true;
        const originalClose = handle.close.bind(handle);
        handle.close = async () => {
          await originalClose();
          throw new Error('injected authority close failure');
        };
      }
      return handle;
    });
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'close-fail', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/authority handles failed to close/);
  });

  it('closes a directory authority handle when its first fstat fails', async () => {
    const root = await workspace();
    const originalOpen = fs.open.bind(fs);
    let closed = false;
    let injected = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (!injected && (Number(flags) & fs.constants.O_DIRECTORY) !== 0) {
        injected = true;
        const originalClose = handle.close.bind(handle);
        handle.stat = async () => { throw new Error('injected first directory fstat failure'); };
        handle.close = async () => { closed = true; await originalClose(); };
      }
      return handle;
    });
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'dir-stat-fail', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/first directory fstat failure/);
    expect(closed).toBe(true);
  });

  it('closes an anonymous publication handle when its first fstat fails', async () => {
    const root = await workspace();
    const originalOpen = fs.open.bind(fs);
    let closed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if ((Number(flags) & 0o20000000) !== 0) {
        const originalClose = handle.close.bind(handle);
        handle.stat = async () => { throw new Error('injected first anonymous fstat failure'); };
        handle.close = async () => { closed = true; await originalClose(); };
      }
      return handle;
    });
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'file-stat-fail', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/first anonymous fstat failure/);
    expect(closed).toBe(true);
  });

  it('keeps the writable inode anonymous until atomic no-replace installation', async () => {
    const root = await workspace();
    const svgRoot = join(root.fsPath, '.SNL_Doc', 'assets', 'svg');
    const sourceTarget = join(svgRoot, `anonymous.source.${createHash('sha256').update(source).digest('hex')}.svg`);
    const originalOpen = fs.open.bind(fs);
    let anonymousInode: bigint | undefined;
    let absentDuringWrite = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (anonymousInode === undefined && (Number(flags) & 0o20000000) !== 0) {
        anonymousInode = (await handle.stat({ bigint: true })).ino;
        const originalWriteFile = handle.writeFile.bind(handle);
        handle.writeFile = async (...args: Parameters<typeof handle.writeFile>) => {
          await expect(fs.lstat(sourceTarget)).rejects.toMatchObject({ code: 'ENOENT' });
          absentDuringWrite = true;
          return originalWriteFile(...args);
        };
      }
      return handle;
    });
    const result = await writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'anonymous', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    });
    expect(absentDuringWrite).toBe(true);
    expect((await fs.stat(join(root.fsPath, '.SNL_Doc', 'assets', result.sourcePath), { bigint: true })).ino).toBe(anonymousInode);
  });

  it('revalidates all canonical files after the directory sync gap', async () => {
    const root = await workspace();
    const svgRoot = join(root.fsPath, '.SNL_Doc', 'assets', 'svg');
    const sourceTarget = join(svgRoot, `sync-race.source.${createHash('sha256').update(source).digest('hex')}.svg`);
    const originalOpen = fs.open.bind(fs);
    let replaced = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if ((String(path) === svgRoot || String(path).endsWith('/svg')) &&
          (Number(flags) & fs.constants.O_DIRECTORY) !== 0 && (Number(flags) & 0o20000000) === 0) {
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => {
          await originalSync();
          if (!replaced) {
            replaced = true;
            await fs.rename(sourceTarget, `${sourceTarget}.attacker-preserved`);
            await fs.writeFile(sourceTarget, source.replace('h1', 'h2'), { mode: 0o400 });
          }
        };
      }
      return handle;
    });
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'sync-race', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/bytes do not match|rollback/i);
  });

  it('retains rollback ownership when anonymous close fails after linking', async () => {
    const root = await workspace();
    const svgRoot = join(root.fsPath, '.SNL_Doc', 'assets', 'svg');
    const sourceTarget = join(svgRoot, `close-owned.source.${createHash('sha256').update(source).digest('hex')}.svg`);
    const originalOpen = fs.open.bind(fs);
    let injected = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (!injected && (Number(flags) & 0o20000000) !== 0) {
        injected = true;
        const originalClose = handle.close.bind(handle);
        handle.close = async () => {
          await originalClose();
          throw new Error('injected anonymous close failure after link');
        };
      }
      return handle;
    });
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'close-owned', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/anonymous close failure|authority/i);
    await expect(fs.lstat(sourceTarget)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(svgRoot)).some((entry) => entry.startsWith('.snl-quarantine-'))).toBe(true);
  });

  it('syncs the held SVG directory before acknowledging the manifest commit point', async () => {
    const root = await workspace();
    const svgRoot = join(root.fsPath, '.SNL_Doc', 'assets', 'svg');
    const originalOpen = fs.open.bind(fs);
    let directorySyncCalls = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if ((String(path) === svgRoot || String(path).endsWith('/svg')) && (Number(flags) & fs.constants.O_DIRECTORY) !== 0 && (Number(flags) & 0o20000000) === 0) {
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => { directorySyncCalls += 1; await originalSync(); };
      }
      return handle;
    });
    await writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'durable', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    });
    expect(directorySyncCalls).toBe(1);
  });

  it('rejects oversized untrusted SVG bytes before parsing active markup', async () => {
    const root = await workspace();
    const oversized = `<svg xmlns="http://www.w3.org/2000/svg"><script/>${' '.repeat(1024 * 1024)}</svg>`;
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'oversized', sourceSvg: oversized,
      templateSvg: template, accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/1024 KiB/);
  });

  it('rejects unsafe names and active runtime template markup', async () => {
    const root = await workspace();
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: '../escape', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/name|slug/i);
    const unsafeTemplates = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><style>path{fill:url(https://evil/x)}</style></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><animate attributeName="x"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path fill="url(data:image/svg+xml,x)"/></svg>'
    ];
    for (const unsafe of unsafeTemplates) {
      await expect(writeWorkspaceSvgMacroAssets({
        workspaceRoot: root as never, slug: 'bad', sourceSvg: source, templateSvg: unsafe,
        accessibilityLabel: 'x', operations: []
      })).rejects.toThrow(/safe|not supported|not allowed|paint/i);
      await expect(writeWorkspaceSvgMacroAssets({
        workspaceRoot: root as never, slug: 'bad', sourceSvg: unsafe, templateSvg: template,
        accessibilityLabel: 'x', operations: []
      })).rejects.toThrow(/safe|not supported|not allowed|paint/i);
    }
  });

  it('accepts an XML declaration but rejects non-empty slot anchors at the host boundary', async () => {
    const root = await workspace();
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'declared', sourceSvg: `<?xml version="1.0"?>${source}`, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).resolves.toMatchObject({ projection: { generation: 1 } });
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'comment-slot', sourceSvg: source,
      templateSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g data-snl-slot="0"><!--not empty--></g></svg>',
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/slot|empty/i);
  });

  it('keeps descendant creation on the held .SNL_Doc inode after an ancestor swap', async () => {
    const root = await workspace();
    const snlDoc = join(root.fsPath, '.SNL_Doc');
    const movedSnlDoc = join(root.fsPath, '.SNL_Doc-held');
    const outside = await fs.mkdtemp(join(tmpdir(), 'snl-svg-ancestor-race-'));
    roots.push(outside);
    const originalMkdir = fs.mkdir.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'mkdir').mockImplementation(async (path, options) => {
      if (!swapped && String(path).endsWith('/assets')) {
        swapped = true;
        await fs.rename(snlDoc, movedSnlDoc);
        await fs.symlink(outside, snlDoc, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return originalMkdir(path, options as never);
    });
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'ancestor-race', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/changed|publication|rollback|preserved|ENOENT|no such/i);
    expect(await fs.readdir(outside)).toEqual([]);
    await fs.unlink(snlDoc);
    await fs.rename(movedSnlDoc, snlDoc);
  });

  it('refuses a symlinked SVG asset directory', async () => {
    const root = await workspace();
    const outside = await fs.mkdtemp(join(tmpdir(), 'snl-svg-outside-'));
    roots.push(outside);
    await fs.mkdir(join(root.fsPath, '.SNL_Doc', 'assets'), { recursive: true });
    await fs.symlink(outside, join(root.fsPath, '.SNL_Doc', 'assets', 'svg'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'diagram', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/symbolic link/i);
  });
  it('fails closed when the SVG directory changes after a destination file opens', async () => {
    const root = await workspace();
    const svgRoot = join(root.fsPath, '.SNL_Doc', 'assets', 'svg');
    const movedRoot = join(root.fsPath, '.SNL_Doc', 'assets', 'svg-before-race');
    const outside = await fs.mkdtemp(join(tmpdir(), 'snl-svg-race-'));
    roots.push(outside);
    const originalOpen = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (!swapped && (Number(flags) & 0o20000000) !== 0) {
        swapped = true;
        await fs.rename(svgRoot, movedRoot);
        await fs.symlink(outside, svgRoot, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return handle;
    });
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'race', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/changed|identity|preserved/i);
    expect(await fs.readdir(outside)).toEqual([]);
    await fs.unlink(svgRoot);
    await fs.rename(movedRoot, svgRoot);
  });

  it('quarantines rather than deletes a pathname replacement during rollback', async () => {
    const root = await workspace();
    const originalLstat = fs.lstat.bind(fs);
    const originalRename = fs.rename.bind(fs);
    let sourceChecks = 0;
    let replaced = false;
    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      if (!replaced && String(path).includes('cleanup-race.source.')) {
        sourceChecks += 1;
        if (sourceChecks === 2) {
          replaced = true;
          await originalRename(path, `${String(path)}.owned-aside`);
          await fs.writeFile(path, 'unrelated replacement', 'utf8');
        }
      }
      return originalLstat(path, options as never);
    });
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'cleanup-race', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/changed|quarantine|preserved/i);
    const svgRoot = join(root.fsPath, '.SNL_Doc', 'assets', 'svg');
    const entries = await fs.readdir(svgRoot);
    const preserved = await Promise.all(entries.map(async (name) => ({ name, bytes: await fs.readFile(join(svgRoot, name), 'utf8') })));
    expect(preserved.some((entry) => entry.name.startsWith('.snl-quarantine-') && entry.bytes === 'unrelated replacement')).toBe(true);
  });

  it('honors the shared workspace writer lock', async () => {
    const root = await workspace();
    await fs.writeFile(join(root.fsPath, '.SNL_Doc', '.data-write.lock'), JSON.stringify({
      version: 1, pid: process.pid, hostname: 'test-host', token: 'held', purpose: 'another writer', createdAt: new Date().toISOString()
    }));
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'diagram', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/locked/i);
  });

  it('rejects reserved Windows device slugs and pre-existing destination symlinks', async () => {
    const root = await workspace();
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'CON', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/name|reserved|slug/i);

    const svgRoot = join(root.fsPath, '.SNL_Doc', 'assets', 'svg');
    await fs.mkdir(svgRoot, { recursive: true });
    const digest = createHash('sha256').update(source).digest('hex');
    const outside = join(root.fsPath, 'outside.svg');
    await fs.writeFile(outside, source);
    await fs.symlink(outside, join(svgRoot, `diagram.source.${digest}.svg`));
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'diagram', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/symbolic link/i);
  });

  it('fails closed if the SVG directory changes while the manifest handle is verified', async () => {
    const root = await workspace();
    const svgRoot = join(root.fsPath, '.SNL_Doc', 'assets', 'svg');
    const movedRoot = join(root.fsPath, '.SNL_Doc', 'assets', 'svg-during-verify');
    const outside = await fs.mkdtemp(join(tmpdir(), 'snl-svg-verify-race-'));
    roots.push(outside);
    const originalOpen = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (!swapped && String(path).includes('.manifest.') && (Number(flags) & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0) {
        swapped = true;
        await fs.rename(svgRoot, movedRoot);
        const basename = String(path).split(/[\\/]/).pop() as string;
        await fs.link(join(movedRoot, basename), join(outside, basename));
        await fs.symlink(outside, svgRoot, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return handle;
    });
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'verify-race', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/changed|rollback/i);
    const preserved = await fs.readdir(outside);
    expect(preserved).toHaveLength(1);
    expect(preserved[0]).toMatch(/^verify-race\.manifest\./);
    expect(await fs.readFile(join(outside, preserved[0]), 'utf8')).toContain('"version": 1');
    await fs.unlink(svgRoot);
    await fs.rename(movedRoot, svgRoot);
  });

  it('rejects a source pathname replacement during the final three-file authority pass', async () => {
    const root = await workspace();
    const originalOpen = fs.open.bind(fs);
    const originalRename = fs.rename.bind(fs);
    let replaced = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (!replaced && String(path).includes('final-race.source.') && (Number(flags) & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0) {
        replaced = true;
        await originalRename(path, `${String(path)}.verified-aside`);
        await fs.writeFile(path, 'different source bytes', 'utf8');
      }
      return handle;
    });
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'final-race', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/changed|verification|rollback|preserved/i);
    const svgRoot = join(root.fsPath, '.SNL_Doc', 'assets', 'svg');
    const entries = await fs.readdir(svgRoot);
    const preserved = await Promise.all(entries.filter((name) => name.startsWith('.snl-quarantine-')).map((name) => fs.readFile(join(svgRoot, name), 'utf8')));
    expect(preserved).toContain('different source bytes');
  });

  it('rejects mode 0444 instead of weakening the exact immutable 0400 contract', async () => {
    const root = await workspace();
    const originalOpen = fs.open.bind(fs);
    let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (!changed && String(path).includes('mode-race.source.') && (Number(flags) & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0) {
        changed = true;
        await fs.chmod(path, 0o444);
      }
      return originalOpen(path, flags, mode);
    });
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'mode-race', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/0400|mode|rollback/i);
  });

  it('post-write verifies the manifest and rolls back a corrupted publication', async () => {
    const root = await workspace();
    const originalOpen = fs.open.bind(fs);
    let corrupted = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (!corrupted && String(path).includes('.manifest.') && (Number(flags) & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0) {
        corrupted = true;
        await fs.chmod(path, 0o600);
        await fs.writeFile(path, '{"corrupt":true}\n');
        await fs.chmod(path, 0o400);
      }
      return originalOpen(path, flags, mode);
    });
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'corrupt', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/bytes|size|verification|rollback/i);
    const svgRoot = join(root.fsPath, '.SNL_Doc', 'assets', 'svg');
    expect((await fs.readdir(svgRoot)).filter((name) => name.startsWith('corrupt.'))).toEqual([]);
  });

  it('rolls back newly-created immutable files when manifest publication fails', async () => {
    const root = await workspace();
    const svgRoot = join(root.fsPath, '.SNL_Doc', 'assets', 'svg');
    await fs.mkdir(svgRoot, { recursive: true });
    const sourceDigest = createHash('sha256').update(source).digest('hex');
    const templateDigest = createHash('sha256').update(template).digest('hex');
    const manifest = `${JSON.stringify({
      version: 1,
      compiler: 'snl-doc-extension-svg-editor:v1',
      source: `svg/rollback.source.${sourceDigest}.svg`,
      source_revision: `sha256:${sourceDigest}`,
      output: `svg/rollback.template.${templateDigest}.svg`,
      output_revision: `sha256:${templateDigest}`,
      operations: []
    }, null, 2)}
`;
    const manifestDigest = createHash('sha256').update(manifest).digest('hex');
    const outside = join(root.fsPath, 'outside.json');
    await fs.writeFile(outside, manifest);
    await fs.symlink(outside, join(svgRoot, `rollback.manifest.${manifestDigest}.json`));
    await expect(writeWorkspaceSvgMacroAssets({
      workspaceRoot: root as never, slug: 'rollback', sourceSvg: source, templateSvg: template,
      accessibilityLabel: 'x', operations: []
    })).rejects.toThrow(/symbolic link/i);
    await expect(fs.stat(join(svgRoot, `rollback.source.${sourceDigest}.svg`))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(join(svgRoot, `rollback.template.${templateDigest}.svg`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

});
