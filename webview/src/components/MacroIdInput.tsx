import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useId
} from 'react';
import {
  createSnooglSearchDocument,
  SnooglSearchIndex,
  type SnooglSearchCandidate
} from '../../../src/snooglSearch';
import './MacroIdInput.css';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';
import {
  MacroPreview,
  type MacroPreviewRuntime,
  useProvidedMacroPreviewRuntime
} from '../render/MacroPreview';

const MESSAGES = defineUiMessages(
  'macroIdInput',
  {
    suggestions: 'Macro ID suggestions',
    dialog: 'SNoogL Macro Search',
    heading: 'SNoogL · Macro',
    search: 'Search macros in SNoogL',
    results: 'SNoogL macro results',
    hint: "Tab inserts the selected Macro name · Style stays in the editor's separate dropdown · Esc closes",
    preview: 'Preview {id}'
  },
  {
    suggestions: '宏 ID 建议',
    dialog: 'SNoogL 宏搜索',
    heading: 'SNoogL · 宏',
    search: '在 SNoogL 中搜索宏',
    results: 'SNoogL 宏搜索结果',
    hint: 'Tab 插入所选宏名 · 样式仍在编辑器的独立下拉框中设置 · Esc 关闭',
    preview: '预览 {id}'
  }
);

const EMPTY_MACRO_CANDIDATES: readonly SnooglSearchCandidate[] = [];

export type MacroIdDslTone = 'plain' | 'formula' | 'text' | 'binder' | 'context';

export interface MacroIdDslToken {
  text: string;
  tone: MacroIdDslTone;
}

export function autoCloseLeadingDelimiter(
  previous: string,
  next: string
): { value: string; caret: number | null } {
  if (previous.length === 0 && (next === '$' || next === '%')) {
    return { value: `${next}${next}`, caret: 1 };
  }
  return { value: next, caret: null };
}

/** Lightweight lexical projection of the parser's delimiter/binder roles. */
export function tokenizeMacroIdDsl(value: string): MacroIdDslToken[] {
  const tokens: MacroIdDslToken[] = [];
  let atNodeStart = true;
  let inTextDelimiter = false;
  const push = (text: string, tone: MacroIdDslTone): void => {
    const previous = tokens.at(-1);
    if (previous?.tone === tone) previous.text += text;
    else tokens.push({ text, tone });
  };
  for (const char of value) {
    if (char === '%') {
      push(char, 'text');
      inTextDelimiter = !inTextDelimiter;
      atNodeStart = false;
    } else if (inTextDelimiter) {
      // `%…%` is one parser-owned literal Text leaf. Do not present any
      // interior `$`, `@`, comma, or bracket as active SNL structure.
      push(char, 'plain');
    } else if (char === '$') {
      push(char, 'formula');
      atNodeStart = false;
    } else if (char === '@') {
      push(char, atNodeStart ? 'binder' : 'context');
      atNodeStart = false;
    } else {
      push(char, 'plain');
      if (char === '(' || char === ',') atNodeStart = true;
      else if (!/\s/.test(char)) atNodeStart = false;
    }
  }
  return tokens;
}

/**
 * The span a Macro completion replaces: the identifier under the caret plus
 * any `[style]` bracket immediately after it.
 *
 * Cat 2026-07-25: Style is completed from this same control now, so picking
 * `foo[bar]` over an existing `foo[baz]` must replace the bracket too —
 * otherwise the old style would be left dangling as `foo[bar][baz]`.
 */
function macroTokenRange(value: string, caret: number): { start: number; end: number } {
  const isToken = (char: string): boolean => !/[\s(),\[\]$%@]/.test(char);
  let start = Math.min(Math.max(caret, 0), value.length);
  let end = start;
  // Caret parked just after `foo[bar]|`: treat it as being on that token,
  // otherwise the range collapses to nothing and no completion is offered.
  if (start > 0 && value[start - 1] === ']') {
    const opening = value.lastIndexOf('[', start - 1);
    if (opening > 0) {
      end = start;
      start = opening;
      while (start > 0 && isToken(value[start - 1])) start -= 1;
      return { start, end };
    }
  }
  while (start > 0 && isToken(value[start - 1])) start -= 1;
  while (end < value.length && isToken(value[end])) end += 1;
  // Caret sitting inside `foo[ba|z]`: walk back out to the identifier, then
  // recompute `end` from there so the closing bracket is included too —
  // otherwise the replacement leaves a stray `]` behind as `foo[qux]]`.
  if (start > 0 && value[start - 1] === '[') {
    const bracket = start - 1;
    let identifierStart = bracket;
    while (identifierStart > 0 && isToken(value[identifierStart - 1])) identifierStart -= 1;
    if (identifierStart < bracket) {
      start = identifierStart;
      const closingBracket = value.indexOf(']', bracket);
      end = closingBracket === -1 ? end : closingBracket + 1;
      return { start, end };
    }
  }
  const closing = value.indexOf(']', end);
  if (value[end] === '[' && closing !== -1) end = closing + 1;
  return { start, end };
}

interface MacroIdInputBaseProps {
  value: string;
  onChange: (value: string) => void;
  autoSize?: boolean;
  macroCandidates?: readonly SnooglSearchCandidate[];
  /** Shared, surface-scoped preview runtime. Candidate metadata stays search-only. */
  macroPreviewRuntime?: MacroPreviewRuntime;
  /** Open the embedded SNoogL Macro picker as soon as this control mounts. */
  openSnooglOnMount?: boolean;
  /**
   * SNoogL Tab inserts the picked Macro id at the caret instead of replacing
   * the surrounding token. Used by the Canvas subtree (Ctrl+F2) editor, where
   * the box holds a whole SNL expression and replacing it would wipe the tree.
   */
  snooglInsertsMacroId?: boolean;
  /** Select the whole value once the control mounts (F2-style editing). */
  selectAllOnMount?: boolean;
  /** Let this control consume Tab for autocomplete. */
  acceptSuggestionOnTab?: boolean;
  /** Reports whether this control currently owns unshifted Tab for a visible suggestion. */
  onSuggestionTabOwnershipChange?: (ownsTab: boolean) => void;
}

export type MacroIdInputProps =
  | (MacroIdInputBaseProps &
      Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
        multiline?: false;
      })
  | (MacroIdInputBaseProps &
      Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'rows'> & {
        multiline: true;
      });

/** Shared Macro-ID / SNL typing surface used by structural Entry editors. */
export const MacroIdInput = forwardRef<
  HTMLInputElement | HTMLTextAreaElement,
  MacroIdInputProps
>(function MacroIdInput(
  {
    value,
    onChange,
    multiline = false,
    autoSize = false,
    macroCandidates = EMPTY_MACRO_CANDIDATES,
    macroPreviewRuntime: suppliedMacroPreviewRuntime,
    openSnooglOnMount = false,
    snooglInsertsMacroId = false,
    selectAllOnMount = false,
    acceptSuggestionOnTab = true,
    onSuggestionTabOwnershipChange,
    style,
    className,
    ...props
  },
  forwardedRef
): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const providedMacroPreviewRuntime = useProvidedMacroPreviewRuntime();
  const macroPreviewRuntime = suppliedMacroPreviewRuntime ?? providedMacroPreviewRuntime;
  const instanceId = useId().replace(/:/g, '');
  const controlRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const compositionActiveRef = useRef(false);
  const inputDuringCompositionRef = useRef(false);
  const suggestionOwnershipRef = useRef(false);
  const [compositionActive, setCompositionActive] = useState(false);
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [mirrorStyle, setMirrorStyle] = useState<React.CSSProperties>({});
  const mirrorSignatureRef = useRef('');
  const [caretPosition, setCaretPosition] = useState(value.length);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(0);
  const [snooglOpen, setSnooglOpen] = useState(false);
  const [snooglQuery, setSnooglQuery] = useState('');
  const [snooglSelection, setSnooglSelection] = useState(0);
  const [visibleSnooglPreviewIds, setVisibleSnooglPreviewIds] = useState<Set<string>>(
    () => new Set()
  );
  const snooglSearchRef = useRef<HTMLInputElement | null>(null);
  const snooglPreviewRowsRef = useRef(new Map<string, HTMLElement>());
  const snooglObserverGenerationRef = useRef(0);
  const snooglRangeRef = useRef<{ start: number; end: number } | null>(null);
  const interactionDisabled = Boolean(
    (props as React.InputHTMLAttributes<HTMLInputElement>).readOnly ||
    (props as React.InputHTMLAttributes<HTMLInputElement>).disabled
  );
  useImperativeHandle(forwardedRef, () => controlRef.current!, [multiline]);
  const searchCandidates = useMemo(
    () => Array.from(new Map(
      macroCandidates.map((candidate) => [candidate.id, candidate] as const)
    ).values()),
    [macroCandidates]
  );
  const searchIndex = useMemo(() => new SnooglSearchIndex(
    searchCandidates.map((candidate) => createSnooglSearchDocument({
      id: candidate.id,
      value: candidate,
      labels: candidate.labels
    }))
  ), [searchCandidates]);

  const handleValueChange = (next: string, nextCaret: number | null): void => {
    const normalized = autoCloseLeadingDelimiter(value, next);
    // A parent may project one typed surface into separate fields (for
    // example `foo@entry` becomes Macro `foo` plus a context picker). React
    // then writes a value different from the browser's native edit and moves
    // the caret to the end. Preserve the post-input caret for every edit, not
    // only delimiter auto-close.
    pendingCaretRef.current = normalized.caret ?? nextCaret;
    // Every edit gets its own layout transaction, even when the parent rejects
    // it and leaves the controlled value unchanged. This consumes the pending
    // caret now instead of leaking it into a later unrelated prop update.
    setSelectionEpoch((epoch) => epoch + 1);
    setCaretPosition(normalized.caret ?? nextCaret ?? normalized.value.length);
    setHighlightedSuggestion(0);
    onChange(normalized.value);
    if (!interactionDisabled) {
      if (compositionActiveRef.current) inputDuringCompositionRef.current = true;
      else setSuggestionsOpen(true);
    }
  };

  useLayoutEffect(() => {
    // Selection changes during composition can terminate or relocate the IME
    // session. Keep the requested caret pending until compositionend.
    if (compositionActiveRef.current || pendingCaretRef.current === null) return;
    const control = controlRef.current;
    if (!control) return;
    const caret = Math.min(pendingCaretRef.current, control.value.length);
    pendingCaretRef.current = null;
    control.setSelectionRange(caret, caret);
  }, [selectionEpoch, value]);

  const beginComposition = (): void => {
    compositionActiveRef.current = true;
    inputDuringCompositionRef.current = false;
    setCompositionActive(true);
    pendingCaretRef.current = null;
  };
  const endComposition = (): void => {
    compositionActiveRef.current = false;
    setCompositionActive(false);
    if (inputDuringCompositionRef.current && !interactionDisabled) {
      inputDuringCompositionRef.current = false;
      setHighlightedSuggestion(0);
      setSuggestionsOpen(true);
    }
    if (pendingCaretRef.current !== null) {
      setSelectionEpoch((epoch) => epoch + 1);
    }
  };

  useEffect(() => {
    if (snooglOpen) snooglSearchRef.current?.focus();
  }, [snooglOpen]);

  useEffect(() => {
    if (!selectAllOnMount || interactionDisabled) return;
    const control = controlRef.current;
    if (!control) return;
    control.focus();
    control.setSelectionRange(0, control.value.length);
    // Mount-only: retyping must not re-select what the user is editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectAllOnMount, interactionDisabled]);

  useEffect(() => {
    if (!openSnooglOnMount || interactionDisabled) return;
    snooglRangeRef.current = macroTokenRange(value, value.length);
    setSuggestionsOpen(false);
    setSnooglQuery('');
    setSnooglSelection(0);
    setSnooglOpen(true);
  }, [openSnooglOnMount, interactionDisabled]);

  const suggestionsAt = (position: number): string[] => {
    const range = macroTokenRange(value, position);
    const token = value.slice(range.start, range.end);
    const needle = token.split('[')[0];
    if (!needle) return [];
    // SNoogL owns Macro identity only. Style is selected through the editor's
    // separate dropdown and must never leak back into this text channel.
    return searchIndex.search(needle)
      .map((result) => result.value.id)
      .filter((id) => id.toLowerCase() !== token.toLowerCase())
      .slice(0, 8);
  };
  const suggestions = suggestionsOpen ? suggestionsAt(caretPosition) : [];

  useEffect(() => {
    setHighlightedSuggestion((index) =>
      suggestions.length === 0 ? 0 : Math.min(index, suggestions.length - 1)
    );
  }, [suggestions.length]);
  useEffect(() => {
    if (suggestionsOpen && suggestions.length === 0) setSuggestionsOpen(false);
  }, [suggestionsOpen, suggestions.length]);

  const suggestionsVisible = suggestionsOpen && suggestions.length > 0;
  const ownsSuggestionTab = acceptSuggestionOnTab && suggestionsVisible &&
    !compositionActive && !snooglOpen;
  useEffect(() => {
    if (suggestionOwnershipRef.current === ownsSuggestionTab) return;
    suggestionOwnershipRef.current = ownsSuggestionTab;
    onSuggestionTabOwnershipChange?.(ownsSuggestionTab);
  }, [ownsSuggestionTab, onSuggestionTabOwnershipChange]);
  useEffect(() => () => {
    if (!suggestionOwnershipRef.current) return;
    suggestionOwnershipRef.current = false;
    onSuggestionTabOwnershipChange?.(false);
  }, [onSuggestionTabOwnershipChange]);

  const snooglResults = snooglOpen
    ? searchIndex.search(snooglQuery)
        .map((result) => result.value.id)
        .slice(0, 30)
    : [];

  const snooglResultsKey = snooglResults.join('\u0000');
  useEffect(() => {
    const generation = ++snooglObserverGenerationRef.current;
    setVisibleSnooglPreviewIds(new Set());
    if (!snooglOpen || !macroPreviewRuntime || snooglResults.length === 0) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisibleSnooglPreviewIds(new Set(snooglResults));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (snooglObserverGenerationRef.current !== generation) return;
      setVisibleSnooglPreviewIds((current) => {
        const next = new Set(current);
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.macroPreviewRow;
          if (!id) continue;
          if (snooglPreviewRowsRef.current.get(id) !== entry.target) continue;
          if (entry.isIntersecting) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    });
    for (const id of snooglResults) {
      const row = snooglPreviewRowsRef.current.get(id);
      if (row) observer.observe(row);
    }
    return () => {
      if (snooglObserverGenerationRef.current === generation) {
        snooglObserverGenerationRef.current += 1;
      }
      observer.disconnect();
    };
    // The joined key intentionally invalidates observation for a new ranked result set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [macroPreviewRuntime, snooglOpen, snooglResultsKey]);

  useEffect(() => {
    setSnooglSelection((index) =>
      snooglResults.length === 0 ? 0 : Math.min(index, snooglResults.length - 1)
    );
  }, [snooglResults.length]);

  useEffect(() => {
    if (!snooglOpen) return;
    const id = snooglResults[snooglSelection];
    if (!id) return;
    snooglPreviewRowsRef.current.get(id)?.scrollIntoView?.({ block: 'nearest' });
  }, [snooglOpen, snooglResultsKey, snooglSelection]);

  const replaceRangeWithMacro = (range: { start: number; end: number }, id: string): void => {
    const next = `${value.slice(0, range.start)}${id}${value.slice(range.end)}`;
    pendingCaretRef.current = range.start + id.length;
    setCaretPosition(range.start + id.length);
    onChange(next);
  };

  const applySuggestion = (id: string): void => {
    const currentCaret = controlRef.current?.selectionStart ?? value.length;
    const range = macroTokenRange(value, currentCaret);
    replaceRangeWithMacro(range, id);
    setSuggestionsOpen(false);
  };

  const handleControlKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>
  ): void => {
    const currentCaret = event.currentTarget.selectionStart ?? value.length;
    const selectionEnd = event.currentTarget.selectionEnd ?? currentCaret;
    if (event.nativeEvent.isComposing &&
        (event.key === 'ArrowDown' || event.key === 'ArrowUp' ||
         event.key === 'Escape' || event.key === 'Tab')) {
      return;
    }
    if (
      !interactionDisabled &&
      !event.nativeEvent.isComposing &&
      (event.key === '$' || event.key === '%') &&
      currentCaret === 0
    ) {
      event.preventDefault();
      const inner = selectionEnd === value.length ? '' : value;
      const closingDelimiter = inner.endsWith('$') || inner.endsWith('%') ? '' : event.key;
      const next = `${event.key}${inner}${closingDelimiter}`;
      pendingCaretRef.current = 1;
      setCaretPosition(1);
      onChange(next);
      setSuggestionsOpen(false);
      return;
    }
    if (!interactionDisabled && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      event.stopPropagation();
      snooglRangeRef.current = snooglInsertsMacroId
        ? { start: currentCaret, end: currentCaret }
        : macroTokenRange(value, currentCaret);
      setSuggestionsOpen(false);
      setSnooglQuery('');
      setSnooglSelection(0);
      setSnooglOpen(true);
      return;
    }
    const currentSuggestions = suggestionsVisible
      ? (currentCaret === caretPosition ? suggestions : suggestionsAt(currentCaret))
      : [];
    if (suggestionsVisible && currentSuggestions.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setHighlightedSuggestion((index) =>
          (index + delta + currentSuggestions.length) % currentSuggestions.length
        );
        return;
      }
      if (event.key === 'Tab' && !event.shiftKey && acceptSuggestionOnTab) {
        event.preventDefault();
        applySuggestion(
          currentSuggestions[highlightedSuggestion] ?? currentSuggestions[0]
        );
        return;
      }
    }
    if (event.key === 'Escape' && suggestionsVisible) {
      event.preventDefault();
      setSuggestionsOpen(false);
      return;
    }
    (props.onKeyDown as React.KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement> | undefined)?.(event);
  };

  const handleControlFocus = (
    event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>
  ): void => {
    delete event.currentTarget.dataset.snlSuppressSuggestionsOnce;
    (props.onFocus as React.FocusEventHandler<HTMLInputElement | HTMLTextAreaElement> | undefined)?.(event);
  };
  const handleControlSelect = (
    event: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>
  ): void => {
    setCaretPosition(event.currentTarget.selectionStart ?? value.length);
    setHighlightedSuggestion(0);
    (props.onSelect as React.ReactEventHandler<HTMLInputElement | HTMLTextAreaElement> | undefined)?.(event);
  };
  const handleControlBlur = (
    event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>
  ): void => {
    setSuggestionsOpen(false);
    (props.onBlur as React.FocusEventHandler<HTMLInputElement | HTMLTextAreaElement> | undefined)?.(event);
  };

  const lines = value.split('\n');
  const rows = Math.max(1, lines.length);
  const widthCh = Math.min(
    80,
    Math.max(12, ...lines.map((line) => line.length + 2))
  );

  useLayoutEffect(() => {
    if (!multiline || !autoSize) return;
    const textarea = controlRef.current as HTMLTextAreaElement | null;
    if (!textarea) return;
    const resize = (): void => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.max(textarea.scrollHeight, rows * 20 + 8)}px`;
    };
    resize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(resize);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [value, multiline, autoSize, rows]);

  useLayoutEffect(() => {
    const control = controlRef.current;
    if (!control) return;
    const computed = window.getComputedStyle(control);
    const next: React.CSSProperties = {
      top: computed.borderTopWidth,
      right: computed.borderRightWidth,
      bottom: computed.borderBottomWidth,
      left: computed.borderLeftWidth,
      padding: computed.padding,
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      fontWeight: computed.fontWeight,
      fontStyle: computed.fontStyle,
      lineHeight: computed.lineHeight,
      letterSpacing: computed.letterSpacing,
      textAlign: computed.textAlign as React.CSSProperties['textAlign'],
      textIndent: computed.textIndent,
      tabSize: computed.tabSize
    };
    const signature = JSON.stringify(next);
    if (signature !== mirrorSignatureRef.current) {
      mirrorSignatureRef.current = signature;
      setMirrorStyle(next);
    }
  });

  const layoutStyle: React.CSSProperties = {
    position: style?.position ?? 'relative',
    left: style?.left,
    top: style?.top,
    right: style?.right,
    bottom: style?.bottom,
    zIndex: style?.zIndex,
    display: style?.display ?? (multiline ? 'inline-block' : 'inline-flex'),
    ...(style?.flex !== undefined
      ? { flex: style.flex }
      : {
          flexGrow: style?.flexGrow,
          flexShrink: style?.flexShrink,
          flexBasis: style?.flexBasis
        }),
    alignSelf: style?.alignSelf,
    width: autoSize ? `${widthCh}ch` : style?.width,
    minWidth: style?.minWidth,
    maxWidth: style?.maxWidth,
    height: style?.height,
    margin: style?.margin,
    marginTop: style?.marginTop,
    marginRight: style?.marginRight,
    marginBottom: style?.marginBottom,
    marginLeft: style?.marginLeft,
    background: style?.background ?? style?.backgroundColor ??
      'var(--vscode-input-background, #1e1e1e)',
    borderRadius: style?.borderRadius
  };
  const controlStyle: React.CSSProperties = {
    ...style,
    position: 'relative',
    left: undefined,
    top: undefined,
    right: undefined,
    bottom: undefined,
    zIndex: 1,
    display: 'block',
    flex: undefined,
    flexGrow: undefined,
    flexShrink: undefined,
    flexBasis: undefined,
    width: '100%',
    minWidth: 0,
    maxWidth: '100%',
    margin: 0,
    boxSizing: 'border-box',
    background: 'transparent',
    backgroundColor: 'transparent',
    color: value ? 'transparent' : style?.color,
    caretColor: style?.color ?? 'var(--vscode-input-foreground, #ddd)',
    ...(autoSize ? { resize: 'none', overflow: 'hidden' } : {})
  };
  const tokenColors: Record<MacroIdDslTone, string> = {
    plain: style?.color?.toString() ?? 'var(--vscode-input-foreground, #ddd)',
    formula: '#f14c4c',
    text: '#4ec9b0',
    binder: '#ce9178',
    context: '#c586c0'
  };
  const highlight = value ? (
    <div
      aria-hidden="true"
      data-macro-id-highlight="true"
      style={{
        ...mirrorStyle,
        position: 'absolute',
        zIndex: 0,
        pointerEvents: 'none',
        boxSizing: 'border-box',
        overflow: 'hidden',
        whiteSpace: multiline ? 'pre-wrap' : 'pre'
      }}
    >
      <span
        data-macro-id-highlight-content="true"
        style={{
          display: 'block',
          transform: `translate(${-scroll.left}px, ${-scroll.top}px)`
        }}
      >
        {tokenizeMacroIdDsl(value).map((token, index) => (
          <span key={index} data-tone={token.tone} style={{ color: tokenColors[token.tone] }}>
            {token.text}
          </span>
        ))}
      </span>
    </div>
  ) : null;

  const suggestionList = suggestionsVisible ? (
    <div
      id={`${instanceId}-suggestions`}
      role="listbox"
      aria-label={t('suggestions')}
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        minWidth: '100%',
        width: macroPreviewRuntime ? 'min(42rem, calc(100vw - 2rem))' : undefined,
        maxWidth: 'calc(100vw - 2rem)',
        maxHeight: '12rem',
        overflow: 'hidden',
        zIndex: 1000,
        border: '1px solid var(--vscode-widget-border, #555)',
        background: 'var(--vscode-editorWidget-background, #252526)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.35)'
      }}
    >
      <div style={{ display: 'flex', minWidth: 0, maxHeight: '12rem' }}>
        <div style={{ minWidth: 0, flex: '1 1 12rem', overflowY: 'auto' }}>
          {suggestions.map((id, index) => (
            <div
              id={`${instanceId}-suggestion-${index}`}
              key={id}
              role="option"
              aria-selected={index === highlightedSuggestion}
              onMouseDown={(event) => {
                event.preventDefault();
                applySuggestion(id);
              }}
              style={{
                padding: '0.25rem 0.45rem',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                color: 'var(--vscode-editorWidget-foreground, #ddd)',
                background: index === highlightedSuggestion
                  ? 'var(--vscode-list-activeSelectionBackground, #094771)'
                  : 'transparent'
              }}
            >
              {id}
            </div>
          ))}
        </div>
        {macroPreviewRuntime ? (
          <div
            data-macro-preview-pane="inline"
            aria-live="polite"
            style={{
              flex: '1 1 18rem',
              minWidth: '12rem',
              maxWidth: '24rem',
              overflow: 'auto',
              padding: '0.5rem',
              borderLeft: '1px solid var(--vscode-widget-border, #555)',
              pointerEvents: 'none'
            }}
          >
            {(() => {
              const id = suggestions[highlightedSuggestion] ?? suggestions[0];
              const macro = id ? macroPreviewRuntime.macros[id] : undefined;
              return macro
                ? <MacroPreview macro={macro} runtime={macroPreviewRuntime} label={t('preview', { id })} />
                : null;
            })()}
          </div>
        ) : null}
      </div>
    </div>
  ) : null;

  const closeSnoogl = (): void => {
    setSnooglOpen(false);
    window.setTimeout(() => controlRef.current?.focus(), 0);
  };
  const commitSnooglResult = (id: string): void => {
    const range = snooglRangeRef.current;
    if (!range) return;
    // In insert-only mode `range` is already the collapsed caret position, so
    // picking a Macro never wipes the surrounding SNL expression.
    replaceRangeWithMacro(range, id);
    closeSnoogl();
  };
  const commitSnooglSelection = (): void => {
    const id = snooglResults[snooglSelection];
    if (id) commitSnooglResult(id);
  };
  const snooglDialog = snooglOpen ? (
    <div
      role="dialog"
      aria-label={t('dialog')}
      aria-modal="true"
      style={{
        position: 'fixed',
        left: '50%',
        top: '18%',
        transform: 'translateX(-50%)',
        width: 'min(42rem, calc(100vw - 3rem))',
        maxHeight: '64vh',
        zIndex: 10000,
        padding: '0.75rem',
        border: '1px solid var(--vscode-widget-border, #555)',
        borderRadius: '6px',
        background: 'var(--vscode-editorWidget-background, #252526)',
        boxShadow: '0 12px 36px rgba(0,0,0,0.55)'
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>{t('heading')}</div>
      <input
        ref={snooglSearchRef}
        aria-label={t('search')}
        aria-controls={`${instanceId}-snoogl-results`}
        aria-activedescendant={snooglResults.length > 0
          ? `${instanceId}-snoogl-result-${snooglSelection}`
          : undefined}
        value={snooglQuery}
        onChange={(event) => {
          setSnooglQuery(event.target.value);
          setSnooglSelection(0);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing &&
              (event.key === 'ArrowDown' || event.key === 'ArrowUp' ||
               event.key === 'Escape' || event.key === 'Tab')) {
            return;
          }
          if (event.key === 'Tab' && !event.shiftKey && snooglResults.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            commitSnooglSelection();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (snooglResults.length > 0) {
              const delta = event.key === 'ArrowDown' ? 1 : -1;
              setSnooglSelection((index) =>
                (index + delta + snooglResults.length) % snooglResults.length
              );
            }
          } else if (event.key === 'Escape') {
            event.preventDefault();
            closeSnoogl();
          }
        }}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '0.4rem 0.5rem',
          color: 'var(--vscode-input-foreground, #ddd)',
          background: 'var(--vscode-input-background, #1e1e1e)',
          border: '1px solid var(--vscode-input-border, #555)'
        }}
      />
      <div
        id={`${instanceId}-snoogl-results`}
        role="listbox"
        aria-label={t('results')}
        aria-activedescendant={snooglResults.length > 0
          ? `${instanceId}-snoogl-result-${snooglSelection}`
          : undefined}
        style={{ marginTop: '0.5rem', maxHeight: '48vh', overflowY: 'auto' }}
      >
        {snooglResults.map((id, index) => (
          <div
            id={`${instanceId}-snoogl-result-${index}`}
            key={id}
            role="option"
            aria-selected={index === snooglSelection}
            ref={(element) => {
              if (element) snooglPreviewRowsRef.current.set(id, element);
              else snooglPreviewRowsRef.current.delete(id);
            }}
            data-macro-preview-row={id}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commitSnooglResult(id)}
            style={{
              padding: '0.35rem 0.5rem',
              cursor: 'pointer',
              display: macroPreviewRuntime ? 'grid' : undefined,
              gridTemplateColumns: macroPreviewRuntime ? 'minmax(8rem, 1fr) minmax(12rem, 2fr)' : undefined,
              gap: macroPreviewRuntime ? '0.75rem' : undefined,
              alignItems: 'center',
              minHeight: macroPreviewRuntime ? '3rem' : undefined,
              background: index === snooglSelection
                ? 'var(--vscode-list-activeSelectionBackground, #094771)'
                : 'transparent'
            }}
          >
            <span>{id}</span>
            {macroPreviewRuntime && visibleSnooglPreviewIds.has(id) &&
              macroPreviewRuntime.macros[id] ? (
                <span style={{ pointerEvents: 'none', minWidth: 0 }}>
                  <MacroPreview
                    macro={macroPreviewRuntime.macros[id]}
                    runtime={macroPreviewRuntime}
                    label={t('preview', { id })}
                  />
                </span>
              ) : null}
          </div>
        ))}
      </div>
      <div style={{ marginTop: '0.45rem', opacity: 0.65, fontSize: '0.8rem' }}>
        {t('hint')}
      </div>
    </div>
  ) : null;

  const viewportStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    borderRadius: style?.borderRadius
  };

  if (multiline) {
    const textareaProps = props as unknown as React.TextareaHTMLAttributes<HTMLTextAreaElement>;
    return (
      <span style={layoutStyle} data-macro-id-control="true">
        <span style={viewportStyle} data-macro-id-viewport="true">
          {highlight}
          <textarea
            {...textareaProps}
            ref={(element) => { controlRef.current = element; }}
            className={['snl-macro-id-native-control', className].filter(Boolean).join(' ')}
            value={value}
             aria-controls={suggestions.length > 0 ? `${instanceId}-suggestions` : undefined}
             aria-activedescendant={suggestions.length > 0
               ? `${instanceId}-suggestion-${highlightedSuggestion}`
               : undefined}
            rows={autoSize ? rows : undefined}
            onChange={(event) => handleValueChange(
              event.target.value,
              event.target.selectionStart
            )}
            onSelect={handleControlSelect}
            onCompositionStart={(event) => {
              beginComposition();
              textareaProps.onCompositionStart?.(event);
            }}
            onCompositionEnd={(event) => {
              textareaProps.onCompositionEnd?.(event);
              endComposition();
            }}
            onKeyDown={handleControlKeyDown}
            onFocus={handleControlFocus}
            onBlur={handleControlBlur}
            onScroll={(event) => {
              setScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop });
              textareaProps.onScroll?.(event);
            }}
            style={controlStyle}
          />
        </span>
        {suggestionList}
        {snooglDialog}
      </span>
    );
  }

  const inputProps = props as React.InputHTMLAttributes<HTMLInputElement>;
  return (
    <span style={layoutStyle} data-macro-id-control="true">
      <span style={viewportStyle} data-macro-id-viewport="true">
        {highlight}
        <input
          {...inputProps}
          ref={(element) => { controlRef.current = element; }}
          className={['snl-macro-id-native-control', className].filter(Boolean).join(' ')}
          value={value}
          aria-controls={suggestions.length > 0 ? `${instanceId}-suggestions` : undefined}
          aria-activedescendant={suggestions.length > 0
            ? `${instanceId}-suggestion-${highlightedSuggestion}`
            : undefined}
          onChange={(event) => handleValueChange(
            event.target.value,
            event.target.selectionStart
          )}
          onSelect={handleControlSelect}
          onCompositionStart={(event) => {
            beginComposition();
            inputProps.onCompositionStart?.(event);
          }}
          onCompositionEnd={(event) => {
            inputProps.onCompositionEnd?.(event);
            endComposition();
          }}
          onKeyDown={handleControlKeyDown}
          onFocus={handleControlFocus}
          onBlur={handleControlBlur}
          onScroll={(event) => {
            setScroll({ left: event.currentTarget.scrollLeft, top: 0 });
            inputProps.onScroll?.(event);
          }}
          style={controlStyle}
          type={inputProps.type ?? 'text'}
        />
      </span>
      {suggestionList}
      {snooglDialog}
    </span>
  );
});
