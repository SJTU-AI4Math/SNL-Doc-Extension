// Reusable entry-picker widget: type-ahead search + list dropdown, backed by
// the shared `.SNL_Doc/entries.json` pool.
//
// Origin (cat 2026-07-08): "所有需要输入 EntityId 的地方都要能选，不能只让人贴
// uuid — 现在 Library outline 里加节点、Macro source.entries 里填 id，全都是
// 干抄的，一旦手滑就是 hard-to-catch mismatch." This component is the shared
// widget for those "lookup existing entry by id / title" slots.
//
// Two modes (chosen via props, not a discriminated union — the surface is
// small enough that a couple of optional flags stay readable):
//
//   Lookup mode (default): user picks one of the existing entries in the
//     pool. Free-typing is allowed for filtering but the value committed via
//     `onChange` MUST resolve to a real id (checked by the caller — we just
//     surface `resolvedEntry` so callers can show their own inline warnings).
//
//   Lookup-or-new mode (`allowNew`): the same, but a value not matching any
//     existing id is committed anyway. Used by AddNodeForm where "not found →
//     create the entry as part of this node" is a legit path.
//
// Design notes:
//   - Fuzzy match on both `id` and `title` (case-insensitive substring). We
//     do NOT do sort-by-relevance; results are stable, in `entries[]` order,
//     so a user typing then correcting doesn't see the list reshuffle.
//   - Bounded list (default 30, prop `maxResults`): >100k-entry pools were
//     hypothetical when we shipped this; the cap keeps the DOM cheap.
//   - Keyboard: ArrowDown / ArrowUp move the highlight; Enter commits it;
//     Escape blurs. Click-to-pick works too. This mirrors the pattern the
//     rest of the extension's autocompletes use.
//   - Popover positioning is naive `position: absolute; top: 100%`. Callers
//     should ensure the wrapping container is `position: relative` (or at
//     least a positioning context). We do NOT portal — VS Code webviews
//     block a lot of portal patterns, and popovers overflowing a form scroll
//     region is preferable to fighting the CSP.
//   - This file has ZERO runtime deps beyond React + our own EntryOption
//     type. It ships in every webview bundle that imports it (each entry is
//     self-contained per webview/vite.config.ts).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { EntryOption } from '../render/EntryRender';

export interface EntityIdSearchBoxProps {
  /** The full entry pool the user is picking from. Filtered client-side. */
  entries: readonly EntryOption[];
  /** Current committed value (an entry id, or free text in `allowNew`). */
  value: string;
  /** Emitted on Enter/click of a highlighted result OR on raw text edits
   *  (so parent state stays in sync while user is typing). */
  onChange: (nextValue: string) => void;
  /** Text shown when the input is empty. */
  placeholder?: string;
  /** Enable free-typing values not present in the pool. Default: false. */
  allowNew?: boolean;
  /** Cap on how many results appear in the dropdown. Default: 30. */
  maxResults?: number;
  /** Optional inline label. Rendered as a `<label>` above the input. */
  label?: string;
  /** Optional wrapper style. The wrapper is `position: relative` so the
   *  dropdown anchors correctly. */
  style?: React.CSSProperties;
  /** Optional inline style on the input itself. Merged over defaults. */
  inputStyle?: React.CSSProperties;
  /** Optional autofocus on mount (used for the sibling-add / child-add
   *  popover in CreateLibraryApp where the field is the primary action). */
  autoFocus?: boolean;
  /** Optional ID prefix so multiple instances on one page get unique DOM ids
   *  for the `<label htmlFor>` wire. Defaults to a random-ish per-instance
   *  string; only pass if you need it stable. */
  idPrefix?: string;
}

/**
 * Result of resolving `value` against `entries`. Callers can use this to
 * render their own inline badge / warning. `null` means the current value
 * doesn't match any entry (either a typo in lookup mode, or a legit
 * new-entry path in `allowNew` mode — the component doesn't distinguish;
 * callers decide how to treat it).
 */
export function resolveEntryOption(
  value: string,
  entries: readonly EntryOption[]
): EntryOption | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return entries.find((e) => e.id === trimmed) ?? null;
}

export function EntityIdSearchBox(
  props: EntityIdSearchBoxProps
): React.ReactElement {
  const {
    entries,
    value,
    onChange,
    placeholder,
    allowNew = false,
    maxResults = 30,
    label,
    style,
    inputStyle,
    autoFocus = false,
    idPrefix
  } = props;

  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const generatedIdRef = useRef<string>(
    // Stable per-mount id fallback. Not cryptographic; only used for the
    // <label htmlFor> wire.
    `entityid-search-${Math.random().toString(36).slice(2, 10)}`
  );
  const inputId = idPrefix ?? generatedIdRef.current;

  const trimmed = value.trim();
  const results = useMemo(() => {
    if (!trimmed) return entries.slice(0, maxResults);
    const needle = trimmed.toLowerCase();
    const matched: EntryOption[] = [];
    for (const e of entries) {
      if (
        e.id.toLowerCase().includes(needle) ||
        e.title.toLowerCase().includes(needle)
      ) {
        matched.push(e);
        if (matched.length >= maxResults) break;
      }
    }
    return matched;
  }, [entries, trimmed, maxResults]);

  // Clamp the highlight so it stays valid as results shrink; do NOT reset it
  // on every keystroke (that would fight the user's ArrowDown state).
  useEffect(() => {
    if (highlightIdx >= results.length) {
      setHighlightIdx(results.length > 0 ? results.length - 1 : 0);
    }
  }, [results.length, highlightIdx]);

  // Close the popover when focus leaves the wrapper. We can't just listen to
  // input `onBlur` — clicking a result item briefly blurs the input BEFORE
  // the onMouseDown fires, so we'd close the list before the click lands.
  // The pointerdown-outside listener handles that reliably.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent): void {
      const w = wrapperRef.current;
      if (w && e.target instanceof Node && !w.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function commit(entry: EntryOption | null): void {
    if (entry) {
      onChange(entry.id);
      setOpen(false);
    } else if (allowNew) {
      // Keep whatever's already in `value` — user is intentionally typing
      // something new. Just close the popover.
      setOpen(false);
    }
    // Lookup-only mode with no match: DO NOT commit, DO NOT close.
    // The user needs to keep typing or pick from the list; the caller's
    // inline warning tells them what's wrong.
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) setOpen(true);
        setHighlightIdx((i) => Math.min(i + 1, results.length - 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightIdx((i) => Math.max(i - 1, 0));
        return;
      case 'Enter':
        e.preventDefault();
        if (open && results[highlightIdx]) {
          commit(results[highlightIdx]);
        } else if (allowNew) {
          // No dropdown selection, but free-text is allowed — commit-as-is
          // (the value is already in parent state via `onChange` on input).
          setOpen(false);
        }
        return;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        return;
      default:
        return;
    }
  }

  const resolved = resolveEntryOption(value, entries);
  const isMismatch = trimmed.length > 0 && !resolved && !allowNew;

  return (
    <div ref={wrapperRef} style={{ position: 'relative', ...style }}>
      {label ? (
        <label
          htmlFor={inputId}
          style={{
            display: 'block',
            fontSize: '0.85rem',
            opacity: 0.85,
            marginBottom: '0.25rem'
          }}
        >
          {label}
        </label>
      ) : null}
      <input
        id={inputId}
        ref={inputRef}
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-invalid={isMismatch}
        style={{
          width: '100%',
          padding: '0.35rem 0.5rem',
          border: `1px solid ${
            isMismatch
              ? 'var(--vscode-inputValidation-warningBorder, orange)'
              : 'var(--vscode-input-border, transparent)'
          }`,
          background: 'var(--vscode-input-background, white)',
          color: 'var(--vscode-input-foreground, black)',
          borderRadius: '2px',
          fontFamily: 'inherit',
          fontSize: 'inherit',
          boxSizing: 'border-box',
          ...inputStyle
        }}
      />
      {/* Inline resolved-title chip. Shows the picked entry's title next to
          the id so it's visually obvious what the id maps to. Only rendered
          when the value actually resolves — mismatch state relies on the
          input's aria-invalid + border color, plus caller-side warnings. */}
      {resolved ? (
        <div
          style={{
            marginTop: '0.25rem',
            fontSize: '0.8rem',
            opacity: 0.75,
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'center'
          }}
        >
          <span
            style={{
              fontFamily:
                'var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace)',
              fontSize: '0.75rem'
            }}
          >
            {resolved.id}
          </span>
          <span>→</span>
          <span style={{ fontWeight: 500 }}>{resolved.title || '(untitled)'}</span>
          {resolved.hasContent ? null : (
            <span
              title="Entry exists but has no content yet (stub)"
              style={{
                fontSize: '0.7rem',
                padding: '0 0.3rem',
                borderRadius: '2px',
                background: 'var(--vscode-badge-background, #666)',
                color: 'var(--vscode-badge-foreground, white)'
              }}
            >
              stub
            </span>
          )}
        </div>
      ) : null}

      {open && results.length > 0 ? (
        <ul
          role="listbox"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 100,
            margin: 0,
            padding: 0,
            listStyle: 'none',
            maxHeight: '260px',
            overflowY: 'auto',
            background:
              'var(--vscode-quickInput-background, var(--vscode-editor-background, white))',
            border:
              '1px solid var(--vscode-quickInput-list-focusBackground, rgba(0,0,0,0.15))',
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            borderRadius: '2px'
          }}
        >
          {results.map((e, i) => {
            const isHighlight = i === highlightIdx;
            return (
              <li
                key={e.id}
                role="option"
                aria-selected={isHighlight}
                onMouseDown={(evt) => {
                  // MouseDown, not Click — Click fires after the input's
                  // blur handler could close the list.
                  evt.preventDefault();
                  commit(e);
                }}
                onMouseEnter={() => setHighlightIdx(i)}
                style={{
                  padding: '0.35rem 0.5rem',
                  cursor: 'pointer',
                  background: isHighlight
                    ? 'var(--vscode-list-hoverBackground, rgba(0,0,0,0.05))'
                    : 'transparent',
                  display: 'flex',
                  gap: '0.5rem',
                  alignItems: 'baseline'
                }}
              >
                <span
                  style={{
                    fontFamily:
                      'var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace)',
                    fontSize: '0.8rem',
                    opacity: 0.9,
                    flexShrink: 0
                  }}
                >
                  {e.id}
                </span>
                <span
                  style={{
                    opacity: 0.75,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {e.title || '(untitled)'}
                </span>
                {e.hasContent ? null : (
                  <span
                    style={{
                      fontSize: '0.7rem',
                      padding: '0 0.3rem',
                      borderRadius: '2px',
                      background: 'var(--vscode-badge-background, #666)',
                      color: 'var(--vscode-badge-foreground, white)',
                      marginLeft: 'auto',
                      flexShrink: 0
                    }}
                  >
                    stub
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {open && results.length === 0 && trimmed.length > 0 ? (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 100,
            marginTop: '2px',
            padding: '0.5rem',
            background:
              'var(--vscode-quickInput-background, var(--vscode-editor-background, white))',
            border:
              '1px solid var(--vscode-quickInput-list-focusBackground, rgba(0,0,0,0.15))',
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            borderRadius: '2px',
            fontSize: '0.85rem',
            opacity: 0.75
          }}
        >
          No matching entry.
          {allowNew ? ' Press Enter to keep this as a new value.' : ''}
        </div>
      ) : null}
    </div>
  );
}
