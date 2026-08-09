import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('localized editor data-loss guards', () => {
  it('protects Entry drafts, including temporary Contributor, from watcher refresh', () => {
    const entry = source('webview/src/CreateEntryApp.tsx');
    expect(entry).toContain('formDirtyRef.current &&');
    expect(entry).toContain('contributor,');
    expect(entry).toContain("mode === 'edit' && !contributorDirtyRef.current");
    expect(entry).toContain('existingMetadataRef.current.contributionInfo');
    expect(entry).toContain(': contributor.trim() || null');
    expect(entry).toContain('contentDirtyRef.current.has(format)');
  });

  it('protects Macro drafts while localizing text Templates without language-selected Styles', () => {
    const macro = source('webview/src/CreateMacroApp.tsx');
    expect(macro).toContain('sameDirtyDraft');
    expect(macro).toContain('<LocalizedEditScope');
    expect(macro).toContain('useLocalizedBinding');
    expect(macro).toContain('localizedModeConfirm');
    expect(macro).not.toContain('defaultStyleByLanguage');
    expect(macro).not.toContain('template_i18n');
    expect(macro).not.toContain('merge_localized_projection');
  });
});
