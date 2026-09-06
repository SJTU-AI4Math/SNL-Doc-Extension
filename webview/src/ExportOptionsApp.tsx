// Export Options panel — the settings surface for a static HTML export.
//
// Cat 2026-07-28: '保存文件时开个新 Panel 来设置，包括导出的位置、选项等都
// 做在 Panel 里.' Replaces the previous QuickPick + save-dialog chain, which
// could only ask one question at a time and gave no view of the choices.
//
// The panel is the *settings* surface only. The harvested markup arrives from
// the Infoview and is held by the host; this webview never sees it.

import React, { useEffect, useState, useRef } from 'react';
import { DEFAULT_SOURCE_OPTIONS, type SourceExportOptions } from '../../src/sourceExport/types';
import { SourceExportFields } from './export/SourceExportFields';
import { getVsCodeApi, PANEL_STYLE, type VsCodeApi } from './vscodeApi';
import { Button } from './components/Button';
import { PanelHeader } from './components/PanelHeader';
import { FormField, TextInput, Alert } from './components/FormControls';
import { defineUiMessages, useUiMessages } from './i18n/uiMessages';

const MESSAGES = defineUiMessages('exportOptions', {
  sourcePreview: 'Preview selected sources', cancelPreview: 'Cancel preview', sourceConfirm: 'I reviewed this exact file list and agree to share it', diskVersion: 'Explicitly use disk versions of unsaved files', saveSources: 'Save listed buffers, then preview again', sourceFiles: 'Source files', excluded: 'Excluded / unavailable',
  sourceSize: '{bytes} bytes · approximately {encoded} bytes encoded',
  title: 'Export HTML', infoview: '← Infoview', backTitle: 'Back to the Library Infoview',
  loading: 'Loading export context…', entries: { arg: 'count', one: '{count} entry', other: '{count} entries' },
  images: { arg: 'count', one: '{count} image', other: '{count} images' }, outputShape: 'Output shape',
  destination: 'Destination', browse: 'Browse…', options: 'Options', export: 'Export',
  reveal: 'Reveal in file manager', interactive: 'Keep interaction (hover, popovers, routes, relationships, language, theme)',
  interactiveHint: 'Adds the standalone runtime for SNL highlighting, click-pinned Entry previews, collapsed sections, Ctrl+Click node routes, route-local relationship sections, and the top-right language/theme controls. Uncheck for a document with no JavaScript at all.',
  folder: 'Folder', folderDescription: 'index.html plus assets/ and fonts/. Smaller; good for hosting.',
  single: 'Single file', singleDescription: 'One .html with images and fonts inlined. Good for sending to someone.'
}, {
  sourcePreview: '预览选中的源码', cancelPreview: '取消预览', sourceConfirm: '已检查此文件清单，同意分享这些源码', diskVersion: '明确使用未保存文件的磁盘版本', saveSources: '保存列出的缓冲区，再重新预览', sourceFiles: '源文件', excluded: '排除 / 不可用',
  sourceSize: '{bytes} 字节 · 编码后约 {encoded} 字节',
  title: '导出 HTML', infoview: '← 信息视图', backTitle: '返回文档库信息视图', loading: '正在加载导出上下文……',
  entries: '{count} 个条目', images: '{count} 张图片', outputShape: '输出形态', destination: '导出位置',
  browse: '浏览……', options: '选项', export: '导出', reveal: '在文件管理器中显示',
  interactive: '保留交互（悬停、Entry 预览、路由、关系、语言、主题）',
  interactiveHint: '加入独立运行时，恢复 SNL 高亮、点击固定的 Entry 预览、默认收起的区块、Ctrl+Click 节点路由、按 ID 动态生成的关系区块，以及右上角语言和明暗模式按钮。取消勾选则导出完全不含 JavaScript 的文档。',
  folder: '文件夹', folderDescription: 'index.html 加 assets/ 和 fonts/。体积更小，适合托管。',
  single: '单个文件', singleDescription: '一个内联图片和字体的 .html 文件，适合发送给他人。'
});

export type ExportShape = 'single' | 'directory';

interface Context {
  slug: string;
  title: string;
  entryCount: number;
  assetCount: number;
  /** Absolute default destination, shown so the reader knows where it lands. */
  defaultDestination: string;
  sourceAvailable?: boolean;
  sourceRoot?: string;
}

interface SourcePreviewSummary {
  blocked?: boolean; confirmationId: string; files: { displayPath: string; kind: string; byteLength: number }[]; directories: string[]; totalBytes: number; estimatedBytes: number;
  exclusions: { path: string; reason: string }[]; warnings: string[]; externalRoots: string[]; unresolved: { entryId: string; status: string; reason?: string }[]; dirtyFiles: string[];
}

type Incoming =
  | { type: 'exportContext'; context: Context }
  | { type: 'destinationPicked'; path: string }
  | { type: 'exportDone'; message: string; warnings: string[] }
  | { type: 'exportFailed'; message: string }
  | { type: 'sourcePreview'; preview: SourcePreviewSummary; requestId: number }
  | { type: 'sourcePreviewInvalidated' }
  | undefined;

export function ExportOptionsApp(): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const [api, setApi] = useState<VsCodeApi | undefined>(undefined);
  const [context, setContext] = useState<Context | null>(null);
  const [shape, setShape] = useState<ExportShape>('directory');
  const [destination, setDestination] = useState('');
  const [interactive, setInteractive] = useState(true);
  const [sources, setSources] = useState<SourceExportOptions>(() => ({ ...DEFAULT_SOURCE_OPTIONS, maxTotalBytes: 250 * 1024 * 1024 }));
  const [preview, setPreview] = useState<SourcePreviewSummary | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [sourceConfirmed, setSourceConfirmed] = useState(false);
  const [diskAcknowledged, setDiskAcknowledged] = useState(false);
  const previewRequest = useRef(0);
  function invalidatePreview(): void {
    previewRequest.current++; setPreview(null); setPreviewBusy(false); setSourceConfirmed(false); setDiskAcknowledged(false);
    api?.postMessage({ type: 'cancelSourcePreview' });
  }
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ message: string; warnings: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const vsApi = getVsCodeApi();
    setApi(vsApi);

    function onMessage(event: MessageEvent): void {
      const msg = event.data as Incoming;
      if (!msg || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'sourcePreview':
          if (msg.requestId !== previewRequest.current) break;
          setPreview(msg.preview); setPreviewBusy(false); setSourceConfirmed(false); setDiskAcknowledged(false);
          break;
        case 'sourcePreviewInvalidated':
          previewRequest.current++; setPreview(null); setPreviewBusy(false); setSourceConfirmed(false);
          break;
        case 'exportContext':
          previewRequest.current++; setPreview(null); setSourceConfirmed(false);
          setContext(msg.context);
          setDestination(msg.context.defaultDestination);
          break;
        case 'destinationPicked':
          previewRequest.current++; setPreview(null); setSourceConfirmed(false);
          vsApi?.postMessage({ type: 'cancelSourcePreview' });
          setDestination(msg.path);
          break;
        case 'exportDone':
          setBusy(false);
          setError(null);
          setDone({ message: msg.message, warnings: msg.warnings ?? [] });
          break;
        case 'exportFailed':
          setPreviewBusy(false);
          setBusy(false);
          setError(msg.message);
          break;
        default:
          break;
      }
    }

    window.addEventListener('message', onMessage);
    vsApi?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);


  function cleanedSources(): SourceExportOptions {
    return { ...sources, ...Object.fromEntries((['keep', 'exclude', 'companionFiles', 'allowedExternalRoots'] as const).map(k => [k, sources[k].map(s => s.trim()).filter(Boolean)])) };
  }

  function previewSources(): void {
    const requestId = ++previewRequest.current; setPreview(null); setSourceConfirmed(false); setPreviewBusy(true); setError(null);
    api?.postMessage({ type: 'previewSources', requestId, shape, destination, sources: cleanedSources() });
  }

  function submit(): void {
    setBusy(true);
    setDone(null);
    setError(null);
    api?.postMessage({ type: 'runExport', shape, destination, interactive, sources: cleanedSources(), confirmationId: sourceConfirmed ? preview?.confirmationId : undefined, diskAcknowledged });
  }

  if (!context) {
    return (
      <main style={PANEL_STYLE}>
        <PanelHeader
          vsApi={api}
          title={t('title')}
          showRefresh={false}
          back={{
            label: t('infoview'),
            title: t('backTitle'),
            message: { type: 'openInfoview' }
          }}
        />
        <p style={{ opacity: 0.7 }}>{t('loading')}</p>
      </main>
    );
  }

  return (
    <main style={PANEL_STYLE}>
      <PanelHeader
        vsApi={api}
        title={t('title')}
        showRefresh={false}
        subtitle={`${context.title} · ${t('entries', { count: context.entryCount })} · ${t('images', { count: context.assetCount })}`}
        back={{
          label: t('infoview'),
          title: t('backTitle'),
          message: { type: 'openInfoview' }
        }}
      />

      <FormField id="snl-export-shape" label={t('outputShape')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <ShapeChoice
            checked={shape === 'directory'}
            onChange={() => { invalidatePreview(); setShape('directory'); setSources(v => ({ ...v, maxTotalBytes: 250 * 1024 * 1024 })); }}
            title={t('folder')}
            description={t('folderDescription')}
          />
          <ShapeChoice
            checked={shape === 'single'}
            onChange={() => { invalidatePreview(); setShape('single'); setSources(v => ({ ...v, maxTotalBytes: 25 * 1024 * 1024 })); }}
            title={t('single')}
            description={t('singleDescription')}
          />
        </div>
      </FormField>

      <div className="snl-field">
        <label className="snl-field__label" htmlFor="snl-export-destination">{t('destination')}</label>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <TextInput
            id="snl-export-destination"
            mono
            value={destination}
            onChange={(e) => { invalidatePreview(); setDestination(e.target.value); }}
            spellCheck={false}
          />
          <Button onClick={() => api?.postMessage({ type: 'pickDestination', shape })}>
            {t('browse')}
          </Button>
        </div>
      </div>

      <FormField id="snl-export-options" label={t('options')} hint={t('interactiveHint')}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={interactive}
            onChange={(e) => { invalidatePreview(); setInteractive(e.target.checked); if (!e.target.checked) setSources(v => ({ ...v, enabled: false })); }}
          />
          <span>{t('interactive')}</span>
        </label>
      </FormField>

      <SourceExportFields value={sources} available={!!context.sourceAvailable} disabled={busy} onChange={next => { invalidatePreview(); setSources(next); if (next.enabled) setInteractive(true); }} />
      {sources.enabled && <>
        <p>{context.sourceRoot}</p>
        <Button onClick={previewSources} disabled={busy || previewBusy || !destination.trim()}>{t('sourcePreview')}</Button>
        {previewBusy && <Button onClick={invalidatePreview}>{t('cancelPreview')}</Button>}
        {preview && <section aria-label={t('sourcePreview')}>
          <p>{preview.files.length} {t('sourceFiles')} · {t('sourceSize', { bytes: preview.totalBytes.toLocaleString(), encoded: preview.estimatedBytes.toLocaleString() })}</p>
          <details><summary>{t('sourceFiles')}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflowY: 'auto' }}>{[...preview.directories.map(p => p + '/'), ...preview.files.map(f => `${f.displayPath}  [${f.kind}, ${f.byteLength} bytes]`)].sort().join('\n')}</pre></details>
          <details><summary>{t('excluded')} ({preview.exclusions.length + preview.unresolved.length})</summary>{preview.exclusions.map((e, i) => <div key={i}>{e.path}: {e.reason}</div>)}{preview.unresolved.map((p, i) => <div key={'p' + i}>{p.entryId}: {p.status} {p.reason}</div>)}</details>
          {preview.warnings.map((w, i) => <Alert key={i} severity="warning">{w}</Alert>)}
          {!!preview.externalRoots.length && <pre>{preview.externalRoots.join('\n')}</pre>}
          {!!preview.dirtyFiles.length && <div><pre>{preview.dirtyFiles.join('\n')}</pre><label><input type="checkbox" checked={diskAcknowledged} onChange={e => setDiskAcknowledged(e.target.checked)} /> {t('diskVersion')}</label><Button onClick={() => api?.postMessage({ type: 'saveSourceBuffers' })}>{t('saveSources')}</Button></div>}
          <label style={{ display: 'block', marginTop: 12 }}><input type="checkbox" checked={sourceConfirmed} onChange={e => setSourceConfirmed(e.target.checked)} /> {t('sourceConfirm')}</label>
        </section>}
      </>}

      {error ? <Alert severity="error">{error}</Alert> : null}
      {done ? (
        <Alert severity={done.warnings.length ? 'warning' : 'success'}>
          <div>{done.message}</div>
          {done.warnings.map((w) => (
            <div key={w} style={{ fontSize: '0.85rem', opacity: 0.9 }}>
              {w}
            </div>
          ))}
        </Alert>
      ) : null}

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.25rem' }}>
        <Button
          variant="primary"
          onClick={submit}
          loading={busy}
          disabled={busy || !destination.trim() || (sources.enabled && (!preview || preview.blocked || !sourceConfirmed || (preview.dirtyFiles.length > 0 && !diskAcknowledged)))}
        >
          {t('export')}
        </Button>
        {done ? (
          <Button onClick={() => api?.postMessage({ type: 'revealExport' })}>
            {t('reveal')}
          </Button>
        ) : null}
      </div>
    </main>
  );
}

function ShapeChoice({
  checked,
  onChange,
  title,
  description
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  description: string;
}): React.ReactElement {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.6rem',
        padding: '0.6rem 0.75rem',
        border: '1px solid var(--vscode-widget-border, rgba(128,128,128,0.35))',
        borderRadius: '6px',
        cursor: 'pointer',
        background: checked
          ? 'var(--vscode-list-activeSelectionBackground, rgba(0,120,215,0.12))'
          : 'transparent'
      }}
    >
      <input
        type="radio"
        name="snl-export-shape"
        checked={checked}
        onChange={onChange}
        style={{ marginTop: '0.2rem' }}
      />
      <span>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <br />
        <span style={{ opacity: 0.75, fontSize: '0.85rem' }}>{description}</span>
      </span>
    </label>
  );
}
