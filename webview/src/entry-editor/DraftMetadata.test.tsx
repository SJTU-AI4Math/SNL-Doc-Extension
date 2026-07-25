import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateEntryApp } from '../CreateEntryApp';
import { loadDraft, saveDraft } from '../components/draftState';
import type { VsCodeApi } from '../vscodeApi';

/**
 * A restored draft must not cost the entry its metadata.
 *
 * `updateEntry` on the host overwrites the whole record, so anything the
 * panel fails to send back is destroyed. Under `retainContextWhenHidden:
 * false` the panel is rebuilt from a stashed draft, and the metadata the
 * panel does not edit (contribution_info, pointer, other languages' i18n)
 * used to be absorbed only on the branch that a restored draft skipped.
 * Saving then silently nulled all of it. Review 2026-07-25.
 */

const posted: unknown[] = [];
// `getVsCodeApi` caches the handle module-globally, so every test in this file
// shares ONE api object; only its stored state is reset between tests.
let state: unknown;
const api: VsCodeApi = {
  postMessage: (message: unknown) => { posted.push(message); },
  getState: () => state,
  setState: (next: unknown) => { state = next; }
};
(globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi = () => api;

function installApi(): void {
  state = undefined;
}

function sendInit(): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: {
      type: 'context',
      mode: 'edit',
      id: 'thm-1',
      kinds: [{ id: 'theorem', name: 'Theorem', coloring: { stroke: '#888', background: '#222' } }],
      existingIds: ['thm-1'],
      existing: {
        id: 'thm-1',
        title: 'Host Title',
        kind: 'theorem',
        content: {
          snl: 'host_snl',
          markdown: {
            type: 'i18n',
            default_language: 'en',
            values: { en: 'english body', 'zh-CN': '中文正文' }
          }
        },
        contribution_info: { author: 'someone' },
        pointer: { file: 'a.lean' }
      }
    }
  }));
}

beforeEach(() => {
  cleanup();
  posted.length = 0;
  installApi();
});
afterEach(cleanup);

describe('restored draft in edit mode', () => {
  it('keeps contribution_info, pointer and other languages on save', async () => {
    // Unsaved work that outlived the panel being hidden.
    saveDraft(api, 'createEntry', {
      id: 'thm-1',
      title: 'My Unsaved Title',
      selectedKind: 'theorem',
      content: { snl: 'host_snl', typst: '', latex: '', markdown: 'my draft body', text: '' },
      activeFormat: 'markdown',
      snlMode: 'text'
    });

    const view = render(<CreateEntryApp />);
    sendInit();

    // The draft wins for the visible fields...
    await waitFor(() =>
      expect((view.getByLabelText(/Title/i) as HTMLInputElement).value).toBe('My Unsaved Title')
    );

    const update = await waitFor(() => view.getByRole('button', { name: /Update Entry/i }));
    fireEvent.click(update);

    const submission = await waitFor(() => {
      const found = posted.find(
        (message): message is { type: string; entry: Record<string, unknown> } =>
          typeof message === 'object' && message !== null &&
          (message as { type?: string }).type === 'update'
      );
      expect(found).toBeTruthy();
      return found!;
    });

    // ...but the metadata the panel never shows must survive untouched.
    expect(submission.entry.contribution_info).toEqual({ author: 'someone' });
    expect(submission.entry.pointer).toEqual({ file: 'a.lean' });

    // And the other language is still there, with only the edited one replaced.
    const markdown = submission.entry.content as Record<string, unknown>;
    expect(JSON.stringify(markdown.markdown)).toContain('中文正文');
  });

  it('treats the restored draft text as an edit, not as untouched host text', async () => {
    // Without marking the restored formats dirty, `persist` returns the
    // host's original i18n unchanged and the author's draft body is lost.
    saveDraft(api, 'createEntry', {
      id: 'thm-1',
      title: 'My Unsaved Title',
      selectedKind: 'theorem',
      content: { snl: 'host_snl', typst: '', latex: '', markdown: 'my draft body', text: '' },
      activeFormat: 'markdown',
      snlMode: 'text'
    });
    const view = render(<CreateEntryApp />);
    sendInit();
    await waitFor(() =>
      expect((view.getByLabelText(/Title/i) as HTMLInputElement).value).toBe('My Unsaved Title')
    );
    fireEvent.click(await waitFor(() => view.getByRole('button', { name: /Update Entry/i })));

    const submission = await waitFor(() => {
      const found = posted.find(
        (message): message is { type: string; entry: Record<string, unknown> } =>
          typeof message === 'object' && message !== null &&
          (message as { type?: string }).type === 'update'
      );
      expect(found).toBeTruthy();
      return found!;
    });
    const content = submission.entry.content as Record<string, unknown>;
    expect(JSON.stringify(content.markdown)).toContain('my draft body');
  });

  it('restores a Canvas forest that has no serialized form', async () => {
    // A multi-root forest cannot round trip through `content.snl`, so it must
    // ride in the draft itself or the author's loose blocks vanish.
    saveDraft(api, 'createEntry', {
      id: 'thm-1',
      title: 'Draft',
      selectedKind: 'theorem',
      content: { snl: 'alpha', typst: '', latex: '', markdown: '', text: '' },
      activeFormat: 'snl',
      snlMode: 'canvas',
      canvasForest: [
        { macro_name: 'alpha', children: [] },
        { macro_name: 'loose_block', children: [] }
      ]
    });
    const view = render(<CreateEntryApp />);
    sendInit();
    await waitFor(() =>
      expect(view.container.querySelector('[data-entry-gui-canvas]')).toBeTruthy()
    , { timeout: 3000 });

    // Two root blocks means the forest survived; reparsing `content.snl`
    // alone would have produced exactly one.
    await waitFor(() => {
      const blocks = view.container.querySelectorAll('[data-canvas-root-index]');
      expect(blocks.length).toBe(2);
    }, { timeout: 3000 });
  });

  it('writes the Canvas forest into the draft it stashes', async () => {
    // The restore side is useless if the save side never records the forest.
    const view = render(<CreateEntryApp />);
    sendInit();
    await waitFor(() =>
      expect((view.getByLabelText(/Title/i) as HTMLInputElement).value).toBe('Host Title')
    );
    // Any edit marks the form dirty, which is what enables stashing.
    fireEvent.input(view.getByLabelText(/Title/i), { target: { value: 'edited' } });

    await waitFor(() => {
      const draft = loadDraft<{ canvasForest?: unknown[] }>(api, 'createEntry');
      expect(draft).toBeTruthy();
      expect(Array.isArray(draft!.canvasForest)).toBe(true);
      expect(draft!.canvasForest!.length).toBeGreaterThan(0);
    }, { timeout: 3000 });
  });
});
