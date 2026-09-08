import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import * as reader from './sharedReaderSnapshot';
import type { EntryData, MacroPackageEntry, RelationshipData } from './snlDoc';
import type { FrozenOutlineNode, FrozenReaderSnapshot } from './sharedReaderSnapshot';

const entry = (id: string, snl = ''): EntryData => ({ id, kind: 'entry', title: id, content: { snl }, pointer: null });
const outline = (e: EntryData, children: FrozenOutlineNode[] = []): FrozenOutlineNode[] => [{
  nodeId: e.id, entry: e, kind: null, counterLabel: null, children,
}];
const macro = (name: string, entries: string[] = [], description = ''): MacroPackageEntry => ({
  name, source: { entries, urls: [] }, description, kind: 'const', dynamic_arity: false, styles: [], tags: [],
});
const snapshot = (e = entry('Root')): FrozenReaderSnapshot => ({
  version: 1, renderSnapshotId: 'capture', library: { slug: 'lib', title: 'Library', outline: outline(e), warnings: [] },
  entries: [e], entryKinds: [], entryPackages: {}, macros: {}, macroKinds: [], relationships: [],
  preferences: { language: 'en', color_scheme: 'light', motion: 'full' }, contentLanguage: 'en', languages: [], resources: {},
});

describe('reader dependency closure', () => {
  it('matches parsed explicit context IDs, not prefixes', () => {
    const root = entry('Root', 'x@A.long');
    expect(reader.readerEntryClosure(outline(root), [root, entry('A'), entry('A.long')], {}).map(e => e.id))
      .toEqual(['Root', 'A.long']);
  });

  it('matches parsed macro identifiers, not substrings or literal payloads', () => {
    const root = entry('Root', 'VisibleMacro(%M%, $M$)');
    const macros = { M: macro('M', ['Private']), VisibleMacro: macro('VisibleMacro', ['Public']) };
    expect(reader.readerEntryClosure(outline(root), [root, entry('Private'), entry('Public')], macros).map(e => e.id))
      .toEqual(['Root', 'Public']);
  });
});

describe('fixed point and export security', () => {
  it('includes relation neighbors, their explicit contexts and macro sources, terminating cycles', () => {
    const root = entry('Root', 'Used()');
    root.content.markdown = '![public](public.png)';
    const entries = [root, entry('Source', 'Next()'), entry('Neighbor', 'x@Context.long'),
      entry('Context'), entry('Context.long', 'Used()'), entry('Private')];
    const macros = { Used: macro('Used', ['Source']), Next: macro('Next', ['Root']),
      Unused: macro('Unused', ['Private'], '![private](private.png)') };
    const relationships: RelationshipData[] = [
      { id: 'r1', from: 'Source', to: 'Neighbor', label: 'related', metadata: { custom: 1 } },
      { id: 'r2', from: 'Neighbor', to: 'Root', label: 'uses', metadata: null },
      { id: 'r3', from: 'Private', to: 'Private', label: 'unrelated', metadata: null },
    ];
    const before = JSON.stringify({ entries, macros, relationships });
    const result = reader.readerDependencyClosure(outline(root), entries, macros, relationships);
    expect(result.entries.map(e => e.id)).toEqual(['Root', 'Source', 'Neighbor', 'Context.long']);
    expect(Object.keys(result.macros)).toEqual(['Used', 'Next']);
    expect(result.relationships).toEqual(relationships.slice(0, 2));
    const assetReader = vi.fn();
    reader.readerAssetPaths(result).forEach(assetReader);
    expect(assetReader).toHaveBeenCalledTimes(1);
    expect(assetReader.mock.calls[0][0]).toBe('public.png');
    expect(JSON.stringify(result)).not.toContain('private.png');
    expect(JSON.stringify({ entries, macros, relationships })).toBe(before);
    expect(reader.readerDependencyClosure([], entries, macros, relationships)).toEqual({ entries: [], macros: {}, relationships: [] });
  });

  it('round-trips nested own special keys without script execution or prototype changes', () => {
    const input = snapshot();
    input.resources = JSON.parse('{"__proto__":{"url":"safe","revision":"r","constructor":{"prototype":{"__proto__":7}}}}');
    input.library.title = '</sCrIpT><script>window.attacked=true</script><!--\u2028\u2029';
    const script = reader.frozenReaderScript(input);
    expect(script).not.toMatch(/<|\u2028|\u2029/);
    const context = { window: {} as { __SNL_READER__: FrozenReaderSnapshot; attacked?: boolean } };
    runInNewContext(script, context);
    const output = context.window.__SNL_READER__;
    expect(JSON.stringify(output)).toBe(JSON.stringify(input));
    expect(Object.hasOwn(output.resources, '__proto__')).toBe(true);
    expect(Object.hasOwn(Object.getPrototypeOf(output.resources), 'url')).toBe(false);
    expect(context.window.attacked).toBeUndefined();
  });

  it('clones and strips every Entry pointer in entries and recursive outline for any export mode', () => {
    const root = entry('Root'); root.pointer = { file: '/private/sentinel.lean', pattern: 'secret' };
    const input = snapshot(root);
    const child = entry('OnlyInOutline'); child.pointer = { file: '/private/child.lean' };
    input.library.outline[0].children = [{ ...outline(child)[0], children: outline(root) }];
    root.contribution_info = JSON.parse('{"__proto__":{"constructor":{"prototype":"authored"}}}');
    const before = JSON.stringify(input);
    const output = reader.projectSnapshotForExport(input);
    expect(output).not.toBe(input);
    expect(JSON.stringify(output)).not.toContain('/private/');
    expect(output.entries[0].pointer).toBeNull();
    expect(output.library.outline[0].children[0].entry?.pointer).toBeNull();
    expect(output.library.outline[0].children[0].children[0].entry?.pointer).toBeNull();
    expect(JSON.stringify(output.entries[0].contribution_info)).toBe(JSON.stringify(root.contribution_info));
    output.entries[0].content.snl = 'Changed';
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('reader assets', () => {
  it('normalizes the same workspace-relative spellings as the shared Markdown renderer', () => {
    for (const spelling of ['./assets/figure.svg', '.SNL_Doc/assets/figure.svg', 'assets/figure.svg', 'figure.svg']) {
      expect(reader.readerAssetPaths(`![a](${spelling})`)).toEqual(['figure.svg']);
    }
  });
  it('finds supported SVG assets and validated image presets, rejecting traversal and schemes', () => {
    expect(reader.readerAssetPaths({ styles: [
      { template: { svg_template: { asset: { source: 'diagrams/one.svg' } } } },
      { template: { block_template_name: 'snl-ext-preset:v1:image?src=figures%2Fplot%20one.png&layout=inline&alt=Plot' } },
      { template: { block_template_name: 'snl-ext-preset:v1:image?src=..%2Fsecret.png&layout=block' } },
    ], markdown: '![x](https://example.test/x.png) ![x](//example.test/x.png) ![x](../secret.png) ![x](assets/%2e%2e/private.png) ![x](assets/%252e%252e/private.png) ![x](data:image/png;base64,AA) ![x](assets/a%00.png)',
    })).toEqual(['diagrams/one.svg', 'figures/plot one.png']);
  });
  it('parses CommonMark angle-space image destinations', () => {
    expect(reader.readerAssetPaths({ markdown: '![figure](<figures/a b.svg>)' })).toEqual(['figures/a b.svg']);
  });
  it('resolves reference images with normalized identifiers and first definitions', () => {
    expect(reader.readerAssetPaths({ markdown: '![figure][CHART]\n\n[chart]: figures/chart.svg\n[chart]: private.svg' }))
      .toEqual(['figures/chart.svg']);
  });
  it('collects all localized images, not code, unused definitions or arbitrary src queries', () => {
    expect(reader.readerAssetPaths({ markdown: { type: 'i18n', default_language: 'en', values: {
      en: '![a](a.svg)\n\n`![hidden](hidden.svg)`\n\n[unused]: private.svg\n\nhttps://x.test/?src=private.png',
      'zh-CN': '![b](b.svg)',
    } } })).toEqual(['a.svg', 'b.svg']);
  });
});
