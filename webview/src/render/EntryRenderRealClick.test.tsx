// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../runtime/preferencesRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/preferencesRuntime')>();
  return {
    ...actual,
    use_preferences_revision: () => 0,
    get_popover_preferences: () => ({ hoverEnabled: false })
  };
});

import { EntryRender } from './EntryRender';
import { HoverPopoverProvider } from './HoverPopoverProvider';
import type { MacroRecord } from './macroData';

const root = {
  id: 'root', kind: 'definition', title: 'Root',
  content: { snl: 'x@child' }, pointer: null, contribution_info: null
};
const child = {
  id: 'child', kind: 'definition', title: 'Pinned child',
  content: { markdown: 'Pinned child body' }, pointer: null, contribution_info: null
};

afterEach(cleanup);

describe('EntryRender real dependency click pinning', () => {
  it('pins a catalog-sourced Macro without an explicit @ annotation', async () => {
    const userMacros: MacroRecord = {
      Ref: {
        name: 'Ref', description: '', source: { entries: ['child'], urls: [] },
        dynamic_arity: false, kind: 'const', tags: [],
        styles: [{ style_name: 'default', mode: 'formula_inline', template: '\\mathrm{Ref}', tags: [] }]
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

  it('lets the real Collapsible triangle toggle without SNL activation, pin, or popover', async () => {
    const userMacros: MacroRecord = {
      Fold: {
        name: 'Fold', description: '', source: { entries: ['child'], urls: [] },
        dynamic_arity: true, kind: 'const', tags: [],
        styles: [{ style_name: 'default', mode: 'block', template: '#0', block_template_name: 'collapsible', tags: [] }]
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
          entry={{ ...root, content: { snl: 'Fold(summary,body)' } }}
          kind={null}
          entries={[{ id: 'child', title: 'Pinned child', hasContent: true, snl: '@x' }]}
          postMessage={vi.fn()}
          userMacros={userMacros}
        />
      </HoverPopoverProvider>
    );
    const toggle = await waitFor(() => view.getByRole('button', { name: 'Collapse' }));
    const activationRoot = toggle.closest<HTMLElement>('[data-tree-path]');
    expect(activationRoot).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggle, { button: 0, clientX: 10, clientY: 10 });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(activationRoot!.classList.contains('snl-single-hover')).toBe(false);
    expect(document.body.textContent).not.toContain('Pinned child body');
    expect(document.querySelectorAll('[data-popover-id]')).toHaveLength(0);

    expect(fireEvent.keyDown(toggle, { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(toggle, { key: ' ' })).toBe(true);
    expect(activationRoot!.classList.contains('snl-single-hover')).toBe(false);
    expect(document.body.textContent).not.toContain('Pinned child body');
    expect(document.querySelectorAll('[data-popover-id]')).toHaveLength(0);
  });

  it('pins a referenced Entry through a real pointerdown → click sequence', async () => {
    const view = render(
      <HoverPopoverProvider
        postMessage={vi.fn()}
        entries={[{ id: 'child', title: 'Pinned child', hasContent: true, snl: '@x' }]}
        localDetails={{ child: { entry: child, kind: null }}}
      >
        <>
          <EntryRender
            entry={root}
            kind={null}
            entries={[{ id: 'child', title: 'Pinned child', hasContent: true, snl: '@x' }]}
            postMessage={vi.fn()}
          />
          <div data-testid="stopped-blank" onPointerDown={(event) => event.stopPropagation()}>blank</div>
        </>
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
    expect(view.container.querySelector('.snl-single-hover')).not.toBeNull();

    const section = view.container.querySelector('section')!;
    fireEvent.pointerDown(section, { button: 0, clientX: 5, clientY: 5 });
    await waitFor(() => expect(document.body.textContent).not.toContain('Pinned child body'));
    expect(view.container.querySelector('.snl-single-hover')).toBeNull();

    fireEvent.click(clickTarget, { button: 0, clientX: 40, clientY: 30 });
    await waitFor(() => expect(document.body.textContent).toContain('Pinned child body'));
    fireEvent.pointerDown(view.getByTestId('stopped-blank'));
    await waitFor(() => expect(document.body.textContent).not.toContain('Pinned child body'));
    expect(view.container.querySelector('.snl-single-hover')).toBeNull();
  });
});
