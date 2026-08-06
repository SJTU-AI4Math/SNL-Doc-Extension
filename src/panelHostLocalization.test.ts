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
      description: '提供章/节/小节层级结构，以及 12 种 Fulcrum-Notes-Typst 内容类型（定义/公理/引理/定理/推论/性质/备注/例子/反例/构造/证明/问题）。每种类型都会设置 defaultCounterName（其英文名称的 slug）。',
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
    expect(source).toContain("title: t('saveDialogTitle')");
    expect(source).toContain("title: t('folderDialogTitle')");
    expect(source).toContain("openLabel: t('exportHere')");
  });

  it('keeps Chinese preset descriptions semantically complete', () => {
    const source = fs.readFileSync(path.join(__dirname, 'initKindsPanelController.ts'), 'utf8');
    expect(source).toContain('12 种 Fulcrum-Notes-Typst 内容类型');
    expect(source).toContain('defaultCounterName');
    expect(source).toContain('rule / const / bvar / binder / fvar');
    expect(source).toContain('不应触发悬停反馈');
  });
});
