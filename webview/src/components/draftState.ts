// Draft persistence + the Ctrl/Cmd+S accelerator shared by every editor panel.
//
// Cat 2026-07-25: "点跳转离开页面就会整个页面重置，这样会丢失未保存的编辑内容"
// and "在各个编辑 Panel 里，Ctrl + S 则相当于点 Update 按钮".
//
// Why the reset happens: every panel is created with
// `retainContextWhenHidden: false` (see src/*Panel.ts and the
// panelRetention.test.ts policy that keeps it that way — retaining a dozen
// hidden KaTeX/graph webviews is expensive). VS Code therefore DESTROYS the
// webview's DOM whenever the panel is hidden, and rebuilds it from scratch on
// return. React state is gone with it; nothing in the panel was ever written
// down, so the edits simply vanished.
//
// The fix is not to flip that flag — the memory policy is deliberate. It is to
// write the in-progress edits into the webview's own persisted state, which is
// exactly what `getState`/`setState` are for: VS Code keeps that blob across
// the teardown and hands it back on reload.

import { useEffect, useRef } from 'react';
import type { VsCodeApi } from '../vscodeApi';

/** Everything we persist, namespaced per panel so panels cannot collide. */
type DraftEnvelope = Record<string, unknown>;

function readEnvelope(vsApi: VsCodeApi | undefined): DraftEnvelope {
  const raw = vsApi?.getState?.();
  return raw && typeof raw === 'object' ? (raw as DraftEnvelope) : {};
}

/**
 * Read a previously stashed draft for `key`, if any.
 *
 * Returns undefined when there is nothing stored, so callers can keep their
 * normal "initialize from props" path unchanged.
 */
export function loadDraft<T>(vsApi: VsCodeApi | undefined, key: string): T | undefined {
  const stored = readEnvelope(vsApi)[key];
  return stored === undefined ? undefined : (stored as T);
}

/** Write (or clear, when `draft` is undefined) the stash for `key`. */
export function saveDraft(
  vsApi: VsCodeApi | undefined,
  key: string,
  draft: unknown
): void {
  if (!vsApi?.setState) return;
  const envelope = { ...readEnvelope(vsApi) };
  if (draft === undefined) delete envelope[key];
  else envelope[key] = draft;
  vsApi.setState(envelope);
}

/**
 * Keep `draft` mirrored into webview state for as long as the component lives.
 *
 * `enabled` lets a panel skip persistence until it is actually dirty, so a
 * freshly opened panel never stashes a snapshot that would later shadow newer
 * data pushed from the host.
 */
export function usePersistedDraft(
  vsApi: VsCodeApi | undefined,
  key: string,
  draft: unknown,
  enabled = true
): void {
  useEffect(() => {
    if (!enabled) return;
    saveDraft(vsApi, key, draft);
  }, [vsApi, key, draft, enabled]);
}

/**
 * Ctrl/Cmd+S anywhere in the panel runs `onSave` — the same thing the
 * Create/Update button does.
 *
 * Bound on the capture phase at the document level so it works no matter which
 * input has focus, and `preventDefault`ed so the host does not also try to
 * save an unrelated editor. `enabled` mirrors the button's disabled state:
 * pressing the shortcut must not do something the button would refuse, and
 * `onBlocked` lets the panel explain why instead of appearing to ignore the
 * key (review 2026-07-25).
 *
 * `event.code` is checked alongside `event.key` so layouts that report a
 * non-`s` key for the physical S position still work.
 */
export function useSaveShortcut(
  onSave: () => void,
  enabled: boolean,
  onBlocked?: () => void
): void {
  const handlerRef = useRef(onSave);
  handlerRef.current = onSave;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const blockedRef = useRef(onBlocked);
  blockedRef.current = onBlocked;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const isSaveKey =
        event.key === 's' || event.key === 'S' || event.code === 'KeyS';
      if (!isSaveKey) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      // Always swallow it: letting VS Code fall through to "save file" from
      // inside an editor panel is never what the author meant.
      event.preventDefault();
      event.stopPropagation();
      if (enabledRef.current) handlerRef.current();
      else blockedRef.current?.();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
