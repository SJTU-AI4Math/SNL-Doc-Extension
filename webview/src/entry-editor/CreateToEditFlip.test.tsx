import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
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
vi.mock('../render/EntrySurface', () => ({
  EntrySurface: ({ entry }: { entry: { content?: { snl?: string } } }) =>
    <div data-testid="entry-preview-surface">{entry.content?.snl ?? ''}</div>
}));
const renderedMacroDrivers: unknown[] = [];
vi.mock('./MonacoTextEditor', () => ({
  MonacoTextEditor: ({ value, ariaLabel, onChange }: {
    value: string;
    ariaLabel: string;
    onChange(value: string): void;
  }) => <textarea aria-label={ariaLabel} value={value}
    onChange={(event) => onChange(event.currentTarget.value)} />
}));

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
    SnlSyntaxTreeView: ({ tree, macro_data_driver }: {
      tree: SnlSyntaxTree;
      macro_data_driver: unknown;
    }) => {
      renderedMacroDrivers.push(macro_data_driver);
      return renderNode(tree);
    }
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
  renderedMacroDrivers.length = 0;
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

  it('blocks Package mutation while the primary Entry save is pending', async () => {
    const view = render(<CreateEntryApp />);
    send(createContext());

    fireEvent.click(await view.findByRole('button', { name: 'Create Package' }));
    fireEvent.change(view.getByLabelText('New Package ID'), { target: { value: 'Deferred' } });

    const titleInput = view.container.querySelector<HTMLInputElement>('#snl-entry-title')!;
    const idInput = view.container.querySelector<HTMLInputElement>(
      'input#snl-entry-id, #snl-entry-id-input'
    ) ?? view.container.querySelector<HTMLInputElement>('[id^="snl-entry-id"]')!;
    fireEvent.change(titleInput, { target: { value: 'Primary Pending' } });
    fireEvent.change(idInput, { target: { value: 'primary-pending' } });
    fireEvent.click(view.getByRole('button', { name: 'Create Entry' }));
    expect(posted.some((message) => message?.type === 'create')).toBe(true);

    const addPackage = view.getByRole('button', { name: 'Add Package' }) as HTMLButtonElement;
    expect(addPackage.disabled).toBe(true);
    fireEvent.click(addPackage);
    expect(posted.some((message) => message?.type === 'createPackage')).toBe(false);
  });

  it('resets a pending Package request when create mode becomes edit mode', async () => {
    const view = render(<CreateEntryApp />);
    send(createContext());

    fireEvent.click(await view.findByRole('button', { name: 'Create Package' }));
    fireEvent.change(view.getByLabelText('New Package ID'), { target: { value: 'Deferred' } });
    fireEvent.click(view.getByRole('button', { name: 'Add Package' }));
    const packageRequest = posted.findLast((message) => message?.type === 'createPackage');
    expect(packageRequest?.requestId).toBeTruthy();
    expect(view.getByRole('button', { name: 'Creating…' })).toBeTruthy();

    const titleInput = view.container.querySelector<HTMLInputElement>('#snl-entry-title')!;
    const idInput = view.container.querySelector<HTMLInputElement>(
      'input#snl-entry-id, #snl-entry-id-input'
    ) ?? view.container.querySelector<HTMLInputElement>('[id^="snl-entry-id"]')!;
    fireEvent.change(titleInput, { target: { value: 'Created While Package Pending' } });
    fireEvent.change(idInput, { target: { value: 'created-while-package-pending' } });
    const createEntryButton = view.getByRole('button', { name: 'Create Entry' }) as HTMLButtonElement;
    expect(createEntryButton.disabled).toBe(true);
    fireEvent.click(createEntryButton);
    expect(posted.some((message) => message?.type === 'create')).toBe(false);

    send({ type: 'created', id: 'created-while-package-pending' });
    send({
      ...(editContext({
        id: 'created-while-package-pending',
        package: '_unpackaged',
        title: 'Created While Package Pending',
        kind: 'definition',
        content: {}
      }) as Record<string, unknown>),
      entryPackages: ['_unpackaged', 'Logic', 'Deferred']
    });

    const selector = view.getByLabelText('Package') as HTMLSelectElement;
    await waitFor(() => expect(selector.value).toBe('_unpackaged'));
    expect(Array.from(selector.options).some((option) => option.value === 'Deferred')).toBe(true);
    expect(view.queryByRole('button', { name: 'Creating…' })).toBeNull();
    expect(view.queryByLabelText('New Package ID')).toBeNull();

    act(() => send({
      type: 'packageCreated',
      packageId: 'Deferred',
      requestId: packageRequest.requestId
    }));
    expect(selector.value).toBe('_unpackaged');
    fireEvent.click(view.getByRole('button', { name: 'Create Package' }));
    fireEvent.change(view.getByLabelText('New Package ID'), { target: { value: 'Fresh' } });
    expect((view.getByRole('button', { name: 'Add Package' }) as HTMLButtonElement).disabled)
      .toBe(false);
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

  it('keeps Live Preview visible without a disclosure control', async () => {
    const view = render(<CreateEntryApp />);
    send(editContext({
      id: 'preview-entry', package: '_unpackaged', title: 'Preview Entry',
      kind: 'definition', content: {}
    }));

    await waitFor(() => expect(view.getByTestId('entry-preview-surface')).toBeTruthy());
    const previewHeading = view.getByRole('heading', { name: 'Live Preview' });
    expect(previewHeading.closest('button')).toBeNull();
    expect(view.queryByRole('button', { name: /Live Preview.*section/i })).toBeNull();
  });

  it('removes redundant edit prose while preserving create-mode ID and Package guidance', async () => {
    const editView = render(<CreateEntryApp />);
    send(editContext({
      id: 'compact-entry', package: '_unpackaged', title: 'Compact Entry',
      kind: 'definition', content: {}
    }));

    await waitFor(() => expect(editView.getByLabelText('ID (readonly)')).toBeTruthy());
    expect(editView.queryByText(/stable references used by relationship links/i)).toBeNull();
    expect(editView.queryByText(/Prefer a semantic id/i)).toBeNull();
    expect(editView.queryByText(/Package membership may be changed later/i)).toBeNull();
    expect(editView.getByLabelText('Package')).toBeTruthy();
    editView.unmount();

    const createView = render(<CreateEntryApp />);
    send(createContext());
    await waitFor(() => expect(createView.getByText(/Prefer a semantic id/i)).toBeTruthy());
    expect(createView.getByText(/Package membership may be changed later/i)).toBeTruthy();
  });

  it('creates a Package from the selector and selects the host-confirmed Package', async () => {
    const view = render(<CreateEntryApp />);
    send(editContext({
      id: 'package-create-entry', package: '_unpackaged', title: 'Package Create Entry',
      kind: 'definition', content: {}
    }));

    const createButton = await view.findByRole('button', { name: 'Create Package' });
    fireEvent.click(createButton);
    const packageId = view.getByLabelText('New Package ID');
    fireEvent.change(packageId, { target: { value: 'Algebra' } });
    fireEvent.click(view.getByRole('button', { name: 'Add Package' }));

    const selector = view.getByLabelText('Package') as HTMLSelectElement;
    const updateButton = view.getByRole('button', { name: 'Update Entry' }) as HTMLButtonElement;
    expect(updateButton.disabled).toBe(true);
    const request = posted.findLast((message) => message?.type === 'createPackage');
    expect(request).toMatchObject({ type: 'createPackage', packageId: 'Algebra' });
    expect(typeof request?.requestId).toBe('string');

    act(() => send({
      type: 'packageCreated', packageId: 'Algebra', requestId: 'stale-request'
    }));
    expect(selector.value).toBe('_unpackaged');
    expect(view.getByLabelText('New Package ID')).toBeTruthy();

    send({ type: 'packageCreated', packageId: 'Algebra', requestId: request.requestId });
    await waitFor(() => expect(selector.value).toBe('Algebra'));
    expect(Array.from(selector.options).some((option) => option.value === 'Algebra')).toBe(true);
    expect(view.queryByLabelText('New Package ID')).toBeNull();
    expect(updateButton.disabled).toBe(false);
  });

  it('keeps the Package creator open with an actionable host error', async () => {
    const view = render(<CreateEntryApp />);
    send(editContext({
      id: 'package-error-entry', package: '_unpackaged', title: 'Package Error Entry',
      kind: 'definition', content: {}
    }));

    fireEvent.click(await view.findByRole('button', { name: 'Create Package' }));
    fireEvent.change(view.getByLabelText('New Package ID'), { target: { value: 'bad/package' } });
    fireEvent.click(view.getByRole('button', { name: 'Add Package' }));
    const request = posted.findLast((message) => message?.type === 'createPackage');
    send({
      type: 'packageCreateFailed',
      requestId: request.requestId,
      message: 'Could not create Package: invalid ID'
    });

    expect((await view.findByRole('alert')).textContent).toContain('Could not create Package: invalid ID');
    expect(view.getByLabelText('New Package ID')).toBeTruthy();
    expect((view.getByRole('button', { name: 'Add Package' }) as HTMLButtonElement).disabled).toBe(false);
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

  it('keeps Preview and Canvas content through the immediate post-update context', async () => {
    const view = render(<CreateEntryApp />);
    send(editContext({
      id: 'saved-canvas',
      title: 'Saved Canvas',
      kind: 'definition',
      content: { snl: 'root(child)' }
    }));

    await waitFor(() => {
      expect(view.getByTestId('entry-preview-surface').textContent).toBe('root(child)');
      expect(view.container.querySelector<HTMLElement>('[data-canvas-root]')?.textContent)
        .toContain('root');
    });
    const driverBeforeSaveRefresh = renderedMacroDrivers.at(-1);

    fireEvent.click(view.getByRole('button', { name: 'Update Entry' }));
    const update = posted.findLast((message) => message?.type === 'update');
    expect(update?.entry.content.snl).toBe('root(child)');

    act(() => {
      send({ type: 'updated', id: 'saved-canvas' });
      // The save's follow-up read can race a watcher/cache and briefly carry an
      // older empty snapshot. It must update revision/metadata without erasing
      // the content that was just acknowledged as successfully persisted.
      send(editContext({
        id: 'saved-canvas',
        title: 'STALE HOST ECHO',
        kind: 'definition',
        content: {}
      }));
    });

    await waitFor(() => {
      expect(view.getByTestId('entry-preview-surface').textContent).toBe('root(child)');
      expect(view.container.querySelector<HTMLElement>('[data-canvas-root]')?.textContent)
        .toContain('root');
    });
    expect(renderedMacroDrivers.at(-1)).toBe(driverBeforeSaveRefresh);

    act(() => {
      send(editContext({
        id: 'saved-canvas',
        title: 'Later authoritative refresh',
        kind: 'definition',
        content: { snl: 'replacement(next)' }
      }));
    });
    await waitFor(() => {
      expect(view.getByTestId('entry-preview-surface').textContent).toBe('replacement(next)');
      expect(view.container.querySelector<HTMLElement>('[data-canvas-root]')?.textContent)
        .toContain('replacement');
    });
  });

  it('does not carry a saved-context guard across retargets', async () => {
    const view = render(<CreateEntryApp />);
    act(() => {
      send(editContext({
        id: 'entry-a',
        title: 'Entry A',
        kind: 'definition',
        content: { snl: 'oldA(child)' }
      }));
      send({ type: 'updated', id: 'entry-a' });
      send({ type: 'retarget', mode: 'edit', id: 'entry-b' });
      send(editContext({
        id: 'entry-b',
        title: 'Entry B',
        kind: 'definition',
        content: { snl: 'entryB(child)' }
      }));
      send({ type: 'retarget', mode: 'edit', id: 'entry-a' });
      send(editContext({
        id: 'entry-a',
        title: 'Entry A reloaded',
        kind: 'definition',
        content: { snl: 'authoritativeA(next)' }
      }));
    });

    await waitFor(() => {
      expect(view.getByTestId('entry-preview-surface').textContent)
        .toBe('authoritativeA(next)');
      expect(view.container.querySelector<HTMLElement>('[data-canvas-root]')?.textContent)
        .toContain('authoritativeA');
    });
  });

  it('keeps edits made after an update request dirty when the acknowledgement arrives', async () => {
    const view = render(<CreateEntryApp />);
    act(() => {
      send(editContext({
        id: 'pending-save',
        title: 'Submitted title',
        kind: 'definition',
        content: { snl: 'root(child)' }
      }));
    });
    const title = await waitFor(() =>
      view.container.querySelector<HTMLInputElement>('#snl-entry-title')!
    );
    fireEvent.click(view.getByRole('button', { name: 'Update Entry' }));
    fireEvent.input(title, { target: { value: 'Edited while saving' } });

    act(() => {
      send({ type: 'updated', id: 'pending-save' });
    });
    await waitFor(() => {
      expect(loadDraft<{ title: string }>(api, 'createEntry:edit:pending-save')?.title)
        .toBe('Edited while saving');
    });

    act(() => {
      send({ type: 'retarget', mode: 'edit', id: 'other-entry' });
      send(editContext({
        id: 'other-entry', title: 'Other entry', kind: 'definition',
        content: { snl: 'other(child)' }
      }));
    });
    await waitFor(() => expect(title.value).toBe('Other entry'));
    act(() => {
      send({ type: 'retarget', mode: 'edit', id: 'pending-save' });
      send(editContext({
        id: 'pending-save',
        title: 'Submitted title',
        kind: 'definition',
        content: { snl: 'root(child)' }
      }));
    });

    await waitFor(() => expect(title.value).toBe('Edited while saving'));
    fireEvent.click(view.getByRole('button', { name: 'Update Entry' }));
    expect(posted.findLast((message) => message?.type === 'update')?.entry.title)
      .toBe('Edited while saving');
  });

  it('clears dirty state when an update acknowledges the current edit generation', async () => {
    const view = render(<CreateEntryApp />);
    act(() => {
      send(editContext({
        id: 'current-save',
        title: 'Original title',
        kind: 'definition',
        content: { snl: 'root(child)' }
      }));
    });
    const title = await waitFor(() =>
      view.container.querySelector<HTMLInputElement>('#snl-entry-title')!
    );
    fireEvent.input(title, { target: { value: 'Saved local title' } });
    fireEvent.click(view.getByRole('button', { name: 'Update Entry' }));
    act(() => {
      send({ type: 'updated', id: 'current-save' });
      send(editContext({
        id: 'current-save',
        title: 'Saved local title',
        kind: 'definition',
        content: { snl: 'root(child)' }
      }));
      send(editContext({
        id: 'current-save',
        title: 'Later authoritative title',
        kind: 'definition',
        content: { snl: 'root(child)' }
      }));
    });

    await waitFor(() => expect(title.value).toBe('Later authoritative title'));
  });

  it('keeps edits made after a create request dirty across the create-to-edit flip', async () => {
    const view = render(<CreateEntryApp />);
    act(() => { send(createContext()); });
    const title = await waitFor(() =>
      view.container.querySelector<HTMLInputElement>('#snl-entry-title')!
    );
    const idInput = view.container.querySelector<HTMLInputElement>('input#snl-entry-id, #snl-entry-id-input')
      ?? view.container.querySelector<HTMLInputElement>('[id^="snl-entry-id"]')!;
    fireEvent.input(title, { target: { value: 'Submitted create title' } });
    fireEvent.input(idInput, { target: { value: 'pending-create' } });
    fireEvent.click(view.getByRole('button', { name: 'Create Entry' }));
    const create = posted.findLast((message) => message?.type === 'create');
    expect(create?.entry.title).toBe('Submitted create title');

    fireEvent.input(title, { target: { value: 'Edited while creating' } });
    act(() => {
      send({ type: 'created', id: 'pending-create' });
      send(editContext({
        id: 'pending-create',
        title: 'Submitted create title',
        kind: 'definition',
        content: create.entry.content
      }));
      send(editContext({
        id: 'pending-create',
        title: 'Submitted create title',
        kind: 'definition',
        content: create.entry.content
      }));
    });

    await waitFor(() => expect(title.value).toBe('Edited while creating'));
  });

  it('keeps an incomplete Canvas edit made while an update is pending', async () => {
    const view = render(<CreateEntryApp />);
    act(() => {
      send({
        ...(editContext({
          id: 'pending-canvas',
          title: 'Pending Canvas',
          kind: 'definition',
          content: { snl: 'list(child)' }
        }) as Record<string, unknown>),
        macros: {
          list: {
            name: 'list', description: '', kind: 'fvar', tags: [],
            dynamic_arity: true, source: { entries: [], urls: [] },
            default_style: 'default',
            styles: [{
              style_name: 'default', mode: 'formula_inline', template: '#*',
              separator: ', ', tags: []
            }]
          }
        }
      });
    });
    const canvas = await waitFor(() =>
      view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!
    );
    fireEvent.click(view.getByRole('button', { name: 'Update Entry' }));
    const root = view.container.querySelector<HTMLElement>('[data-tree-path=""]')!;
    fireEvent.click(root);
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());
    fireEvent.keyDown(canvas, { key: '+', code: 'Equal' });
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-kind="argPlaceholder"]')).toHaveLength(1)
    );
    await waitFor(() => {
      const draft = loadDraft<{ canvasForest: SnlSyntaxTree[] }>(
        api,
        'createEntry:edit:pending-canvas'
      );
      expect(draft?.canvasForest?.[0]?.children.at(-1)?.kind).toBe('argPlaceholder');
    });

    act(() => {
      send({ type: 'updated', id: 'pending-canvas' });
      send(editContext({
        id: 'pending-canvas', title: 'Pending Canvas', kind: 'definition',
        content: { snl: 'list(child)' }
      }));
    });
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-kind="argPlaceholder"]')).toHaveLength(1)
    );
    act(() => {
      send(editContext({
        id: 'pending-canvas', title: 'Later authoritative Canvas', kind: 'definition',
        content: { snl: 'replacement(next)' }
      }));
    });

    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-kind="argPlaceholder"]')).toHaveLength(1)
    );
  });

  it('persists UUID regeneration as an authored draft change', async () => {
    const view = render(<CreateEntryApp />);
    act(() => { send(createContext()); });
    const idInput = await waitFor(() =>
      view.container.querySelector<HTMLInputElement>('input#snl-entry-id, #snl-entry-id-input')
        ?? view.container.querySelector<HTMLInputElement>('[id^="snl-entry-id"]')!
    );
    const before = idInput.value;
    const uuidButton = view.getByRole('button', { name: /fresh UUID v4/ });
    fireEvent.click(uuidButton);
    await waitFor(() => expect(idInput.value).not.toBe(before));
    await waitFor(() => {
      expect(loadDraft<{ id: string }>(api, 'createEntry:create:')?.id).toBe(idInput.value);
    });
  });
});
