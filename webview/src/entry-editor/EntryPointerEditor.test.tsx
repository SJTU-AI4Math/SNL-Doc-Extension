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
