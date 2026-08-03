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
import { use_localized, type LocalizedString } from './runtime/useLocalized';

function ui(en: string, zhCN: string): LocalizedString {
  return { type: 'i18n', default_language: 'en', values: { en, 'zh-CN': zhCN } };
}

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

  const shapeLabel = use_localized(ui('Output shape', '输出形态'));
  const destLabel = use_localized(ui('Destination', '导出位置'));
  const browseLabel = use_localized(ui('Browse…', '浏览……'));
  const optionsLabel = use_localized(ui('Options', '选项'));
  const exportLabel = use_localized(ui('Export', '导出'));
  const revealLabel = use_localized(ui('Reveal in file manager', '在文件管理器中显示'));
  const interactiveLabel = use_localized(
    ui('Keep interaction (hover highlight, collapse)', '保留交互（悬停高亮、折叠）')
  );
  const interactiveHint = use_localized(
    ui(
      'Inlines a small script that restores SNL hover highlighting and outline collapse. Uncheck for a document with no JavaScript at all.',
      '内联一小段脚本，恢复 SNL 悬停高亮与大纲折叠。取消勾选则导出完全不含 JavaScript 的文档。'
    )
  );

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
          title={ui('Export HTML', '导出 HTML')}
          back={{
            label: ui('Infoview', '信息视图'),
            title: ui('Back to the Library Infoview', '返回文档库信息视图'),
            message: { type: 'openInfoview' }
          }}
        />
        <p style={{ opacity: 0.7 }}>Loading export context…</p>
      </main>
    );
  }

  return (
    <main style={PANEL_STYLE}>
      <PanelHeader
        vsApi={api}
        title={ui('Export HTML', '导出 HTML')}
        subtitle={`${context.title} · ${context.entryCount} entries · ${context.assetCount} image(s)`}
        back={{
          label: ui('← Infoview', '← 信息视图'),
          title: ui('Back to the Library Infoview', '返回文档库信息视图'),
          message: { type: 'openInfoview' }
        }}
      />

      <FormField id="snl-export-shape" label={shapeLabel}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <ShapeChoice
            checked={shape === 'directory'}
            onChange={() => setShape('directory')}
            title="Folder"
            description="index.html plus assets/ and fonts/. Smaller; good for hosting."
          />
          <ShapeChoice
            checked={shape === 'single'}
            onChange={() => setShape('single')}
            title="Single file"
            description="One .html with images and fonts inlined. Good for sending to someone."
          />
        </div>
      </FormField>

      <FormField id="snl-export-destination" label={destLabel}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <TextInput
            id="snl-export-destination"
            mono
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            spellCheck={false}
          />
          <Button onClick={() => api?.postMessage({ type: 'pickDestination', shape })}>
            {browseLabel}
          </Button>
        </div>
      </FormField>

      <FormField id="snl-export-options" label={optionsLabel} hint={interactiveHint}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={interactive}
            onChange={(e) => setInteractive(e.target.checked)}
          />
          <span>{interactiveLabel}</span>
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
          {exportLabel}
        </Button>
        {done ? (
          <Button onClick={() => api?.postMessage({ type: 'revealExport' })}>
            {revealLabel}
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
