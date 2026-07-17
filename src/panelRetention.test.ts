import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('webview panel retention policy', () => {
  it('does not retain every hidden KaTeX/graph/editor webview in memory', () => {
    const src = resolve(__dirname);
    const offenders = readdirSync(src)
      .filter((name) => name.endsWith('Panel.ts'))
      .filter((name) => readFileSync(resolve(src, name), 'utf8').includes('retainContextWhenHidden: true'));
    expect(offenders).toEqual([]);
  });
});
