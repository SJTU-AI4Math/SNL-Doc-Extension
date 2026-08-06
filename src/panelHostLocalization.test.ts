import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
vi.mock('./snlDoc', () => ({
  ENTRY_KIND_PRESETS: [], MACRO_KIND_PRESETS: []
}));
vi.mock('./panelUtil', () => ({}));

import { projectKindPresets } from './initKindsPanelController';

const scoped = [
  'infoviewPanel.ts',
  'createEntryPanel.ts',
  'createMacroPanel.ts',
  'createMacroPackagePanel.ts',
  'createRelationshipPanel.ts',
  'kindPanelController.ts',
  'graphPanel.ts',
  'initKindsPanelController.ts',
  'snooglPanel.ts'
];

describe('panel-controller host localization', () => {
  it('routes every scoped controller through the host runtime and effective locale', () => {
    for (const file of scoped) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(source, file).toContain('createHostTranslator');
      expect(source, file).toContain('read_extension_preferences().language');
      expect(source, file).toContain('defineHostMessages');
    }
  });

  it('projects built-in preset copy in Chinese by stable id without mutating stored presets', () => {
    const source = [{
      id: 'fulcrum-math-notes',
      label: "Fulcrum's Math Notes",
      description: 'A broad mathematical writing set.',
      kinds: [{ id: 'definition' }]
    }];
    const projected = projectKindPresets('entry', 'zh-CN', source);

    expect(projected).toEqual([{
      id: 'fulcrum-math-notes',
      label: 'Fulcrum 数学笔记',
      description: '章节层级结构以及 Fulcrum 数学内容类型。',
      count: 1
    }]);
    expect(source[0].label).toBe("Fulcrum's Math Notes");
    expect(source[0].description).toBe('A broad mathematical writing set.');
  });

  it('keeps unknown preset ids as dynamic authored data', () => {
    const projected = projectKindPresets('macro', 'zh-CN', [{
      id: 'custom', label: 'Team preset', description: 'Team-owned copy', kinds: []
    }]);
    expect(projected[0]).toMatchObject({
      id: 'custom', label: 'Team preset', description: 'Team-owned copy', count: 0
    });
  });

  it('compares modal confirmation against the exact action label originally displayed', () => {
    const infoview = fs.readFileSync(path.join(__dirname, 'infoviewPanel.ts'), 'utf8');
    expect(infoview).toContain("const deleteAction = hostText()('delete')");
    expect(infoview).toContain('confirmed !== deleteAction');

    const library = fs.readFileSync(path.join(__dirname, 'createLibraryPanel.ts'), 'utf8');
    expect(library).toContain("const removeAction = libraryT()('outlineRemoveAction')");
    expect(library).toContain('confirmed !== removeAction');
  });

  it('refreshes the export locale and context when the live interface locale changes', () => {
    const source = fs.readFileSync(path.join(__dirname, 'exportOptionsPanel.ts'), 'utf8');
    expect(source).toContain('bind_preferences_panel_locale_change(panel');
    expect(source).toContain('instance.payload = { ...instance.payload, locale }');
    expect(source).toContain('void instance.pushContext()');
    expect(source).not.toContain("'exportOptions',\n      'SNL Export HTML'");
  });
});
