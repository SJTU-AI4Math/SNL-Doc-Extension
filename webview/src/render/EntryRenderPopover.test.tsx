import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  hooks: undefined as import('@sjtu-ai4math/snl-basics/entry').SnlRenderHooks | undefined,
  hoverEnabled: false,
  explicitSrc: null as string | null,
  currentPopoverId: null as string | null
}));
const activation = vi.hoisted(() => ({
  activation_id: 41,
  request_deactivate: vi.fn(() => true)
}));
const registerActivation = vi.hoisted(() => vi.fn());
const popovers = vi.hoisted(() => ({
  spawn: vi.fn(() => 'popover-hover'),
  pin: vi.fn(() => 'popover-pinned'),
  updatePointer: vi.fn(),
  freeze: vi.fn(),
  cancelUnfrozen: vi.fn(),
  dismissAll: vi.fn(),
  isAlive: vi.fn(() => true)
}));

vi.mock('../runtime/preferencesRuntime', () => ({
  use_preferences_revision: () => 0,
  use_content_language: () => 'en',
  get_popover_preferences: () => ({ hoverEnabled: state.hoverEnabled }),
  get_content_language: () => 'en',
  webview_language_runtime: {}
}));

vi.mock('./HoverPopoverProvider', () => ({
  useHoverPopovers: () => popovers,
  useCurrentPopoverId: () => state.currentPopoverId,
  useRegisterPopoverActivation: () => registerActivation
}));

vi.mock('@sjtu-ai4math/snl-basics/entry', () => {
  type Context = { ctrl_key?: boolean; [key: string]: unknown };
  class Driver {
    constructor(readonly options: Record<string, (context: Context) => unknown>) {}
    dispatch_hover(context: Context): unknown { return this.options.on_hover?.(context); }
    dispatch_click(context: Context): unknown {
      return context.ctrl_key && this.options.on_ctrl_click
        ? this.options.on_ctrl_click(context)
        : this.options.on_click?.(context);
    }
  }
  return {
    EntryDataDriver: class { constructor(_options: unknown) {} },
    MacroDataDriver: class { constructor(_options: unknown) {} },
    SnlInteractionDriver: Driver,
    EntrySurface: ({ interaction_driver, hooks }: { interaction_driver: Driver; hooks: import('@sjtu-ai4math/snl-basics/entry').SnlRenderHooks }) => {
      state.hooks = hooks;
      return (
      <button
        data-testid="reference"
        data-src={state.explicitSrc ?? undefined}
        onMouseMove={(event) => interaction_driver.dispatch_hover({
          node: {}, tree_path: [],
          macro: { source: { entries: ['child'] } },
          target: event.currentTarget,
          activation,
          client_x: 12, client_y: 14,
          ctrl_key: event.ctrlKey, meta_key: event.metaKey,
          shift_key: event.shiftKey, alt_key: event.altKey
        })}
        onClick={(event) => interaction_driver.dispatch_click({
          node: {}, tree_path: [],
          macro: { source: { entries: ['child'] } },
          target: event.currentTarget,
          activation,
          client_x: 12, client_y: 14,
          ctrl_key: event.ctrlKey, meta_key: event.metaKey,
          shift_key: event.shiftKey, alt_key: event.altKey
        })}
      >reference</button>
      );
    }
  };
});

import { EntryRender } from './EntryRender';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.hoverEnabled = false;
  state.explicitSrc = null;
  state.currentPopoverId = null;
});

describe('EntryRender popover preference', () => {
  it('memoizes the content/catalog policy but preserves user hooks overrides', () => {
    const props = {
      entry: { id: 'root', kind: 'definition', title: 'Root',
        content: { snl: 'Type.annotation[nameless](@x,T)' }, pointer: null },
      kind: null, entries: [], postMessage: vi.fn(),
      userMacros: { 'Type.annotation': {
        name: 'Type.annotation', description: '', source: { entries: [], urls: [] },
        dynamic_arity: false, tags: [], styles: [{ style_name: 'nameless', tags: [],
          template: { mode: 'formula_inline' as const, body: '#1' } }]
      } }
    };
    const view = render(<EntryRender {...props} />);
    const initial = state.hooks?.highlightStrategy;
    view.rerender(<EntryRender {...props} entry={{ ...props.entry, title: 'Retitled' }} />);
    expect(state.hooks?.highlightStrategy).toBe(initial);
    view.rerender(<EntryRender {...props} entry={{ ...props.entry, content: { snl: 'x' } }} />);
    expect(state.hooks?.highlightStrategy).not.toBe(initial);
    view.rerender(<EntryRender {...props} userMacros={{}} />);
    expect(state.hooks?.highlightStrategy).not.toBe(initial);
    const custom = { computeHighlightSet: vi.fn(() => ({ singleHover: null, bvarScope: [], binderDecl: [] })) };
    const renderTooltip = vi.fn(() => null);
    view.rerender(<EntryRender {...props} hooksOverride={{ highlightStrategy: custom, renderTooltip }} />);
    expect(state.hooks?.highlightStrategy).toBe(custom);
    expect(state.hooks?.renderTooltip).toBe(renderTooltip);
  });
  it('prefers explicit data-src for hover, pin, and navigation', () => {
    state.hoverEnabled = true;
    state.explicitSrc = 'explicit-child';
    state.currentPopoverId = 'parent-popover';
    const postMessage = vi.fn();
    const view = render(<EntryRender
      entry={{ id: 'root', kind: 'definition', title: 'Root', content: { snl: 'ref' }, pointer: null, contribution_info: null }}
      kind={null}
      entries={[]}
      postMessage={postMessage}
    />);
    const reference = view.getByTestId('reference');
    fireEvent.mouseMove(reference);
    expect(popovers.spawn).toHaveBeenCalledWith(
      'explicit-child', { element: reference, bounds: 'viewport' },
      12, 14, 'parent-popover', { activation }
    );
    expect(registerActivation).toHaveBeenCalledWith('parent-popover', activation);
    fireEvent.click(reference);
    expect(popovers.pin).toHaveBeenCalledWith(
      'explicit-child', { element: reference, bounds: 'viewport' },
      12, 14, 'parent-popover', { activation }
    );
    fireEvent.click(reference, { ctrlKey: true });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'openEntryInfoview', entryId: 'explicit-child'
    });
  });

  it('cancels an owned transient hover when its Entry unmounts', () => {
    state.hoverEnabled = true;
    const view = render(<EntryRender
      entry={{ id: 'root', kind: 'definition', title: 'Root', content: { snl: 'ref' }, pointer: null, contribution_info: null }}
      kind={null}
      entries={[]}
      postMessage={vi.fn()}
    />);
    fireEvent.mouseMove(view.getByTestId('reference'));
    view.unmount();
    expect(popovers.cancelUnfrozen).toHaveBeenCalledWith('popover-hover');
  });

  it('suppresses hover while retaining primary-click pinning', async () => {
    const view = render(<EntryRender
      entry={{ id: 'root', kind: 'definition', title: 'Root', content: { snl: 'ref' }, pointer: null, contribution_info: null }}
      kind={null}
      entries={[]}
      postMessage={vi.fn()}
    />);
    const reference = view.getByTestId('reference');
    fireEvent.mouseMove(reference);
    expect(popovers.spawn).not.toHaveBeenCalled();

    fireEvent.click(reference);
    await waitFor(() => expect(popovers.pin).toHaveBeenCalledWith(
      'child', { element: reference, bounds: 'viewport' }, 12, 14, null, { activation }
    ));
    expect(popovers.spawn).not.toHaveBeenCalled();
  });

  it('closes an existing transient hover when the preference is disabled live', () => {
    state.hoverEnabled = true;
    const props = {
      entry: { id: 'root', kind: 'definition', title: 'Root', content: { snl: 'ref' }, pointer: null, contribution_info: null },
      kind: null,
      entries: [],
      postMessage: vi.fn()
    };
    const view = render(<EntryRender {...props} />);
    fireEvent.mouseMove(view.getByTestId('reference'));
    expect(popovers.spawn).toHaveBeenCalledTimes(1);

    state.hoverEnabled = false;
    view.rerender(<EntryRender {...props} />);
    expect(popovers.cancelUnfrozen).toHaveBeenCalledWith('popover-hover');
  });

  it('retains hover previews when the preference is enabled', () => {
    state.hoverEnabled = true;
    const view = render(<EntryRender
      entry={{ id: 'root', kind: 'definition', title: 'Root', content: { snl: 'ref' }, pointer: null, contribution_info: null }}
      kind={null}
      entries={[]}
      postMessage={vi.fn()}
    />);
    fireEvent.mouseMove(view.getByTestId('reference'));
    expect(popovers.spawn).toHaveBeenCalledTimes(1);
  });
});
