import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('production Extension compile boundary', () => {
  it('does not compile or package host test scripts', () => {
    const tsconfig = JSON.parse(readFileSync(resolve(root, 'tsconfig.json'), 'utf8')) as {
      exclude?: string[];
    };
    expect(tsconfig.exclude).toContain('src/**/*.test.ts');
    expect(tsconfig.exclude).toContain('src/**/*.spec.ts');

    const vscodeIgnore = readFileSync(resolve(root, '.vscodeignore'), 'utf8');
    expect(vscodeIgnore).toContain('out/**/*.test.js');
    expect(vscodeIgnore).toContain('out/**/*.spec.js');

    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.compile).toContain('clean-out.mjs');
  });
});
