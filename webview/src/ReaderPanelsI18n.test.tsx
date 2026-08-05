// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  postMessage: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn()
}));

vi.mock('./vscodeApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vscodeApi')>()),
  getVsCodeApi: () => api
}));
vi.mock('./render/EntrySurface', () => ({
  EntrySurface: ({ entry }: { entry: { title: string } }) => <div>{entry.title}</div>
}));
vi.mock('./components/EntryMacroSection', () => ({ EntryMacroSection: () => null }));

import { App } from './App';
import { EntryInfoviewApp } from './EntryInfoviewApp';
import { SnlGraphApp } from './SnlGraphApp';
import { SnooglApp } from './SnooglApp';
import { ExportOptionsApp } from './ExportOptionsApp';

function hostMessage(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data })));
}

beforeEach(() => {
  document.documentElement.lang = 'zh-CN';
});

afterEach(() => {
  cleanup();
  api.postMessage.mockReset();
  api.getState.mockReset();
  api.setState.mockReset();
  document.documentElement.lang = '';
});

describe('reader panel Chinese UI', () => {
  it('localizes the Libraries view and keeps Library Back as an explicit host transition', () => {
    const view = render(<App />);
    expect(view.getByText('正在加载文档库……')).toBeTruthy();

    hostMessage({ type: 'libraries', libraries: [] });
    expect(view.getByText('0 个文档库')).toBeTruthy();
    expect(view.getByRole('button', { name: '打开整个条目池的关系图' })).toBeTruthy();

    hostMessage({
      type: 'libraryEntries', slug: 'algebra', title: 'Algebra', entries: [], outline: [], warnings: []
    });
    api.postMessage.mockClear();
    fireEvent.click(view.getByRole('button', { name: '返回文档库列表' }));
    expect(api.postMessage).toHaveBeenCalledTimes(1);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'back' });
    expect(view.getByText('0 个条目 · algebra')).toBeTruthy();
  });

  it('localizes entry loading, empty, related-entry, badge, and tooltip text', () => {
    const view = render(<EntryInfoviewApp />);
    expect(view.getByText('正在加载条目……')).toBeTruthy();

    hostMessage({ type: 'entryDetails', entry: null, kind: null, entries: [] });
    expect(view.getByText('在此工作区中找不到该条目。')).toBeTruthy();

    hostMessage({
      type: 'entryDetails',
      entry: { id: 'target', title: 'Target', kind: 'theorem', content: {} },
      kind: null,
      entries: [],
      relatedEntries: {
        context: [{ id: 'ctx', title: '', kindId: 'definition' }],
        dependencies: [{ id: 'dep', title: 'Dependency', isAtomic: true }]
      }
    });
    expect(view.getByRole('heading', { name: '上下文' })).toBeTruthy();
    expect(view.getByRole('heading', { name: '依赖项' })).toBeTruthy();
    expect(view.getByText('（无标题）')).toBeTruthy();
    expect(view.getByText('原子').getAttribute('title')).toBe('原子依赖项——条目池中不存在更短的组合路径。');
    expect(view.getByRole('button', { name: '在“编辑条目”面板中打开此条目' }).textContent).toBe('✎ 编辑');
  });

  it('localizes graph loading, summaries, empty state, filters, and controls', () => {
    const view = render(<SnlGraphApp />);
    expect(view.getByText('正在加载关系图……')).toBeTruthy();
    expect(view.getByRole('button', { name: '返回 SNL 信息视图' }).textContent).toBe('← 信息视图');

    hostMessage({
      type: 'graph', scope: { mode: 'pool' }, title: 'Workspace Graph', nodes: [], edges: [], warnings: []
    });
    expect(view.getByText('0 个节点 · 0 条边 · 已隐藏孤立节点')).toBeTruthy();
    expect(view.getByText(/没有可显示的关系/)).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: '展开筛选器' }));
    expect(view.getByRole('heading', { name: '边' })).toBeTruthy();
    expect(view.getByText('仅原子依赖项')).toBeTruthy();
    expect(view.getByRole('button', { name: '显示所有条目种类（重置种类筛选器）' }).textContent).toBe('全部');
  });

  it('localizes search headings, controls, placeholders, empty state, aria, and score tooltip', () => {
    const view = render(<SnooglApp />);
    expect(view.getByText('搜索工作区中的条目和宏。')).toBeTruthy();
    expect(view.getByRole('tablist', { name: '搜索目标' })).toBeTruthy();
    expect(view.getByRole('tab', { name: '条目' })).toBeTruthy();
    expect(view.getByPlaceholderText('搜索条目——按 ID 或标题……')).toBeTruthy();
    expect(view.getByText('筛选器')).toBeTruthy();
    expect(view.getByText('无匹配项。')).toBeTruthy();

    hostMessage({
      type: 'results', query: { q: 'x', mode: 'entry', filters: {} },
      results: [{ kind: 'entry', id: '', title: '', entryKind: null, score: 2 }],
      kindsByMode: { entry: [], macro: [] }
    });
    expect(view.getByRole('listbox', { name: '条目结果' })).toBeTruthy();
    expect(view.getByText('（无标题）')).toBeTruthy();
    expect(view.getByTitle('重排分数：2')).toBeTruthy();
  });

  it('localizes export loading, choices, hints, and count grammar', () => {
    const view = render(<ExportOptionsApp />);
    expect(view.getByText('正在加载导出上下文……')).toBeTruthy();

    hostMessage({
      type: 'exportContext',
      context: {
        slug: 'algebra', title: 'Algebra', entryCount: 2, assetCount: 1,
        defaultDestination: '/tmp/algebra'
      }
    });
    expect(view.getByText('Algebra · 2 个条目 · 1 张图片')).toBeTruthy();
    expect(view.getByText('文件夹')).toBeTruthy();
    expect(view.getByText('单个文件')).toBeTruthy();
    expect(view.getByText('index.html 加 assets/ 和 fonts/。体积更小，适合托管。')).toBeTruthy();
    expect(view.getByRole('button', { name: '导出' })).toBeTruthy();
  });
});
