import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadKindPresetPackages } from './kindPresets';
import { is_valid_i18n_string } from './localizedContent';

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

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
    version: 3,
    domain: 'entry',
    id: 'example-entry',
    copyKeys: { label: 'leanLabel', description: 'leanDescription' },
    kinds: [{
      id: 'module', name: 'Module',
      coloring: {
        light: { stroke: '#123456', background: '#abcdef' },
        dark: { stroke: '#fedcba', background: '#654321' }
      },
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

  it('preserves localized Entry Kind names and descriptions from Init presets', () => {
    const root = fixtureRoot();
    const name = {
      type: 'i18n', default_language: 'en',
      values: { en: 'Module', 'zh-CN': '模块' }
    };
    const description = {
      type: 'i18n', default_language: 'en',
      values: { en: 'Groups declarations.', 'zh-CN': '组织声明。' }
    };
    writePackage(root, 'entry', 'localized.json', entryPackage({ kinds: [{
      id: 'module', name, description,
      coloring: {
        light: { stroke: '#123456', background: '#abcdef' },
        dark: { stroke: '#fedcba', background: '#654321' }
      },
      defaultCounterName: 'module', style: 'section'
    }] }));

    const kind = loadKindPresetPackages(root, 'entry')[0].kinds[0];
    expect(kind.name).toEqual(name);
    expect(kind.description).toEqual(description);
    expect(kind.coloring.dark).toEqual({ stroke: '#fedcba', background: '#654321' });
  });

  it.each([
    ['malformed JSON', '{'],
    ['unsupported schema', entryPackage({ schema: 'other' })],
    ['unsupported version', entryPackage({ version: 1 })],
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
      'property', 'remark', 'example', 'counterexample', 'construction', 'proof', 'problem', 'context', 'ctor'
    ]);
    expect(macros.map((preset) => preset.id)).toEqual(['snl-basics-defaults']);
    expect(macros[0].kinds.map((kind) => kind.id)).toEqual(['rule', 'const', 'bvar', 'binder', 'fvar', 'sub']);
    for (const kind of [...entries.flatMap((preset) => preset.kinds), ...macros.flatMap((preset) => preset.kinds)]) {
      expect(kind.coloring.light).toEqual(expect.objectContaining({ stroke: expect.any(String), background: expect.any(String) }));
      expect(kind.coloring.dark).toEqual(expect.objectContaining({ stroke: expect.any(String), background: expect.any(String) }));
      for (const scheme of ['light', 'dark'] as const) {
        const coloring = kind.coloring[scheme];
        if (coloring.stroke.startsWith('#') && coloring.background.startsWith('#')) {
          expect(
            contrastRatio(coloring.stroke, coloring.background),
            `${kind.id} ${scheme} palette`
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      if (kind.id !== 'sub') expect(kind.coloring.dark).not.toEqual(kind.coloring.light);
    }
  });

  it('locks the Fulcrum recommended dark semantic palette', () => {
    const fulcrum = loadKindPresetPackages(resources, 'entry')
      .find((preset) => preset.id === 'fulcrum-math-notes')!;
    const expected: Record<string, string> = {
      chapter: '#E5E7EB', section: '#CBD5E1', subsection: '#94A3B8', definition: '#4ADE80',
      axiom: '#FACC15', theorem: '#60A5FA', lemma: '#93C5FD', corollary: '#7DD3FC',
      property: '#E879F9', remark: '#FB923C', example: '#C084FC', counterexample: '#FB7185',
      construction: '#A3A3A3', proof: '#D1D5DB', problem: '#38BDF8', context: '#A78BFA', ctor: '#A3E635'
    };
    expect(Object.fromEntries(fulcrum.kinds.map((kind) => [kind.id, kind.coloring.dark.stroke]))).toEqual(expected);
    for (const kind of fulcrum.kinds) {
      expect(kind.coloring.dark.background, kind.id).toBe('#313131');
      expect(contrastRatio(kind.coloring.dark.stroke, kind.coloring.dark.background), kind.id).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('initializes every shipped Entry Kind with I18n name, I18n description, and dark colors', () => {
    const entries = loadKindPresetPackages(resources, 'entry');
    for (const kind of entries.flatMap((preset) => preset.kinds)) {
      expect(is_valid_i18n_string(kind.name), `${kind.id} name`).toBe(true);
      expect(is_valid_i18n_string(kind.description), `${kind.id} description`).toBe(true);
      expect(kind.name).toMatchObject({ values: { en: expect.any(String), 'zh-CN': expect.any(String) } });
      expect(kind.description).toMatchObject({ values: { en: expect.any(String), 'zh-CN': expect.any(String) } });
      expect(kind.coloring.dark).toEqual(expect.objectContaining({ stroke: expect.any(String), background: expect.any(String) }));
      expect(kind.coloring.dark).not.toEqual(kind.coloring.light);
    }
  });

  it('includes Variable in the Lean 4 default Entry Kind preset', () => {
    const lean = loadKindPresetPackages(resources, 'entry')
      .find((preset) => preset.id === 'lean4-document')!;

    expect(lean.kinds.find((kind) => kind.id === 'variable')).toMatchObject({
      name: { values: { en: 'Variable', 'zh-CN': '变量' } },
      description: { values: { en: 'Declares or documents a variable.', 'zh-CN': '声明或说明一个变量。' } },
      coloring: {
        light: { stroke: '#4B5563', background: '#F3F4F6' },
        dark: { stroke: '#9CA3AF', background: '#313131' }
      },
      defaultCounterName: 'variable',
      style: ''
    });
  });

  it('uses one neutral background for every visible shipped dark Kind while retaining semantic strokes', () => {
    const entries = loadKindPresetPackages(resources, 'entry');
    const macros = loadKindPresetPackages(resources, 'macro');
    const kinds = [...entries, ...macros].flatMap((preset) =>
      preset.kinds.map((kind) => ({ identity: `${preset.id}/${kind.id}`, kind }))
    );
    const transparentKindIdentities = kinds
      .filter(({ kind }) => kind.coloring.dark.background === 'transparent')
      .map(({ identity }) => identity);

    expect(transparentKindIdentities).toEqual(['snl-basics-defaults/sub']);
    for (const { identity, kind } of kinds) {
      if (identity !== 'snl-basics-defaults/sub') {
        expect(kind.coloring.dark.background, identity).toBe('#313131');
      }
    }
    expect(new Set(kinds.map(({ kind }) => kind.coloring.dark.stroke)).size).toBeGreaterThan(1);
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
