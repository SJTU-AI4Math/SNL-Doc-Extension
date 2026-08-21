import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
      if (!swapped && String(path).includes('.source.') && (Number(flags) & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0) {
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
    expect(preserved[0]).toMatch(/^\.snl-quarantine-/);
    expect(await fs.readFile(join(outside, preserved[0]), 'utf8')).toContain('"version": 1');
    await fs.unlink(svgRoot);
    await fs.rename(movedRoot, svgRoot);
  });

  it('post-write verifies the manifest and rolls back a corrupted publication', async () => {
    const root = await workspace();
    const originalOpen = fs.open.bind(fs);
    let corrupted = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (!corrupted && String(path).includes('.manifest.') && (Number(flags) & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0) {
        corrupted = true;
        await fs.writeFile(path, '{"corrupt":true}\n');
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
