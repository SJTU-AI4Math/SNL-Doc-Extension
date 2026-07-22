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
});
