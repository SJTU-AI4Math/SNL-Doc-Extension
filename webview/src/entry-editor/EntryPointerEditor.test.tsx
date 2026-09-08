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

  it.each([
    { file: 'src\\a.ts', mode: 'lines', line: 3, endLine: 7, column: 2, endColumn: 5 },
    { file: 'src/a.ts', mode: 'regex', pattern: String.raw`start/--\s+end`, flags: 'mi', occurrence: 2 },
    { file: 'src/a.ts', mode: 'symbol', symbol: 'Future.target' },
    { file: 'src/a.ts', mode: 'regex', pattern: '[', flags: 'qq' }
  ])('retires stored context without changing untouched $mode addressing or opaque metadata', async (address) => {
    const expected = { ...address, priority: -1.5, opaque: { beforeLines: 'nested is not retired', keep: [1, 2] } };
    const pointer = { ...expected, beforeLines: -1, afterLines: 'future' };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    expect(view.queryByLabelText(/Before lines|After lines/i)).toBeNull();
    expect(loadDraft(api, 'createEntry:edit:thm-1')).toBeUndefined();
    fireEvent.change(view.getByLabelText('Title'), { target: { value: 'Retitled' } });
    fireEvent.click(view.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual(expected);
    expect(pointer.beforeLines).toBe(-1);
    expect(pointer.afterLines).toBe('future');
  });

  it.each(['lines', 'regex'])('does not resurrect retired %s draft fields after refresh, mode switches or remount', async (mode) => {
    const address = mode === 'lines' ? { line: 3, column: 2, endColumn: 9 } : { pattern: String.raw`first/--\s+last`, flags: 'mi', occurrence: 2 };
    const pointer = { file: 'src\\a.ts', mode, ...address, beforeLines: 4, afterLines: 8, opaque: { keep: true } };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    fireEvent.change(view.getByLabelText(/Priority/i), { target: { value: '-2.5' } });
    const saved = loadDraft<{ pointerDraft: Record<string, unknown> }>(api, 'createEntry:edit:thm-1')!;
    view.unmount();
    // Simulate an older persisted draft, including formerly invalid buffer text.
    saved.pointerDraft.beforeLines = 'invalid';
    saved.pointerDraft.afterLines = '-1';
    const restored = await renderEditor(pointer);
    fireEvent.click(sectionButton(restored, 'Pointer'));
    expect(restored.queryByLabelText(/Before lines|After lines/i)).toBeNull();
    expect((restored.getByLabelText(/Priority/i) as HTMLInputElement).value).toBe('-2.5');
    sendContext({ ...pointer, priority: 99, beforeLines: 100 });
    expect((restored.getByLabelText(/Priority/i) as HTMLInputElement).value).toBe('-2.5');
    const modeInput = restored.getByLabelText(/^Mode$/i);
    fireEvent.change(modeInput, { target: { value: mode === 'lines' ? 'regex' : 'lines' } });
    fireEvent.change(modeInput, { target: { value: mode } });
    await waitFor(() => {
      const draft = loadDraft<{ pointerDraft: Record<string, unknown> }>(api, 'createEntry:edit:thm-1')!.pointerDraft;
      expect(draft).not.toHaveProperty('beforeLines');
      expect(draft).not.toHaveProperty('afterLines');
    });
    restored.unmount();
    const reopened = await renderEditor(pointer);
    fireEvent.click(sectionButton(reopened, 'Pointer'));
    expect(reopened.queryByLabelText(/Before lines|After lines/i)).toBeNull();
    const update = reopened.getByRole('button', { name: /Update Entry/i }) as HTMLButtonElement;
    expect(update.disabled).toBe(false);
    fireEvent.click(update);
    expect(latestUpdate().entry.pointer).toEqual({ file: 'src\\a.ts', mode, ...address, priority: -2.5, opaque: { keep: true } });
  });

  it('restores older drafts with missing position and priority fields without buffer defaults', async () => {
    const pointer = { file: 'src/a.ts', mode: 'lines', line: 3 };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    fireEvent.change(view.getByLabelText(/Start line/i), { target: { value: '4' } });
    const saved = loadDraft<{ pointerDraft: Record<string, unknown> }>(api, 'createEntry:edit:thm-1')!;
    view.unmount();
    for (const field of ['beforeLines', 'afterLines', 'column', 'endColumn', 'priority']) delete saved.pointerDraft[field];
    const restored = await renderEditor(pointer);
    fireEvent.click(sectionButton(restored, 'Pointer'));
    expect(restored.queryByLabelText(/Before lines|After lines/i)).toBeNull();
    fireEvent.click(restored.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual({ ...pointer, line: 4 });
  });

  it('localizes exact-range and priority controls in Chinese without retired context controls', async () => {
    document.documentElement.lang = 'zh-CN';
    try {
      const view = render(<CreateEntryApp />);
      sendContext({ file: 'src/a.ts', mode: 'lines', line: 3, beforeLines: 0, afterLines: 6 });
      await waitFor(() => expect((view.getByLabelText('标题') as HTMLInputElement).value).toBe('Theorem One'));
      fireEvent.click(sectionButton(view, '指针'));
      expect(view.queryByLabelText(/前文|后文/)).toBeNull();
      expect((view.getByLabelText('起始列（可选）') as HTMLInputElement).title).toContain('UTF-16');
      expect((view.getByLabelText('结束列（可选）') as HTMLInputElement).title).toContain('不包含该列');
      const priority = view.getByLabelText('优先级（可选）') as HTMLInputElement;
      expect(priority.placeholder).toBe('0');
      fireEvent.change(priority, { target: { value: 'NaN' } });
      expect(view.getByRole('alert').textContent).toContain('有限数值');
    } finally {
      document.documentElement.lang = 'en';
    }
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

  it('joins two labeled regex inputs with fixed hidden slashes in one compact frame', async () => {
    const view = await renderEditor({ file: 'src/a.ts', mode: 'regex', pattern: 'target' });
    fireEvent.click(sectionButton(view, 'Pointer'));
    const pattern = view.getByLabelText(/Regex pattern/i) as HTMLInputElement;
    const flags = view.getByLabelText(/Regex flags/i) as HTMLInputElement;
    const frame = pattern.parentElement!;
    expect(flags.parentElement).toBe(frame);
    expect(Array.from(frame.children).map((child) => child.tagName)).toEqual(['SPAN', 'INPUT', 'SPAN', 'INPUT']);
    for (const slash of frame.querySelectorAll('span')) {
      expect(slash.textContent).toBe('/');
      expect(slash.getAttribute('aria-hidden')).toBe('true');
      expect(slash.hasAttribute('tabindex')).toBe(false);
    }
    expect(frame.style.display).toBe('flex');
    expect(frame.style.gap).toBe('0px');
    expect(frame.style.border).not.toBe('');
    expect(pattern.style.flexGrow).toBe('1');
    expect(pattern.style.minWidth).toBe('0px');
    expect(flags.style.width).toBe('6ch');
    expect(flags.style.flexShrink).toBe('0');
    for (const input of [pattern, flags]) {
      expect(input.style.marginBottom).toBe('0px');
      expect(input.style.borderWidth).toBe('0px');
      expect(input.tabIndex).toBe(0);
      expect(input.labels?.length).toBe(1);
    }
    const occurrence = view.getByLabelText(/Occurrence/i);
    expect(frame.contains(occurrence)).toBe(false);
    expect(frame.querySelectorAll('button').length).toBe(0);
    const inputs = Array.from(view.getByTestId('entry-pointer-editor').querySelectorAll('input'));
    expect(inputs.slice(inputs.indexOf(pattern), inputs.indexOf(pattern) + 3)).toEqual([pattern, flags, occurrence]);
  });

  it.each([String.raw`start/--\s+end`, String.raw`/a\/b/--\\path`, '/literal/mi'])('roundtrips raw pattern %j and flags independently through dirty remount and save', async (rawPattern) => {
    const pointer = { file: 'src/a.ts', mode: 'regex', pattern: 'old', flags: 'i', occurrence: 2,
      priority: -0.5, beforeLines: 9, afterLines: 4, opaque: { keep: ['yes'] } };
    const view = await renderEditor(pointer);
    fireEvent.click(sectionButton(view, 'Pointer'));
    fireEvent.change(view.getByLabelText(/Regex pattern/i), { target: { value: rawPattern } });
    fireEvent.change(view.getByLabelText(/Regex flags/i), { target: { value: 'mi' } });
    fireEvent.change(view.getByLabelText(/Occurrence/i), { target: { value: '3' } });
    view.unmount();
    const restored = await renderEditor(pointer);
    fireEvent.click(sectionButton(restored, 'Pointer'));
    expect((restored.getByLabelText(/Regex pattern/i) as HTMLInputElement).value).toBe(rawPattern);
    expect((restored.getByLabelText(/Regex flags/i) as HTMLInputElement).value).toBe('mi');
    fireEvent.click(restored.getByRole('button', { name: /Update Entry/i }));
    const expected = { file: 'src/a.ts', mode: 'regex', pattern: rawPattern, flags: 'mi', occurrence: 3,
      priority: -0.5, opaque: { keep: ['yes'] } };
    expect(latestUpdate().entry.pointer).toEqual(expected);
    restored.unmount();
    state = undefined;
    const reopened = await renderEditor(latestUpdate().entry.pointer);
    fireEvent.click(sectionButton(reopened, 'Pointer'));
    expect((reopened.getByLabelText(/Regex pattern/i) as HTMLInputElement).value).toBe(rawPattern);
    expect((reopened.getByLabelText(/Regex flags/i) as HTMLInputElement).value).toBe('mi');
    fireEvent.click(reopened.getByRole('button', { name: /Update Entry/i }));
    expect(latestUpdate().entry.pointer).toEqual(expected);
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
