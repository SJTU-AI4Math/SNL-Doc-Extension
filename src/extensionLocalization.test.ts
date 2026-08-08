import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  language: 'zh-CN',
  workspaceRoot: { path: '/ws' } as unknown,
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showQuickPick: vi.fn(),
  executeCommand: vi.fn(),
  createEntryPackageOrShow: vi.fn(),
  initSnlDoc: vi.fn(),
  deleteEntry: vi.fn(),
  regenerateDependencyRelationships: vi.fn(),
  readMacroPackages: vi.fn(),
  resolveActiveMacroPackages: vi.fn()
}));

vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1, Default: 0 },
  commands: {
    registerCommand: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
      mocks.commands.set(name, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: mocks.executeCommand
  },
  window: {
    showInformationMessage: mocks.showInformationMessage,
    showWarningMessage: mocks.showWarningMessage,
    showErrorMessage: mocks.showErrorMessage,
    showQuickPick: mocks.showQuickPick,
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() }))
  },
  workspace: {
    workspaceFolders: [{ uri: { path: '/ws' } }],
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() }))
  }
}));

vi.mock('./infoviewPanel', () => ({ InfoviewPanel: {} }));
vi.mock('./createLibraryPanel', () => ({ CreateLibraryPanel: {} }));
vi.mock('./dashboardPanel', () => ({ DashboardPanel: {} }));
vi.mock('./initEntryKindsPanel', () => ({ InitEntryKindsPanel: {} }));
vi.mock('./createEntryKindPanel', () => ({ CreateEntryKindPanel: {} }));
vi.mock('./initMacroKindsPanel', () => ({ InitMacroKindsPanel: {} }));
vi.mock('./createMacroKindPanel', () => ({ CreateMacroKindPanel: {} }));
vi.mock('./createEntryPanel', () => ({
  CreateEntryPanel: { createPackageOrShow: mocks.createEntryPackageOrShow }
}));
vi.mock('./createMacroPackagePanel', () => ({ CreateMacroPackagePanel: {} }));
vi.mock('./packagePanel', () => ({ PackagePanel: {} }));
vi.mock('./createMacroPanel', () => ({ CreateMacroPanel: {} }));
vi.mock('./createRelationshipPanel', () => ({ CreateRelationshipPanel: {} }));
vi.mock('./graphPanel', () => ({ GraphPanel: {} }));
vi.mock('./snooglPanel', () => ({ SnoogLPanel: {} }));

vi.mock('./trace', () => ({
  isTraceEnabled: vi.fn(() => false), refreshTraceEnabled: vi.fn(),
  setTraceEnabled: vi.fn((value: boolean) => value),
  startTrace: vi.fn(() => ({ mark: vi.fn() })), traceChannel: vi.fn(() => undefined)
}));
vi.mock('./webviewCostProbe', () => ({ registerWebviewCostProbe: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock('./preferencesHost', () => ({ initialize_preferences_host: vi.fn() }));
vi.mock('./preferences', () => ({ read_extension_preferences: () => ({ language: mocks.language }) }));
vi.mock('./snlDocContext', () => ({ installSnlDocContextKey: vi.fn() }));
vi.mock('./dataMigrationCommands', () => ({ checkDataVersion: vi.fn(), repairData: vi.fn() }));
vi.mock('./panelUtil', () => ({ firstWorkspaceFolder: () => mocks.workspaceRoot }));
vi.mock('./snlDoc', () => ({
  initSnlDoc: mocks.initSnlDoc,
  deleteEntry: mocks.deleteEntry,
  regenerateDependencyRelationships: mocks.regenerateDependencyRelationships,
  readMacroPackages: mocks.readMacroPackages,
  resolveActiveMacroPackages: mocks.resolveActiveMacroPackages
}));

import { activate } from './extension';

const context = { extensionUri: {}, subscriptions: [] } as never;
const command = (name: string): ((...args: unknown[]) => unknown) => {
  const handler = mocks.commands.get(name);
  if (!handler) throw new Error(`Missing command ${name}`);
  return handler;
};

describe('extension host UI localization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.commands.clear();
    mocks.language = 'zh-CN';
    mocks.workspaceRoot = { path: '/ws' };
    (context as { subscriptions: unknown[] }).subscriptions = [];
    activate(context);
  });

  it('uses Chinese for init notifications and keeps dynamic errors as parameters', async () => {
    mocks.initSnlDoc.mockResolvedValue({ status: 'created' });
    await command('snlDoc.init')();
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'SNL Doc 骨架已初始化。请使用“SNL：创建文档库”添加第一个库。'
    );

    mocks.initSnlDoc.mockRejectedValueOnce(new Error('磁盘只读'));
    await command('snlDoc.init')();
    expect(mocks.showErrorMessage).toHaveBeenCalledWith('SNL 初始化失败：磁盘只读');
  });

  it('re-reads the effective language after activation', async () => {
    mocks.language = 'en';
    await command('snlDoc.toggleTrace')();
    expect(mocks.showInformationMessage).toHaveBeenCalledWith('SNL panel timing trace ON — open a panel, then check the "SNL Trace" output channel.');
  });

  it('uses the translated modal action for both display and confirmation comparison', async () => {
    mocks.showWarningMessage.mockResolvedValue('删除');
    mocks.deleteEntry.mockResolvedValue({
      status: 'ok',
      references: { libraryNodes: [], macroSources: [], relationships: [] }
    });

    await command('snlDoc.deleteEntry')('entry-1');

    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      '删除条目“entry-1”？',
      expect.objectContaining({
        modal: true,
        detail: expect.stringContaining('共享池')
      }),
      '删除'
    );
    expect(mocks.deleteEntry).toHaveBeenCalledWith(mocks.workspaceRoot, 'entry-1');
    expect(mocks.showInformationMessage).toHaveBeenCalledWith('已删除条目“entry-1”。');
  });

  it('localizes dependency regeneration and package QuickPick copy', async () => {
    mocks.showWarningMessage.mockResolvedValue('重新生成');
    mocks.regenerateDependencyRelationships.mockResolvedValue({
      status: 'ok', report: {
        added: 1, updated: 2, removed: 3, totalDepends: 4, totalUsesContext: 5,
        atomicCount: 6, preservedUser: 7
      }
    });
    await command('snlDoc.regenerateDependencies')();
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      '为整个条目池重新生成依赖关系？',
      expect.objectContaining({ detail: expect.stringContaining('扫描每个条目的 SNL 内容') }),
      '重新生成'
    );
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('依赖关系已重新生成')
    );

    mocks.readMacroPackages.mockResolvedValue([{ file: 'a.json' }, { file: 'b.json' }]);
    mocks.resolveActiveMacroPackages.mockResolvedValue(['a', 'b']);
    mocks.showQuickPick.mockResolvedValue(undefined);
    await command('snlDoc.createMacroPickPackage')();
    expect(mocks.showQuickPick).toHaveBeenCalledWith(
      expect.any(Array),
      { placeHolder: '选择新宏所属的包' }
    );
  });

  it('opens the cat navigation picker and routes every section through existing commands', async () => {
    mocks.showQuickPick
      .mockResolvedValueOnce({ label: 'SNoogL ›', submenu: 'snoogl' })
      .mockResolvedValueOnce({ label: '宏', command: 'snlDoc.openSnoogL', args: ['macro'] });

    await command('snlDoc.openNavigation')();

    const [rootItems, rootOptions] = mocks.showQuickPick.mock.calls.at(-2)!;
    expect(rootOptions).toEqual({ placeHolder: '打开 SNL 页面或创建内容' });
    expect(rootItems.map((item: { label: string; kind?: number; command?: string; submenu?: string }) =>
      [item.label, item.kind ?? 0, item.command ?? '', item.submenu ?? '']
    )).toEqual([
      ['打开 Dashboard 根页面', 0, 'snlDoc.openDashboard', ''],
      ['Create ›', 0, '', 'create'],
      ['', -1, '', ''],
      ['打开 Infoview 根页面', 0, 'snlDoc.openInfoview', ''],
      ['打开全局图谱', 0, 'snlDoc.openInfoviewGraph', ''],
      ['', -1, '', ''],
      ['SNoogL ›', 0, '', 'snoogl']
    ]);
    const [snooglItems, snooglOptions] = mocks.showQuickPick.mock.calls.at(-1)!;
    expect(snooglOptions).toEqual({ placeHolder: 'SNoogL' });
    expect(snooglItems.map((item: { label: string; command: string; args?: unknown[] }) =>
      [item.label, item.command, item.args ?? []]
    )).toEqual([
      ['条目', 'snlDoc.openSnoogL', ['entry']],
      ['宏', 'snlDoc.openSnoogL', ['macro']]
    ]);
    expect(mocks.executeCommand).toHaveBeenCalledWith('snlDoc.openSnoogL', 'macro');

    mocks.showQuickPick
      .mockResolvedValueOnce({ label: 'Create ›', submenu: 'create' })
      .mockResolvedValueOnce(undefined);
    await command('snlDoc.openNavigation')();
    const [createItems, createOptions] = mocks.showQuickPick.mock.calls.at(-1)!;
    expect(createOptions).toEqual({ placeHolder: 'Create' });
    expect(createItems.map((item: { label: string; command: string }) =>
      [item.label, item.command]
    )).toEqual([
      ['文档库', 'snlDoc.createLibrary'],
      ['条目', 'snlDoc.createEntry'],
      ['宏', 'snlDoc.createMacroPickPackage'],
      ['条目包', 'snlDoc.createEntryPackage'],
      ['宏包', 'snlDoc.createMacroPackage'],
      ['条目类型', 'snlDoc.createEntryKind'],
      ['宏类型', 'snlDoc.createMacroKind']
    ]);

    await command('snlDoc.createEntryPackage')();
    expect(mocks.createEntryPackageOrShow).toHaveBeenCalledWith(
      (context as unknown as { extensionUri: unknown }).extensionUri
    );
  });
});
