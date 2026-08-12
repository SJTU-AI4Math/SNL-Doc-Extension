// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VsCodeApi } from '../vscodeApi';

vi.mock('../entry-editor/MonacoTextEditor', () => ({
  MonacoTextEditor: ({ value, ariaLabel, onChange }: {
    value: string;
    ariaLabel: string;
    onChange: (next: string) => void;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}));

import { CreateEntryApp } from '../CreateEntryApp';

const api: VsCodeApi = {
  postMessage: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn()
};
(globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi = () => api;

function pushContext(): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'context',
    mode: 'edit',
    targetState: 'found',
    id: 'entry-a',
    entryRevision: 'revision-entry-a',
    kinds: [{
      id: 'definition', name: 'Definition', style: '', defaultCounterName: 'definition',
      coloring: {
        light: { stroke: '#111111', background: '#eeeeee' },
        dark: { stroke: '#dddddd', background: '#222222' }
      }
    }],
    macros: {
      Known: {
        name: 'Known', description: '', kind: 'const', dynamic_arity: false, tags: [],
        source: { entries: [], urls: ['https://example.test/known'] },
        styles: [{
          style_name: 'default', tags: [],
          template: { mode: 'formula_inline', body: '\\mathrm{Known}' }
        }]
      }
    },
    macroKinds: [],
    macroOrigin: {},
    metricThresholds: { structuralIndexRedBelow: 60, structuralIndexGreenAtLeast: 80 },
    entryPackages: ['logic'],
    selectedPackage: 'logic',
    existingIds: [{ id: 'entry-a', package: 'logic', title: 'Entry A', hasContent: true, snl: 'Known' }],
    relationships: [],
    existing: {
      id: 'entry-a', package: 'logic', kind: 'definition', title: 'Entry A',
      content: { snl: 'Known' }, contribution_info: null, pointer: null
    }
  }})));
}

beforeEach(() => {
  cleanup();
  vi.mocked(api.postMessage).mockClear();
  (api.getState as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  document.documentElement.lang = 'en';
});
afterEach(cleanup);

describe('Entry editor live SSI', () => {
  it('renders between Preview and Content and updates with the current SNL draft', async () => {
    const view = render(<CreateEntryApp />);
    pushContext();

    const ssi = await waitFor(() => view.getByTestId('entry-editor-ssi'));
    expect(ssi.textContent).toContain('SSI');
    expect(ssi.textContent).toContain('1.00');

    const preview = view.getByRole('heading', { name: 'Live Preview' }).closest('section')!;
    const content = view.getByText('Content', { selector: 'label' }).parentElement!;
    expect(preview.compareDocumentPosition(ssi) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ssi.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: 'Text Editor' }));
    fireEvent.change(view.getByLabelText('SNL source editor'), {
      target: { value: 'Unknown' }
    });
    await waitFor(() => expect(ssi.textContent).toContain('0.00'));
  });
});
