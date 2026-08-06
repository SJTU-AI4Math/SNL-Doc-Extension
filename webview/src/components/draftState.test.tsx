import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  editorDraftKey,
  loadDraft,
  saveDraft,
  usePersistedDraft,
  useSaveShortcut
} from './draftState';
import type { VsCodeApi } from '../vscodeApi';

afterEach(cleanup);

/** Stand-in for the real webview API, whose state survives a DOM teardown. */
function fakeApi(initial: unknown = undefined): VsCodeApi & { state: unknown } {
  let state = initial;
  return {
    postMessage: () => undefined,
    getState: () => state,
    setState: (next: unknown) => { state = next; },
    get state() { return state; }
  } as VsCodeApi & { state: unknown };
}

describe('draft persistence across a panel teardown', () => {
  it('scopes editor drafts by domain, mode, and target identity', () => {
    expect(editorDraftKey('macro', 'edit', 'core/FOL.forall')).toBe(
      'editor-draft:macro:edit:core%2FFOL.forall'
    );
    expect(editorDraftKey('macro', 'create', '')).toBe(
      'editor-draft:macro:create:new'
    );
  });

  it('round trips a draft through webview state', () => {
    const api = fakeApi();
    expect(loadDraft(api, 'entry')).toBeUndefined();
    saveDraft(api, 'entry', { title: 'half typed' });
    expect(loadDraft(api, 'entry')).toEqual({ title: 'half typed' });
  });

  it('namespaces panels so they cannot clobber each other', () => {
    const api = fakeApi();
    saveDraft(api, 'entry', { title: 'A' });
    saveDraft(api, 'macro', { name: 'B' });
    expect(loadDraft(api, 'entry')).toEqual({ title: 'A' });
    expect(loadDraft(api, 'macro')).toEqual({ name: 'B' });
  });

  it('clears a draft when handed undefined', () => {
    const api = fakeApi();
    saveDraft(api, 'entry', { title: 'A' });
    saveDraft(api, 'entry', undefined);
    expect(loadDraft(api, 'entry')).toBeUndefined();
  });

  it('degrades quietly when the host offers no state API', () => {
    const bare: VsCodeApi = { postMessage: () => undefined };
    expect(() => saveDraft(bare, 'entry', { a: 1 })).not.toThrow();
    expect(loadDraft(bare, 'entry')).toBeUndefined();
    expect(loadDraft(undefined, 'entry')).toBeUndefined();
  });

  it('survives a full unmount and remount, which is what hiding does', () => {
    const api = fakeApi();
    function Editor({ title }: { title: string }): React.ReactElement {
      usePersistedDraft(api, 'entry', { title });
      return <output data-testid="title">{title}</output>;
    }
    const first = render(<Editor title="unsaved work" />);
    first.unmount();
    // VS Code destroys the DOM under retainContextWhenHidden: false; the
    // stashed draft is the only thing that outlives it.
    expect(loadDraft(api, 'entry')).toEqual({ title: 'unsaved work' });
  });

  it('does not stash anything until the panel says it is dirty', () => {
    const api = fakeApi();
    function Editor({ dirty }: { dirty: boolean }): React.ReactElement {
      usePersistedDraft(api, 'entry', { title: 'from host' }, dirty);
      return <output />;
    }
    const view = render(<Editor dirty={false} />);
    expect(loadDraft(api, 'entry')).toBeUndefined();
    view.rerender(<Editor dirty />);
    expect(loadDraft(api, 'entry')).toEqual({ title: 'from host' });
  });
});

describe('Ctrl/Cmd+S save shortcut', () => {
  function Harness({ onSave, enabled }: { onSave: () => void; enabled: boolean }): React.ReactElement {
    useSaveShortcut(onSave, enabled);
    return <input aria-label="a field" />;
  }

  it('runs the save action for both Ctrl+S and Cmd+S', () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} enabled />);
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    fireEvent.keyDown(document, { key: 's', metaKey: true });
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('fires even while a text field has focus', () => {
    const onSave = vi.fn();
    const view = render(<Harness onSave={onSave} enabled />);
    const input = view.getByLabelText('a field');
    input.focus();
    fireEvent.keyDown(input, { key: 's', ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('swallows the key even when saving is not allowed', () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} enabled={false} />);
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true });
    act(() => { document.dispatchEvent(event); });
    // Never runs a save the button would have refused, but also never lets
    // the host fall through to "save some unrelated file".
    expect(onSave).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores a bare S and Ctrl+Alt+S', () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} enabled />);
    fireEvent.keyDown(document, { key: 's' });
    fireEvent.keyDown(document, { key: 's', ctrlKey: true, altKey: true });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('always calls the latest handler, not the one from first render', () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const view = render(<Harness onSave={stale} enabled />);
    view.rerender(<Harness onSave={fresh} enabled />);
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('stops listening once the panel unmounts', () => {
    const onSave = vi.fn();
    const view = render(<Harness onSave={onSave} enabled />);
    view.unmount();
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('save shortcut when saving is refused', () => {
  it('tells the panel so it can explain, instead of looking dead', () => {
    const onSave = vi.fn();
    const onBlocked = vi.fn();
    function Harness(): React.ReactElement {
      useSaveShortcut(onSave, false, onBlocked);
      return <input aria-label="f" />;
    }
    render(<Harness />);
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it('does not report blocked when the save actually runs', () => {
    const onSave = vi.fn();
    const onBlocked = vi.fn();
    function Harness(): React.ReactElement {
      useSaveShortcut(onSave, true, onBlocked);
      return <input aria-label="f" />;
    }
    render(<Harness />);
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it('recognises the physical S key on layouts that report another key', () => {
    const onSave = vi.fn();
    function Harness(): React.ReactElement {
      useSaveShortcut(onSave, true);
      return <input aria-label="f" />;
    }
    render(<Harness />);
    fireEvent.keyDown(document, { key: 'ы', code: 'KeyS', ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('lets the panel stay silent while a save is already running', () => {
    // The panel decides; the hook must not force a report. A save in flight
    // is not a refusal, and reporting one would clobber the `creating`
    // status that prevents a double submit.
    const onSave = vi.fn();
    const reports: number[] = [];
    let saving = false;
    function Harness(): React.ReactElement {
      useSaveShortcut(
        () => { saving = true; onSave(); },
        !saving,
        () => { if (!saving) reports.push(1); }
      );
      return <input aria-label="f" />;
    }
    const view = render(<Harness />);
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);

    view.rerender(<Harness />);
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    // Second press neither saves again nor reports a bogus refusal.
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([]);
  });
});
