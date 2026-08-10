import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateEntryApp } from '../CreateEntryApp';
import { loadDraft, saveDraft } from '../components/draftState';
import { set_content_language } from '../runtime/preferencesRuntime';
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

function chooseContentLanguage(
  view: ReturnType<typeof render>,
  label: string,
  current: string,
  next: string
): void {
  fireEvent.click(view.getByLabelText(`${label}: ${current}`));
  const menu = view.getByRole('listbox', { name: label });
  fireEvent.click(within(menu).getByText(next).closest('button')!);
}

function sendInit(contentOverrides: Record<string, unknown> = {}): void {
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
          },
          ...contentOverrides
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
  set_content_language('en');
  posted.length = 0;
  installApi();
});
afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
  set_content_language('en');
});

describe('restored draft in edit mode', () => {
  it('puts the localized title editor above the permanent metadata row', async () => {
    const view = render(<CreateEntryApp />);
    sendInit();

    const title = await waitFor(() => titleInput(view));
    expect(title.closest('nav')).toBeNull();
    expect(title.readOnly).toBe(false);
    expect(view.getByText('Title (I18N)')).toBeTruthy();
    expect(view.getByLabelText('Title language: General')).toBeTruthy();

    const metadata = view.container.querySelector('[data-entry-metadata-row]');
    expect(metadata).toBeTruthy();
    const metadataFieldset = metadata?.closest('fieldset');
    expect(metadataFieldset?.style.minWidth).toBe('0px');
    expect(metadataFieldset?.style.width).toBe('100%');
    expect(metadataFieldset?.style.boxSizing).toBe('border-box');
    expect(metadata?.querySelector('#snl-entry-id')).toBeTruthy();
    const packageField = metadata?.querySelector<HTMLInputElement>('#snl-entry-package');
    expect(packageField?.readOnly).toBe(true);
    expect(packageField?.value).toBe('Unpackaged (_unpackaged)');
    expect(view.queryByRole('button', { name: 'Create Entry Package' })).toBeNull();

    const kind = metadata?.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Entry kind: Theorem"]');
    expect(kind).toBeTruthy();
    expect(kind?.textContent).toBe('Theorem');
    expect(kind?.style.borderColor).toBe('rgb(136, 136, 136)');
    expect(kind?.style.background).toBe('rgb(34, 34, 34)');
    fireEvent.click(kind!);
    const kindMenu = view.container.querySelector<HTMLElement>('[role="listbox"]');
    expect(kindMenu?.style.left).toBe('auto');
    expect(kindMenu?.style.right).toBe('0px');
    expect(kindMenu?.style.width).toBe('calc(100vw - 2rem)');
    expect(kindMenu?.style.maxWidth).toBe('20rem');
    expect(kindMenu?.style.minWidth).toBe('');
    const option = view.container.querySelector<HTMLElement>('[role="option"]');
    expect(option?.textContent).toMatch(/Theorem.*theorem.*#888.*#222/s);

    const formatButton = (name: string): HTMLButtonElement =>
      [...view.container.querySelectorAll<HTMLButtonElement>('[data-segmented-button="true"]')]
        .find((button) => button.textContent === name)!;
    expect(formatButton('Typst').disabled).toBe(true);
    expect(formatButton('LaTeX').disabled).toBe(true);
    expect(formatButton('SNL').disabled).toBe(false);
  });

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

  it('restores the per-format edit language so a draft cannot overwrite another translation', async () => {
    saveDraft(api, 'createEntry:edit:thm-1', {
      id: 'thm-1',
      title: 'My Unsaved Title',
      selectedKind: 'theorem',
      content: { snl: 'host_snl', typst: '', latex: '', markdown: '修改后的中文', text: '' },
      contentI18n: {
        markdown: {
          type: 'i18n', default_language: 'en',
          values: { en: 'unsaved English', 'zh-CN': '修改后的中文' }
        }
      },
      contentEditLanguages: {
        typst: '__snl_general__', latex: '__snl_general__',
        markdown: 'zh-CN', text: '__snl_general__'
      },
      contentDirtyFormats: ['markdown'],
      activeFormat: 'markdown',
      snlMode: 'text'
    });
    const view = render(<CreateEntryApp />);
    sendInit();
    await waitFor(() => expect(titleInput(view).value).toBe('My Unsaved Title'));
    await waitFor(() => expect(
      view.getByLabelText('MARKDOWN content language: zh-CN')
    ).toBeTruthy());
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
    expect(content.markdown).toEqual({
      type: 'i18n', default_language: 'en',
      values: { en: 'unsaved English', 'zh-CN': '修改后的中文' }
    });
  });

  it('keeps every unsaved localized projection across a modern draft remount', async () => {
    saveDraft(api, 'createEntry:edit:thm-1', {
      id: 'thm-1', title: 'Draft', selectedKind: 'theorem',
      content: { snl: 'host_snl', typst: '', latex: '', markdown: '本地中文', text: '' },
      contentI18n: {
        markdown: {
          type: 'i18n', default_language: 'en',
          values: { en: 'local English', 'zh-CN': '本地中文' }
        }
      },
      contentEditLanguages: { markdown: 'zh-CN' },
      contentDirtyFormats: ['markdown'],
      activeFormat: 'markdown', snlMode: 'text'
    });
    const view = render(<CreateEntryApp />);
    sendInit();
    await waitFor(() => expect(titleInput(view).value).toBe('Draft'));
    chooseContentLanguage(view, 'MARKDOWN content language', 'zh-CN', 'en');
    // A file-watcher context refresh must merge around the dirty local map,
    // not replace its other unsaved language projections with disk values.
    sendInit();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Selecting General without editing is not permission to collapse the
    // localized map into a plain string.
    chooseContentLanguage(view, 'MARKDOWN content language', 'en', 'General');
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
    expect(content.markdown).toEqual({
      type: 'i18n', default_language: 'en',
      values: { en: 'local English', 'zh-CN': '本地中文' }
    });
  });

  it('keeps an exact empty dirty-format set after a modern draft watcher refresh', async () => {
    saveDraft(api, 'createEntry:edit:thm-1', {
      id: 'thm-1', title: 'Retitled only', selectedKind: 'theorem',
      content: {
        snl: 'host_snl', typst: 'typst only in english', latex: '',
        markdown: 'old on disk', text: ''
      },
      contentI18n: {
        typst: {
          type: 'i18n', default_language: 'en',
          values: { en: 'typst only in english' }
        }
      },
      contentEditLanguages: { typst: 'zh-CN' },
      contentDirtyFormats: [],
      activeFormat: 'typst', snlMode: 'text'
    });
    const view = render(<CreateEntryApp />);
    sendInit({ markdown: 'old on disk' });
    await waitFor(() => expect(titleInput(view).value).toBe('Retitled only'));
    sendInit({ markdown: 'new on disk' });
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
    const content = submission.entry.content as Record<string, unknown>;
    expect(content.typst).toEqual({
      type: 'i18n', default_language: 'en',
      values: { en: 'typst only in english' }
    });
    expect(content.markdown).toBe('new on disk');
  });

  it('migrates a legacy draft using the old panel authoring language', async () => {
    set_content_language('zh-CN');
    saveDraft(api, 'createEntry:edit:thm-1', {
      id: 'thm-1', title: 'Legacy Draft', selectedKind: 'theorem',
      content: { snl: 'host_snl', typst: '', latex: '', markdown: '旧中文草稿', text: '' },
      activeFormat: 'markdown', snlMode: 'text'
    });
    const view = render(<CreateEntryApp />);
    sendInit();
    await waitFor(() => expect(titleInput(view).value).toBe('Legacy Draft'));
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
    expect(content.markdown).toEqual({
      type: 'i18n', default_language: 'en',
      values: { en: 'english body', 'zh-CN': '旧中文草稿' }
    });
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
