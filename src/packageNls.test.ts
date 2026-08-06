import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const en = JSON.parse(readFileSync(resolve(root, 'package.nls.json'), 'utf8')) as Record<string, string>;
const zh = JSON.parse(readFileSync(resolve(root, 'package.nls.zh-cn.json'), 'utf8')) as Record<string, string>;
const manifest = readFileSync(resolve(root, 'package.json'), 'utf8');

describe('package localization catalogs', () => {
  it('keeps en and zh-CN keys identical', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it('defines every package manifest localization token', () => {
    const tokens = [...manifest.matchAll(/%([^%]+)%/g)].map((match) => match[1]);
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) expect(en[token], token).toBeTypeOf('string');
  });

  it('routes every contributed configuration description through package NLS', () => {
    const pkg = JSON.parse(manifest) as {
      contributes?: { configuration?: { properties?: Record<string, { description?: string }> } };
    };
    const properties = pkg.contributes?.configuration?.properties ?? {};
    for (const [name, setting] of Object.entries(properties)) {
      expect(setting.description, name).toMatch(/^%[^%]+%$/);
    }
  });

  it('declares formatter settings with SNL-Basics defaults and bounds', () => {
    const pkg = JSON.parse(manifest) as {
      contributes: { configuration: { properties: Record<string, Record<string, unknown>> } };
    };
    expect(pkg.contributes.configuration.properties['snlDoc.editor.formatter.indentSpaces']).toMatchObject({
      type: 'integer', default: 4, minimum: 0, maximum: 256
    });
    expect(pkg.contributes.configuration.properties['snlDoc.editor.formatter.inlineParenthesisDepth']).toMatchObject({
      type: 'integer', default: 3, minimum: 0, maximum: Number.MAX_SAFE_INTEGER
    });
  });
});
