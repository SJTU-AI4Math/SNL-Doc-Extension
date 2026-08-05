// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('./vscodeApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vscodeApi')>()),
  getVsCodeApi: () => api,
  useVsCodeApiRef: () => ({ current: api })
}));

import { EntryInfoviewApp } from './EntryInfoviewApp';

afterEach(() => {
  cleanup();
  api.postMessage.mockReset();
});

describe('EntryInfoview load errors', () => {
  it('shows strict relationship/read failures instead of an empty relationship view', () => {
    render(<EntryInfoviewApp />);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'entryDetailsError',
          entryId: 'entry-1',
          message: 'relationships.json has duplicate ids'
        }
      }));
    });

    expect(screen.getByRole('alert').textContent).toContain(
      'Could not load entry data: relationships.json has duplicate ids'
    );
    expect(screen.queryByText('Entry not found in this workspace.')).toBeNull();
  });
});
