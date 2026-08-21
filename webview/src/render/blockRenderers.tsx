// Extension-owned block renderers, plus the registry the Extension hands to
// SNL-Basics's view.
//
// ── Why the registry must spread `defaultRenderers` ──────────────────────────
// `SnlSyntaxTreeView` merges hooks as `{ ...defaultRenderHooks, ...hooksOverride }`
// — a SHALLOW merge. So the moment a consumer passes `renderers` at all, that
// object REPLACES the built-in registry wholesale; it is not merged key-by-key.
// Passing `{ collapsible: CollapsibleRenderer }` alone would therefore silently
// kill `list` / `enumerate` / `table` / `centered` everywhere in the Extension.
// Hence `extensionRenderers` below always spreads `defaultRenderers` first, and
// `blockRenderers.test.tsx` locks that invariant with an explicit assertion.
//
// ── Why the collapse chrome comes from `collapseToggleContract` ──────────────
// The glyphs, `.snl-btn` class list and geometry are shared with the static
// HTML export (see `src/collapseToggleContract.ts`), so the triangle looks and
// sits identically on every surface. The *title* text there says "sub-entries",
// which is Entry-tree vocabulary and wrong for a block macro, so this module
// supplies its own local title function rather than mutating the shared
// contract (both the Infoview and the export read it; changing it breaks the
// parity test that keeps the two honest).

import React, { useEffect, useState } from 'react';
import {
  createSvgTemplateRenderer,
  defaultRenderers,
  SvgTemplateAssetRegistry,
  type SnlBlockRenderer,
  type SnlRendererRegistry,
  type SnlSyntaxTree
} from '@sjtu-ai4math/snl-basics';
import {
  COLLAPSE_GLYPH,
  COLLAPSE_TOGGLE_CLASS,
  COLLAPSE_TOGGLE_STYLE
} from '../../../src/collapseToggleContract';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';
import { getVsCodeApi } from '../vscodeApi';
import { parseBlockRendererSpec, tableOptionsFromRendererParams } from './blockRendererSpec';
import { useCollapsibleController } from './CollapsibleScope';
import { createWorkspaceSvgAssetLoader } from './svgTemplateAssets';
import type { TableTemplateOptions } from '../../../src/tableTemplateOptions';

const MESSAGES = defineUiMessages(
  'collapsibleBlock',
  {
    title: { arg: 'count', one: '{action} {count} part', other: '{action} {count} parts' },
    expand: 'Expand', collapse: 'Collapse',
    expandBlock: 'Expand collapsible block {summary}',
    collapseBlock: 'Collapse collapsible block {summary}',
    noun: { arg: 'count', one: 'part', other: 'parts' },
    imagePathRequired: 'Image path is required.',
    imageLoading: 'Loading image…',
    imageLoadFailed: 'Could not load this workspace image.'
  },
  {
    title: '{action} {count} 个部分', expand: '展开', collapse: '收起',
    expandBlock: '展开可折叠块 {summary}', collapseBlock: '收起可折叠块 {summary}', noun: '个部分',
    imagePathRequired: '必须填写图片路径。',
    imageLoading: '正在加载图片…',
    imageLoadFailed: '无法加载此工作区图片。'
  }
);

/**
 * Tooltip text for a collapsible *block macro*. Deliberately NOT
 * `collapseToggleTitle` from the shared contract: that one counts
 * "sub-entries" (Entry tree), while here the hidden children are body parts of
 * one block.
 */
export function collapsibleBlockTitle(
  collapsed: boolean,
  hiddenCount: number,
  locale = 'en'
): string {
  if (locale.toLowerCase().startsWith('zh')) {
    return `${collapsed ? '展开' : '收起'} ${hiddenCount} 个部分`;
  }
  const noun = `part${hiddenCount === 1 ? '' : 's'}`;
  return `${collapsed ? 'Expand' : 'Collapse'} ${hiddenCount} ${noun}`;
}

/**
 * Author intent for the initial fold state, read from `node.mdata.collapsed`.
 * Authored Collapsible blocks default closed; an explicit boolean remains the
 * existing document-level override (`false` means initially open).
 *
 * This is read-only: the expanded/collapsed state the *reader* produces by
 * clicking is transient UI state held in `useState` and is never written back
 * to the node, its `mdata`, or any serialized form. The syntax tree is the
 * document, not a UI store.
 */
function initiallyCollapsed(node: SnlSyntaxTree): boolean {
  const mdata = node.mdata;
  if (typeof mdata === 'object' && mdata !== null) {
    const authored = (mdata as { collapsed?: unknown }).collapsed;
    if (typeof authored === 'boolean') return authored;
  }
  return true;
}

/**
 * `collapsible` block renderer.
 *
 * Semantics: `children[0]` is the always-visible summary / heading;
 * `children.slice(1)` is the foldable body. With fewer than 2 children there is
 * nothing to fold, so it degrades to a plain block (no toggle) instead of
 * erroring.
 */
export const CollapsibleRenderer: SnlBlockRenderer = ({ node, renderChild }) => {
  const t = useUiMessages(MESSAGES);
  const children: SnlSyntaxTree[] = Array.isArray(node.children) ? node.children : [];
  const authoredInitial = initiallyCollapsed(node);
  const controller = useCollapsibleController(authoredInitial, children.length >= 2);
  const { collapsed } = controller;

  // Degenerate case: no separable body → plain block, no chrome.
  if (children.length < 2) {
    return (
      <div className="snl-collapsible snl-collapsible--flat">
        {children.map((child, i) => (
          <React.Fragment key={i}>{renderChild(child)}</React.Fragment>
        ))}
      </div>
    );
  }

  const [summary, ...body] = children;
  const summaryName = typeof summary.macro_name === 'string' && summary.macro_name
    ? summary.macro_name
    : 'summary';

  return (
    <div
      className="snl-collapsible"
      data-collapsed={collapsed ? 'true' : 'false'}
      // Export contract. `harvestLibraryHtml` strips every <button>, so the
      // static file rebuilds the toggle from these markers (see
      // `src/exportRuntime.ts`). The noun differs from the Entry outline's
      // "sub-entries", so it travels with the markup rather than being
      // hardcoded in the runtime.
      data-snl-collapsible=""
      data-snl-child-count={body.length}
      data-snl-collapse-noun={t('noun', { count: body.length })}
      data-snl-collapsed={collapsed ? 'true' : undefined}
      data-snl-initial-collapsed={authoredInitial ? 'true' : 'false'}
      data-snl-collapse-level={controller.depth}
    >
      {/* `position: relative` + the toggle's `position: absolute; left: -20px`
          make the triangle hang in a gutter to the LEFT of the row. The gutter
          is reserved by `.snl-collapsible`'s own padding-left in `ui.css`
          (matching the Entry outline in App.tsx, which reserves it with
          INDENT_PER_LEVEL, and the static export, which reserves it with
          `.snl-export { padding-left }`). Without that reservation the glyph
          escapes past the left edge of the block. */}
      <div
        className="snl-collapsible__summary"
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            event.stopPropagation();
          }
          controller.toggle(event);
        }}
      >
        <button
          type="button"
          className={COLLAPSE_TOGGLE_CLASS}
          style={COLLAPSE_TOGGLE_STYLE as React.CSSProperties}
          aria-expanded={!collapsed}
          aria-controls={controller.bodyId}
          aria-label={t(collapsed ? 'expandBlock' : 'collapseBlock', { summary: summaryName })}
          title={t('title', {
            action: t(collapsed ? 'expand' : 'collapse'),
            count: body.length
          })}
          onClick={(e) => {
            // The summary row is itself clickable; stop the bubble so one
            // click is not counted twice.
            e.stopPropagation();
            if (e.ctrlKey || e.metaKey) e.preventDefault();
            controller.toggle(e);
          }}
        >
          {collapsed ? COLLAPSE_GLYPH.collapsed : COLLAPSE_GLYPH.expanded}
        </button>
        {controller.nest(renderChild(summary))}
      </div>
      {/* Rendered UNCONDITIONALLY and hidden with the `hidden` attribute
          rather than removed from the tree.

          Two reasons. (1) Export: `harvestLibraryHtml` snapshots the live DOM,
          so a body that isn't mounted is silently DROPPED from the exported
          file — the reader loses content, not just a control. The Entry
          outline dodges this by expanding everything before export
          (`setCollapsed(new Set())` in App.tsx), but that switch lives in App
          state and cannot reach a block renderer's local `useState`.
          (2) `hidden` resolves to `display:none`, whose subtree is neither
          rendered nor focusable, so the no-tab-stops guarantee is unchanged.

          Each child gets its own block-level wrapper. A block renderer walks
          `node.children` directly and never sees the style template, so the
          template's `separator` is NOT applied here — without a wrapper the
          steps would run together as inline text ("…there.hence…"). Separation
          is the renderer's job precisely because it is presentation. */}
      <div
        id={controller.bodyId}
        className="snl-collapsible__body"
        data-snl-subtree=""
        hidden={collapsed}
      >
        {body.map((child, i) => (
          <div className="snl-collapsible__part" key={i}>
            {controller.nest(renderChild(child))}
          </div>
        ))}
      </div>
    </div>
  );
};

/**
 * Ordered-list renderer with a block wrapper inside every `<li>`.
 *
 * A directly-rendered child may be an inline-block containing several visual
 * lines. Native list markers align to that inline-block's baseline, i.e. its
 * last line; adding another block wrapper does not change that baseline. The
 * Extension therefore renders a dedicated native-marker element in one grid
 * column and puts the child in the adjacent cell, both aligned to the first
 * row. The marker element inherits `list-style-type`, so theme defaults and
 * custom `@counter-style` prefix/suffix rules still work. The native `<ol>/<li>`
 * structure remains intact for list semantics.
 */
function renderEnumerate(
  { node, renderChild }: Parameters<SnlBlockRenderer>[0],
  configuredListStyle?: string
): React.ReactElement {
  const mdata = node.mdata && typeof node.mdata === 'object'
    ? node.mdata as { start?: unknown; listStyle?: unknown }
    : undefined;
  const start = typeof mdata?.start === 'number' &&
    Number.isFinite(mdata.start) && mdata.start >= 1
    ? mdata.start
    : undefined;
  const listStyle = configuredListStyle ?? (
    typeof mdata?.listStyle === 'string' && mdata.listStyle.length > 0
      ? mdata.listStyle
      : undefined
  );
  const firstCounter = Math.trunc(start ?? 1);

  return (
    <ol
      className="snl-block snl-block-enumerate"
      start={start}
      style={listStyle ? { listStyleType: listStyle } : undefined}
    >
      {node.children.map((child, index) => (
        <li key={index}>
          <span
            className="snl-enumerate-item-marker"
            aria-hidden="true"
            style={{ counterSet: `list-item ${firstCounter + index}` }}
          />
          <div className="snl-enumerate-item-content">{renderChild(child)}</div>
        </li>
      ))}
    </ol>
  );
}

export const EnumerateRenderer: SnlBlockRenderer = (props) => renderEnumerate(props);

/** Compatibility implementation of the Basics 0.3 table contract.
 * Options are closed over from the parameterized renderer key because the
 * published Basics 0.2.4 renderer props do not expose the selected Template. */
function tableRenderer(options: TableTemplateOptions): SnlBlockRenderer {
  const TableRenderer: SnlBlockRenderer = ({ node, renderChild, macro_data_driver }) => {
    const scheme = macro_data_driver.read_context().color_scheme;
    const colors = options.css?.[scheme];
    const style = colors ? {
      color: colors.color || undefined,
      background: colors.background || undefined,
      '--snl-table-border-color': colors.border || undefined
    } as React.CSSProperties : undefined;
    const cellStyle = colors?.border ? { borderColor: colors.border } : undefined;
    const children = Array.isArray(node.children) ? node.children : [];
    const first = children[0];
    const header = options.composition === 'rows' && first?.kind === 'table-header'
      ? first : undefined;
    const rows = header ? children.slice(1) : children;
    const cells = (row: SnlSyntaxTree): SnlSyntaxTree[] =>
      row.children.length > 0 ? row.children : [row];
    return <table
      className="snl-block snl-block-table"
      data-snl-table-composition={options.composition}
      data-snl-table-color-scheme={scheme}
      style={style}
    >
      {header ? <thead><tr>{cells(header).map((cell, index) =>
        <th key={index} style={cellStyle}>{renderChild(cell, index)}</th>)}</tr></thead> : null}
      <tbody>
        {options.composition === 'cells'
          ? <tr>{children.map((cell, index) =>
              <td key={index} style={cellStyle}>{renderChild(cell, index)}</td>)}</tr>
          : rows.map((row, rowIndex) => <tr key={rowIndex}>
              {cells(row).map((cell, index) =>
                <td key={index} style={cellStyle}>{renderChild(cell, index)}</td>)}
            </tr>)}
      </tbody>
    </table>;
  };
  return TableRenderer;
}


const MARKER_LIST_STYLE: Record<string, string> = {
  decimal: 'decimal',
  'lower-alpha': 'lower-alpha',
  'upper-alpha': 'upper-alpha',
  disc: 'disc',
  ellipsis: '"..."'
};

let nextAssetRequest = 0;

function useWorkspaceAsset(path: string): { url?: string; failed: boolean } {
  const [result, setResult] = useState<{ url?: string; failed: boolean }>({ failed: false });
  useEffect(() => {
    const api = getVsCodeApi();
    if (!api) {
      setResult({ failed: true });
      return;
    }
    const request_id = `snl-asset-${++nextAssetRequest}`;
    let active = true;
    const receive = (event: MessageEvent): void => {
      const message = event.data as {
        type?: unknown;
        request_id?: unknown;
        path?: unknown;
        url?: unknown;
      } | null;
      if (!active || message?.type !== 'snl.assets/resolved' ||
          message.request_id !== request_id || message.path !== path) return;
      if (typeof message.url === 'string' && message.url) {
        setResult({ url: message.url, failed: false });
      } else {
        setResult({ failed: true });
      }
    };
    window.addEventListener('message', receive);
    setResult({ failed: false });
    api.postMessage({ type: 'snl.assets/resolve', request_id, path });
    return () => {
      active = false;
      window.removeEventListener('message', receive);
    };
  }, [path]);
  return result;
}

function imageRenderer(
  path: string,
  display: 'inline' | 'block',
  alt: string
): SnlBlockRenderer {
  const ImageRenderer: SnlBlockRenderer = () => {
    const t = useUiMessages(MESSAGES);
    const asset = useWorkspaceAsset(path);
    if (asset.failed) {
      return <span className="snl-render-error" role="alert">{t('imageLoadFailed')}</span>;
    }
    if (!asset.url) {
      return <span className="snl-render-status" role="status">{t('imageLoading')}</span>;
    }
    const image = <img
      src={asset.url}
      alt={alt}
      loading="lazy"
      data-snl-asset-path={path}
      data-snl-image-layout={display}
    />;
    return display === 'inline'
      ? <span className="snl-macro-image snl-macro-image--inline">{image}</span>
      : <figure className="snl-macro-image snl-macro-image--block">{image}</figure>;
  };
  return ImageRenderer;
}

const MissingImageRenderer: SnlBlockRenderer = () => {
  const t = useUiMessages(MESSAGES);
  return <span className="snl-render-error" role="alert">{t('imagePathRequired')}</span>;
};

/**
 * The registry the Extension passes as `hooks.renderers`.
 *
 * MUST spread `defaultRenderers` — see the module header. Dropping the spread
 * silently disables every SNL-Basics built-in block renderer.
 */
let svgTemplateRenderer: SnlBlockRenderer | undefined;
function getSvgTemplateRenderer(): SnlBlockRenderer {
  if (svgTemplateRenderer) return svgTemplateRenderer;
  const loader = createWorkspaceSvgAssetLoader({
    postMessage(message: unknown): void {
      const api = getVsCodeApi();
      if (!api) throw new Error('VS Code asset bridge is unavailable');
      api.postMessage(message);
    }
  });
  const assetRegistry = new SvgTemplateAssetRegistry({ loader, maxSettled: 32 });
  svgTemplateRenderer = createSvgTemplateRenderer({ assetRegistry });
  return svgTemplateRenderer;
}

const baseExtensionRenderers: SnlRendererRegistry = {
  ...defaultRenderers,
  enumerate: EnumerateRenderer,
  collapsible: CollapsibleRenderer,
  image: MissingImageRenderer
};

const parameterizedRendererCache = new Map<string, SnlBlockRenderer>();

export const extensionRenderers: SnlRendererRegistry = new Proxy(baseExtensionRenderers, {
  get(target, property, receiver): unknown {
    if (property === 'svg_template') return getSvgTemplateRenderer();
    const direct = Reflect.get(target, property, receiver);
    if (direct !== undefined || typeof property !== 'string' || !property.includes('?')) return direct;
    const cached = parameterizedRendererCache.get(property);
    if (cached) return cached;
    try {
      const spec = parseBlockRendererSpec(property);
      let renderer: SnlBlockRenderer | undefined;
      if (spec.name === 'enumerate' && spec.params.marker) {
        const listStyle = MARKER_LIST_STYLE[spec.params.marker];
        if (listStyle) renderer = (props) => renderEnumerate(props, listStyle);
      } else if (spec.name === 'table' && spec.params.composition) {
        renderer = tableRenderer(tableOptionsFromRendererParams(spec.params));
      } else if (spec.name === 'image' && spec.params.src) {
        renderer = imageRenderer(
          spec.params.src,
          spec.params.layout === 'inline' ? 'inline' : 'block',
          spec.params.alt
        );
      }
      if (renderer) parameterizedRendererCache.set(property, renderer);
      return renderer;
    } catch {
      return undefined;
    }
  }
}) as SnlRendererRegistry;
