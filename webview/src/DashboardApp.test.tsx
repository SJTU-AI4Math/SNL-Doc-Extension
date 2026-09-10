// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardApp } from './DashboardApp';
import type { VsCodeApi } from './vscodeApi';
import { set_content_language } from './runtime/preferencesRuntime';

const postMessage = vi.fn();

beforeEach(() => {
  postMessage.mockClear();
  (globalThis as { __snlApi?: VsCodeApi }).__snlApi = { postMessage };
});

afterEach(() => {
  set_content_language('en');
  cleanup();
  delete (globalThis as { __snlApi?: VsCodeApi }).__snlApi;
});

describe('Dashboard incremental loading', () => {
  it('patches count-only results locally and ignores stale successes/errors without remounting controls', () => {
    render(<DashboardApp />);
    const send = (data: unknown) => act(() => window.dispatchEvent(new MessageEvent('message', { data })));
    const catalog = {
      hasSnlDoc: true, totalEntryCount: null, entryKinds: [], macroKinds: [],
      entryPackages: [{ id: 'Logic', name: 'Logic', description: '', entryCount: null }],
      macroPackages: [{ file: 'Logic.json', active: true, macroCount: null }], libraries: [],
      dataStatus: { status: 'unchecked', currentVersion: '0.1.0', targetVersion: '0.1.0', pendingCount: 0, message: '' }
    };
    send({ type: 'overview', generation: 1, overview: catalog });
    fireEvent.click(screen.getByText('Entry Packages').closest('button')!);
    const button = screen.getByRole('button', { name: 'Open Entry Package Logic' });
    button.focus();
    expect(button.closest('tr')!.textContent).toContain('—');
    send({ type: 'dashboardStatistics', generation: 1, status: 'error', message: 'broken entry' });
    expect(screen.getByRole('alert').textContent).toContain('broken entry');
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(postMessage).toHaveBeenCalledWith({ type: 'openEntryPackage', packageId: 'Logic' });
    send({ type: 'overview', generation: 2, overview: catalog });
    expect(screen.getByRole('button', { name: 'Open Entry Package Logic' })).toBe(button);
    expect(document.activeElement).toBe(button);
    send({ type: 'dashboardStatistics', generation: 1, status: 'error', message: 'stale error' });
    const statistics = { totalEntryCount: 9000, entryPackages: [{ id: 'Logic', entryCount: 9000 }],
      macroPackages: [{ file: 'Logic.json', macroCount: 7 }], relationshipCount: 3, libraries: [] };
    send({ type: 'dashboardStatistics', generation: 1, status: 'ready', statistics });
    expect(button.closest('tr')!.textContent).not.toContain('9000');
    send({ type: 'dashboardStatistics', generation: 2, status: 'ready', statistics });
    expect(button.closest('tr')!.textContent).toContain('9000');
    expect(document.activeElement).toBe(button);
    expect(screen.getByText('Entry Packages').closest('button')!.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText('stale error')).toBeNull();
    expect(screen.getByRole('status', { name: 'Statistics' }).textContent).toContain('9000');
    expect(screen.getByText('Data version has not been checked yet.')).toBeTruthy();
  });

  it('loads relationship rows only on disclosure, keeping actions usable during local failure', () => {
    render(<DashboardApp />);
    const send = (data: unknown) => act(() => window.dispatchEvent(new MessageEvent('message', { data })));
    send({ type: 'overview', generation: 5, overview: { hasSnlDoc: true } });
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'loadDashboardRelationships' });
    fireEvent.click(screen.getByText('Relationships').closest('button')!);
    expect(postMessage).toHaveBeenCalledWith({ type: 'loadDashboardRelationships' });
    send({ type: 'dashboardRelationships', generation: 5, status: 'error', message: 'broken relationships' });
    fireEvent.click(screen.getByRole('button', { name: 'Create Relationship' }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'createRelationship' });
    send({ type: 'dashboardRelationships', generation: 5, status: 'ready',
      relationships: [{ id: 'r', from: 'a', to: 'b', label: 'implies', metadata: null }],
      entries: [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit relationship r' }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'editRelationship', id: 'r' });
    expect(screen.getByText('Alpha')).toBeTruthy();
  });

  it('shows missing-workspace feedback separately from an uninitialized folder', () => {
    render(<DashboardApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'overview', generation: 1, overview: { hasSnlDoc: false,
        dataStatus: { status: 'missing', currentVersion: null, targetVersion: '0.1.0', pendingCount: 0, message: 'No workspace folder is open.' } }
    } })));
    expect(screen.getByText('No workspace folder is open.')).toBeTruthy();
  });

  it('mounts navigation and independent management controls before any data and keeps them on error', () => {
    render(<DashboardApp />);
    const graph = screen.getByRole('button', { name: 'View Graph' });
    fireEvent.click(graph);
    fireEvent.click(screen.getByRole('button', { name: '+ Create Library' }));
    fireEvent.click(screen.getByRole('button', { name: '⌕ SNoogL: Entry Search' }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'openInfoviewGraph' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'createLibrary' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'openSnoogL', mode: 'entry' });
    act(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'overviewError', message: 'bad config' } })));
    expect(screen.getByRole('button', { name: 'View Graph' })).toBe(graph);
    expect(screen.getByRole('alert').textContent).toContain('bad config');
  });
});

describe('Dashboard Pointer maintenance', () => {
  it.each([
    ['en', 'Pointer maintenance', 'Maintain all Entry Pointers in this workspace'],
    ['zh-CN', 'Pointer 维护', '维护此工作区中的所有条目 Pointer']
  ])('posts the global maintenance intent once with %s labels', async (locale, label, title) => {
    document.documentElement.lang = locale;
    try {
      render(<DashboardApp />);
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'overview', overview: {
          hasSnlDoc: true, totalEntryCount: 0, entries: [], entryPackages: [], libraries: [],
          macroPackages: [], allMacros: [], metricMacroSources: {}, relationships: [],
          entryKinds: [], macroKinds: []
        }
      }}));
      const button = await screen.findByRole('button', { name: label });
      expect(button.getAttribute('title')).toBe(title);
      expect(button.closest('nav.snl-panel-header')).toBeTruthy();
      postMessage.mockClear();
      fireEvent.click(button);
      expect(postMessage.mock.calls).toEqual([[{ type: 'maintainPointers' }]]);
    } finally {
      document.documentElement.lang = 'en';
    }
  });
});

describe('Dashboard library actions', () => {
  it('shows localized Entry Kind names and descriptions without flattening the catalog', async () => {
    render(<DashboardApp />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'overview', overview: {
        hasSnlDoc: true, totalEntryCount: 0, entries: [], libraries: [], macroPackages: [],
        allMacros: [], metricMacroSources: {}, relationships: [], macroKinds: [],
        entryKinds: [{
          id: 'theorem',
          name: { type: 'i18n', default_language: 'en', values: { en: 'Theorem', 'zh-CN': '定理' } },
          description: { type: 'i18n', default_language: 'en', values: { en: 'A proved result.', 'zh-CN': '已经证明的结果。' } },
          coloring: {
            light: { stroke: '#111111', background: '#eeeeee' },
            dark: { stroke: '#dddddd', background: '#222222' }
          },
          defaultCounterName: 'theorem', style: ''
        }]
      }
    }}));
    await screen.findByText('Entry Kinds');
    fireEvent.click(screen.getByText('Entry Kinds').closest('button') as HTMLButtonElement);
    expect(screen.getByText('Theorem')).toBeTruthy();
    expect(screen.getByText('A proved result.')).toBeTruthy();

    act(() => set_content_language('zh-CN'));
    expect(screen.getByText('定理')).toBeTruthy();
    expect(screen.getByText('已经证明的结果。')).toBeTruthy();
  });

  it('routes Kind previews only on Ctrl-click without activating the surrounding row', async () => {
    render(<DashboardApp />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'overview', overview: {
        hasSnlDoc: true, totalEntryCount: 0, entries: [], entryPackages: [], libraries: [],
        macroPackages: [], allMacros: [], metricMacroSources: {}, relationships: [], macroKinds: [],
        entryKinds: [{
          id: 'theorem', name: 'Theorem', description: '',
          coloring: { light: { stroke: '#111111', background: '#eeeeee' }, dark: { stroke: '#dddddd', background: '#222222' } },
          defaultCounterName: 'theorem', style: ''
        }]
      }
    }}));
    await screen.findByText('Entry Kinds');
    fireEvent.click(screen.getByText('Entry Kinds').closest('button') as HTMLButtonElement);
    const preview = document.querySelector<HTMLElement>('[data-kind-preview="true"][data-kind-id="theorem"]');
    expect(preview).toBeTruthy();

    postMessage.mockClear();
    fireEvent.click(preview!);
    expect(postMessage).not.toHaveBeenCalled();
    fireEvent.mouseEnter(preview!);
    fireEvent.keyDown(document, { key: 'Control', ctrlKey: true });
    fireEvent.click(preview!, { ctrlKey: true });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: 'editEntryKind', id: 'theorem' });
  });

  it('offers localized Entry and Macro Kind preset selects and submits both choices once', async () => {
    render(<DashboardApp />);

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'overview',
        overview: {
          hasSnlDoc: false,
          entryKindPresets: [{ id: 'mathematics', label: 'Mathematics', description: 'Math kinds', count: 12 }],
          macroKindPresets: [{ id: 'basics', label: 'SNL-Basics defaults', description: 'Macro kinds', count: 6 }]
        }
      }
    }));

    const entryPreset = await screen.findByRole('combobox', { name: 'Entry Kind preset' });
    const macroPreset = screen.getByRole('combobox', { name: 'Macro Kind preset' });
    expect(screen.getAllByRole('option', { name: 'Empty' })).toHaveLength(2);
    fireEvent.change(entryPreset, { target: { value: 'mathematics' } });
    fireEvent.change(macroPreset, { target: { value: '' } });

    const init = screen.getByRole('button', { name: 'Run SNL: Init' });
    fireEvent.click(init);
    expect((init as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status', { name: 'SNL setup status' }).textContent).toContain('Initializing SNL workspace');

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      type: 'init', entryKindPresetId: 'mathematics', macroKindPresetId: ''
    }));
    expect(postMessage.mock.calls.filter(([message]) => message.type === 'init')).toHaveLength(1);
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
    expect((librariesToggle as HTMLButtonElement).style.justifyContent).toBe('flex-start');
    expect((librariesToggle as HTMLButtonElement).style.textAlign).toBe('left');

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

  it('keeps Entry metrics out of the package-first Dashboard surface', async () => {
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
            entryPackages: [{ id: 'logic', name: 'Logic', description: 'Logical entries', entryCount: 1 }],
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

    await screen.findByText('Entry Packages');
    const packagesToggle = screen.getByText('Entry Packages').closest('button');
    if (!packagesToggle) throw new Error('Entry Packages toggle not found');
    fireEvent.click(packagesToggle);

    expect(await screen.findByText('Logic')).toBeTruthy();
    expect(screen.queryByText('Entry One')).toBeNull();
    expect(screen.queryByText('SNL Structural Index')).toBeNull();
    expect(screen.queryByText('Semantic freedom')).toBeNull();
    expect(screen.queryByText('Structured')).toBeNull();
  });

  it('renders relationship endpoints in the panel content language', async () => {
    set_content_language('zh-CN');
    render(<DashboardApp />);
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'overview',
        overview: {
          hasSnlDoc: true,
          totalEntryCount: 2,
          entries: [
            {
              id: 'entry-1', kind: 'definition', content: {},
              title: {
                type: 'i18n', default_language: 'en',
                values: { en: 'Entry One', 'zh-CN': '条目一' }
              }
            },
            { id: 'entry-2', kind: 'definition', content: {}, title: 'Entry Two' }
          ],
          libraries: [], macroPackages: [], allMacros: [], metricMacroSources: {},
          entryKinds: [], macroKinds: [],
          relationships: [
            { id: 'r1', from: 'entry-1', to: 'entry-2', label: 'depends', metadata: {} }
          ]
        }
      }
    }));

    const relationshipsToggle = (await screen.findByText('Relationships')).closest('button');
    if (!relationshipsToggle) throw new Error('Relationships toggle not found');
    fireEvent.click(relationshipsToggle);
    expect(await screen.findByText('条目一')).toBeTruthy();
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
    expect(screen.getByText('条目包')).toBeTruthy();
    const createLibrary = screen.getByRole('button', { name: '+ 创建库' });
    expect(createLibrary.getAttribute('title')).toBe('打开创建库面板');
    const graphButton = screen.getByRole('button', { name: '查看关系图' });
    expect(graphButton.getAttribute('title')).toBe('打开共享池的完整关系图');
    expect(graphButton.textContent).toContain('查看关系图');
    expect(screen.queryByText('Libraries')).toBeNull();
  });
});


describe('Dashboard Entry Packages', () => {
  it('replaces the flat Entries table with package rows and routes create/open actions', async () => {
    render(<DashboardApp />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'overview', overview: {
        hasSnlDoc: true, totalEntryCount: 1,
        entries: [{ id: 'hidden-entry', kind: 'definition', title: 'Must not render on root', content: {} }],
        entryPackages: [{ id: 'logic', name: 'Logic', description: 'Logical entries', entryCount: 1 }],
        libraries: [], macroPackages: [], allMacros: [], metricMacroSources: {},
        entryKinds: [], macroKinds: [], relationships: []
      }
    }}));

    const section = await screen.findByText('Entry Packages');
    fireEvent.click(section.closest('button') as HTMLButtonElement);
    expect(screen.getByText('Logic')).toBeTruthy();
    expect(screen.getByText('Logical entries')).toBeTruthy();
    expect(screen.queryByText('Must not render on root')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ Create Entry Package' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Entry Package logic' }));

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'createEntryPackage' });
      expect(postMessage).toHaveBeenCalledWith({ type: 'openEntryPackage', packageId: 'logic' });
    });
  });
});
