// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('./vscodeApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vscodeApi')>()),
  getVsCodeApi: () => api,
  useVsCodeApiRef: () => ({ current: api })
}));

import { CreateLibraryApp } from './CreateLibraryApp';

afterEach(() => {
  cleanup();
  api.postMessage.mockReset();
});

describe('Library counter errors', () => {
  it('surfaces a failed counter mutation while preserving the existing tree', () => {
    render(<CreateLibraryApp />);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'context',
          mode: 'edit',
          slug: 'algebra',
          existing: { title: 'Algebra' }
        }
      }));
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'countersLoaded',
          counters: [{ id: 'counter-1', name: 'theorem', numbering: '1', children: [] }]
        }
      }));
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'countersError', message: 'revision conflict' }
      }));
    });

    expect(screen.getByRole('alert').textContent).toContain(
      'Counter update failed: revision conflict'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand counters' }));
    expect(screen.getByDisplayValue('theorem')).toBeDefined();
  });
});
