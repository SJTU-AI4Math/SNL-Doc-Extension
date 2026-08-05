import { act, cleanup, render, screen } from '@testing-library/react';
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
});
