import React, { createContext, useContext } from 'react';
import {
  defaultRenderHooks,
  SnlSyntaxTreeView,
  type KindPalette,
  type MacroDataDriver,
  type SnlRenderHooks,
  type SnlSyntaxTree
} from '@sjtu-ai4math/snl-basics';
import { ReaderRuntime, type LanguageEnvironment } from '@sjtu-ai4math/snl-basics/runtime';
import { analyzeLatexTemplatePlaceholders } from '../../../src/templatePlaceholders';
import { CollapsibleScope } from './CollapsibleScope';
import { extensionRenderers } from './blockRenderers';
import { createMacroDataDriver } from './macroData';
import { macroKindsToPalette, type MacroKindPaletteSource } from './macroKindPalette';
import {
  MACRO_PREVIEW_ARGUMENTS,
  MAX_MACRO_PREVIEW_ARGS,
  macroPreviewArgumentNode
} from './macroPreviewPlaceholders';
import {
  resolveWireTemplate,
  wireMacroEntriesToRenderable,
  type WireMacro,
  type WireMacroStyle,
  type WireMacroTemplate
} from './macroWire';

const VARIADIC_PREVIEW_ARGS = 3;

export interface MacroPreviewRuntime {
  readonly macros: Readonly<Record<string, WireMacro>>;
  readonly macroDataDriver: MacroDataDriver;
  readonly readerRuntime: ReaderRuntime<LanguageEnvironment<string>>;
  readonly hooks: SnlRenderHooks;
  readonly kindPalette: KindPalette | undefined;
  readonly language: string;
  readonly renderRevision: number;
  readonly backendQueryCount: () => number;
}

export interface CreateMacroPreviewRuntimeOptions {
  macros: Readonly<Record<string, WireMacro>>;
  macroKinds?: readonly MacroKindPaletteSource[];
  language: string;
  renderRevision?: number;
}

export function createMacroPreviewRuntime({
  macros,
  macroKinds = [],
  language,
  renderRevision = 0
}: CreateMacroPreviewRuntimeOptions): MacroPreviewRuntime {
  let backendQueries = 0;
  const macroRecord = {
    ...wireMacroEntriesToRenderable(Object.entries(macros), language),
    ...MACRO_PREVIEW_ARGUMENTS
  };
  return {
    macros,
    macroDataDriver: createMacroDataDriver([macroRecord], () => { backendQueries += 1; }),
    readerRuntime: new ReaderRuntime({
      queries: { query_environment: () => ({ language }) }
    }),
    hooks: {
      ...defaultRenderHooks,
      renderTooltip: () => null,
      renderers: extensionRenderers
    },
    kindPalette: macroKindsToPalette(macroKinds),
    language,
    renderRevision,
    backendQueryCount: () => backendQueries
  };
}

const MacroPreviewRuntimeContext = createContext<MacroPreviewRuntime | undefined>(undefined);

export function MacroPreviewRuntimeProvider({
  runtime,
  children
}: {
  runtime: MacroPreviewRuntime;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <MacroPreviewRuntimeContext.Provider value={runtime}>
      {children}
    </MacroPreviewRuntimeContext.Provider>
  );
}

export function useProvidedMacroPreviewRuntime(): MacroPreviewRuntime | undefined {
  return useContext(MacroPreviewRuntimeContext);
}

function selectedStyle(macro: WireMacro, styleName: string | undefined): WireMacroStyle | undefined {
  if (!Array.isArray(macro.styles) || macro.styles.length === 0) return undefined;
  if (styleName === undefined) return macro.styles[0];
  return macro.styles.find((style) => style.style_name === styleName) ?? macro.styles[0];
}

function previewTemplate(
  macro: WireMacro,
  styleName: string | undefined,
  language: string
): WireMacroTemplate | undefined {
  const style = selectedStyle(macro, styleName);
  return style ? resolveWireTemplate(style.template, language) : undefined;
}

export function macroPreviewTree(
  macro: WireMacro,
  styleName: string | undefined,
  language: string
): SnlSyntaxTree {
  const template = previewTemplate(macro, styleName, language);
  const analysis = analyzeLatexTemplatePlaceholders(template?.body ?? '');
  if (analysis.invalid) throw new Error('invalid Macro preview template placeholders');
  const argCount = macro.dynamic_arity
    ? Math.min(VARIADIC_PREVIEW_ARGS, MAX_MACRO_PREVIEW_ARGS)
    : Math.min(analysis.positional_arity, MAX_MACRO_PREVIEW_ARGS);
  return {
    macro_name: macro.name,
    kind: '',
    mdata: null,
    children: Array.from({ length: argCount }, (_, index) => macroPreviewArgumentNode(index)),
    ...(styleName === undefined ? {} : { style_name: styleName })
  };
}

class MacroPreviewBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidUpdate(previous: Readonly<{ fallback: React.ReactNode; children: React.ReactNode }>): void {
    if (this.state.failed && previous.children !== this.props.children) {
      this.setState({ failed: false });
    }
  }

  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function PreviewFallback(): React.ReactElement {
  return (
    <span data-macro-preview-fallback="true" style={{ opacity: 0.5 }}>
      —
    </span>
  );
}

function PreviewFrame({
  macroName,
  label,
  children
}: {
  macroName: string;
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      role="img"
      aria-label={label}
      data-macro-preview={macroName}
      inert
      style={{ display: 'inline-block', maxWidth: '100%', pointerEvents: 'none' }}
    >
      {children}
    </span>
  );
}

export function MacroPreview({
  macro,
  styleName,
  runtime,
  label
}: {
  macro: WireMacro;
  styleName?: string;
  runtime: MacroPreviewRuntime;
  label: string;
}): React.ReactElement {
  const preview = React.useMemo(() => {
    try {
      return {
        template: previewTemplate(macro, styleName, runtime.language),
        tree: macroPreviewTree(macro, styleName, runtime.language)
      };
    } catch {
      return undefined;
    }
  }, [macro, runtime.language, styleName]);
  const resetKey = `${macro.name}:${styleName ?? 'default'}:${runtime.renderRevision}`;
  const view = React.useMemo(() => preview ? (
    <CollapsibleScope resetKey={resetKey} label={label}>
      <SnlSyntaxTreeView
        key={resetKey}
        tree={preview.tree}
        macro_data_driver={runtime.macroDataDriver}
        reader_runtime={runtime.readerRuntime}
        hooks={runtime.hooks}
        kindPalette={runtime.kindPalette}
      />
    </CollapsibleScope>
  ) : null, [
    label,
    preview,
    resetKey,
    runtime.hooks,
    runtime.kindPalette,
    runtime.macroDataDriver,
    runtime.readerRuntime
  ]);

  if (!preview?.template?.body.trim() || !view) {
    return (
      <PreviewFrame macroName={macro.name} label={label}>
        <PreviewFallback />
      </PreviewFrame>
    );
  }

  return (
    <PreviewFrame macroName={macro.name} label={label}>
      <MacroPreviewBoundary fallback={<PreviewFallback />}>
        {view}
      </MacroPreviewBoundary>
    </PreviewFrame>
  );
}
