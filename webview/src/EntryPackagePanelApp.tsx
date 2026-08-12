import React, { useEffect, useState } from 'react';
import type { Localized } from '@sjtu-ai4math/snl-basics';
import type { ThemedKindColoring } from '../../src/kindColoring';
import { PanelHeader } from './components/PanelHeader';
import { EmptyAction } from './components/EmptyAction';
import { IconButton } from './components/IconButton';
import { RowPrimaryButton } from './components/RowPrimaryButton';
import { defineUiMessages, useUiMessages } from './i18n/uiMessages';
import { is_valid_i18n_string, resolve_localized_string } from '../../src/localizedContent';
import { isEntryDataPayload, isEntryKindPayload } from './render/EntryRender';
import { resolveWebviewKindColoring } from './render/kindColoring';
import { use_content_language, use_preferences_revision } from './runtime/preferencesRuntime';
import { PANEL_STYLE, useVsCodeApiRef } from './vscodeApi';

const MESSAGES = defineUiMessages('entryPackagePanel', {
  loading: 'Loading Entry Package…', dashboard: 'Dashboard', backDashboard: 'Back to Dashboard',
  missing: 'Entry Package {id} does not exist.', panelFallback: 'SNL Entry Package',
  entryCount: { arg: 'count', one: '{id} · {count} entry', other: '{id} · {count} entries' },
  createEntry: 'Create Entry', empty: 'No entries yet — create the first one in this package.',
  colPreview: 'Preview', colTitle: 'Title', colId: 'ID', colKind: 'Kind', colFormats: 'Formats',
  unknownKind: '⚠ unknown',
  unknownKindTitle: 'Unknown kind “{kind}”', malformed: 'The Entry Package response is malformed.', editEntry: 'Edit entry {title}', deleteEntry: 'Delete entry {id}'
}, {
  loading: '正在加载条目包…', dashboard: '仪表板', backDashboard: '返回仪表板',
  missing: '条目包 {id} 不存在。', panelFallback: 'SNL 条目包',
  entryCount: { arg: 'count', other: '{id} · {count} 个条目' },
  createEntry: '创建条目', empty: '暂无条目——请在此包中创建第一个条目。',
  colPreview: '预览', colTitle: '标题', colId: 'ID', colKind: '类别', colFormats: '格式',
  unknownKind: '⚠ 未知',
  unknownKindTitle: '未知类别“{kind}”', malformed: '条目包响应格式无效。', editEntry: '编辑条目 {title}', deleteEntry: '删除条目 {id}'
});

interface EntryData {
  id: string; package?: string; kind: string; title: Localized<string, string>;
  content: { snl?: string; typst?: Localized<string, string>; latex?: Localized<string, string>; markdown?: Localized<string, string>; text?: Localized<string, string> };
}
interface EntryKind {
  id: string; name: Localized<string, string>; description?: Localized<string, string>;
  coloring: ThemedKindColoring; defaultCounterName?: string; style: string;
}
interface PackageIdentity { id: string; name: string; description: string }
type Model =
  | { kind: 'loading' }
  | { kind: 'missing'; packageId: string }
  | { kind: 'error'; message: string }
  | { kind: 'package'; package: PackageIdentity; entries: EntryData[]; entryKinds: EntryKind[] };

type Incoming =
  | { type: 'entryPackage'; package: unknown; entries?: unknown; entryKinds?: unknown; metricMacroSources?: unknown; metricThresholds?: unknown }
  | { type: 'noEntryPackage'; packageId: string }
  | { type: 'error'; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function isPackageIdentity(value: unknown): value is PackageIdentity {
  return isRecord(value) && typeof value.id === 'string' &&
    typeof value.name === 'string' && typeof value.description === 'string';
}

function isLocalizedContent(value: unknown): value is Localized<string, string> {
  return typeof value === 'string' || is_valid_i18n_string(value);
}

function isPackageEntryPayload(value: unknown): value is EntryData {
  if (!isEntryDataPayload(value)) return false;
  const content = value.content as Record<string, unknown>;
  return (content.snl === undefined || typeof content.snl === 'string') &&
    (content.typst === undefined || isLocalizedContent(content.typst)) &&
    (content.latex === undefined || isLocalizedContent(content.latex)) &&
    (content.markdown === undefined || isLocalizedContent(content.markdown)) &&
    (content.text === undefined || isLocalizedContent(content.text));
}

const HEAD: React.CSSProperties = { textAlign: 'left', padding: '0.45rem 0.55rem', borderBottom: '1px solid var(--vscode-panel-border)' };
const CELL: React.CSSProperties = { padding: '0.42rem 0.55rem', borderBottom: '1px solid var(--vscode-panel-border)' };
const MONO: React.CSSProperties = { fontFamily: 'var(--vscode-editor-font-family, monospace)' };

export function EntryPackagePanelApp(): React.ReactElement {
  use_preferences_revision();
  const t = useUiMessages(MESSAGES);
  const apiRef = useVsCodeApiRef();
  const [model, setModel] = useState<Model>({ kind: 'loading' });
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const msg = event.data as Incoming | undefined;
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'entryPackage') {
        const pkg = msg.package;
        if (!isPackageIdentity(pkg) || !Array.isArray(msg.entries) ||
            !msg.entries.every(isPackageEntryPayload) || !Array.isArray(msg.entryKinds) ||
            !msg.entryKinds.every(isEntryKindPayload)) {
          setModel({ kind: 'error', message: t('malformed') });
          return;
        }
        // Metric fields are deliberately ignored for compatibility with hosts
        // transitioning away from package-local SSI calculation.
        setModel({ kind: 'package', package: pkg,
          entries: msg.entries, entryKinds: msg.entryKinds });
      } else if (msg.type === 'noEntryPackage' && typeof msg.packageId === 'string') {
        setModel({ kind: 'missing', packageId: msg.packageId });
      } else if (msg.type === 'error' && typeof msg.message === 'string') {
        setModel({ kind: 'error', message: msg.message });
      }
    };
    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [apiRef, t]);

  const header = (title: string, subtitle?: string) => <PanelHeader vsApi={apiRef.current} title={title} subtitle={subtitle}
    back={{ label: t('dashboard'), title: t('backDashboard'), message: { type: 'nav.openDashboard' } }} />;
  if (model.kind === 'loading') return <main style={PANEL_STYLE}>{header(t('panelFallback'))}<p>{t('loading')}</p></main>;
  if (model.kind === 'missing') return <main style={PANEL_STYLE}>{header(t('panelFallback'))}<p>{t('missing', { id: model.packageId })}</p></main>;
  if (model.kind === 'error') return <main style={PANEL_STYLE}>{header(t('panelFallback'))}<p role="alert" style={{ color: 'var(--vscode-errorForeground)' }}>{model.message}</p></main>;
  return <main style={PANEL_STYLE}>
    {header(model.package.name || model.package.id, t('entryCount', { id: model.package.id, count: model.entries.length }))}
    {model.package.description ? <p>{model.package.description}</p> : null}
    {model.entries.length ? <EntriesTable model={model} /> : <p>{t('empty')}</p>}
    <EmptyAction size="lg" className="snl-empty-action--large" label={t('createEntry')}
      onClick={() => apiRef.current?.postMessage({ type: 'createEntry' })} />
  </main>;
}

function populatedFormats(entry: EntryData): string {
  const keys = ['snl', 'typst', 'latex', 'markdown', 'text'] as const;
  return keys.filter((key) => {
    const value = entry.content[key];
    return typeof value === 'string'
      ? value.trim().length > 0
      : value !== undefined && Object.values(value.values).some(
        (projection) => typeof projection === 'string' && projection.trim().length > 0);
  }).join(', ') || '—';
}

function EntriesTable({ model }: { model: Extract<Model, { kind: 'package' }> }): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const language = use_content_language();
  const apiRef = useVsCodeApiRef();
  return <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem' }}><thead><tr>
    <th style={HEAD}>{t('colPreview')}</th><th style={HEAD}>{t('colTitle')}</th><th style={HEAD}>{t('colId')}</th>
    <th style={HEAD}>{t('colKind')}</th><th style={HEAD}>{t('colFormats')}</th><th style={HEAD} />
  </tr></thead><tbody>{model.entries.map((entry) => {
    const title = resolve_localized_string(entry.title, language);
    const kind = model.entryKinds.find((item) => item.id === entry.kind);
    return <tr key={entry.id}>
      <td style={CELL}><span aria-hidden="true" style={{ display: 'inline-block', width: '2rem', height: '1rem', borderRadius: '3px',
        background: kind ? resolveWebviewKindColoring(kind.coloring).background : '#888888',
        border: `1px solid ${kind ? resolveWebviewKindColoring(kind.coloring).stroke : '#666666'}` }} /></td>
      <td style={CELL}><RowPrimaryButton label={t('editEntry', { title })} onActivate={() => apiRef.current?.postMessage({ type: 'editEntry', id: entry.id })}>{title}</RowPrimaryButton></td>
      <td style={{ ...CELL, ...MONO }}>{entry.id}</td>
      <td style={CELL}>{kind ? resolve_localized_string(kind.name, language) : <span title={t('unknownKindTitle', { kind: entry.kind })}>{t('unknownKind')}</span>}</td>
      <td style={{ ...CELL, ...MONO }}>{populatedFormats(entry)}</td>
      <td style={CELL}><IconButton icon="delete" label={t('deleteEntry', { id: entry.id })} variant="destructive" size="sm" onClick={() => apiRef.current?.postMessage({ type: 'deleteEntry', id: entry.id })} /></td>
    </tr>;
  })}</tbody></table>;
}
