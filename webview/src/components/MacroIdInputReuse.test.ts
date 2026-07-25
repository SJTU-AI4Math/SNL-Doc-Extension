import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(__dirname, '../../..');

describe('shared Macro ID editor adoption', () => {
  it('routes Canvas editing/insertion, Inductive and Create Macro names through MacroIdInput', () => {
    const entry = fs.readFileSync(path.join(repo, 'webview/src/CreateEntryApp.tsx'), 'utf8');
    const macro = fs.readFileSync(path.join(repo, 'webview/src/CreateMacroApp.tsx'), 'utf8');
    expect(entry.match(/<MacroIdInput/g)).toHaveLength(3);
    expect(macro.match(/<MacroIdInput/g)).toHaveLength(2);
    expect(entry).toContain('macroIds={macroIds}');
    expect(macro).toContain('macroIds={macroIds}');
  });

  it('loads Create Macro autocomplete IDs from every active workspace package', () => {
    const host = fs.readFileSync(path.join(repo, 'src/createMacroPanel.ts'), 'utf8');
    expect(host).toContain('Object.keys(await readAllMacros(root)).sort()');
    expect(host).toContain('macroIds,');
  });
});
