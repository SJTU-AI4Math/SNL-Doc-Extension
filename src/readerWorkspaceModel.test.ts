import { describe, expect, it, vi } from 'vitest';
// Use the real public ESM parser/Markdown implementation at the host bridge seam.
vi.mock('./snlBasicsHostCompat', async () => ({
  ...(await import('@sjtu-ai4math/snl-basics/core')),
  ...(await import('mdast-util-from-markdown')),
}));
import { buildWorkspaceReaderSnapshot, readerAssetPaths, type WorkspaceReaderInput } from './readerWorkspaceModel';
import { readerDependencyClosure } from './sharedReaderSnapshot';
import type { EntryData, MacroPackageEntry } from './snlDoc';

const entry = (id: string): EntryData => ({ id, package: 'Pkg', kind: 'entry', title: id, content: { markdown: `![${id}](${id}.png)` }, pointer: null });
const macro = (name: string): MacroPackageEntry => ({ name, source: { entries: [], urls: [] }, description: '', kind: 'const', dynamic_arity: false, styles: [], tags: [] });
const input = (): WorkspaceReaderInput => ({
  config: { version: '0.1.0', supported_languages: [{ id: 'zh', display_name: '中文' }, { id: 'en', display_name: 'English' }] },
  entries: [entry('Root'), entry('Child'), entry('Unrelated'), entry('__proto__')],
  entryKinds: [{ id: 'entry', name: 'Entry', defaultCounterName: 'entry', style: '', coloring: { light: { stroke: '', background: '' }, dark: { stroke: '', background: '' } } }],
  macros: { Unused: macro('Unused') }, macroKinds: [],
  relationships: [{ id: 'unrelated', from: 'Unrelated', to: '__proto__', label: 'uses', metadata: null }],
  library: { slug: 'book', metadata: { title: 'Book', description: 'Description' },
    counters: [{ id: 'e', name: 'entry', numbering: '1', children: [] }],
    graph: { nodes: [
      { id: 'root', label: 'Entry', props: { entryId: 'Root' } },
      { id: 'child', label: 'Entry', props: { entryId: 'Child' } },
    ], relationships: [{ from: 'root', to: 'child', label: 'branch' }] } },
});

describe('workspace Reader snapshot', () => {
  it('keeps the whole searchable workspace while numbering only the selected Library', () => {
    const source = input();
    const snapshot = buildWorkspaceReaderSnapshot(source);
    expect(snapshot.version).toBe(1);
    expect(snapshot.library.title).toBe('Book');
    expect(snapshot.library.outline.map(node => node.entry?.id)).toEqual(['Root']);
    expect(snapshot.library.outline[0].counterLabel).toBe('1');
    expect(snapshot.library.outline[0].children[0].entry?.id).toBe('Child');
    expect(snapshot.entries.map(e => e.id)).toEqual(['Root', 'Child', 'Unrelated', '__proto__']);
    expect(Object.keys(snapshot.macros)).toEqual(['Unused']);
    expect(snapshot.relationships).toEqual(source.relationships);
    expect(Object.hasOwn(snapshot.entryPackages, '__proto__')).toBe(true);
    expect(snapshot.entryPackages.__proto__).toBe('Pkg');
    expect(readerAssetPaths(snapshot)).toEqual(['Child.png', 'Root.png', 'Unrelated.png', '__proto__.png']);
    expect(readerDependencyClosure(snapshot.library.outline, snapshot.entries, snapshot.macros, snapshot.relationships).entries.map(e => e.id)).toEqual(['Root', 'Child']);
    snapshot.entries[0].title = 'changed';
    expect(source.entries[0].title).toBe('Root');
  });

  it('retains repeated branches and placeholders, terminates cycles, and warns on dangling counters', () => {
    const source = input();
    source.library.graph.nodes.push(
      { id: 'second', label: 'Entry', props: { entryId: 'Unrelated' } },
      { id: 'missing', label: 'Entry', props: { entryId: 'Missing', counterId: 'absent' } },
    );
    source.library.graph.relationships.push(
      { from: 'second', to: 'child', label: 'branch' },
      { from: 'child', to: 'missing', label: 'branch' },
      { from: 'missing', to: 'child', label: 'branch' },
    );
    const snapshot = buildWorkspaceReaderSnapshot(source);
    expect(snapshot.library.outline.map(node => node.nodeId)).toEqual(['root', 'second']);
    expect(snapshot.library.outline[0].children[0].nodeId).toBe('child');
    expect(snapshot.library.outline[1].children[0].nodeId).toBe('child');
    expect(snapshot.library.outline[0].children[0].children[0].entry).toBeNull();
    expect(snapshot.library.warnings.some(w => w.includes('Missing'))).toBe(true);
    expect(snapshot.library.warnings.some(w => w.includes('absent'))).toBe(true);
  });

  it('derives deterministic revisions and localized preferences without mutating raw input', () => {
    const source = input();
    source.config = { supported_languages: [{ id: 'de', display_name: 'Deutsch' }] };
    source.contentLanguage = 'de';
    source.preferences = { language: 'zh', color_scheme: 'dark' };
    const before = JSON.stringify(source);
    const first = buildWorkspaceReaderSnapshot(source);
    expect(buildWorkspaceReaderSnapshot(source).renderSnapshotId).toBe(first.renderSnapshotId);
    expect(first.contentLanguage).toBe('de');
    expect(first.preferences).toMatchObject({ language: 'zh', color_scheme: 'dark' });
    expect(first.languages).toContainEqual({ id: 'de', display_name: 'Deutsch' });
    expect(JSON.stringify(source)).toBe(before);
    source.entries[2].title = 'new searchable title';
    expect(buildWorkspaceReaderSnapshot(source).renderSnapshotId).not.toBe(first.renderSnapshotId);
  });
});
