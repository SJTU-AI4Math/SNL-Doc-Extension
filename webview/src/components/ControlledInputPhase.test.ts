import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const editorSources = [
  ['CreateEntryApp.tsx', 3],
  ['CreateMacroApp.tsx', 4]
] as const;

describe('controlled editor input event ordering', () => {
  it.each(editorSources)('%s marks dirty after target input handlers', (file) => {
    const source = readFileSync(`webview/src/${file}`, 'utf8');
    expect(source).not.toContain('onInputCapture=');
    expect(source).toMatch(/<main[\s\S]*?onInput=/);
  });

  it.each(editorSources)('%s commits every native select during input before change fallback', (file, expected) => {
    const source = readFileSync(`webview/src/${file}`, 'utf8');
    const selectBlocks = source.match(/<select\b[\s\S]*?<\/select>/g) ?? [];
    expect(selectBlocks).toHaveLength(expected);
    for (const block of selectBlocks) {
      expect(block).toContain('onInput=');
      expect(block).toContain('onChange=');
    }
  });
});
