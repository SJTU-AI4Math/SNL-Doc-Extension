// Export Options panel — the settings surface for a static HTML export.
//
// Cat 2026-07-28: '保存文件时开个新 Panel 来设置，包括导出的位置、选项等都
// 做在 Panel 里.' Replaces the previous QuickPick + save-dialog chain, which
// could only ask one question at a time and gave no view of the choices.
//
// The panel is the *settings* surface only. The harvested markup arrives from
// the Infoview and is held by the host; this webview never sees it.

import React, { useEffect, useState } from 'react';
import { getVsCodeApi, PANEL_STYLE, type VsCodeApi } from './vscodeApi';
import { Button } from './components/Button';
import { PanelHeader } from './components/PanelHeader';
import { FormField, TextInput, Alert } from './components/FormControls';
import { defineUiMessages, useUiMessages } from './i18n/uiMessages';

const MESSAGES = defineUiMessages('exportOptions', {
  title: 'Export HTML', infoview: '← Infoview', backTitle: 'Back to the Library Infoview',
  loading: 'Loading export context…', entries: { arg: 'count', one: '{count} entry', other: '{count} entries' },
  images: { arg: 'count', one: '{count} image', other: '{count} images' }, outputShape: 'Output shape',
  destination: 'Destination', browse: 'Browse…', options: 'Options', export: 'Export',
  reveal: 'Reveal in file manager', interactive: 'Keep interaction (hover, popovers, routes, language, theme)',
  interactiveHint: 'Adds the standalone runtime for SNL highlighting, click-pinned Entry previews, outline collapse, node routes, and the top-right language/theme controls. Uncheck for a document with no JavaScript at all.',
  folder: 'Folder', folderDescription: 'index.html plus assets/ and fonts/. Smaller; good for hosting.',
  single: 'Single file', singleDescription: 'One .html with images and fonts inlined. Good for sending to someone.'
}, {
  title: '导出 HTML', infoview: '← 信息视图', backTitle: '返回文档库信息视图', loading: '正在加载导出上下文……',
  entries: '{count} 个条目', images: '{count} 张图片', outputShape: '输出形态', destination: '导出位置',
  browse: '浏览……', options: '选项', export: '导出', reveal: '在文件管理器中显示',
  interactive: '保留交互（悬停、Entry 预览、路由、语言、主题）',
  interactiveHint: '加入独立运行时，恢复 SNL 高亮、点击固定的 Entry 预览、大纲折叠、节点路由，以及右上角语言和明暗模式按钮。取消勾选则导出完全不含 JavaScript 的文档。',
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
}

type Incoming =
  | { type: 'exportContext'; context: Context }
  | { type: 'destinationPicked'; path: string }
  | { type: 'exportDone'; message: string; warnings: string[] }
  | { type: 'exportFailed'; message: string }
  | undefined;

export function ExportOptionsApp(): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const [api, setApi] = useState<VsCodeApi | undefined>(undefined);
  const [context, setContext] = useState<Context | null>(null);
  const [shape, setShape] = useState<ExportShape>('directory');
  const [destination, setDestination] = useState('');
  const [interactive, setInteractive] = useState(true);
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
        case 'exportContext':
          setContext(msg.context);
          setDestination(msg.context.defaultDestination);
          break;
        case 'destinationPicked':
          setDestination(msg.path);
          break;
        case 'exportDone':
          setBusy(false);
          setError(null);
          setDone({ message: msg.message, warnings: msg.warnings ?? [] });
          break;
        case 'exportFailed':
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


  function submit(): void {
    setBusy(true);
    setDone(null);
    setError(null);
    api?.postMessage({ type: 'runExport', shape, destination, interactive });
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
            onChange={() => setShape('directory')}
            title={t('folder')}
            description={t('folderDescription')}
          />
          <ShapeChoice
            checked={shape === 'single'}
            onChange={() => setShape('single')}
            title={t('single')}
            description={t('singleDescription')}
          />
        </div>
      </FormField>

      <FormField id="snl-export-destination" label={t('destination')}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <TextInput
            id="snl-export-destination"
            mono
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            spellCheck={false}
          />
          <Button onClick={() => api?.postMessage({ type: 'pickDestination', shape })}>
            {t('browse')}
          </Button>
        </div>
      </FormField>

      <FormField id="snl-export-options" label={t('options')} hint={t('interactiveHint')}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={interactive}
            onChange={(e) => setInteractive(e.target.checked)}
          />
          <span>{t('interactive')}</span>
        </label>
      </FormField>

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
          disabled={busy || !destination.trim()}
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
