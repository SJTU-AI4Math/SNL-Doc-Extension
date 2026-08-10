// Reusable entity-id widget: type-ahead search + list dropdown, backed by
// the shared `.SNL_Doc/entries.json` pool.
//
// Origin (cat 2026-07-08): "所有需要输入 EntityId 的地方都要能选，不能只让人贴
// uuid — 现在 Library outline 里加节点、Macro source.entries 里填 id，全都是
// 干抄的，一旦手滑就是 hard-to-catch mismatch."
//
// Design (cat 2026-07-09 refactor): the widget is parameterized by a
// `validate` callback and does NOT hard-code semantics like "reject new
// values" or "reject existing values". Callers pass the rule they need:
//
//   ENTRY_VALIDATE_RULES.requireMatch  — value MUST resolve to a pool entry
//                                        (macro source.entries; kind
//                                        selection; any "pick an existing
//                                        thing" slot).
//   ENTRY_VALIDATE_RULES.requireUnique — value MUST NOT already be in the
//                                        pool (creating a new id where
//                                        duplicates would collide).
//   ENTRY_VALIDATE_RULES.permitNew     — either a match or a novel value
//                                        is fine (Library AddNodeForm
//                                        where "not in pool → mint new
//                                        entry" is a legit path).
//
// Callers with unusual rules just write their own validate function —
// signature and return shape are documented on {@link EntityValidateFn}.
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
//   - The widget always commits raw text via `onChange` as the user types
//     (parent state stays in sync). "commit on Enter/click" refers to the
//     highlighted list item — Enter without a match just closes the dropdown
//     if the rule permits novel values (or beeps via the caller's error
//     rendering if not; the widget itself never blocks the keystroke).
//   - This file has ZERO runtime deps beyond React + our own EntryOption
//     type. It ships in every webview bundle that imports it (each entry is
//     self-contained per webview/vite.config.ts).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { EntryOption } from '../render/EntryRender';
import { entitySearchKeyAction } from './interactionModel';
import {
  createUiTranslator,
  defineUiMessages,
  useUiMessages
} from '../i18n/uiMessages';
import { resolve_localized_string } from '../../../src/localizedContent';
import { use_content_language } from '../runtime/preferencesRuntime';

const MESSAGES = defineUiMessages(
  'entityIdSearch',
  {
    noEntryWithId: 'No entry with this id in the current pool.',
    duplicateId: 'Id "{id}" already exists.',
    newId: 'New id — will be created on submit.',
    untitled: '(untitled)',
    stubTitle: 'Entry exists but has no content yet (stub)',
    stub: 'stub',
    noMatch: 'No matching entry.',
    keepNew: 'Press Enter to keep this as a new value.'
  },
  {
    noEntryWithId: '当前条目池中没有此 ID 对应的条目。',
    duplicateId: 'ID“{id}”已存在。',
    newId: '新 ID — 提交时将创建对应条目。',
    untitled: '（无标题）',
    stubTitle: '条目已存在，但尚无内容（存根）',
    stub: '存根',
    noMatch: '没有匹配的条目。',
    keepNew: '按 Enter 保留为新值。'
  }
);

function entityMessageTranslator() {
  const language = typeof document === 'undefined' ? 'en' : document.documentElement.lang;
  return createUiTranslator(language, MESSAGES);
}

/**
 * Verdict returned by a {@link EntityValidateFn}.
 *
 *   ok      — value is acceptable, no visual affordance needed.
 *   info    — value is acceptable but the caller wants to surface a note
 *             (e.g. "will create new entry"). Rendered in neutral color.
 *   warn    — value is acceptable but suspect (yellow border, warning
 *             message). The widget commits it anyway; the caller's submit
 *             handler decides whether to block.
 *   error   — value is unacceptable. The widget renders red border +
 *             message; commit still fires via onChange (state stays in
 *             sync while typing) but the caller's submit handler is
 *             expected to guard on the validate result too.
 *   null    — no verdict (equivalent to `ok` visually; skipped entirely).
 */
export type EntityValidateStatus = 'ok' | 'info' | 'warn' | 'error';

export interface EntityValidateVerdict {
  status: EntityValidateStatus;
  /** Optional inline message rendered under the input. Keep terse — one
   *  line, ~60 chars. */
  message?: string;
}

/**
 * Validation function. Receives:
 *   value   — raw string currently in the input (already trimmed).
 *   matched — the EntryOption whose `id` equals `value`, or null if none.
 *   entries — the full pool (in case a rule needs to scan for near-hits
 *             or duplicate cases beyond exact-id).
 *
 * Return null / undefined to opt out of validation for this value (no
 * badge, no border color change).
 */
export type EntityValidateFn = (
  value: string,
  matched: EntryOption | null,
  entries: readonly EntryOption[]
) => EntityValidateVerdict | null | undefined;

/**
 * Preset validation rules for the three common flavors. Rolling your own
 * is fine — these just save a few lines at the callsite.
 */
export const ENTRY_VALIDATE_RULES: {
  /** Empty is OK (row not filled yet); non-empty must resolve to a pool
   *  entry. Used by macro source.entries and any "pick an existing" slot. */
  requireMatch: EntityValidateFn;
  /** Value must NOT already appear in the pool (creating a fresh unique
   *  id). Empty is treated as "not yet decided" — no error. */
  requireUnique: EntityValidateFn;
  /** Either a match or a novel value; empty warns "will fall through";
   *  match confirms; novel value surfaces an info note. */
  permitNew: EntityValidateFn;
} = {
  requireMatch: (value, matched) => {
    if (!value) return null;
    if (matched) return { status: 'ok' };
    return {
      status: 'error',
      message: entityMessageTranslator()('noEntryWithId')
    };
  },
  requireUnique: (value, matched) => {
    if (!value) return null;
    if (!matched) return { status: 'ok' };
    return {
      status: 'error',
      message: entityMessageTranslator()('duplicateId', { id: value })
    };
  },
  permitNew: (value, matched) => {
    if (!value) return null;
    if (matched) return { status: 'ok' };
    return {
      status: 'info',
      message: entityMessageTranslator()('newId')
    };
  }
};

export interface EntityIdSearchBoxProps {
  /** The full pool the user is picking from. Filtered client-side. */
  entries: readonly EntryOption[];
  /** Current committed value (an entry id, or free text). */
  value: string;
  /** Emitted on Enter/click of a highlighted result OR on raw text edits
   *  (so parent state stays in sync while user is typing). */
  onChange: (nextValue: string) => void;
  /** Emitted only when the author commits an existing suggestion with Enter
   *  or pointer selection. Raw query keystrokes never call this callback. */
  onCommit?: (entryId: string) => void;
  /** Optional Escape hook for callers that keep an uncommitted local draft. */
  onCancel?: () => void;
  /** Validation rule. Default: {@link ENTRY_VALIDATE_RULES.requireMatch}
   *  (the safest default — matches the original widget's "must pick from
   *  the list" behavior). Pass a preset or your own function. */
  validate?: EntityValidateFn;
  /** Text shown when the input is empty. */
  placeholder?: string;
  /** Cap on how many results appear in the dropdown. Default: 30. */
  maxResults?: number;
  /** Optional inline label. Rendered as a `<label>` above the input. */
  label?: string;
  /** Accessible name used when a compact caller intentionally renders no
   * visible label. */
  ariaLabel?: string;
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
  /** Hide the inline resolved-title chip that normally appears below the
   *  input on match. Useful when the caller already renders its own
   *  status line (e.g. Library AddNodeForm). Default: false. */
  hideResolvedChip?: boolean;
  /** Render suggestions in normal document flow instead of overlaying the
   *  controls below. Intended for compact forms with primary actions directly
   *  under the search box. */
  suggestionsInFlow?: boolean;
}

/**
 * Result of resolving `value` against `entries`. Callers can use this to
 * render their own inline badge / warning. `null` means the current value
 * doesn't match any entry — semantics of that state depend on the caller's
 * `validate` rule; callers decide how to treat it.
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
    onCommit,
    onCancel,
    validate = ENTRY_VALIDATE_RULES.requireMatch,
    placeholder,
    maxResults = 30,
    label,
    ariaLabel,
    style,
    inputStyle,
    autoFocus = false,
    idPrefix,
    hideResolvedChip = false,
    suggestionsInFlow = false
  } = props;
  const t = useUiMessages(MESSAGES);
  const contentLanguage = use_content_language();

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
  const listboxId = `${inputId}-results`;

  const trimmed = value.trim();
  const results = useMemo(() => {
    if (!trimmed) return entries.slice(0, maxResults);
    const needle = trimmed.toLowerCase();
    const matched: EntryOption[] = [];
    for (const e of entries) {
      if (
        e.id.toLowerCase().includes(needle) ||
        resolve_localized_string(e.title, contentLanguage).toLowerCase().includes(needle)
      ) {
        matched.push(e);
        if (matched.length >= maxResults) break;
      }
    }
    return matched;
  }, [contentLanguage, entries, trimmed, maxResults]);

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

  const resolved = resolveEntryOption(value, entries);
  const verdict = useMemo(
    () => validate(trimmed, resolved, entries) ?? null,
    [validate, trimmed, resolved, entries]
  );

  function commit(entry: EntryOption): void {
    onChange(entry.id);
    onCommit?.(entry.id);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      onCancel();
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    const navigation = entitySearchKeyAction(
      e.key,
      highlightIdx,
      results.length,
      open
    );
    if (navigation) {
      e.preventDefault();
      setHighlightIdx(navigation.index);
      setOpen(navigation.open);
      if (navigation.blur) inputRef.current?.blur();
      return;
    }
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        if (open && results[highlightIdx]) {
          commit(results[highlightIdx]);
        } else {
          // No highlighted result — just close the dropdown. Whether the
          // typed value is acceptable is up to `validate`; the widget
          // itself never eats the keystroke.
          setOpen(false);
        }
        return;
      default:
        return;
    }
  }

  // Border color derived from the current verdict. `null` = neutral;
  // `ok` = neutral (green would be too loud for every valid state);
  // `info` = neutral border, message colored; `warn` = yellow; `error` = red.
  const borderColor = (() => {
    if (!verdict) return 'var(--vscode-input-border, transparent)';
    switch (verdict.status) {
      case 'error':
        return 'var(--vscode-inputValidation-errorBorder, #be1100)';
      case 'warn':
        return 'var(--vscode-inputValidation-warningBorder, #cca700)';
      default:
        return 'var(--vscode-input-border, transparent)';
    }
  })();

  const messageColor = (() => {
    if (!verdict) return 'var(--vscode-descriptionForeground, #999)';
    switch (verdict.status) {
      case 'error':
        return 'var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground, #f48771))';
      case 'warn':
        return 'var(--vscode-editorWarning-foreground, #cca700)';
      case 'info':
      case 'ok':
        return 'var(--vscode-descriptionForeground, #999)';
    }
  })();

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
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open && results.length > 0}
        aria-controls={listboxId}
        aria-activedescendant={
          open && results[highlightIdx]
            ? `${listboxId}-option-${highlightIdx}`
            : undefined
        }
        aria-invalid={verdict?.status === 'error'}
        style={{
          width: '100%',
          padding: '0.35rem 0.5rem',
          border: `1px solid ${borderColor}`,
          background: 'var(--vscode-input-background, white)',
          color: 'var(--vscode-input-foreground, black)',
          borderRadius: '2px',
          fontFamily: 'inherit',
          fontSize: 'inherit',
          boxSizing: 'border-box',
          ...inputStyle
        }}
      />
      {/* Validation message. Rendered even in `info` / `ok` states when the
          validate fn wants to communicate something (e.g. permitNew's
          "will be created on submit"). */}
      {verdict?.message ? (
        <p
          style={{
            margin: '0.2rem 0 0',
            fontSize: '0.75rem',
            color: messageColor
          }}
        >
          {verdict.message}
        </p>
      ) : null}
      {/* Inline resolved-title chip. Shows the picked entry's title next to
          the id so it's visually obvious what the id maps to. Only rendered
          when the value actually resolves AND the caller hasn't opted out
          via `hideResolvedChip` (used when the caller has its own status
          line so the chip would be redundant). */}
      {resolved && !hideResolvedChip ? (
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
          <span style={{ fontWeight: 500 }}>
            {resolve_localized_string(resolved.title, contentLanguage) || t('untitled')}
          </span>
          {resolved.hasContent ? null : (
            <span
              title={t('stubTitle')}
              style={{
                fontSize: '0.7rem',
                padding: '0 0.3rem',
                borderRadius: '2px',
                background: 'var(--vscode-badge-background, #666)',
                color: 'var(--vscode-badge-foreground, white)'
              }}
            >
              {t('stub')}
            </span>
          )}
        </div>
      ) : null}

      {open && results.length > 0 ? (
        <ul
          id={listboxId}
          role="listbox"
          style={{
            position: suggestionsInFlow ? 'static' : 'absolute',
            top: suggestionsInFlow ? undefined : '100%',
            left: suggestionsInFlow ? undefined : 0,
            right: suggestionsInFlow ? undefined : 0,
            zIndex: suggestionsInFlow ? undefined : 100,
            margin: suggestionsInFlow ? '2px 0 0' : 0,
            padding: 0,
            listStyle: 'none',
            maxHeight: '260px',
            overflowY: 'auto',
            background:
              'var(--vscode-quickInput-background, var(--vscode-editor-background, #1e1e1e))',
            border:
              '1px solid var(--vscode-quickInput-list-focusBackground, rgba(0,0,0,0.15))',
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            borderRadius: '2px'
          }}
        >
          {results.map((e, i) => {
            const isHighlight = i === highlightIdx;
            const entryTitle = resolve_localized_string(e.title, contentLanguage);
            return (
              <li
                id={`${listboxId}-option-${i}`}
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
                  {entryTitle || t('untitled')}
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
                    {t('stub')}
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
            position: suggestionsInFlow ? 'static' : 'absolute',
            top: suggestionsInFlow ? undefined : '100%',
            left: suggestionsInFlow ? undefined : 0,
            right: suggestionsInFlow ? undefined : 0,
            zIndex: suggestionsInFlow ? undefined : 100,
            marginTop: '2px',
            padding: '0.5rem',
            background:
              'var(--vscode-quickInput-background, var(--vscode-editor-background, #1e1e1e))',
            border:
              '1px solid var(--vscode-quickInput-list-focusBackground, rgba(0,0,0,0.15))',
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            borderRadius: '2px',
            fontSize: '0.85rem',
            opacity: 0.75
          }}
        >
          {t('noMatch')}
          {verdict?.status === 'error'
            ? ''
            : ` ${t('keepNew')}`}
        </div>
      ) : null}
    </div>
  );
}
