import { expect, it, vi } from 'vitest';
import { cacheRootForWorkspace } from './cacheRoot';
it('uses fsPath only for file roots and narrow legacy doubles', () => {
  const toString = vi.fn(() => 'ignored');
  expect(cacheRootForWorkspace({ scheme: 'file', fsPath: '/local', toString })).toBe('/local');
  expect(cacheRootForWorkspace({ fsPath: '/legacy', toString })).toBe('/legacy');
  expect(toString).not.toHaveBeenCalled();
});
it('retains the full unencoded URI identity for every explicit non-file scheme', () => {
  for (const scheme of ['memfs', 'vscode-remote', '']) {
    const uri = `${scheme}://owner/path with space?query=value#fragment`;
    const toString = vi.fn(() => uri);
    expect(cacheRootForWorkspace({ scheme, fsPath: '/path with space', toString })).toEqual({ uri });
    expect(toString).toHaveBeenCalledWith(true);
  }
});
