import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  window: { activeColorTheme: { kind: 2 } },
  workspace: { getConfiguration: () => ({ get: () => 'auto' }) }
}));

import { createLibraryHostTranslator } from './createLibraryPanel';
import { createDashboardHostTranslator } from './dashboardPanel';
import { createPackageHostTranslator } from './packagePanel';
import { createEntryPackageEditorHostTranslator } from './createEntryPackagePanel';

describe('Library, Dashboard, and Package host localization', () => {
  it('localizes library panel titles, postMessage prose, and outline deletion UI', () => {
    const t = createLibraryHostTranslator('zh-CN');
    expect(t('createTitle')).toBe('SNL 创建库');
    expect(t('editTitle', { slug: 'algebra' })).toBe('SNL 编辑库 — algebra');
    expect(t('libraryCreated', { title: '代数', slug: 'algebra' }))
      .toBe('已创建库“代数”（标识：algebra）。');
    expect(t('graphMissingWarning')).toBe('graph.json 不存在；首次编辑时将创建该文件');
    expect(t('outlineHasChildren')).toBe('无法删除：此节点包含子节点。');
    expect(t('outlineRemovePrompt', { node: 'entry-1' }))
      .toBe('要从此库的大纲中移除“entry-1”吗？');
    expect(t('outlineRemoveAction')).toBe('移除');
  });

  it('localizes dashboard panel and setup notifications', () => {
    const t = createDashboardHostTranslator('zh-CN');
    expect(t('title')).toBe('SNL 仪表板');
    expect(t('noWorkspaceOverview')).toBe('未打开工作区文件夹。');
    expect(t('kindInitRequiresWorkspace')).toBe('初始化类型需要打开文件夹或工作区。');
    expect(t('initialized')).toBe('SNL Doc 框架已初始化。请使用“SNL：创建文档库”添加第一个库。');
    expect(t('activePackagesFailed', { error: 'disk' }))
      .toBe('SNL 仪表板：更新活动包失败：disk');
  });

  it('localizes package batch confirmations, actions, and host-authored errors', () => {
    const t = createPackageHostTranslator('zh-CN');
    expect(t('title', { file: 'algebra' })).toBe('SNL 宏 — algebra');
    expect(t('deletePrompt', { count: 2 })).toBe('要从此包中删除 2 个宏吗？');
    expect(t('deleteDetail')).toBe('此操作无法撤销。将重写包 JSON 并移除这些宏。');
    expect(t('deleteAction')).toBe('删除');
    expect(t('destinationConflict', { operation: '移动', names: 'x, y' }))
      .toBe('拒绝移动——目标包中已存在：x, y。请先重命名或移除冲突项。');
    expect(t('duplicatePackage', { file: 'new-pack' })).toBe('名为“new-pack”的包已存在。');
    expect(t('noWorkspace')).toBe('未打开工作区文件夹。');
  });

  it('localizes the required Entry Package name before composing the validation message', () => {
    const en = createEntryPackageEditorHostTranslator('en');
    const zh = createEntryPackageEditorHostTranslator('zh-CN');
    expect(en('invalid', { reason: en('nameRequired') }))
      .toBe('Could not create Entry Package: Name is required.');
    expect(zh('invalid', { reason: zh('nameRequired') }))
      .toBe('无法创建条目包：名称为必填项。');
  });
});
