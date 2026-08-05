import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateLibraryApp } from './CreateLibraryApp';

afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
});

function send(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data })));
}

function enterEditMode(): void {
  send({
    type: 'context',
    mode: 'edit',
    slug: 'real-analysis',
    existing: { slug: 'real-analysis', title: 'Real Analysis' }
  });
}

function sendGraph(overrides: Record<string, unknown> = {}): void {
  send({
    type: 'graph',
    nodes: [],
    relationships: [],
    entries: [],
    kinds: [],
    metricMacroSources: {},
    metricThresholds: { structuralIndexRedBelow: 60, structuralIndexGreenAtLeast: 80 },
    warnings: [],
    ...overrides
  });
}

describe('Library editor localization', () => {
  it('renders the create and title editor copy in Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(<CreateLibraryApp />);

    expect(view.getByRole('heading', { name: '创建文库' })).toBeTruthy();
    expect(view.getByText('文库标题')).toBeTruthy();
    expect(view.getByPlaceholderText('例如：实分析')).toBeTruthy();
    expect(view.getByRole('button', { name: '创建文库' })).toBeTruthy();
  });

  it('renders counters and outline copy in Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(<CreateLibraryApp />);
    enterEditMode();
    send({
      type: 'countersLoaded',
      counters: [
        { id: 'counter-a', name: 'theorem', numbering: '1', children: [] },
        { id: 'counter-b', name: 'theorem', numbering: 'A', children: [] }
      ]
    });
    sendGraph();

    expect(view.getByRole('heading', { name: '编辑文库' })).toBeTruthy();
    expect(view.getByText('标识（只读）')).toBeTruthy();
    expect(view.getByRole('heading', { name: '计数器（2）' })).toBeTruthy();
    expect(view.getAllByText('（名称重复）')).toHaveLength(2);
    expect(view.getByRole('heading', { name: '大纲' })).toBeTruthy();
    expect(view.getByText('0 个节点 · 0 条分支边')).toBeTruthy();
    expect(view.getByText('还没有条目 — 请点击下方的“添加根条目”。')).toBeTruthy();
  });

  it('renders pending entries and the add form in Chinese without translating ids', () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(<CreateLibraryApp />);
    enterEditMode();
    sendGraph({
      nodes: [{ id: 'node-1', label: 'entry', props: { entryId: 'pending-entry-id' } }]
    });

    expect(view.getByText('⚠ 待创建')).toBeTruthy();
    expect(view.getByText('pending-entry-id')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: '+ 添加根条目' }));
    expect(view.getByText('条目 ID')).toBeTruthy();
    expect(view.getByPlaceholderText('搜索现有条目，或输入新 ID 后点击“创建”')).toBeTruthy();
    expect(view.getByText('留空 — “创建”将打开“创建条目”面板')).toBeTruthy();
    expect(view.getByRole('button', { name: '取消' })).toBeTruthy();
  });
});
