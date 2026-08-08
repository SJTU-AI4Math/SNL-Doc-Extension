import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SnlGraphApp } from './SnlGraphApp';

afterEach(cleanup);

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

  it('switches graph node colors when the live VS Code body theme changes', async () => {
    document.body.className = 'vscode-light';
    const view = render(<SnlGraphApp />);
    send({
      type: 'graph', scope: { mode: 'pool' }, title: 'Relationship Graph',
      nodes: [
        { id: 'a', packageId: '_unpackaged', title: 'A', kind: 'Theorem', kindId: 'theorem', color: '#111111', background: '#eeeeee', coloring: { light: { stroke: '#111111', background: '#eeeeee' }, dark: { stroke: '#ffffff', background: '#222222' } } },
        { id: 'b', packageId: '_unpackaged', title: 'B', kind: 'Theorem', kindId: 'theorem', color: '#111111', background: '#eeeeee', coloring: { light: { stroke: '#111111', background: '#eeeeee' }, dark: { stroke: '#ffffff', background: '#222222' } } }
      ],
      edges: [{ id: 'e', from: 'a', to: 'b', label: 'uses', isDependency: false, isAtomic: null }],
      warnings: [], entryOptions: [], macros: {}, macroKinds: []
    });
    expect(view.container.querySelector('rect[fill="#eeeeee"]')).toBeTruthy();
    act(() => { document.body.className = 'vscode-dark'; });
    await waitFor(() => expect(view.container.querySelector('rect[fill="#222222"]')).toBeTruthy());
  });
});
