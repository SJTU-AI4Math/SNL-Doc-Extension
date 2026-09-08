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
  coloring: { light: { stroke: '#888', background: '#222' }, dark: { stroke: '#888', background: '#222' } },
  numbering: 'theorem',
  style: 'default'
};

function sendContext(pointer: unknown = null): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: {
      type: 'context',
      mode: 'edit',
      entryRevision: 'pointer-test-revision',
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
  await waitFor(() => expect((view.getByLabelText('Title') as HTMLInputElement).value).toBe('Theorem One'));
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
  it('keeps Preview visible while secondary metadata sections start collapsed', async () => {
    const view = await renderEditor();

    for (const name of ['Relationships', 'Contributor', 'Pointer']) {
      expect(sectionButton(view, name).getAttribute('aria-expanded')).toBe('false');
    }
    expect(view.getByRole('heading', { name: 'Live Preview' })).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Live Preview' })).toBeNull();
    expect(view.getAllByText(/Theorem One/).length).toBeGreaterThan(0);
    expect(view.getByText('Content')).toBeTruthy();
    expect(view.queryByText(/Not implemented yet — deferred until the contribution_info schema/i)).toBeNull();
  });
});

describe('Entry pointer editor', () => {
  it('edits exact half-open coordinates and fractional priority without losing opaque metadata or CAS', async () => {
    const pointer = { file: 'src/a.ts', mode: 'lines', line: 4, column: 2, endColumn: 7, priority: 0, extension: { keep: true } };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    expect((view.getByLabelText(/Start column/i) as HTMLInputElement).value).toBe('2');
    expect((view.getByLabelText(/End column/i) as HTMLInputElement).value).toBe('7');
    expect((view.getByLabelText(/Priority/i) as HTMLInputElement).value).toBe('0');
    fireEvent.change(view.getByLabelText(/Start column/i), { target: { value: '3' } });
    fireEvent.change(view.getByLabelText(/Priority/i), { target: { value: '-1.5' } });
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({ ...pointer, column: 3, priority: -1.5 });
    expect(latestUpdate()).toMatchObject({ expectedRevision: 'pointer-test-revision' });
  });

  it.each(['lines', 'regex'])('creates and reopens a %s Pointer with explicit zero priority', async (mode) => {
    const view = render(<CreateEntryApp />);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'create', kinds: [kind], existing: null,
      selectedPackage: '_unpackaged', entryPackages: ['_unpackaged'], existingIds: []
    }}));
    await waitFor(() => expect(view.getByLabelText('Title')).toBeTruthy());
    fireEvent.change(view.container.querySelector('#snl-entry-id')!, { target: { value: 'thm-1' } });
    fireEvent.change(view.getByLabelText('Title'), { target: { value: 'Theorem One' } });
    fireEvent.click(sectionButton(view, 'Pointer'));
    fireEvent.click(view.getByLabelText(/Bind this Entry/i));
    fireEvent.change(view.getByLabelText(/Project-relative file/i), { target: { value: 'src/a.ts' } });
    fireEvent.change(view.getByLabelText(/^Mode$/i), { target: { value: mode } });
    if (mode === 'regex') {
      fireEvent.change(view.getByLabelText(/Regex pattern/i), { target: { value: 'target' } });
      expect(view.queryByLabelText(/Start column/i)).toBeNull();
    } else {
      fireEvent.change(view.getByLabelText(/Start column/i), { target: { value: '1' } });
      fireEvent.change(view.getByLabelText(/End column/i), { target: { value: '1' } });
    }
    fireEvent.change(view.getByLabelText(/Priority/i), { target: { value: '0' } });
    fireEvent.click(view.getByRole('button', { name: /^Create Entry$/i }));
    const created = posted.findLast((m) => (m as { type?: string }).type === 'create') as { entry: { pointer: unknown } };
    const expected = { file: 'src/a.ts', mode, priority: 0,
      ...(mode === 'lines' ? { line: 1, column: 1, endColumn: 1 } : { pattern: 'target' }) };
    expect(created?.entry.pointer).toEqual(expected);
    view.unmount();
    const reopened = await renderEditor(created.entry.pointer);
    fireEvent.click(sectionButton(reopened, 'Pointer'));
    expect((reopened.getByLabelText(/Priority/i) as HTMLInputElement).value).toBe('0');
    fireEvent.click(reopened.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual(expected);
  });

  it.each(['lines', 'regex'])('clears priority to omission without normalizing %s addressing', async (mode) => {
    const address = mode === 'lines' ? { line: 3, column: 2, endColumn: 9 } : { pattern: 'target', flags: 'm' };
    const pointer = { file: 'src\\a.ts', mode, ...address, priority: -0.25, opaque: { keep: true } };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    fireEvent.change(view.getByLabelText(/Priority/i), { target: { value: '' } });
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    const { priority: _, ...expected } = pointer;
    expect(latestUpdate().entry.pointer).toEqual(expected);
  });

  it('restores position drafts after remount and omits cleared columns with opaque metadata intact', async () => {
    const pointer = { file: 'src/a.ts', mode: 'lines', line: 3, column: 2, endColumn: 9, priority: 4, opaque: [1] };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    fireEvent.change(view.getByLabelText(/Start column/i), { target: { value: '5' } });
    fireEvent.change(view.getByLabelText(/Priority/i), { target: { value: '-2.5' } });
    sendContext({ ...pointer, column: 8, priority: 99 });
    expect((view.getByLabelText(/Start column/i) as HTMLInputElement).value).toBe('5');
    view.unmount();
    const restored = await renderEditor(pointer);
    fireEvent.click(sectionButton(restored, 'Pointer'));
    expect((restored.getByLabelText(/Start column/i) as HTMLInputElement).value).toBe('5');
    expect((restored.getByLabelText(/Priority/i) as HTMLInputElement).value).toBe('-2.5');
    for (const label of [/Start column/i, /End column/i]) fireEvent.change(restored.getByLabelText(label), { target: { value: '' } });
    fireEvent.click(restored.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({ file: 'src/a.ts', mode: 'lines', line: 3, priority: -2.5, opaque: [1] });
  });

  it('retains inactive position drafts without leaking columns to regex or losing metadata', async () => {
    const pointer = { file: 'src\\a.ts', mode: 'lines', line: 4, column: 3, endColumn: 6, opaque: { keep: true } };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    const mode = view.getByLabelText(/^Mode$/i);
    fireEvent.change(mode, { target: { value: 'regex' } });
    fireEvent.change(view.getByLabelText(/Regex pattern/i), { target: { value: 'draft' } });
    fireEvent.change(view.getByLabelText(/Priority/i), { target: { value: '-1.25' } });
    expect(view.queryByLabelText(/Start column/i)).toBeNull();
    fireEvent.change(mode, { target: { value: 'lines' } });
    expect((view.getByLabelText(/Start column/i) as HTMLInputElement).value).toBe('3');
    expect((view.getByLabelText(/End column/i) as HTMLInputElement).value).toBe('6');
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({ ...pointer, priority: -1.25 });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'updated', id: 'thm-1' } }));
    await waitFor(() => expect((view.getByRole('button', { name: /Update Entry/i }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(mode, { target: { value: 'regex' } });
    expect((view.getByLabelText(/Regex pattern/i) as HTMLInputElement).value).toBe('draft');
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({ file: 'src/a.ts', mode: 'regex', pattern: 'draft', priority: -1.25, opaque: { keep: true } });
  });

  it.each(['', '4'])('rejects inverted same-line columns with endLine %j, accepting equal endpoints', async (endLine) => {
    const pointer = { file: 'src/a.ts', mode: 'lines', line: 4, ...(endLine ? { endLine: 4 } : {}), column: 5, endColumn: 8 };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    const end = view.getByLabelText(/End column/i);
    fireEvent.change(end, { target: { value: '4' } });
    expect(view.getByRole('alert').textContent).toContain('must not precede');
    expect(end.getAttribute('aria-invalid')).toBe('true');
    const update = view.getByRole('button', { name: /Update Entry/i }) as HTMLButtonElement;
    expect(update.disabled).toBe(true);
    fireEvent.change(end, { target: { value: '5' } });
    expect(update.disabled).toBe(false);
    fireEvent.click(update);
    expect(latestUpdate().entry.pointer).toEqual({ ...pointer, endColumn: 5 });
  });

  it('allows increasing lines with decreasing columns and safe maximum columns', async () => {
    const pointer = { file: 'src/a.ts', mode: 'lines', line: 4, endLine: 5 };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    fireEvent.change(view.getByLabelText(/Start column/i), { target: { value: '9007199254740991' } });
    fireEvent.change(view.getByLabelText(/End column/i), { target: { value: '1' } });
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({ ...pointer, column: Number.MAX_SAFE_INTEGER, endColumn: 1 });
  });

  for (const label of ['Start column', 'End column', 'End line']) {
    it.each(['0', '-1', '1.5', '9007199254740992', 'text', '1e2', ' '])(`blocks malformed ${label} %j without silently omitting it`, async (input) => {
      const view = await renderEditor({ file: 'src/a.ts', mode: 'lines', line: 1 });
      fireEvent.click(sectionButton(view, 'Pointer'));
      const field = view.getByLabelText(new RegExp(label));
      fireEvent.change(field, { target: { value: input } });
      const update = view.getByRole('button', { name: /Update Entry/i }) as HTMLButtonElement;
      expect(update.disabled).toBe(true);
      expect(field.getAttribute('aria-invalid')).toBe('true');
      fireEvent.click(update);
      fireEvent.keyDown(document, { key: 's', ctrlKey: true });
      expect(posted.some((m) => (m as { type?: string }).type === 'update')).toBe(false);
      fireEvent.change(field, { target: { value: '' } });
      expect(update.disabled).toBe(false);
    });
  }

  for (const mode of ['lines', 'regex']) {
    it.each(['NaN', 'Infinity', '-Infinity', '1e309', 'text', ' ', '0x10'])(`blocks nonfinite or malformed priority %j in ${mode}`, async (input) => {
      const view = await renderEditor({ file: 'src/a.ts', mode, ...(mode === 'lines' ? { line: 1 } : { pattern: 'target' }) });
      fireEvent.click(sectionButton(view, 'Pointer'));
      const field = view.getByLabelText(/Priority/i);
      fireEvent.change(field, { target: { value: input } });
      const update = view.getByRole('button', { name: /Update Entry/i }) as HTMLButtonElement;
      expect(update.disabled).toBe(true);
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(view.getByRole('alert').textContent).toContain('finite number');
      fireEvent.keyDown(document, { key: 's', ctrlKey: true });
      expect(posted.some((m) => (m as { type?: string }).type === 'update')).toBe(false);
      fireEvent.change(field, { target: { value: '' } });
      expect(update.disabled).toBe(false);
    });
  }

  it('hydrates asymmetric context and edits only its leaves, preserving opaque Pointer metadata', async () => {
    const pointer = {
      file: 'src\\a.ts', mode: 'lines', line: 4, endLine: 9,
      beforeLines: 0, afterLines: 23, extension: { anchor: 'keep' }
    };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    const section = within(view.getByTestId('entry-pointer-editor'));
    const before = section.getByLabelText(/Before lines/i) as HTMLInputElement;
    const after = section.getByLabelText(/After lines/i) as HTMLInputElement;
    expect(before.value).toBe('0');
    expect(after.value).toBe('23');
    fireEvent.change(after, { target: { value: '8' } });
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({ ...pointer, afterLines: 8 });
  });

  it.each([
    { file: 'src/a.ts', mode: 'lines', line: 3, endLine: 7 },
    { file: 'src/a.ts', mode: 'regex', pattern: 'start[\\s\\S]*end', flags: 'm', occurrence: 2 }
  ])('keeps omitted defaults independent and accepts zero and the safe maximum in $mode mode', async (pointer) => {
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    const section = within(view.getByTestId('entry-pointer-editor'));
    const before = section.getByLabelText(/Before lines/i) as HTMLInputElement;
    const after = section.getByLabelText(/After lines/i) as HTMLInputElement;
    expect(before.value).toBe('');
    expect(after.value).toBe('');
    expect(before.placeholder).toBe('15');
    expect(after.placeholder).toBe('15');
    expect(before.title).toMatch(/actual start, not the cursor/);
    expect(after.title).toMatch(/actual end, not the cursor/);
    expect(loadDraft(api, 'createEntry:edit:thm-1')).toBeUndefined();
    fireEvent.change(before, { target: { value: '0' } });
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({ ...pointer, beforeLines: 0 });
    // Complete the host acknowledgement before the next save.
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'updated', id: 'thm-1' } }));
    await waitFor(() => expect((view.getByRole('button', { name: /Update Entry/i }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(before, { target: { value: '' } });
    fireEvent.change(after, { target: { value: '9007199254740991' } });
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({ ...pointer, afterLines: Number.MAX_SAFE_INTEGER });
  });

  it.each(['lines', 'regex'])('clears explicit context values without materializing defaults in %s mode', async (mode) => {
    const address = mode === 'lines' ? { line: 5 } : { pattern: 'target' };
    const pointer = { file: 'src/a.ts', mode, ...address, beforeLines: 6, afterLines: 0, opaque: [1, 2] };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    const section = within(view.getByTestId('entry-pointer-editor'));
    for (const label of [/Before lines/i, /After lines/i]) {
      fireEvent.change(section.getByLabelText(label), { target: { value: '' } });
    }
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({ file: 'src/a.ts', mode, ...address, opaque: [1, 2] });
  });

  it('does not lose opaque metadata when returning from an inactive mode draft to edit context', async () => {
    const pointer = { file: 'src/a.ts', mode: 'lines', line: 3, extension: { keep: true } };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    const mode = view.getByLabelText(/^Mode$/i);
    fireEvent.change(mode, { target: { value: 'regex' } });
    fireEvent.change(view.getByLabelText(/Regex pattern/i), { target: { value: 'draft' } });
    fireEvent.change(mode, { target: { value: 'lines' } });
    fireEvent.change(view.getByLabelText(/After lines/i), { target: { value: '0' } });
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({ ...pointer, afterLines: 0 });
  });

  it('preserves both mode drafts and context values through mode switches', async () => {
    const view = await renderEditor({ file: 'src/a.ts', mode: 'regex', pattern: 'first\\nlast', flags: 'm', occurrence: 2, beforeLines: 2, afterLines: 8 });
    fireEvent.click(sectionButton(view, 'Pointer'));
    const section = within(view.getByTestId('entry-pointer-editor'));
    const mode = section.getByLabelText(/^Mode$/i);
    fireEvent.change(mode, { target: { value: 'lines' } });
    fireEvent.change(section.getByLabelText(/Start line/i), { target: { value: '10' } });
    fireEvent.change(section.getByLabelText(/End line/i), { target: { value: '20' } });
    fireEvent.change(section.getByLabelText(/Before lines/i), { target: { value: '0' } });
    fireEvent.change(mode, { target: { value: 'regex' } });
    expect((section.getByLabelText(/Regex pattern/i) as HTMLInputElement).value).toBe('first\\nlast');
    expect((section.getByLabelText(/Before lines/i) as HTMLInputElement).value).toBe('0');
    expect((section.getByLabelText(/After lines/i) as HTMLInputElement).value).toBe('8');
    fireEvent.change(mode, { target: { value: 'lines' } });
    expect((section.getByLabelText(/Start line/i) as HTMLInputElement).value).toBe('10');
    expect((section.getByLabelText(/End line/i) as HTMLInputElement).value).toBe('20');
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({ file: 'src/a.ts', mode: 'lines', line: 10, endLine: 20, beforeLines: 0, afterLines: 8 });
  });

  for (const mode of ['lines', 'regex']) {
    for (const label of ['Before lines', 'After lines']) {
      it.each(['-1', '1.5', '9007199254740992', 'text', '1e2', ' '])(`blocks invalid ${label} %j in ${mode} mode`, async (input) => {
        const pointer = mode === 'lines'
          ? { file: 'src/a.ts', mode, line: 1 }
          : { file: 'src/a.ts', mode, pattern: 'target' };
        const view = await renderEditor(pointer);
        fireEvent.click(sectionButton(view, 'Pointer'));
        const section = within(view.getByTestId('entry-pointer-editor'));
        const field = section.getByLabelText(new RegExp(label));
        fireEvent.change(field, { target: { value: input } });
        const alert = section.getByRole('alert');
        expect(alert.textContent).toContain('nonnegative safe integer');
        expect(field.getAttribute('aria-invalid')).toBe('true');
        expect(field.getAttribute('aria-describedby')).toBe(alert.id);
        const update = view.getByRole('button', { name: /Update Entry/i }) as HTMLButtonElement;
        expect(update.disabled).toBe(true);
        posted.length = 0;
        fireEvent.click(update);
        fireEvent.keyDown(document, { key: 's', ctrlKey: true });
        expect(posted.some((message) => (message as { type?: string }).type === 'update')).toBe(false);
        fireEvent.change(field, { target: { value: '' } });
        expect(update.disabled).toBe(false);
        expect(section.queryByRole('alert')).toBeNull();
      });
    }
  }

  it('marks context edits dirty, restores them after remount and keeps same-target refreshes out', async () => {
    const pointer = { file: 'src/a.ts', mode: 'lines', line: 4, beforeLines: 1, afterLines: 2, opaque: 'keep' };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    fireEvent.change(view.getByLabelText(/Before lines/i), { target: { value: '0' } });
    await waitFor(() => expect(loadDraft<{ pointerDraft: { beforeLines: string } }>(api, 'createEntry:edit:thm-1')?.pointerDraft.beforeLines).toBe('0'));
    sendContext({ ...pointer, beforeLines: 12, afterLines: 30 });
    await waitFor(() => expect((view.getByLabelText(/Before lines/i) as HTMLInputElement).value).toBe('0'));
    expect((view.getByLabelText(/After lines/i) as HTMLInputElement).value).toBe('2');
    view.unmount();
    const restored = await renderEditor(pointer);
    fireEvent.click(sectionButton(restored, 'Pointer'));
    expect((restored.getByLabelText(/Before lines/i) as HTMLInputElement).value).toBe('0');
    fireEvent.click(restored.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({ ...pointer, beforeLines: 0 });
  });

  it.each(['lines', 'regex'])('authors asymmetric context on a newly enabled %s Pointer', async (mode) => {
    const view = await renderEditor();
    fireEvent.click(sectionButton(view, 'Pointer'));
    const section = within(view.getByTestId('entry-pointer-editor'));
    fireEvent.click(section.getByLabelText(/Bind this Entry/i));
    fireEvent.change(section.getByLabelText(/Project-relative file/i), { target: { value: 'src/new.ts' } });
    fireEvent.change(section.getByLabelText(/^Mode$/i), { target: { value: mode } });
    if (mode === 'regex') fireEvent.change(section.getByLabelText(/Regex pattern/i), { target: { value: 'target' } });
    fireEvent.change(section.getByLabelText(/Before lines/i), { target: { value: '0' } });
    fireEvent.change(section.getByLabelText(/After lines/i), { target: { value: '9' } });
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({
      file: 'src/new.ts', mode, ...(mode === 'lines' ? { line: 1 } : { pattern: 'target' }), beforeLines: 0, afterLines: 9
    });
  });

  it('absorbs new context values after disclosure-only interaction and resets them on retarget', async () => {
    const pointer = { file: 'src/a.ts', mode: 'lines', line: 3, beforeLines: 1, afterLines: 8 };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    sendContext({ ...pointer, beforeLines: 0, afterLines: 21 });
    await waitFor(() => expect((view.getByLabelText(/After lines/i) as HTMLInputElement).value).toBe('21'));
    expect((view.getByLabelText(/Before lines/i) as HTMLInputElement).value).toBe('0');
    expect(loadDraft(api, 'createEntry:edit:thm-1')).toBeUndefined();
    fireEvent.change(view.getByLabelText(/After lines/i), { target: { value: '99' } });
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'edit', id: 'thm-2', kinds: [kind], existingIds: [], relationships: [],
      existing: { id: 'thm-2', title: 'Second', kind: 'theorem', content: { snl: 'second' },
        pointer: { file: 'src/b.ts', mode: 'regex', pattern: 'other' } }
    }}));
    await waitFor(() => expect((view.getByLabelText('Title') as HTMLInputElement).value).toBe('Second'));
    if (sectionButton(view, 'Pointer').getAttribute('aria-expanded') === 'false') fireEvent.click(sectionButton(view, 'Pointer'));
    expect((view.getByLabelText(/Before lines/i) as HTMLInputElement).value).toBe('');
    expect((view.getByLabelText(/After lines/i) as HTMLInputElement).value).toBe('');
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({ file: 'src/b.ts', mode: 'regex', pattern: 'other' });
  });

  it('restores pre-context-field drafts with omitted defaults', async () => {
    const pointer = { file: 'src/a.ts', mode: 'lines', line: 3 };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    fireEvent.change(view.getByLabelText(/Start line/i), { target: { value: '4' } });
    const saved = loadDraft<{ pointerDraft: Record<string, unknown> }>(api, 'createEntry:edit:thm-1')!;
    view.unmount();
    delete saved.pointerDraft.beforeLines;
    delete saved.pointerDraft.afterLines;
    delete saved.pointerDraft.column;
    delete saved.pointerDraft.endColumn;
    delete saved.pointerDraft.priority;
    const restored = await renderEditor(pointer);
    fireEvent.click(sectionButton(restored, 'Pointer'));
    expect((restored.getByLabelText(/Before lines/i) as HTMLInputElement).value).toBe('');
    expect((restored.getByLabelText(/After lines/i) as HTMLInputElement).value).toBe('');
    fireEvent.click(restored.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({ ...pointer, line: 4 });
  });

  it('localizes context labels, range tooltips and validation in Chinese', async () => {
    document.documentElement.lang = 'zh-CN';
    try {
      const view = render(<CreateEntryApp />);
      sendContext({ file: 'src/a.ts', mode: 'lines', line: 3, beforeLines: 0, afterLines: 6 });
      await waitFor(() => expect((view.getByLabelText('标题') as HTMLInputElement).value).toBe('Theorem One'));
      fireEvent.click(sectionButton(view, '指针'));
      const before = view.getByLabelText('前文行数（可选）') as HTMLInputElement;
      const after = view.getByLabelText('后文行数（可选）') as HTMLInputElement;
      expect(before.value).toBe('0');
      expect(after.value).toBe('6');
      expect(before.title).toContain('实际起始位置');
      expect(after.title).toContain('实际结束位置');
      expect(before.title).toContain('最终反向引用范围');
      expect(after.title).toContain('不是查询回退距离');
      expect((view.getByLabelText('起始列（可选）') as HTMLInputElement).title).toContain('UTF-16');
      expect((view.getByLabelText('结束列（可选）') as HTMLInputElement).title).toContain('不包含该列');
      const priority = view.getByLabelText('优先级（可选）') as HTMLInputElement;
      expect(priority.placeholder).toBe('0');
      expect(priority.title).toContain('最终范围较小者');
      fireEvent.change(priority, { target: { value: 'NaN' } });
      expect(view.getByRole('alert').textContent).toContain('有限数值');
      fireEvent.change(priority, { target: { value: '' } });
      fireEvent.change(before, { target: { value: '-1' } });
      expect(view.getByRole('alert').textContent).toContain('非负安全整数');
    } finally {
      document.documentElement.lang = 'en';
    }
  });

  it('preserves untouched legacy context metadata during unrelated edits', async () => {
    const pointer = { file: 'src/a.ts', mode: 'lines', line: 3, beforeLines: -1, afterLines: 'future', opaque: { keep: true } };
    const view = await renderEditor(pointer);
    fireEvent.change(view.getByLabelText('Title'), { target: { value: 'Retitled' } });
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual(pointer);
  });

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
      expect((view.getByLabelText('Title') as HTMLInputElement).value).toBe('Externally Updated')
    );
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual(futurePointer);
  });

  it('allows unrelated edits while preserving an untouched malformed stored pointer', async () => {
    const malformed = { file: 'src/a.ts', mode: 'regex', pattern: '[', flags: 'qq' };
    const view = await renderEditor(malformed);
    fireEvent.change(view.getByLabelText('Title'), { target: { value: 'Retitled' } });
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
