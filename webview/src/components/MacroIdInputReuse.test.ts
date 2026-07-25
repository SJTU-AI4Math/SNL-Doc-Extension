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
    expect(entry).toContain('macroCandidates={macroCandidates}');
    expect(macro).toContain('macroCandidates={macroCandidates}');
  });

  it('loads Create Macro search candidates with tags from every active workspace package', () => {
    const host = fs.readFileSync(path.join(repo, 'src/createMacroPanel.ts'), 'utf8');
    // The macros are now fetched alongside the other panel reads (one
    // concurrent batch instead of serial awaits), then mapped.
    expect(host).toContain('readAllMacros(root)');
    expect(host).toContain('Object.entries(allMacros)');
    expect(host).toContain('labels: macro.tags');
    expect(host).toContain('macroCandidates,');
  });
});
