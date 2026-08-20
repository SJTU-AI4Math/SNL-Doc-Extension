import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readWorkspaceSvgSource, SVG_ASSET_BASE_IDENTITY } from './workspaceAssets';

function uri(path: string) { const url = pathToFileURL(path); return { scheme: 'file', authority: '', path: url.pathname, fsPath: path, toString: () => url.href }; }

vi.mock('vscode', () => ({
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: { joinPath: (base: ReturnType<typeof uri>, ...parts: string[]) => uri(join(base.fsPath, ...parts)) },
  workspace: { fs: {} }
}));
const nodeFs = {
  stat: async (target: ReturnType<typeof uri>) => { const s = await fs.lstat(target.fsPath); return { type: (s.isFile() ? 1 : 2) | (s.isSymbolicLink() ? 64 : 0), size: s.size }; }
};

describe('readWorkspaceSvgSource', () => {
  it('returns strict UTF-8 only when base and sha256 revision match', async () => {
    const temp = await fs.mkdtemp(join(tmpdir(), 'snl-svg-source-'));
    try {
      const root = join(temp, 'ws'); const dir = join(root, '.SNL_Doc', 'assets', 'diagrams');
      await fs.mkdir(dir, { recursive: true });
      const source = '<svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>';
      await fs.writeFile(join(dir, 'proof.svg'), source);
      const revision = `sha256:${createHash('sha256').update(source).digest('hex')}`;
      await expect(readWorkspaceSvgSource({ workspaceRoot: uri(root) as never, relativePath: 'diagrams/proof.svg', baseIdentity: SVG_ASSET_BASE_IDENTITY, revision, fsApi: nodeFs as never })).resolves.toBe(source);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });

  it.each([
    ['../secret.svg', SVG_ASSET_BASE_IDENTITY, 'sha256:x'],
    ['proof.svg', 'https://evil.invalid/', 'sha256:x'],
    ['proof.png', SVG_ASSET_BASE_IDENTITY, 'sha256:x']
  ])('rejects unsafe source identity %s', async (relativePath, baseIdentity, revision) => {
    await expect(readWorkspaceSvgSource({ workspaceRoot: uri('/missing') as never, relativePath, baseIdentity, revision, fsApi: nodeFs as never })).rejects.toThrow();
  });
});
