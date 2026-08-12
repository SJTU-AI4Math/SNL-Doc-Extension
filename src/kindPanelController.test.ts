import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createEntryKind: vi.fn(),
  updateEntryKind: vi.fn(),
  createMacroKind: vi.fn(),
  updateMacroKind: vi.fn()
}));

vi.mock('vscode', () => ({
  window: { showInformationMessage: vi.fn(), showErrorMessage: vi.fn() },
  ViewColumn: { Active: -1 },
  Uri: { joinPath: vi.fn() }
}));
vi.mock('./preferencesHost', () => ({ bind_preferences_panel_title: vi.fn() }));
vi.mock('./preferences', () => ({ read_extension_preferences: () => ({ language: 'en' }) }));
vi.mock('./hostI18n', () => ({
  defineHostMessages: (en: unknown) => en,
  createHostTranslator: () => (key: string) => key
}));
vi.mock('./panelUtil', () => ({
  buildPanelHtml: () => '', firstWorkspaceFolder: () => undefined,
  handlePanelNavMessage: async () => false, installSnlDocWatcher: vi.fn()
}));
vi.mock('./snlDoc', () => ({
  createEntryKind: mocks.createEntryKind,
  updateEntryKind: mocks.updateEntryKind,
  createMacroKind: mocks.createMacroKind,
  updateMacroKind: mocks.updateMacroKind,
  entityRevision: vi.fn(), readEntryKinds: vi.fn(), readMacroKinds: vi.fn()
}));

import { KindPanelController } from './kindPanelController';

const coloring = {
  light: { stroke: '#111111', background: '#eeeeee' },
  dark: { stroke: '#dddddd', background: '#222222' }
};

function controller(domain: 'entry' | 'macro', mode: 'create' | 'edit', id = ''): any {
  const value = Object.create(KindPanelController.prototype);
  Object.assign(value, {
    domain, mode, id, contextGeneration: 0,
    panel: { webview: { postMessage: vi.fn(async () => true) } }
  });
  return value;
}

describe('Kind panel themed-color host bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const fn of [mocks.createEntryKind, mocks.updateEntryKind, mocks.createMacroKind, mocks.updateMacroKind]) {
      fn.mockResolvedValue({ status: 'invalid', message: 'test terminal result' });
    }
  });

  it('passes complete Entry Kind coloring through create and revisioned update', async () => {
    const root = { path: '/workspace' };
    const name = { type: 'i18n', default_language: 'en', values: { en: 'Theorem', 'zh-CN': '定理' } };
    const description = { type: 'i18n', default_language: 'en', values: { en: 'A result.', 'zh-CN': '一个结果。' } };
    await controller('entry', 'create').saveEntry(root, 'create', {
      id: ' theorem ', name, description, coloring,
      defaultCounterName: 'theorem', style: 'boxed'
    });
    expect(mocks.createEntryKind).toHaveBeenCalledWith(root, {
      id: ' theorem ', name, description, coloring,
      defaultCounterName: 'theorem', style: 'boxed'
    });

    await controller('entry', 'edit', 'theorem').saveEntry(root, 'update', {
      name: 'Updated', coloring, defaultCounterName: '', style: ''
    }, 'entry-revision');
    expect(mocks.updateEntryKind).toHaveBeenCalledWith(root, 'theorem', {
      name: 'Updated', description: '', coloring, defaultCounterName: '', style: ''
    }, 'entry-revision');
  });

  it('passes complete Macro Kind coloring through create and revisioned update', async () => {
    const root = { path: '/workspace' };
    await controller('macro', 'create').saveMacro(root, 'create', {
      id: ' operator ', name: 'Operator', description: 'Ops', coloring
    });
    expect(mocks.createMacroKind).toHaveBeenCalledWith(root, {
      id: ' operator ', name: 'Operator', description: 'Ops', coloring
    });

    await controller('macro', 'edit', 'operator').saveMacro(root, 'update', {
      name: 'Updated operator', description: '', coloring
    }, 'macro-revision');
    expect(mocks.updateMacroKind).toHaveBeenCalledWith(root, 'operator', {
      name: 'Updated operator', description: '', coloring
    }, 'macro-revision');
  });
});
