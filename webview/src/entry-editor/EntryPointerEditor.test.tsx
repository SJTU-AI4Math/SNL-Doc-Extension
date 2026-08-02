import React from 'react';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateEntryApp } from '../CreateEntryApp';
import { loadDraft } from '../components/draftState';
import type { VsCodeApi } from '../vscodeApi';

const posted: unknown[] = [];
let state: unknown;
const api: VsCodeApi = {
  postMessage: (message: unknown) => { posted.push(message); },
  getState: () => state,
  setState: (next: unknown) => { state = next; }
};
(globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi = () => api;

const kind = {
  id: 'theorem',
  name: 'Theorem',
  coloring: { stroke: '#888', background: '#222' },
  numbering: 'theorem',
  style: 'default'
};

function sendContext(pointer: unknown = null): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: {
      type: 'context',
      mode: 'edit',
      id: 'thm-1',
      kinds: [kind],
      existingIds: [{ id: 'thm-1', title: 'Theorem One' }],
      existing: {
        id: 'thm-1',
        title: 'Theorem One',
        kind: 'theorem',
        content: { snl: 'statement' },
        contribution_info: null,
        pointer
      },
      relationships: []
    }
  }));
}

async function renderEditor(pointer: unknown = null) {
  const view = render(<CreateEntryApp />);
  sendContext(pointer);
  await waitFor(() => expect((view.getByLabelText(/Title/i) as HTMLInputElement).value).toBe('Theorem One'));
  return view;
}

function sectionButton(view: ReturnType<typeof render>, name: string): HTMLButtonElement {
  const label = view.getByText(name, { selector: 'span[role="heading"]' });
  const button = label.closest('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error(`No disclosure button for ${name}`);
  return button;
}

function latestUpdate(): { type: string; entry: Record<string, unknown> } {
  const found = posted.findLast(
    (message): message is { type: string; entry: Record<string, unknown> } =>
      typeof message === 'object' && message !== null &&
      (message as { type?: string }).type === 'update'
  );
  if (!found) throw new Error('No update message was posted');
  return found;
}

beforeEach(() => {
  cleanup();
  posted.length = 0;
  state = undefined;
});
afterEach(cleanup);

describe('Entry editor secondary sections', () => {
  it('keeps every section except basic information and content collapsed by default', async () => {
    const view = await renderEditor();

    for (const name of ['Live Preview', 'Relationships', 'Contributor', 'Pointer']) {
      expect(sectionButton(view, name).getAttribute('aria-expanded')).toBe('false');
    }
    expect(view.getByText('Content')).toBeTruthy();
    expect(view.queryByText(/Not implemented yet — deferred until the contribution_info schema/i)).toBeNull();

    fireEvent.click(sectionButton(view, 'Live Preview'));
    expect(sectionButton(view, 'Live Preview').getAttribute('aria-expanded')).toBe('true');
    expect(view.getAllByText(/Theorem One/).length).toBeGreaterThan(0);
  });
});

describe('Entry pointer editor', () => {
  it('loads and saves a line-range pointer using the schema field names', async () => {
    const view = await renderEditor({
      file: 'src/original.ts',
      mode: 'lines',
      line: 4,
      endLine: 9
    });

    fireEvent.click(sectionButton(view, 'Pointer'));
    const section = view.getByTestId('entry-pointer-editor');
    expect((within(section).getByLabelText(/Project-relative file/i) as HTMLInputElement).value).toBe('src/original.ts');
    expect((within(section).getByLabelText(/^Mode$/i) as HTMLSelectElement).value).toBe('lines');

    fireEvent.change(within(section).getByLabelText(/Project-relative file/i), {
      target: { value: 'src/updated.ts' }
    });
    fireEvent.change(within(section).getByLabelText(/Start line/i), { target: { value: '12' } });
    fireEvent.change(within(section).getByLabelText(/End line/i), { target: { value: '15' } });
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));

    expect(latestUpdate().entry.pointer).toEqual({
      file: 'src/updated.ts',
      mode: 'lines',
      line: 12,
      endLine: 15
    });
  });

  it('switches to regex-dependent fields and saves only the regex schema', async () => {
    const view = await renderEditor({ file: 'src/a.ts', mode: 'lines', line: 7, endLine: 8 });
    fireEvent.click(sectionButton(view, 'Pointer'));
    const section = view.getByTestId('entry-pointer-editor');

    fireEvent.change(within(section).getByLabelText(/^Mode$/i), { target: { value: 'regex' } });
    fireEvent.change(within(section).getByLabelText(/Regex pattern/i), { target: { value: 'function\\s+prove' } });
    fireEvent.change(within(section).getByLabelText(/Regex flags/i), { target: { value: 'im' } });
    fireEvent.change(within(section).getByLabelText(/Occurrence/i), { target: { value: '3' } });
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));

    expect(latestUpdate().entry.pointer).toEqual({
      file: 'src/a.ts',
      mode: 'regex',
      pattern: 'function\\s+prove',
      flags: 'im',
      occurrence: 3
    });
  });

  it('can remove an existing pointer without leaving stale mode fields', async () => {
    const view = await renderEditor({ file: 'src/a.ts', mode: 'regex', pattern: 'target' });
    fireEvent.click(sectionButton(view, 'Pointer'));
    const section = view.getByTestId('entry-pointer-editor');
    fireEvent.click(within(section).getByLabelText(/Bind this Entry/i));
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toBeNull();
  });

  it('does not treat opening a collapsed section as an Entry edit', async () => {
    const futurePointer = {
      file: 'src/a.ts',
      mode: 'symbol',
      symbol: 'Namespace.target'
    };
    const view = await renderEditor(futurePointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    expect(loadDraft<Record<string, unknown>>(api, 'createEntry:edit:thm-1')).toBeUndefined();

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'context',
        mode: 'edit',
        id: 'thm-1',
        kinds: [kind],
        existingIds: [{ id: 'thm-1', title: 'Externally Updated' }],
        existing: {
          id: 'thm-1', title: 'Externally Updated', kind: 'theorem',
          content: { snl: 'external' }, contribution_info: null, pointer: futurePointer
        },
        relationships: []
      }
    }));
    await waitFor(() =>
      expect((view.getByLabelText(/Title/i) as HTMLInputElement).value).toBe('Externally Updated')
    );
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual(futurePointer);
  });

  it('allows unrelated edits while preserving an untouched malformed stored pointer', async () => {
    const malformed = { file: 'src/a.ts', mode: 'regex', pattern: '[', flags: 'qq' };
    const view = await renderEditor(malformed);
    fireEvent.change(view.getByLabelText(/Title/i), { target: { value: 'Retitled' } });
    const update = view.getByRole('button', { name: /Update Entry/i }) as HTMLButtonElement;
    expect(update.disabled).toBe(false);
    fireEvent.click(update);
    expect(latestUpdate().entry.pointer).toEqual(malformed);
  });

  it('announces pointer validation errors and associates them with the invalid field', async () => {
    const view = await renderEditor({ file: 'src/a.ts', mode: 'regex', pattern: 'valid' });
    fireEvent.click(sectionButton(view, 'Pointer'));
    const section = view.getByTestId('entry-pointer-editor');
    const pattern = within(section).getByLabelText(/Regex pattern/i);
    fireEvent.change(pattern, { target: { value: '[' } });

    const alert = within(section).getByRole('alert');
    expect(alert.textContent).toMatch(/Invalid regular expression/i);
    expect(pattern.getAttribute('aria-invalid')).toBe('true');
    expect(pattern.getAttribute('aria-describedby')).toBe(alert.id);
  });
});
