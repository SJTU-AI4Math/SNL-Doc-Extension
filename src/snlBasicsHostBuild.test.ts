import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('SNL-Basics CommonJS host build placement', () => {
  it('keeps generated compatibility output under out instead of the source tree', () => {
    expect(existsSync(resolve(root, 'out/snl-basics-host.cjs'))).toBe(true);
    expect(existsSync(resolve(root, 'vendor/snl-basics-host.cjs'))).toBe(false);
  });

  it('loads compiled shared contracts without an ESM require, while preserving browser public imports', () => {
    for (const file of ['tableTemplateOptions', 'uiSpecVerifier']) {
      expect(readFileSync(resolve(root, 'src', file+'.ts'), 'utf8')).toContain('@sjtu-ai4math/snl-basics');
    }
    const output = execFileSync(process.execPath, ['-e', `
      const Module = require('node:module'); const original = Module._load;
      Module._load = function(name,...rest) {
        if (name.startsWith('@sjtu-ai4math/snl-basics')) throw new Error('ERR_REQUIRE_ESM: '+name);
        return original.call(this,name,...rest);
      };
      const table = require('./out/tableTemplateOptions.js');
      const spec = require('./out/uiSpecVerifier.js');
      if (typeof table.readTableTemplateOptions !== 'function' || typeof spec.verifyUiSpecWorkspace !== 'function') throw new Error('missing contract');
      table.readTableTemplateOptions({mode:'block'}, 'probe');
      console.log('host contracts passed');
    `], { cwd: root, encoding: 'utf8' });
    expect(output).toContain('host contracts passed');
  });

  it('loads the generated bridge beside compiled host modules', () => {
    const source = readFileSync(resolve(root, 'src/snlBasicsHostCompat.ts'), 'utf8');
    expect(source).toContain("require('../out/snl-basics-host.cjs')");
    expect(source).not.toContain("require('../vendor/");
  });
});
