import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react';

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
  const push = (text: string, tone: MacroIdDslTone): void => {
    const previous = tokens.at(-1);
    if (previous?.tone === tone) previous.text += text;
    else tokens.push({ text, tone });
  };
  for (const char of value) {
    if (char === '$') {
      push(char, 'formula');
      atNodeStart = false;
    } else if (char === '%') {
      push(char, 'text');
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

function macroTokenRange(value: string, caret: number): { start: number; end: number } {
  const isToken = (char: string): boolean => !/[\s(),\[\]$%@]/.test(char);
  let start = Math.min(Math.max(caret, 0), value.length);
  let end = start;
  while (start > 0 && isToken(value[start - 1])) start -= 1;
  while (end < value.length && isToken(value[end])) end += 1;
  return { start, end };
}

interface MacroIdInputBaseProps {
  value: string;
  onChange: (value: string) => void;
  autoSize?: boolean;
  macroIds?: readonly string[];
  /** Open the embedded SNoogL Macro picker as soon as this control mounts. */
  openSnooglOnMount?: boolean;
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
    macroIds = [],
    openSnooglOnMount = false,
    style,
    className,
    ...props
  },
  forwardedRef
): React.ReactElement {
  const controlRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [mirrorStyle, setMirrorStyle] = useState<React.CSSProperties>({});
  const mirrorSignatureRef = useRef('');
  const [caretPosition, setCaretPosition] = useState(value.length);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(0);
  const [snooglOpen, setSnooglOpen] = useState(false);
  const [snooglQuery, setSnooglQuery] = useState('');
  const [snooglSelection, setSnooglSelection] = useState(0);
  const snooglSearchRef = useRef<HTMLInputElement | null>(null);
  const snooglRangeRef = useRef<{ start: number; end: number } | null>(null);
  const interactionDisabled = Boolean(
    (props as React.InputHTMLAttributes<HTMLInputElement>).readOnly ||
    (props as React.InputHTMLAttributes<HTMLInputElement>).disabled
  );
  useImperativeHandle(forwardedRef, () => controlRef.current!, [multiline]);

  const handleValueChange = (next: string, nextCaret: number | null): void => {
    const normalized = autoCloseLeadingDelimiter(value, next);
    pendingCaretRef.current = normalized.caret;
    setCaretPosition(normalized.caret ?? nextCaret ?? normalized.value.length);
    onChange(normalized.value);
    if (!interactionDisabled) setSuggestionsOpen(true);
  };

  useLayoutEffect(() => {
    if (pendingCaretRef.current === null) return;
    const caret = pendingCaretRef.current;
    pendingCaretRef.current = null;
    controlRef.current?.setSelectionRange(caret, caret);
  }, [value]);

  useEffect(() => {
    if (snooglOpen) snooglSearchRef.current?.focus();
  }, [snooglOpen]);

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
    const needle = value.slice(range.start, range.end).toLowerCase();
    return needle
      ? Array.from(new Set(macroIds))
          .filter((id) =>
            id.toLowerCase().includes(needle) &&
            id.toLowerCase() !== needle
          )
          .slice(0, 8)
      : [];
  };
  const suggestions = suggestionsAt(caretPosition);

  useEffect(() => {
    setHighlightedSuggestion((index) =>
      suggestions.length === 0 ? 0 : Math.min(index, suggestions.length - 1)
    );
  }, [suggestions.length]);

  const snooglResults = Array.from(new Set(macroIds))
    .filter((id) => id.toLowerCase().includes(snooglQuery.trim().toLowerCase()))
    .slice(0, 30);

  useEffect(() => {
    setSnooglSelection((index) =>
      snooglResults.length === 0 ? 0 : Math.min(index, snooglResults.length - 1)
    );
  }, [snooglResults.length]);

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
    if (
      !interactionDisabled &&
      !event.nativeEvent.isComposing &&
      (event.key === '$' || event.key === '%') &&
      currentCaret === 0
    ) {
      event.preventDefault();
      const inner = selectionEnd === value.length ? '' : value;
      const next = `${event.key}${inner}${event.key}`;
      pendingCaretRef.current = 1;
      setCaretPosition(1);
      onChange(next);
      setSuggestionsOpen(false);
      return;
    }
    if (!interactionDisabled && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      event.stopPropagation();
      snooglRangeRef.current = macroTokenRange(value, currentCaret);
      setSuggestionsOpen(false);
      setSnooglQuery('');
      setSnooglSelection(0);
      setSnooglOpen(true);
      return;
    }
    const currentSuggestions = suggestionsAt(currentCaret);
    if (suggestionsOpen && currentSuggestions.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setHighlightedSuggestion((index) =>
          (index + delta + currentSuggestions.length) % currentSuggestions.length
        );
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        applySuggestion(
          currentSuggestions[highlightedSuggestion] ?? currentSuggestions[0]
        );
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSuggestionsOpen(false);
        return;
      }
    }
    (props.onKeyDown as React.KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement> | undefined)?.(event);
  };

  const handleControlFocus = (
    event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>
  ): void => {
    if (!interactionDisabled) setSuggestionsOpen(true);
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
    window.setTimeout(() => setSuggestionsOpen(false), 0);
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
    flex: style?.flex,
    flexGrow: style?.flexGrow,
    flexShrink: style?.flexShrink,
    flexBasis: style?.flexBasis,
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

  const suggestionList = suggestionsOpen && suggestions.length > 0 ? (
    <div
      role="listbox"
      aria-label="Macro ID suggestions"
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        minWidth: '100%',
        maxHeight: '12rem',
        overflowY: 'auto',
        zIndex: 1000,
        border: '1px solid var(--vscode-widget-border, #555)',
        background: 'var(--vscode-editorWidget-background, #252526)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.35)'
      }}
    >
      {suggestions.map((id, index) => (
        <div
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
  ) : null;

  const closeSnoogl = (): void => {
    setSnooglOpen(false);
    window.setTimeout(() => controlRef.current?.focus(), 0);
  };
  const commitSnooglSelection = (): void => {
    const id = snooglResults[snooglSelection];
    const range = snooglRangeRef.current;
    if (!id || !range) return;
    replaceRangeWithMacro(range, id);
    closeSnoogl();
  };
  const snooglDialog = snooglOpen ? (
    <div
      role="dialog"
      aria-label="SNoogL Macro Search"
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
      <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>SNoogL · Macro</div>
      <input
        ref={snooglSearchRef}
        aria-label="Search macros in SNoogL"
        value={snooglQuery}
        onChange={(event) => {
          setSnooglQuery(event.target.value);
          setSnooglSelection(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Tab') {
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
      <div role="listbox" aria-label="SNoogL macro results" style={{ marginTop: '0.5rem', maxHeight: '48vh', overflowY: 'auto' }}>
        {snooglResults.map((id, index) => (
          <div
            key={id}
            role="option"
            aria-selected={index === snooglSelection}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setSnooglSelection(index)}
            style={{
              padding: '0.35rem 0.5rem',
              cursor: 'pointer',
              background: index === snooglSelection
                ? 'var(--vscode-list-activeSelectionBackground, #094771)'
                : 'transparent'
            }}
          >
            {id}
          </div>
        ))}
      </div>
      <div style={{ marginTop: '0.45rem', opacity: 0.65, fontSize: '0.8rem' }}>
        Tab inserts the selected Macro · Esc closes
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
            className={className}
            value={value}
            rows={autoSize ? rows : undefined}
            onChange={(event) => handleValueChange(
              event.target.value,
              event.target.selectionStart
            )}
            onSelect={handleControlSelect}
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
          className={className}
          value={value}
          onChange={(event) => handleValueChange(
            event.target.value,
            event.target.selectionStart
          )}
          onSelect={handleControlSelect}
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
