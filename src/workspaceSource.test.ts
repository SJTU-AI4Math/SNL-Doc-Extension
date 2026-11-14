import { describe, expect, it, vi } from 'vitest';

const window = vi.hoisted(() => ({ showQuickPick: vi.fn(), showWarningMessage: vi.fn() }));
const workspace = vi.hoisted(() => ({ workspaceFolders: [] as unknown[] }));
const executeCommand = vi.hoisted(() => vi.fn());
vi.mock('vscode', () => ({ window, workspace, commands: { executeCommand } }));
import { bindWorkspaceSource, getWorkspaceSource, selectWorkspaceSource } from './workspaceSource';

describe('workspace source selection', () => {
  it('does not redirect an existing panel; rebinds only after reload and never silently replaces a removed source', async () => {
    const folder = (name: string) => ({ name, uri: { scheme: 'file', fsPath: name, toString: () => name } });
    const first = folder('one'), second = folder('two');
    workspace.workspaceFolders = [first, second];
    let saved: string | undefined;
    const state = { get: () => saved, update: async (_: string, value: string) => { saved = value; } };
    bindWorkspaceSource(state as never);
    expect(getWorkspaceSource()).toBe(first.uri);
    window.showQuickPick.mockImplementation(async choices => choices[1]);
    const labels = { current: '', noFolder: '', prompt: '', reload: '', change: 'Switch' };
    await selectWorkspaceSource(state as never, labels);
    expect(saved).toBeUndefined();
    window.showWarningMessage.mockResolvedValue('Switch');
    await selectWorkspaceSource(state as never, labels);
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
    expect(getWorkspaceSource()).toBe(first.uri);
    bindWorkspaceSource(state as never);
    expect(getWorkspaceSource()).toBe(second.uri);
    workspace.workspaceFolders = [first];
    expect(getWorkspaceSource()).toBeUndefined();
  });
});
