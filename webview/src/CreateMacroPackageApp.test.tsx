import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CreateMacroPackageApp } from './CreateMacroPackageApp';
import type { VsCodeApi } from './vscodeApi';

const posted: unknown[] = [];
const api: VsCodeApi = {
  postMessage: (message: unknown) => { posted.push(message); },
  getState: () => undefined,
  setState: () => undefined
};

beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi = () => api;
});

beforeEach(() => posted.splice(0));
afterEach(() => cleanup());

describe('CreateMacroPackageApp stale-edit protection', () => {
  it('preserves a dirty draft and its original revision across watcher refreshes', async () => {
    const view = render(<CreateMacroPackageApp />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'edit', file: 'Logic', packageRevision: 'revision-1',
      existing: { file: 'Logic', name: 'Original', description: 'before' }
    } }));
    const name = await view.findByLabelText('Display name') as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Original'));
    fireEvent.change(name, { target: { value: 'Unsaved draft' } });

    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'edit', file: 'Logic', packageRevision: 'revision-2',
      existing: { file: 'Logic', name: 'External edit', description: 'outside' }
    } }));
    await waitFor(() => expect(name.value).toBe('Unsaved draft'));

    fireEvent.click(view.getByRole('button', { name: /update package/i }));
    await waitFor(() => expect(posted).toContainEqual(expect.objectContaining({
      type: 'update', file: 'Logic', name: 'Unsaved draft', expectedRevision: 'revision-1'
    })));
  });
});
