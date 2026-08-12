import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SnlGraphApp } from './SnlGraphApp';
import { set_content_language } from './runtime/preferencesRuntime';

afterEach(() => {
  cleanup();
  set_content_language('en');
});

function send(message: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data: message })));
}

describe('SnlGraphApp strict refresh errors', () => {
  beforeEach(() => {
    (globalThis as any).__snlApi = { postMessage() {} };
  });

  it('renders an initial graph error instead of loading forever', () => {
    render(<SnlGraphApp />);
    send({ type: 'graphError', scope: { mode: 'pool' }, title: 'Relationship Graph', message: 'malformed entries' });
    expect(screen.getByText('malformed entries')).toBeTruthy();
    expect(screen.queryByText('Loading graph…')).toBeNull();
  });

  it('preserves the last valid snapshot while clearly marking it stale', () => {
    render(<SnlGraphApp />);
    send({
      type: 'graph', scope: { mode: 'pool' }, title: 'Relationship Graph',
      nodes: [], edges: [], warnings: [], entryOptions: [], macros: {}, macroKinds: []
    });
    send({ type: 'graphError', scope: { mode: 'pool' }, title: 'Relationship Graph', message: 'new read failed' });
    expect(screen.getByRole('alert').textContent).toContain('showing the last valid graph');
    expect(screen.getByRole('alert').textContent).toContain('new read failed');
  });

  it('reactively resolves raw localized Entry Kind names in graph filters', async () => {
    render(<SnlGraphApp />);
    const kind = {
      type: 'i18n', default_language: 'en', values: { en: 'Theorem', 'zh-CN': '定理' }
    };
    const coloring = {
      light: { stroke: '#111111', background: '#eeeeee' },
      dark: { stroke: '#dddddd', background: '#222222' }
    };
    send({
      type: 'graph', scope: { mode: 'pool' }, title: 'Relationship Graph',
      nodes: [
        { id: 'a', packageId: '_unpackaged', title: 'A', kind, kindId: 'theorem', coloring },
        { id: 'b', packageId: '_unpackaged', title: 'B', kind, kindId: 'theorem', coloring }
      ],
      edges: [{ id: 'r', from: 'a', to: 'b', label: 'depends', isDependency: false, isAtomic: null }],
      warnings: [], entryOptions: [], macros: {}, macroKinds: []
    });
    fireEvent.click(screen.getByTitle('Expand filters'));
    expect(screen.getAllByText('Theorem').length).toBeGreaterThan(0);

    act(() => set_content_language('zh-CN'));
    await waitFor(() => expect(screen.getAllByText('定理').length).toBeGreaterThan(0));
    expect(screen.queryAllByText('Theorem')).toHaveLength(0);
  });
});
