// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardApp } from './DashboardApp';
import type { VsCodeApi } from './vscodeApi';

const postMessage = vi.fn();

beforeEach(() => {
  postMessage.mockClear();
  (globalThis as { __snlApi?: VsCodeApi }).__snlApi = { postMessage };
});

afterEach(() => {
  cleanup();
  delete (globalThis as { __snlApi?: VsCodeApi }).__snlApi;
});

describe('Dashboard library actions', () => {
  it('offers exactly one initialization action before the workspace is initialized', async () => {
    render(<DashboardApp />);

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'overview',
        overview: { hasSnlDoc: false }
      }
    }));

    const init = await screen.findByRole('button', { name: 'Run SNL: Init' });
    expect(screen.queryByRole('button', { name: 'Initialize Entry Kinds' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Initialize Macro Kinds' })).toBeNull();

    fireEvent.click(init);
    expect((init as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status', { name: 'SNL setup status' }).textContent).toContain('Initializing SNL workspace');

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: 'init' }));
  });

  it('offers Create as well as Initialize when both Kind catalogs are empty', async () => {
    render(<DashboardApp />);

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'overview',
        overview: {
          hasSnlDoc: true,
          totalEntryCount: 0,
          entries: [],
          libraries: [],
          macroPackages: [],
          allMacros: [],
          metricMacroSources: {},
          entryKinds: [],
          macroKinds: [],
          relationships: []
        }
      }
    }));

    await screen.findByText('Entry Kinds');
    fireEvent.click(screen.getByText('Entry Kinds').closest('button') as HTMLButtonElement);
    fireEvent.click(screen.getByText('SNL Macro Kinds').closest('button') as HTMLButtonElement);

    fireEvent.click(screen.getByRole('button', { name: 'Initialize Entry Kinds' }));
    expect(screen.getByRole('status', { name: 'SNL setup status' }).textContent).toContain('Initializing SNL workspace');
    expect(
      (screen.getByRole('button', { name: 'Initialize Entry Kinds' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Initialize Macro Kinds' }) as HTMLButtonElement).disabled
    ).toBe(true);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'setupStatus', status: 'idle' }
    }));
    await waitFor(() => {
      expect(
        (screen.getByRole('button', { name: 'Initialize Macro Kinds' }) as HTMLButtonElement).disabled
      ).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create Entry Kind' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Macro Kind' }));

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'createEntryKind' });
      expect(postMessage).toHaveBeenCalledWith({ type: 'createMacroKind' });
    });
    expect(screen.getByRole('button', { name: 'Initialize Entry Kinds' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Initialize Macro Kinds' })).toBeTruthy();
  });

  it('creates a library from the collapsed Libraries section header', async () => {
    render(<DashboardApp />);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'overview',
          overview: {
            hasSnlDoc: true,
            totalEntryCount: 0,
            entries: [],
            libraries: [],
            macroPackages: [],
            allMacros: [],
            metricMacroSources: {},
            entryKinds: [],
            macroKinds: [],
            relationships: []
          }
        }
      })
    );

    const createButton = await screen.findByRole('button', {
      name: '+ Create Library'
    });
    const librariesToggle = screen.getByRole('button', {
      name: /Libraries0 libraries/
    });
    expect(createButton.textContent).toBe('+ Create Library');
    expect(createButton.getAttribute('title')).toBe('Open the Create Library panel');
    expect(librariesToggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(createButton);

    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({ type: 'createLibrary' })
    );
    expect(librariesToggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows data version health and routes check/repair actions to the host', async () => {
    render(<DashboardApp />);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'overview',
          overview: {
            hasSnlDoc: true,
            totalEntryCount: 0,
            entries: [],
            libraries: [],
            macroPackages: [],
            allMacros: [],
            metricMacroSources: {},
            entryKinds: [],
            macroKinds: [],
            relationships: [],
            dataStatus: {
              status: 'needsMigration',
              currentVersion: '0.0.3',
              targetVersion: '0.0.4',
              pendingCount: 1,
              message: '1 migration step required.'
            }
          }
        }
      })
    );

    expect(await screen.findByText('Data maintenance')).toBeTruthy();
    expect(screen.getByText('0.0.3 → 0.0.4')).toBeTruthy();
    expect(screen.getByText('1 migration step required.')).toBeTruthy();
    expect(screen.getByText('1 pending migration step(s).')).toBeTruthy();
    expect(screen.getByText('Data maintenance').closest('button')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check data' }));
    fireEvent.click(screen.getByRole('button', { name: 'Repair / migrate data' }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dataMigrationStatus', status: 'running', operation: 'repair' }
    }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Repair \/ migrate data/ }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('button', { name: 'Check data' }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByText(/Migration is running/).textContent).toContain('Migration is running');
    });
    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'checkDataVersion' });
      expect(postMessage).toHaveBeenCalledWith({ type: 'repairData' });
    });
  });

  it('shows a single SNL Structural Index column for entries', async () => {
    render(<DashboardApp />);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'overview',
          overview: {
            hasSnlDoc: true,
            totalEntryCount: 1,
            entries: [
              {
                id: 'entry-1',
                kind: 'definition',
                title: 'Entry One',
                content: { snl: 'free' }
              }
            ],
            libraries: [],
            macroPackages: [],
            allMacros: [],
            metricMacroSources: {},
            entryKinds: [],
            macroKinds: [],
            relationships: []
          }
        }
      })
    );

    await screen.findByText('Entries');
    const entriesToggle = screen.getByText('Entries').closest('button');
    if (!entriesToggle) throw new Error('Entries toggle not found');
    fireEvent.click(entriesToggle);

    expect(await screen.findByText('SNL Structural Index')).toBeTruthy();
    expect(screen.queryByText('Semantic freedom')).toBeNull();
    expect(screen.queryByText('Structured')).toBeNull();
  });
});

describe('Dashboard Chinese localization', () => {
  beforeEach(() => {
    document.documentElement.lang = 'zh-CN';
  });

  afterEach(() => {
    document.documentElement.lang = '';
  });

  it('renders setup and initialized dashboard controls in Simplified Chinese', async () => {
    const { unmount } = render(<DashboardApp />);
    expect(screen.getByText('正在加载项目概览…')).toBeTruthy();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'overview', overview: { hasSnlDoc: false } }
    }));
    expect(await screen.findByRole('button', { name: '运行 SNL：初始化' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '初始化条目类别' })).toBeNull();
    expect(screen.queryByRole('button', { name: '初始化宏类别' })).toBeNull();
    expect(screen.getByRole('status', { name: 'SNL 设置状态' })).toBeTruthy();

    unmount();
    render(<DashboardApp />);
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'overview',
        overview: {
          hasSnlDoc: true,
          totalEntryCount: 0,
          entries: [],
          libraries: [],
          macroPackages: [],
          allMacros: [],
          metricMacroSources: {},
          entryKinds: [],
          macroKinds: [],
          relationships: []
        }
      }
    }));

    expect(await screen.findByText('数据维护')).toBeTruthy();
    expect(screen.getByText('库')).toBeTruthy();
    expect(screen.getByText('共享条目')).toBeTruthy();
    const createLibrary = screen.getByRole('button', { name: '+ 创建库' });
    expect(createLibrary.getAttribute('title')).toBe('打开创建库面板');
    const graphButton = screen.getByRole('button', { name: '查看关系图' });
    expect(graphButton.getAttribute('title')).toBe('打开共享池的完整关系图');
    expect(graphButton.textContent).toContain('查看关系图');
    expect(screen.queryByText('Libraries')).toBeNull();
  });
});
