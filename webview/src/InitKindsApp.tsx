import React, { useState } from 'react';
import { PANEL_STYLE } from './vscodeApi';
import { PanelNav } from './components/PanelNav';
import { Button } from './components/Button';
import { Alert, FormField, Select } from './components/FormControls';
import { useVsCodeBridge } from './components/useVsCodeBridge';

export type KindDomain = 'entry' | 'macro';
export interface PresetOption { id: string; label: string; description: string; count: number; }
type Status =
  | { kind: 'idle' | 'applying' }
  | { kind: 'applied'; presetId: string; count: number }
  | { kind: 'nonEmpty'; existing: number; message: string }
  | { kind: 'noSnlDoc' | 'noWorkspace' | 'unknownPreset' | 'error'; message: string };

export function kindInitializationCopy(domain: KindDomain) {
  const cap = domain === 'entry' ? 'Entry' : 'Macro';
  return {
    title: `Initialize ${cap} Kinds`,
    configKey: `${domain}_kinds`,
    singular: `${domain} kind`,
    cap
  } as const;
}

export function InitKindsApp({ domain }: { domain: KindDomain }): React.ReactElement {
  const copy = kindInitializationCopy(domain);
  const [presets, setPresets] = useState<PresetOption[]>([]);
  const [existing, setExisting] = useState(0);
  const [selected, setSelected] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const { apiRef, post } = useVsCodeBridge<
    | { type: 'init'; presets: PresetOption[]; existing: number }
    | { type: 'applied'; presetId: string; count: number }
    | { type: 'nonEmpty'; existing: number; message: string }
    | { type: 'noSnlDoc' | 'noWorkspace' | 'unknownPreset' | 'error'; message: string }
  >((msg) => {
    if (msg.type === 'init') {
      const nextPresets = Array.isArray(msg.presets) ? msg.presets : [];
      setPresets(nextPresets);
      setExisting(msg.existing);
      setSelected((previous) => previous || nextPresets[0]?.id || '');
      setLoaded(true);
    } else if (msg.type === 'applied') {
      setStatus({ kind: 'applied', presetId: msg.presetId, count: msg.count });
      setExisting(msg.count);
    } else if (msg.type === 'nonEmpty') {
      setStatus({ kind: 'nonEmpty', existing: msg.existing, message: msg.message });
      setExisting(msg.existing);
    } else {
      setStatus({ kind: msg.type, message: msg.message });
    }
  });

  const catalogBusy = existing > 0;
  const canApply = loaded && !catalogBusy && !!selected && status.kind !== 'applying';
  const selectedPreset = presets.find((preset) => preset.id === selected);
  const apply = (): void => {
    if (!canApply) return;
    setStatus({ kind: 'applying' });
    post({ type: 'apply', presetId: selected });
  };

  return <main style={{ ...PANEL_STYLE, maxWidth: '40rem' }}>
    <PanelNav vsApi={apiRef.current} back={{ label: 'Dashboard', title: 'Back to Dashboard', message: { type: 'nav.openDashboard' } }} />
    <h1 style={{ margin: '0 0 .5rem', fontSize: '1.25rem' }}>{copy.title}</h1>
    {!loaded ? <p style={{ opacity: .7 }}>Loading presets…</p> : <>
      <p style={{ margin: '0 0 1rem', opacity: .85 }}>
        Seed <code>.SNL_Doc/config.json#{copy.configKey}</code> from a preset. Presets replace an empty catalog only.
      </p>
      {catalogBusy ? <Alert severity="warning">{copy.configKey} already has {existing} {existing === 1 ? copy.singular : `${copy.singular}s`}. Applying a preset would clobber them, so this panel is disabled.</Alert> : null}
      <FormField label="Preset">
        <Select value={selected} onChange={(event) => setSelected(event.target.value)} disabled={catalogBusy || status.kind === 'applying'}>
          {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label} ({preset.count} kind{preset.count === 1 ? '' : 's'})</option>)}
        </Select>
      </FormField>
      {selectedPreset ? <p style={{ opacity: .75, fontStyle: 'italic' }}>{selectedPreset.description}{selectedPreset.count === 0 ? ' Applying this preset writes an empty catalog.' : ''}</p> : null}
      <Button variant="primary" onClick={apply} disabled={!canApply} loading={status.kind === 'applying'} loadingLabel="Applying…">Apply Preset</Button>
      <InitStatus status={status} presets={presets} singular={copy.singular} />
    </>}
  </main>;
}

function InitStatus({ status, presets, singular }: { status: Status; presets: PresetOption[]; singular: string }): React.ReactElement | null {
  if (status.kind === 'idle' || status.kind === 'applying') return null;
  if (status.kind === 'applied') {
    const label = presets.find((preset) => preset.id === status.presetId)?.label ?? status.presetId;
    return <Alert severity="success">Applied “{label}” — {status.count} {status.count === 1 ? singular : `${singular}s`} added.</Alert>;
  }
  if (status.kind === 'nonEmpty') return <Alert severity="warning">{status.message}</Alert>;
  return <Alert severity="error">{status.message}</Alert>;
}
