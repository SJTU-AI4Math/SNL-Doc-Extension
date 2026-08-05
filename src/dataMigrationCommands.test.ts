import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  language: 'en',
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  withProgress: vi.fn(async (_options: unknown, task: () => Promise<unknown>) => task()),
  executeCommand: vi.fn(),
  inspect: vi.fn(),
  migrate: vi.fn()
}));

vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  commands: { executeCommand: mocks.executeCommand },
  window: {
    showInformationMessage: mocks.showInformationMessage,
    showWarningMessage: mocks.showWarningMessage,
    showErrorMessage: mocks.showErrorMessage,
    withProgress: mocks.withProgress
  }
}));

vi.mock('./vscodeDataMigration', () => ({
  inspectWorkspaceDataVersion: mocks.inspect,
  migrateWorkspaceData: mocks.migrate
}));

vi.mock('./preferences', () => ({
  read_extension_preferences: () => ({ language: mocks.language })
}));

import { checkDataVersion, repairData } from './dataMigrationCommands';

describe('data migration commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.language = 'en';
  });

  it('reports the current version and complete pending chain without writing', async () => {
    mocks.inspect.mockResolvedValue({
      status: 'needsMigration', currentVersion: '0.0.2', targetVersion: '0.0.4',
      message: '2 steps', pending: [
        { from: '0.0.2', to: '0.0.3', description: 'Kinds' },
        { from: '0.0.3', to: '0.0.4', description: 'Macros' }
      ]
    });
    await checkDataVersion({ path: '/ws' } as never);
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('0.0.2 → 0.0.3 → 0.0.4'),
      expect.anything()
    );
    expect(mocks.migrate).not.toHaveBeenCalled();
  });

  it('opens the Dashboard when the user selects that action from the check result', async () => {
    mocks.inspect.mockResolvedValue({
      status: 'current', currentVersion: '0.0.4', targetVersion: '0.0.4',
      message: 'current', pending: []
    });
    mocks.showInformationMessage.mockResolvedValue('Open Dashboard');
    await checkDataVersion({ path: '/ws' } as never);
    expect(mocks.executeCommand).toHaveBeenCalledWith('snlDoc.openDashboard');
  });

  it('refuses invalid and future data versions', async () => {
    mocks.inspect.mockResolvedValue({
      status: 'future', currentVersion: '9.0.0', targetVersion: '0.0.4',
      message: 'newer'
    });
    await checkDataVersion({ path: '/ws' } as never);
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('newer'));
  });

  it('asks before repair and reports every applied migration', async () => {
    mocks.inspect.mockResolvedValue({
      status: 'needsMigration', currentVersion: '0.0.3', targetVersion: '0.0.4',
      message: '1 step', pending: [
        { from: '0.0.3', to: '0.0.4', description: 'Canonicalize packages' }
      ]
    });
    mocks.showWarningMessage.mockResolvedValue('Migrate');
    mocks.migrate.mockResolvedValue({
      from: '0.0.3', to: '0.0.4', applied: [
        { from: '0.0.3', to: '0.0.4', description: 'Canonicalize packages' }
      ]
    });
    await repairData({ path: '/ws' } as never);
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('0.0.3 → 0.0.4'),
      expect.objectContaining({ modal: true }),
      'Migrate'
    );
    expect(mocks.migrate).toHaveBeenCalledOnce();
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('0.0.3 → 0.0.4')
    );
  });

  it('does not keep the Dashboard running until the success toast is dismissed', async () => {
    mocks.inspect.mockResolvedValue({
      status: 'needsMigration', currentVersion: '0.0.3', targetVersion: '0.0.4',
      message: '1 step', pending: [{ from: '0.0.3', to: '0.0.4', description: 'x' }]
    });
    mocks.showWarningMessage.mockResolvedValue('Migrate');
    mocks.migrate.mockResolvedValue({
      from: '0.0.3', to: '0.0.4', applied: [{ from: '0.0.3', to: '0.0.4', description: 'x' }]
    });
    mocks.showInformationMessage.mockImplementation(() => new Promise(() => {}));

    const outcome = await Promise.race([
      repairData({ path: '/ws' } as never).then(() => 'returned'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 30))
    ]);
    expect(outcome).toBe('returned');
  });

  it('does nothing when repair confirmation is cancelled', async () => {
    mocks.inspect.mockResolvedValue({
      status: 'needsMigration', currentVersion: '0.0.3', targetVersion: '0.0.4',
      message: '1 step', pending: [{ from: '0.0.3', to: '0.0.4', description: 'x' }]
    });
    mocks.showWarningMessage.mockResolvedValue(undefined);
    await repairData({ path: '/ws' } as never);
    expect(mocks.migrate).not.toHaveBeenCalled();
  });

  it('uses the effective Chinese locale for host notifications', async () => {
    mocks.language = 'zh-CN';
    await checkDataVersion(undefined);
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      '检查 SNL 数据需要打开文件夹或工作区。'
    );
  });
});
