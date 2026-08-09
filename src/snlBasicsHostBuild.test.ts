import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('SNL-Basics CommonJS host build placement', () => {
  it('keeps generated compatibility output under out instead of the source tree', () => {
    expect(existsSync(resolve(root, 'out/snl-basics-host.cjs'))).toBe(true);
    expect(existsSync(resolve(root, 'vendor/snl-basics-host.cjs'))).toBe(false);
  });

  it('loads the generated bridge beside compiled host modules', () => {
    const source = readFileSync(resolve(root, 'src/snlBasicsHostCompat.ts'), 'utf8');
    expect(source).toContain("require('../out/snl-basics-host.cjs')");
    expect(source).not.toContain("require('../vendor/");
  });
});
