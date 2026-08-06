import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateEntryApp } from '../CreateEntryApp';
import { loadDraft, saveDraft } from '../components/draftState';
import type { VsCodeApi } from '../vscodeApi';

/**
 * A restored draft must not cost the entry its metadata.
 *
 * `updateEntry` overwrites the whole record, so a restored draft must still merge host-only metadata
 * (pointer and other languages' i18n). Contributor is now an editable,
 * identity-scoped draft field rather than deferred metadata.
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

function titleInput(view: ReturnType<typeof render>): HTMLInputElement {
  const input = view.container.querySelector<HTMLInputElement>('#snl-entry-title');
  if (!input) throw new Error('entry title input not rendered');
  return input;
}

function submitButton(view: ReturnType<typeof render>): HTMLButtonElement {
  const button = view.container.querySelector<HTMLButtonElement>('button.snl-btn--primary');
  if (!button) throw new Error('entry submit button not rendered');
  return button;
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
          },
          // English only: reading in zh-CN falls back to `en`. Marking this
          // untouched format dirty would write that fallback into `zh-CN`.
          typst: {
            type: 'i18n',
            default_language: 'en',
            values: { en: 'typst only in english' }
          }
        },
        contribution_info: 'someone',
        pointer: { file: 'a.lean' }
      }
    }
  }));
}

beforeEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
  posted.length = 0;
  installApi();
});
afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
});

describe('restored draft in edit mode', () => {
  it('keeps contribution_info, pointer and other languages on save', async () => {
    // Unsaved work that outlived the panel being hidden.
    saveDraft(api, 'createEntry:edit:thm-1', {
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
      expect(titleInput(view).value).toBe('My Unsaved Title')
    );

    const update = await waitFor(() => submitButton(view));
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
    expect(submission.entry.contribution_info).toBe('someone');
    expect(submission.entry.pointer).toEqual({ file: 'a.lean' });

    // And the other language is still there, with only the edited one replaced.
    const markdown = submission.entry.content as Record<string, unknown>;
    expect(JSON.stringify(markdown.markdown)).toContain('中文正文');
  });

  it('treats the restored draft text as an edit, not as untouched host text', async () => {
    // Without marking the restored formats dirty, `persist` returns the
    // host's original i18n unchanged and the author's draft body is lost.
    saveDraft(api, 'createEntry:edit:thm-1', {
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
      expect(titleInput(view).value).toBe('My Unsaved Title')
    );
    fireEvent.click(await waitFor(() => submitButton(view)));

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
    saveDraft(api, 'createEntry:edit:thm-1', {
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
      expect(titleInput(view).value).toBe('Host Title')
    );
    // Any edit marks the form dirty, which is what enables stashing.
    fireEvent.input(titleInput(view), { target: { value: 'edited' } });

    await waitFor(() => {
      const draft = loadDraft<{ canvasForest?: unknown[] }>(api, 'createEntry:edit:thm-1');
      expect(draft).toBeTruthy();
      expect(Array.isArray(draft!.canvasForest)).toBe(true);
      expect(draft!.canvasForest!.length).toBeGreaterThan(0);
    }, { timeout: 3000 });
  });

  it('does not widen dirty formats when the watcher re-pushes a dirty form', async () => {
    // No draft here: the panel is alive and its dirty tracking is accurate.
    // Widening it would freeze every untouched format's language fallback
    // into an explicit current-language translation. Review 2026-07-25.
    // Read in zh-CN so an unedited format's fallback vs explicit value are
    // distinguishable in the payload.
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'snl.preferences/snapshot',
        generation: 'draft-test',
        revision: 1,
        preferences: { language: 'zh-CN', color_scheme: 'dark', motion: 'auto' }
      }
    }));
    const view = render(<CreateEntryApp />);
    sendInit();
    await waitFor(() =>
      expect(titleInput(view).value).toBe('Host Title')
    );
    // Author edits ONLY the title; typst is left untouched.
    fireEvent.input(titleInput(view), { target: { value: 'Retitled' } });
    // The file watcher re-pushes the same entry.
    sendInit();
    await new Promise((resolve) => setTimeout(resolve, 100));

    fireEvent.click(await waitFor(() => submitButton(view)));
    const submission = await waitFor(() => {
      const found = posted.find(
        (message): message is { type: string; entry: Record<string, unknown> } =>
          typeof message === 'object' && message !== null &&
          (message as { type?: string }).type === 'update'
      );
      expect(found).toBeTruthy();
      return found!;
    });

    // markdown was never edited, so its i18n must come back untouched —
    // both languages intact and distinct.
    const content = submission.entry.content as Record<string, unknown>;
    // typst was never edited, so its English-only i18n must come back
    // untouched — no forged zh-CN key freezing the fallback.
    expect(JSON.stringify(content.typst)).not.toContain('zh-CN');
    expect(JSON.stringify(content.markdown)).toContain('中文正文');
  });

  it('does not leak one entry\'s draft onto another after a retarget', async () => {
    // ONE panel now serves every entry (cat 2026-07-25), so a shared draft
    // key would restore thm-1's unsaved text over thm-2 the moment you
    // navigated between them.
    saveDraft(api, 'createEntry:edit:thm-1', {
      id: 'thm-1',
      title: 'Draft For One',
      selectedKind: 'theorem',
      content: { snl: '', typst: '', latex: '', markdown: 'one body', text: '' },
      activeFormat: 'markdown',
      snlMode: 'text'
    });

    const view = render(<CreateEntryApp />);
    sendInit();
    await waitFor(() =>
      expect(titleInput(view).value).toBe('Draft For One')
    );

    // Host retargets the live panel at a different entry.
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'retarget', mode: 'edit', id: 'thm-2' }
    }));

    await waitFor(() =>
      expect(titleInput(view).value).not.toBe('Draft For One')
    );
  });

  it('drops the previous entry\'s relationships on retarget', async () => {
    const view = render(<CreateEntryApp />);
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'context',
        mode: 'edit',
        id: 'thm-1',
        kinds: [{ id: 'theorem', name: 'Theorem', coloring: { stroke: '#888', background: '#222' } }],
        existingIds: ['thm-1'],
        existing: { id: 'thm-1', title: 'One', kind: 'theorem', content: { snl: '' } },
        relationships: [
          { id: 'r1', label: 'depends', direction: 'outgoing', otherId: 'lemma-9', otherTitle: 'Lemma Nine' }
        ]
      }
    }));
    // The section is collapsed by default, so assert on the visible count.
    await waitFor(() =>
      expect(view.getByRole('button', { name: /(?:Relationships|关系) \(1\)/ })).toBeTruthy()
    );

    // Retarget must clear them, or the new entry shows the old one's graph.
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'retarget', mode: 'edit', id: 'thm-2' }
    }));
    await waitFor(() =>
      expect(view.getByRole('button', { name: /(?:Relationships|关系) \(0\)/ })).toBeTruthy()
    );
  });
});
