import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('localized editor data-loss guards', () => {
  it('protects Entry drafts from watcher refresh and preserves deferred metadata', () => {
    const entry = source('webview/src/CreateEntryApp.tsx');
    expect(entry).toContain('formDirtyRef.current &&');
    expect(entry).toContain('existingMetadataRef.current.contribution_info');
    expect(entry).toContain('contentDirtyRef.current.has(format)');
  });

  it('protects Macro drafts and confirms destructive mode conversion', () => {
    const macro = source('webview/src/CreateMacroApp.tsx');
    expect(macro).toContain('sameDirtyDraft');
    expect(macro).toContain('window.confirm');
    expect(macro).toContain('template_dirty');
  });
});
