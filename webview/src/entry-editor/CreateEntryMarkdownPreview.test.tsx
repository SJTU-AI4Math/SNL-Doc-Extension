import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VsCodeApi } from '../vscodeApi';

vi.mock('../render/HoverPopoverProvider', () => ({
  HoverPopoverProvider: ({ children, markdownImageUrlTransform }: {
    children: React.ReactNode;
    markdownImageUrlTransform?: (source: string) => string;
  }) => <div data-provider-image-url={markdownImageUrlTransform?.('assets/preview.png')}>{children}</div>
}));
vi.mock('../render/EntrySurface', () => ({
  EntrySurface: ({ markdownImageUrlTransform }: {
    markdownImageUrlTransform?: (source: string) => string;
  }) => <img data-testid="draft-image" src={markdownImageUrlTransform?.('assets/preview.png')} />
}));

import { CreateEntryApp } from '../CreateEntryApp';

const api: VsCodeApi = {
  postMessage: vi.fn(),
  getState: () => undefined,
  setState: () => undefined
};
(globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi = () => api;

beforeEach(() => {
  document.documentElement.dataset.snlAssetBaseUri = 'snl-workspace-asset://workspace';
});
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.snlAssetBaseUri;
});

describe('CreateEntryApp Markdown live preview', () => {
  it('uses the workspace image URL transformer for the draft and its hover provider', async () => {
    const view = render(<CreateEntryApp />);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'context', targetGeneration: 0, mode: 'create', id: 'draft-entry',
        kinds: [{
          id: 'definition', name: 'Definition',
          coloring: { light: { stroke: '#888', background: '#eee' }, dark: { stroke: '#888', background: '#222' } },
          numbering: '1', style: 'default'
        }],
        entryPackages: ['_unpackaged'], selectedPackage: '_unpackaged',
        existingIds: [], relationships: []
      } }));
    });

    const image = await waitFor(() => view.getByTestId('draft-image') as HTMLImageElement);
    expect(image.getAttribute('src')).toBe('snl-workspace-asset://workspace/preview.png');
    expect(image.closest('[data-provider-image-url]')?.getAttribute('data-provider-image-url'))
      .toBe('snl-workspace-asset://workspace/preview.png');
  });
});
