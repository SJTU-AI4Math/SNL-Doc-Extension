import React, { useCallback, useEffect, useRef, useState } from 'react';
import './monaco.css';

interface Disposable { dispose(): void }
interface MonacoModel {
  getValue(): string;
  setValue(value: string): void;
  getFullModelRange(): unknown;
  pushEditOperations(
    selections: null,
    edits: Array<{ range: unknown; text: string }>,
    cursorStateComputer: () => null
  ): unknown;
  pushStackElement(): void;
  dispose(): void;
}
interface MonacoEditor {
  addCommand(keybinding: number, handler: () => void): unknown;
  onDidChangeModelContent(handler: () => void): Disposable;
  layout(): void;
  dispose(): void;
}
export interface MonacoApi {
  KeyMod: { CtrlCmd: number; Shift: number; Alt: number };
  KeyCode: { KeyS: number; KeyF: number };
  editor: {
    createModel(value: string, language?: string): MonacoModel;
    create(container: HTMLElement, options: Record<string, unknown>): MonacoEditor;
    setTheme(theme: string): void;
  };
}

export type MonacoLoader = () => Promise<MonacoApi>;

async function loadDefaultMonaco(): Promise<MonacoApi> {
  return (await import('./monacoRuntime')).monaco as unknown as MonacoApi;
}

export interface MonacoTextEditorProps {
  value: string;
  language: string;
  ariaLabel: string;
  placeholder?: string;
  theme?: string;
  formatLabel?: string;
  formatShortcutLabel?: string;
  onChange(value: string): void;
  onSave(): void;
  format?: (source: string) => string;
  onFormatError?: (error: unknown) => void;
  loadMonaco?: MonacoLoader;
}

export function MonacoTextEditor({
  value,
  language,
  ariaLabel,
  placeholder,
  theme = 'vs-dark',
  formatLabel,
  formatShortcutLabel,
  onChange,
  onSave,
  format,
  onFormatError,
  loadMonaco = loadDefaultMonaco
}: MonacoTextEditorProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef<MonacoModel | null>(null);
  const editorRef = useRef<MonacoEditor | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const formatRef = useRef(format);
  const onFormatErrorRef = useRef(onFormatError);
  const [ready, setReady] = useState(false);

  onChangeRef.current = onChange;
  valueRef.current = value;
  onSaveRef.current = onSave;
  formatRef.current = format;
  onFormatErrorRef.current = onFormatError;

  const runFormat = useCallback((): void => {
    const model = modelRef.current;
    const formatter = formatRef.current;
    if (!model || !formatter) return;
    try {
      const formatted = formatter(model.getValue());
      if (formatted === model.getValue()) return;
      model.pushStackElement();
      model.pushEditOperations(
        null,
        [{ range: model.getFullModelRange(), text: formatted }],
        () => null
      );
      model.pushStackElement();
    } catch (error) {
      onFormatErrorRef.current?.(error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let changeDisposable: Disposable | undefined;
    let resizeObserver: ResizeObserver | undefined;
    const container = containerRef.current;
    if (!container) return;

    void loadMonaco().then((monaco) => {
      if (cancelled) return;
      const model = monaco.editor.createModel(valueRef.current, language);
      const editor = monaco.editor.create(container, {
        model,
        ariaLabel,
        automaticLayout: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        fontFamily: 'var(--vscode-editor-font-family, monospace)',
        fontSize: 14,
        lineNumbers: 'on',
        padding: { top: 8, bottom: 8 },
        placeholder
      });
      modelRef.current = model;
      editorRef.current = editor;
      monacoRef.current = monaco;
      monaco.editor.setTheme(theme);
      changeDisposable = editor.onDidChangeModelContent(() => {
        onChangeRef.current(model.getValue());
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
      if (formatRef.current) {
        editor.addCommand(
          monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
          runFormat
        );
      }
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => editor.layout());
        resizeObserver.observe(container);
      }
      editor.layout();
      setReady(true);
    }).catch((error) => {
      if (!cancelled) onFormatErrorRef.current?.(error);
    });

    return () => {
      cancelled = true;
      setReady(false);
      resizeObserver?.disconnect();
      changeDisposable?.dispose();
      editorRef.current?.dispose();
      modelRef.current?.dispose();
      editorRef.current = null;
      modelRef.current = null;
      monacoRef.current = null;
    };
    // A visible Text Editor owns exactly one model. Changing tab/language
    // unmounts it; controlled value changes are synchronized below.
  }, [ariaLabel, language, loadMonaco, placeholder, runFormat]);

  useEffect(() => {
    const model = modelRef.current;
    if (model && model.getValue() !== value) model.setValue(value);
  }, [value]);

  useEffect(() => {
    if (ready) monacoRef.current?.editor.setTheme(theme);
  }, [ready, theme]);

  return <div className="snl-monaco-shell">
    {format && formatLabel ? (
      <div className="snl-monaco-toolbar">
        <button type="button" className="snl-button snl-button--secondary" onClick={runFormat}>
          {formatLabel}
        </button>
        {formatShortcutLabel ? <span aria-hidden="true">{formatShortcutLabel}</span> : null}
      </div>
    ) : null}
    <div
      ref={containerRef}
      className="snl-monaco-editor"
      data-testid="monaco-editor"
      data-ready={ready ? 'true' : 'false'}
      aria-label={ariaLabel}
    />
  </div>;
}
