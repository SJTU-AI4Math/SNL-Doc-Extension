import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSnlSyntaxTree } from '@sjtu-ai4math/snl-basics/core';

const ROOT = resolve(__dirname, '..', 'test-fixtures', 'svg-entry-integration', '.SNL_Doc');
const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));

describe('real SVG Entry integration workspace', () => {
  it('binds the persisted projection to the exact local SVG bytes and valid SNL', () => {
    const macroFiles = readdirSync(resolve(ROOT, 'macros')).filter((name) => name.endsWith('.json'));
    const macros = macroFiles.map((name) => readJson(`macros/${name}`) as {
      macro: { name: string; styles: Array<{ template: unknown }> };
    });
    const diagram = macros.find((record) => record.macro.name === 'diagram')!;
    const localized = diagram.macro.styles[0].template as {
      values: { en: { svg_template: { asset: { source: string; base_identity: string; revision: string } } } };
    };
    const asset = localized.values.en.svg_template.asset;
    const bytes = readFileSync(resolve(ROOT, 'assets', asset.source));
    expect(asset.base_identity).toBe('workspace:.SNL_Doc/assets');
    expect(asset.revision).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(bytes.toString('utf8').match(/data-snl-slot=/g)).toHaveLength(4);

    const entries = readdirSync(resolve(ROOT, 'entries')).map((name) =>
      readJson(`entries/${name}`) as { entry: { content: { snl: string } } });
    for (const record of entries) expect(() => parseSnlSyntaxTree(record.entry.content.snl)).not.toThrow();
    expect(entries.some((record) => record.entry.content.snl.includes('wrap(diagram('))).toBe(true);
  });

  it('is a self-contained active package and two-node Library fixture', () => {
    const config = readJson('config.json') as { active_macro_packages: string[] };
    const pkg = readJson('packages/svg-fixture-package.json') as { id: string; entry_ids: string[] };
    const graph = readJson('libraries/svg-entry/graph.json') as { nodes: Array<{ props: { entryId: string } }> };
    expect(config.active_macro_packages).toContain('svg-fixture');
    expect(pkg).toMatchObject({ id: 'svg-fixture', entry_ids: ['svg-primary', 'svg-reference'] });
    expect(graph.nodes.map((node) => node.props.entryId)).toEqual(['svg-primary', 'svg-reference']);
  });
});
