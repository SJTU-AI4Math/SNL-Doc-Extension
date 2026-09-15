import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readWorkspaceAsset, readWorkspaceSvgSource } from './workspaceAssets';

function uri(path: string) { return { scheme: 'file', path, fsPath: path }; }
vi.mock('vscode', () => ({
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: { joinPath: (base: ReturnType<typeof uri>, ...parts: string[]) => uri(join(base.fsPath, ...parts)) }
}));
const baseIdentity = 'workspace:.SNL_Doc/assets';
const revision = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const realStat = async (target: ReturnType<typeof uri>) => {
  const s = await fs.lstat(target.fsPath);
  return { type: (s.isFile() ? 1 : 2) | (s.isSymbolicLink() ? 64 : 0), size: s.size };
};
const fsApi = { stat: vi.fn(realStat) };
afterEach(() => vi.restoreAllMocks());
async function fixture(source: string, run: (options: Parameters<typeof readWorkspaceSvgSource>[0], file: string) => Promise<void>) {
  const root = await fs.mkdtemp(join(tmpdir(), 'snl-svg-read-'));
  try {
    await fs.mkdir(join(root, '.SNL_Doc/assets'), { recursive: true });
    const file = join(root, '.SNL_Doc/assets/proof.svg');
    await fs.writeFile(file, source);
    await run({ workspaceRoot: uri(root) as never, relativePath: 'proof.svg', expectedRevision: revision(source), fsApi: fsApi as never }, file);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

describe('workspace SVG read authority', () => {
  it('accepts exact UTF-8 with explicit fixed identity and trusted omitted identity', async () => {
    const source = '<svg><!--证明--></svg>';
    await fixture(source, async options => {
      await expect(readWorkspaceSvgSource({ ...options, baseIdentity })).resolves.toBe(source);
      await expect(readWorkspaceSvgSource(options)).resolves.toBe(source);
    });
  });
  it('rejects a foreign nonempty base before any disk I/O despite valid bytes and digest', async () => {
    await fixture('<svg/>', async options => {
      fsApi.stat.mockClear();
      const open = vi.spyOn(fs, 'open');
      await expect(readWorkspaceSvgSource({ ...options, baseIdentity: 'offline:P' })).rejects.toThrow(/base identity/i);
      expect(fsApi.stat).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    });
  });
  it.each(['prefix', 'digest'])('rejects noncanonical uppercase %s before I/O', async part => {
    await fixture('<svg/>', async options => {
      fsApi.stat.mockClear();
      const expectedRevision = part === 'prefix' ? options.expectedRevision.replace('sha256:', 'SHA256:') : `sha256:${options.expectedRevision.slice(7).toUpperCase()}`;
      await expect(readWorkspaceSvgSource({ ...options, expectedRevision })).rejects.toThrow(/sha256/);
      expect(fsApi.stat).not.toHaveBeenCalled();
    });
  });
  it('rejects over-1MiB SVG with valid digest before opening; image limit remains 10MiB', async () => {
    const source = `<svg>${' '.repeat(1024 * 1024)}</svg>`;
    await fixture(source, async options => {
      const open = vi.spyOn(fs, 'open');
      await expect(readWorkspaceSvgSource(options)).rejects.toThrow(/1 MiB/);
      expect(open).not.toHaveBeenCalled();
      await expect(readWorkspaceAsset(options)).resolves.toEqual(Buffer.from(source));
    });
  });
  it('preserves the separate image 10MiB inclusive ceiling', async () => {
    const source = 'x'.repeat(10 * 1024 * 1024);
    await fixture(source, async (options, file) => {
      const bytes = await readWorkspaceAsset(options);
      expect(bytes.byteLength).toBe(10 * 1024 * 1024);
      expect(revision(bytes)).toBe(revision(source));
      await fs.appendFile(file, 'x');
      const open = vi.spyOn(fs, 'open');
      await expect(readWorkspaceAsset(options)).rejects.toThrow(/10 MiB/);
      expect(open).not.toHaveBeenCalled();
    });
  });
  it('accepts exactly 1MiB SVG', async () => {
    const source = `<svg>${' '.repeat(1024 * 1024 - 11)}</svg>`;
    await fixture(source, async options => {
      await expect(readWorkspaceSvgSource(options)).resolves.toBe(source);
    });
  });
  it('rechecks the SVG ceiling on the opened inode when provider stat understates size', async () => {
    const source = `<svg>${' '.repeat(1024 * 1024)}</svg>`;
    await fixture(source, async options => {
      const stat = realStat;
      fsApi.stat.mockImplementation(async target => ({ ...await stat(target), size: 0 }));
      try { await expect(readWorkspaceSvgSource(options)).rejects.toThrow(/1 MiB/); }
      finally { fsApi.stat.mockImplementation(stat); }
    });
  });
  it('rejects growth after fstat with a matching digest of the actual bytes', async () => {
    const source = `<svg>${' '.repeat(1024 * 1024)}</svg>`;
    await fixture('<svg/>', async (options, file) => {
      const open = fs.open.bind(fs);
      let first = true;
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (first) {
          first = false;
          const read = handle.readFile.bind(handle);
          handle.readFile = (async (...readArgs: Parameters<typeof handle.readFile>) => {
            await fs.writeFile(file, source);
            return read(...readArgs);
          }) as typeof handle.readFile;
        }
        return handle;
      });
      await expect(readWorkspaceSvgSource({ ...options, expectedRevision: revision(source) })).rejects.toThrow(/1 MiB/);
    });
  });
});
