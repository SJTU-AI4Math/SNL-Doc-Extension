import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import { CreateEntryApp } from '../CreateEntryApp';
import { loadDraft, saveDraft } from '../components/draftState';
import type { VsCodeApi } from '../vscodeApi';

/**
 * Create → Edit, in place.
 *
 * Cat 2026-07-27: after a successful create the host flips the SAME panel
 * into edit mode for the entry that was just written and re-pushes context.
 * The form must not flicker to blank, must not lose the Canvas layout, and
 * the next save must be an `update`, not a second `create`.
 */

vi.mock('../render/HoverPopoverProvider', () => ({
  HoverPopoverProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));
vi.mock('../render/EntrySurface', () => ({ EntrySurface: () => null }));

vi.mock('@sjtu-ai4math/snl-basics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sjtu-ai4math/snl-basics')>();
  const ReactModule = await import('react');
  const renderNode = (tree: SnlSyntaxTree, path: number[] = []): React.ReactElement =>
    ReactModule.createElement(
      'div',
      { key: path.join('.') || 'root', 'data-tree-path': path.join('.'), 'data-kind': tree.kind },
      tree.macro_name,
      tree.children.map((child, index) => renderNode(child, [...path, index]))
    );
  return {
    ...actual,
    SnlSyntaxTreeView: ({ tree }: { tree: SnlSyntaxTree }) => renderNode(tree)
  };
});

const posted: any[] = [];
// `getVsCodeApi` caches module-globally, so one api object serves every test;
// only its stored state is reset in between.
let state: unknown;
const api: VsCodeApi = {
  postMessage: (message: unknown) => { posted.push(message); },
  getState: () => state,
  setState: (next: unknown) => { state = next; }
};
(globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi = () => api;

const KINDS = [{
  id: 'definition',
  name: 'Definition',
  coloring: { stroke: '#888888', background: '#222222' },
  numbering: '1',
  style: 'default'
}];

function createContext(): unknown {
  return {
    type: 'context',
    mode: 'create',
    kinds: KINDS,
    macros: {},
    macroKinds: [],
    macroOrigin: {},
    existing: null,
    entryPackages: ['_unpackaged', 'Logic'],
    existingIds: []
  };
}

function editContext(entry: any): unknown {
  return {
    type: 'context',
    mode: 'edit',
    id: entry.id,
    kinds: KINDS,
    macros: {},
    macroKinds: [],
    macroOrigin: {},
    existing: entry,
    entryPackages: ['_unpackaged', 'Logic'],
    existingIds: [{ id: entry.id, title: entry.title, hasContent: true }],
    relationships: []
  };
}

function send(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

beforeAll(() => {
  if (typeof PointerEvent === 'undefined') {
    Object.defineProperty(globalThis, 'PointerEvent', {
      configurable: true,
      value: class PointerEvent extends MouseEvent {
        pointerId: number;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
        }
      }
    });
  }
  for (const method of ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture'] as const) {
    if (!(method in HTMLElement.prototype)) {
      Object.defineProperty(HTMLElement.prototype, method, {
        configurable: true,
        value: method === 'hasPointerCapture' ? () => false : () => undefined
      });
    }
  }
});

beforeEach(() => {
  posted.length = 0;
  state = undefined;
});

afterEach(() => {
  cleanup();
});

describe('CreateEntryApp create → edit flip', () => {
  it('shows edit UI, keeps the submitted form, and saves as update', async () => {
    const view = render(<CreateEntryApp />);
    send(createContext());

    const titleInput = await waitFor(() =>
      view.container.querySelector<HTMLInputElement>('#snl-entry-title')!);
    fireEvent.change(titleInput, { target: { value: 'Brand New' } });
    const idInput = view.container.querySelector<HTMLInputElement>('input#snl-entry-id, #snl-entry-id-input')
      ?? view.container.querySelector<HTMLInputElement>('[id^="snl-entry-id"]')!;
    fireEvent.change(idInput, { target: { value: 'thm-new' } });

    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Create Entry');
    fireEvent.click(view.getByRole('button', { name: 'Create Entry' }));
    const create = posted.findLast((m) => m?.type === 'create');
    expect(create).toBeTruthy();
    expect(create.entry.id).toBe('thm-new');

    // Host acknowledges, then flips the panel and re-pushes context.
    // NOTE: the form is deliberately left CLEAN here (no typing after
    // submit, and `created` clears the dirty flag). That makes
    // `justCreatedIdRef` the only thing standing between the on-screen form
    // and a re-fill — the ordinary `formDirty && sameId` rule cannot mask a
    // regression in the flip logic. The echoed entry carries a DIFFERENT
    // title so a re-fill is observable.
    send({ type: 'created', id: 'thm-new' });
    send(editContext({
      id: 'thm-new',
      title: 'HOST ECHO — must not appear',
      kind: 'definition',
      content: create.entry.content
    }));

    // (b) edit-mode UI, with the submitted values still on screen.
    await waitFor(() => {
      expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Edit Entry');
    });
    expect(view.container.querySelector<HTMLInputElement>('#snl-entry-title')!.value)
      .toBe('Brand New');
    const readonlyId = view.container.querySelector<HTMLInputElement>('input#snl-entry-id')!;
    expect(readonlyId.readOnly).toBe(true);
    expect(readonlyId.value).toBe('thm-new');
    expect(view.getByRole('button', { name: 'Update Entry' })).toBeTruthy();
    const navButtons = Array.from(view.container.querySelectorAll('nav button'));
    expect(navButtons.some((b) => (b.textContent ?? '').includes('Infoview'))).toBe(true);

    // (c) a second save is an update, not a duplicate create.
    const createsBefore = posted.filter((m) => m?.type === 'create').length;
    fireEvent.click(view.getByRole('button', { name: 'Update Entry' }));
    await waitFor(() => {
      expect(posted.some((m) => m?.type === 'update')).toBe(true);
    });
    expect(posted.filter((m) => m?.type === 'create')).toHaveLength(createsBefore);
    const update = posted.findLast((m) => m?.type === 'update');
    expect(update.entry.id).toBe('thm-new');
    expect(update.entry.title).toBe('Brand New');
  });

  it('selects an Entry Package with one change in create mode', async () => {
    const view = render(<CreateEntryApp />);
    send(createContext());
    const packageSelect = await waitFor(() =>
      view.container.querySelector<HTMLSelectElement>('#snl-entry-package')!);
    expect(packageSelect.value).toBe('_unpackaged');

    fireEvent.input(packageSelect, { target: { value: 'Logic' } });
    fireEvent.change(packageSelect);

    expect(packageSelect.value).toBe('Logic');
  });

  it('loads and persists explicit Package membership', async () => {
    const view = render(<CreateEntryApp />);
    send(editContext({
      id: 'packaged-entry',
      package: 'Logic',
      title: 'Packaged Entry',
      kind: 'definition',
      content: {}
    }));
    const packageSelect = await waitFor(() =>
      view.container.querySelector<HTMLSelectElement>('#snl-entry-package')!);
    expect(packageSelect.value).toBe('Logic');
    fireEvent.change(packageSelect, { target: { value: '_unpackaged' } });
    fireEvent.click(view.getByRole('button', { name: 'Update Entry' }));
    await waitFor(() => expect(posted.some((message) => message?.type === 'update')).toBe(true));
    expect(posted.findLast((message) => message?.type === 'update').entry.package)
      .toBe('_unpackaged');
  });

  it('preserves a dirty Package selection when that Package disappears', async () => {
    const view = render(<CreateEntryApp />);
    const entry = {
      id: 'packaged-draft', package: 'Logic', title: 'Draft', kind: 'definition', content: {}
    };
    send(editContext(entry));
    const title = await waitFor(() =>
      view.container.querySelector<HTMLInputElement>('#snl-entry-title')!);
    fireEvent.change(title, { target: { value: 'Dirty draft' } });
    send({ ...(editContext(entry) as Record<string, unknown>), entryPackages: ['_unpackaged'] });

    const packageSelect = view.container.querySelector<HTMLSelectElement>('#snl-entry-package')!;
    await waitFor(() => expect(packageSelect.value).toBe('Logic'));
    expect(view.getByText(/selected Package no longer exists/i)).toBeTruthy();
    const updateButton = view.getByRole('button', { name: 'Update Entry' }) as HTMLButtonElement;
    expect(updateButton.disabled).toBe(true);
    fireEvent.change(packageSelect, { target: { value: '_unpackaged' } });
    expect(updateButton.disabled).toBe(false);
  });

  it('keeps the original revision when restoring an edit draft', async () => {
    saveDraft(api, 'createEntry:edit:revision-draft', {
      id: 'revision-draft',
      title: 'Restored title',
      selectedKind: 'definition',
      selectedPackage: '_unpackaged',
      content: { snl: '', typst: '', latex: '', markdown: '', text: '' },
      activeFormat: 'snl',
      snlMode: 'text',
      entryRevision: 'old-editor-revision'
    });
    const view = render(<CreateEntryApp />);
    send({
      ...(editContext({
        id: 'revision-draft', package: '_unpackaged', title: 'New disk title',
        kind: 'definition', content: {}
      }) as Record<string, unknown>),
      entryRevision: 'new-disk-revision'
    });
    await waitFor(() => expect(
      view.container.querySelector<HTMLInputElement>('#snl-entry-title')!.value
    ).toBe('Restored title'));
    fireEvent.click(view.getByRole('button', { name: 'Update Entry' }));
    await waitFor(() => expect(posted.some((message) => message?.type === 'update')).toBe(true));
    expect(posted.findLast((message) => message?.type === 'update').expectedRevision)
      .toBe('old-editor-revision');
  });

  it('does not let a stale edit-key draft clobber the just-created content', async () => {
    // Left behind by an earlier session that edited an entry with this id.
    saveDraft(api, 'createEntry:edit:thm-stale', {
      id: 'thm-stale',
      title: 'STALE TITLE',
      selectedKind: 'definition',
      content: { snl: 'stale_snl', typst: '', latex: '', markdown: '', text: '' },
      activeFormat: 'snl',
      snlMode: 'text'
    });

    const view = render(<CreateEntryApp />);
    send(createContext());
    const titleInput = await waitFor(() =>
      view.container.querySelector<HTMLInputElement>('#snl-entry-title')!);
    fireEvent.change(titleInput, { target: { value: 'Fresh Title' } });
    const idInput = view.container.querySelector<HTMLInputElement>('[id^="snl-entry-id"]')!;
    fireEvent.change(idInput, { target: { value: 'thm-stale' } });

    fireEvent.click(view.getByRole('button', { name: 'Create Entry' }));
    const create = posted.findLast((m) => m?.type === 'create');

    send({ type: 'created', id: 'thm-stale' });
    send(editContext({
      id: 'thm-stale',
      title: 'Fresh Title',
      kind: 'definition',
      content: create.entry.content
    }));

    await waitFor(() => {
      expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Edit Entry');
    });
    // (d) the stale stash must be gone AND must not have been applied.
    expect(loadDraft(api, 'createEntry:edit:thm-stale')).toBeUndefined();
    expect(view.container.querySelector<HTMLInputElement>('#snl-entry-title')!.value)
      .toBe('Fresh Title');
  });

  it('keeps the Canvas forest and block layout across the flip', async () => {
    const view = render(<CreateEntryApp />);
    send(createContext());

    const titleInput = await waitFor(() =>
      view.container.querySelector<HTMLInputElement>('#snl-entry-title')!);
    fireEvent.change(titleInput, { target: { value: 'Canvas Entry' } });
    fireEvent.change(
      view.container.querySelector<HTMLInputElement>('[id^="snl-entry-id"]')!,
      { target: { value: 'canvas-1' } }
    );

    // Author some SNL in the text editor, then move to Canvas and drag it.
    fireEvent.click(view.getByRole('button', { name: 'Text Editor' }));
    const snlBox = await waitFor(() => {
      const box = view.container.querySelector<HTMLTextAreaElement>('textarea');
      if (!box) throw new Error('no snl textarea');
      return box;
    });
    fireEvent.change(snlBox, { target: { value: 'root(child)' } });

    fireEvent.click(view.getByRole('button', { name: 'GUI Editor (Canvas)' }));
    let block = await waitFor(() =>
      view.container.querySelector<HTMLElement>('[data-canvas-root]')!);
    fireEvent.pointerDown(block, { pointerId: 21, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(block, { pointerId: 21, clientX: 70, clientY: 50 });
    fireEvent.pointerUp(block, { pointerId: 21, clientX: 70, clientY: 50 });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const left = block.style.left;
    const top = block.style.top;
    expect(left).not.toBe('');

    fireEvent.click(view.getByRole('button', { name: 'Create Entry' }));
    const create = posted.findLast((m) => m?.type === 'create');
    expect(create.entry.content.snl).toBe('root(child)');

    send({ type: 'created', id: 'canvas-1' });
    send(editContext({
      id: 'canvas-1',
      title: 'HOST ECHO — must not appear',
      kind: 'definition',
      // The host round-trips through its own serializer, so the echoed SNL
      // is equivalent but not character-identical. Re-filling from it would
      // reparse and rebuild the forest with fresh node identity.
      content: { ...create.entry.content, snl: 'root(\n  child\n)' }
    }));

    await waitFor(() => {
      expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Edit Entry');
    });
    // (e) same block, same position — the forest was NOT re-derived from snl.
    block = view.container.querySelector<HTMLElement>('[data-canvas-root]')!;
    expect(block).toBeTruthy();
    expect(block.textContent).toContain('root');
    expect(block.style.left).toBe(left);
    expect(block.style.top).toBe(top);
    // The clean-form guard again: the host's echoed title must not land.
    expect(view.container.querySelector<HTMLInputElement>('#snl-entry-title')!.value)
      .toBe('Canvas Entry');
  });
});
