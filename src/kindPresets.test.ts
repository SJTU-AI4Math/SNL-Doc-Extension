import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadKindPresetPackages } from './kindPresets';

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'snl-kind-presets-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, 'entry'), { recursive: true });
  mkdirSync(join(root, 'macro'), { recursive: true });
  return root;
}

function entryPackage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'snl-doc.kind-preset',
    version: 1,
    domain: 'entry',
    id: 'example-entry',
    copyKeys: { label: 'leanLabel', description: 'leanDescription' },
    kinds: [{
      id: 'module', name: 'Module',
      coloring: { stroke: '#123456', background: '#abcdef' },
      defaultCounterName: 'module', style: 'section'
    }],
    ...overrides
  };
}

function writePackage(root: string, domain: 'entry' | 'macro', name: string, value: unknown): void {
  writeFileSync(join(root, domain, name), JSON.stringify(value));
}

describe('loadKindPresetPackages', () => {
  it('loads validated JSON files in deterministic preset-id order', () => {
    const root = fixtureRoot();
    writePackage(root, 'entry', 'z.json', entryPackage({ id: 'z-preset' }));
    writePackage(root, 'entry', 'a.json', entryPackage({ id: 'a-preset' }));

    const presets = loadKindPresetPackages(root, 'entry');

    expect(presets.map((preset) => preset.id)).toEqual(['a-preset', 'z-preset']);
    expect(presets[0].kinds[0]).toMatchObject({ id: 'module', defaultCounterName: 'module' });
  });

  it.each([
    ['malformed JSON', '{'],
    ['unsupported schema', entryPackage({ schema: 'other' })],
    ['unsupported version', entryPackage({ version: 2 })],
    ['wrong domain', entryPackage({ domain: 'macro' })],
    ['empty kinds', entryPackage({ kinds: [] })],
    ['placeholder copy', entryPackage({ copyKeys: { label: 'placeholder', description: 'todo' } })],
    ['unknown copy keys', entryPackage({ copyKeys: { label: 'unknownLabel', description: 'unknownDescription' } })],
    ['duplicate kind ids', entryPackage({ kinds: [
      (entryPackage().kinds as unknown[])[0],
      (entryPackage().kinds as unknown[])[0]
    ] })]
  ])('fails closed on %s', (_name, value) => {
    const root = fixtureRoot();
    const path = join(root, 'entry', 'bad.json');
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    expect(() => loadKindPresetPackages(root, 'entry')).toThrow(/bad\.json/);
  });

  it('fails closed on duplicate preset ids across files', () => {
    const root = fixtureRoot();
    writePackage(root, 'entry', 'one.json', entryPackage());
    writePackage(root, 'entry', 'two.json', entryPackage());
    expect(() => loadKindPresetPackages(root, 'entry')).toThrow(/duplicate preset id/i);
  });
});

describe('shipped Kind preset packages', () => {
  const resources = resolve(__dirname, '..', 'resources', 'kind-presets');

  it('ships complete, non-placeholder entry catalogs for Lean 4, TypeScript, and Python', () => {
    const presets = loadKindPresetPackages(resources, 'entry');
    const expected = ['fulcrum-math-notes', 'lean4-document', 'python-document', 'typescript-document'];
    expect(presets.map((preset) => preset.id)).toEqual(expected);
    for (const id of ['lean4-document', 'typescript-document', 'python-document']) {
      const preset = presets.find((candidate) => candidate.id === id)!;
      expect(preset.kinds.length).toBeGreaterThanOrEqual(8);
      expect(JSON.stringify(preset)).not.toMatch(/placeholder|todo|tbd/i);
    }
  });

  it('retains the Fulcrum and SNL-Basics catalogs without invented language macro presets', () => {
    const entries = loadKindPresetPackages(resources, 'entry');
    const macros = loadKindPresetPackages(resources, 'macro');
    expect(entries.find((preset) => preset.id === 'fulcrum-math-notes')?.kinds.map((kind) => kind.id)).toEqual([
      'chapter', 'section', 'subsection', 'definition', 'axiom', 'lemma', 'theorem', 'corollary',
      'property', 'remark', 'example', 'counterexample', 'construction', 'proof', 'problem', 'context'
    ]);
    expect(macros.map((preset) => preset.id)).toEqual(['snl-basics-defaults']);
    expect(macros[0].kinds.map((kind) => kind.id)).toEqual(['rule', 'const', 'bvar', 'binder', 'fvar', 'sub']);
  });

  it('is included by VS Code extension packaging rules', () => {
    const vscodeIgnore = readFileSync(resolve(__dirname, '..', '.vscodeignore'), 'utf8');
    expect(vscodeIgnore).not.toMatch(/^resources\/kind-presets/m);
    expect(vscodeIgnore).not.toMatch(/^resources\/\*\*/m);
  });

  it('is loaded by the host instead of duplicated as in-code payloads', () => {
    const source = readFileSync(resolve(__dirname, 'snlDoc.ts'), 'utf8');
    expect(source).toContain('loadKindPresetPackages');
    expect(source).not.toMatch(/export const ENTRY_KIND_PRESETS[^=]*=\s*\[/);
    expect(source).not.toMatch(/export const MACRO_KIND_PRESETS[^=]*=\s*\[/);
  });
});
