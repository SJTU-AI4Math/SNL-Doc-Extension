import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ documents: [] as unknown[] }));
vi.mock('vscode', () => ({ workspace: { get textDocuments() { return mocks.documents; } } }));
import { resolveEntryPointer } from './pointer';
describe('Forward Pointer dirty-buffer parity', () => {
  it('resolves the open unsaved buffer rather than absent/old disk bytes', async () => {
    mocks.documents = [{ uri: { scheme: 'file', fsPath: '/ws/dirty.lean' }, version: 7, getText: () => 'inserted\nanchor\n' }];
    const result = await resolveEntryPointer({ fsPath: '/ws' } as never, { file: 'dirty.lean', mode: 'regex', pattern: 'anchor' });
    expect(result).toMatchObject({ status: 'ok', startLine: 2, endLine: 2 });
  });
  it('rejects an async resolution made stale by another edit', async () => {
    const document = { uri: { scheme: 'file', fsPath: '/ws/dirty.lean' }, version: 7, getText: () => 'anchor\n' };
    mocks.documents = [document];
    const pending = resolveEntryPointer({ fsPath: '/ws' } as never, { file: 'dirty.lean', mode: 'regex', pattern: 'anchor' });
    document.version++;
    expect(await pending).toMatchObject({ status: 'source-changed' });
  });
});
