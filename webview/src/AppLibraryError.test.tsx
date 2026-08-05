// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
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

describe('Library Infoview fatal graph errors', () => {
  it('shows an explicit invalid-library state instead of an empty outline', async () => {
    render(<App />);
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'libraryEntriesError',
        slug: 'notes',
        message: 'Could not resolve Library Entry references: malformed envelope'
      }
    }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/malformed envelope/);
    expect(screen.getByText(/Library unavailable: notes/)).toBeTruthy();
  });
});
