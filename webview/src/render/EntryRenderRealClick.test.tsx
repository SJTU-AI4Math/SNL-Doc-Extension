// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../runtime/preferencesRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/preferencesRuntime')>();
  return {
    ...actual,
    get_popover_preferences: () => ({ hoverEnabled: false })
  };
});

import { EntryRender } from './EntryRender';
import { HoverPopoverProvider } from './HoverPopoverProvider';
import type { MacroRecord } from './macroData';
import { apply_preferences_snapshot, set_content_language } from '../runtime/preferencesRuntime';

const root = {
  id: 'root', kind: 'definition', title: 'Root',
  content: { snl: 'x@child' }, pointer: null, contribution_info: null
};
const child = {
  id: 'child', kind: 'definition', title: 'Pinned child',
  content: { markdown: 'Pinned child body' }, pointer: null, contribution_info: null
};

afterEach(cleanup);

it('selects the Entry Kind variant from the live dark theme context', async () => {
  apply_preferences_snapshot({
    type: 'snl.preferences/snapshot', generation: 'entry-theme', revision: 1,
    preferences: { language: 'en', color_scheme: 'dark', motion: 'full' }
  });
  const view = render(
    <HoverPopoverProvider postMessage={vi.fn()} entries={[]}>
      <EntryRender
        entry={{ ...root, content: { text: 'Body' } }}
        kind={{
          id: 'definition', name: 'Definition', style: '',
          coloring: {
            light: { stroke: '#111111', background: '#eeeeee' },
            dark: { stroke: '#dddddd', background: '#222222' }
          }
        }}
        entries={[]}
        postMessage={vi.fn()}
      />
    </HoverPopoverProvider>
  );
  const surface = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-id="root"]')!);
  expect(surface.style.borderLeft).toContain('rgb(221, 221, 221)');
  expect(surface.style.background).toBe('rgb(34, 34, 34)');
});

it('renders both Entry title and body from the Panel content language', async () => {
  set_content_language('zh-CN');
  const localizedEntry = {
    id: 'localized', kind: 'definition',
    title: {
      type: 'i18n' as const, default_language: 'en',
      values: { en: 'English title', 'zh-CN': '中文标题' }
    },
    content: {
      text: {
        type: 'i18n' as const, default_language: 'en',
        values: { en: 'English body', 'zh-CN': '中文正文' }
      }
    },
    pointer: null, contribution_info: null
  };
  const view = render(
    <HoverPopoverProvider postMessage={vi.fn()} entries={[]}>
      <EntryRender entry={localizedEntry} kind={null} entries={[]} postMessage={vi.fn()} />
    </HoverPopoverProvider>
  );
  expect((await view.findAllByText('中文标题')).length).toBeGreaterThan(0);
  expect(view.getByText('中文正文')).toBeTruthy();
  act(() => set_content_language('en'));
  expect((await view.findAllByText('English title')).length).toBeGreaterThan(0);
  expect(view.getByText('English body')).toBeTruthy();
});

describe('EntryRender real dependency click pinning', () => {
  it('pins a catalog-sourced Macro without an explicit @ annotation', async () => {
    const userMacros: MacroRecord = {
      Ref: {
        name: 'Ref', description: '', source: { entries: ['child'], urls: [] },
        dynamic_arity: false, tags: [],
        styles: [{
          style_name: 'default', tags: [],
          template: { mode: 'formula_inline', body: '\\mathrm{Ref}' }
        }]
      }
    };
    const view = render(
      <HoverPopoverProvider
        postMessage={vi.fn()}
        entries={[{ id: 'child', title: 'Pinned child', hasContent: true, snl: '@x' }]}
        localDetails={{ child: { entry: child, kind: null }}}
        userMacros={userMacros}
      >
        <EntryRender
          entry={{ ...root, content: { snl: 'Ref()' } }}
          kind={null}
          entries={[{ id: 'child', title: 'Pinned child', hasContent: true, snl: '@x' }]}
          postMessage={vi.fn()}
          userMacros={userMacros}
        />
      </HoverPopoverProvider>
    );
    const target = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-name="Ref"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(target.getAttribute('data-src')).toBeNull();
    fireEvent.pointerDown(target, { button: 0, clientX: 40, clientY: 30 });
    fireEvent.pointerUp(target, { button: 0, clientX: 40, clientY: 30 });
    fireEvent.click(target, { button: 0, clientX: 40, clientY: 30 });
    await waitFor(() => expect(document.body.textContent).toContain('Pinned child body'));
    expect(document.body.textContent?.match(/Pinned child body/g)).toHaveLength(1);
  });

  it('pins a referenced Entry through a real pointerdown → click sequence', async () => {
    const view = render(
      <HoverPopoverProvider
        postMessage={vi.fn()}
        entries={[{ id: 'child', title: 'Pinned child', hasContent: true, snl: '@x' }]}
        localDetails={{ child: { entry: child, kind: null }}}
      >
        <EntryRender
          entry={root}
          kind={null}
          entries={[{ id: 'child', title: 'Pinned child', hasContent: true, snl: '@x' }]}
          postMessage={vi.fn()}
        />
      </HoverPopoverProvider>
    );

    const target = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-src="child"]');
      expect(found).not.toBeNull();
      return found!;
    });

    let clickTarget = target;
    while (clickTarget.firstElementChild instanceof HTMLElement) {
      clickTarget = clickTarget.firstElementChild;
    }
    expect(clickTarget).not.toBe(target);
    fireEvent.pointerDown(clickTarget, { button: 0, clientX: 40, clientY: 30 });
    fireEvent.pointerUp(clickTarget, { button: 0, clientX: 40, clientY: 30 });
    fireEvent.click(clickTarget, { button: 0, clientX: 40, clientY: 30 });

    await waitFor(() => expect(document.body.textContent).toContain('Pinned child body'));
    expect(document.body.textContent?.match(/Pinned child body/g)).toHaveLength(1);
  });
});
