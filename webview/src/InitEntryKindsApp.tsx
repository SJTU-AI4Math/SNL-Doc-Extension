// SNL Initialize Entry Kinds webview: a preset picker for seeding
// `config.json#entry_kinds` from scratch. Refuses when the catalog already
// has entries — see InitEntryKindsPanel for the reason.

import React, { useEffect, useRef, useState } from 'react';
import {
  getVsCodeApi,
  PANEL_STYLE,
  type VsCodeApi
} from './vscodeApi';
import { PanelNav } from './components/PanelNav';
import { Button } from './components/Button';

interface PresetOption {
  id: string;
  label: string;
  description: string;
  count: number;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'applying' }
  | { kind: 'applied'; presetId: string; count: number }
  | { kind: 'nonEmpty'; existing: number; message: string }
  | { kind: 'noSnlDoc'; message: string }
  | { kind: 'noWorkspace'; message: string }
  | { kind: 'unknownPreset'; message: string }
  | { kind: 'error'; message: string };

export function InitEntryKindsApp(): React.ReactElement {
  const [presets, setPresets] = useState<PresetOption[]>([]);
  const [existing, setExisting] = useState<number>(0);
  const [selected, setSelected] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | {
            type: 'init';
            presets: PresetOption[];
            existing: number;
          }
        | { type: 'applied'; presetId: string; count: number }
        | { type: 'nonEmpty'; existing: number; message: string }
        | { type: 'noSnlDoc'; message: string }
        | { type: 'noWorkspace'; message: string }
        | { type: 'unknownPreset'; message: string }
        | { type: 'error'; message: string }
        | undefined;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'init':
          setPresets(msg.presets);
          setExisting(msg.existing);
          if (!selected && msg.presets.length > 0) {
            setSelected(msg.presets[0].id);
          }
          setLoaded(true);
          return;
        case 'applied':
          setStatus({
            kind: 'applied',
            presetId: msg.presetId,
            count: msg.count
          });
          setExisting(msg.count);
          return;
        case 'nonEmpty':
          setStatus({
            kind: 'nonEmpty',
            existing: msg.existing,
            message: msg.message
          });
          setExisting(msg.existing);
          return;
        case 'noSnlDoc':
          setStatus({ kind: 'noSnlDoc', message: msg.message });
          return;
        case 'noWorkspace':
          setStatus({ kind: 'noWorkspace', message: msg.message });
          return;
        case 'unknownPreset':
          setStatus({ kind: 'unknownPreset', message: msg.message });
          return;
        case 'error':
          setStatus({ kind: 'error', message: msg.message });
          return;
      }
    }

    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedPreset = presets.find((p) => p.id === selected);
  const catalogBusy = existing > 0;
  const canApply =
    !catalogBusy && !!selected && status.kind !== 'applying' && loaded;

  function handleApply(): void {
    if (!canApply) return;
    setStatus({ kind: 'applying' });
    apiRef.current?.postMessage({ type: 'apply', presetId: selected });
  }

  if (!loaded) {
    return (
      <main style={PANEL_STYLE}>
      <PanelNav
        vsApi={apiRef.current}
        back={{ label: 'Dashboard', title: 'Back to Dashboard', message: { type: 'nav.openDashboard' } }}
      />
        <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
          Initialize Entry Kinds
        </h1>
        <p style={{ opacity: 0.7 }}>Loading presets…</p>
      </main>
    );
  }

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '40rem' }}>
      <PanelNav
        vsApi={apiRef.current}
        back={{ label: 'Dashboard', title: 'Back to Dashboard', message: { type: 'nav.openDashboard' } }}
      />
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
        Initialize Entry Kinds
      </h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.85 }}>
        Seed <code>.SNL_Doc/config.json#entry_kinds</code> from a preset.
        Presets replace an empty catalog only — if you already have entry
        kinds, edit them individually via <strong>Create Entry Kind</strong>{' '}
        or by hand in <code>config.json</code>.
      </p>

      {catalogBusy ? (
        <div
          style={{
            padding: '0.6rem 0.8rem',
            marginBottom: '1rem',
            border:
              '1px solid var(--vscode-editorWarning-foreground, #cca700)',
            borderRadius: '3px',
            color: 'var(--vscode-editorWarning-foreground, #cca700)',
            background: 'transparent'
          }}
        >
          ⚠️ entry_kinds already has {existing} entr
          {existing === 1 ? 'y' : 'ies'}. Applying a preset here would
          clobber them, so this panel is disabled.
        </div>
      ) : null}

      <label
        htmlFor="snl-preset-select"
        style={{ display: 'block', marginBottom: '0.35rem', fontWeight: 600 }}
      >
        Preset
      </label>
      <select
        id="snl-preset-select"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        disabled={catalogBusy || status.kind === 'applying'}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '0.4rem 0.55rem',
          marginBottom: '0.9rem',
          color: 'var(--vscode-input-foreground, #ddd)',
          background: 'var(--vscode-input-background, #2a2a2a)',
          border:
            '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
          borderRadius: '2px',
          fontFamily: 'inherit',
          fontSize: '0.95rem'
        }}
      >
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label} ({p.count} kind{p.count === 1 ? '' : 's'})
          </option>
        ))}
      </select>

      {selectedPreset ? (
        <p
          style={{
            margin: '0 0 1rem',
            opacity: 0.75,
            fontStyle: 'italic'
          }}
        >
          {selectedPreset.description}
          {selectedPreset.count === 0
            ? ' Applying this preset writes an empty catalog — you can then add kinds one by one.'
            : ''}
        </p>
      ) : null}

      <Button
        variant="primary"
        onClick={handleApply}
        disabled={!canApply}
      >
        {status.kind === 'applying' ? 'Applying…' : 'Apply Preset'}
      </Button>

      <StatusLine status={status} presets={presets} />
    </main>
  );
}

function StatusLine({
  status,
  presets
}: {
  status: Status;
  presets: PresetOption[];
}): React.ReactElement | null {
  if (status.kind === 'idle' || status.kind === 'applying') {
    return null;
  }

  let text = '';
  let color = 'var(--vscode-foreground, #ddd)';

  if (status.kind === 'applied') {
    const label =
      presets.find((p) => p.id === status.presetId)?.label ?? status.presetId;
    text = `✅ Applied "${label}" — ${status.count} entry kind${
      status.count === 1 ? '' : 's'
    } added.`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'nonEmpty') {
    text = `⚠️ ${status.message}`;
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else {
    text = `❌ ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  }

  return (
    <p
      style={{
        marginTop: '1rem',
        marginBottom: 0,
        color,
        fontWeight: 600
      }}
    >
      {text}
    </p>
  );
}
