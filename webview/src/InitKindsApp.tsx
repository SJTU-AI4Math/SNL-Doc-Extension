import React, { useState } from 'react';
import { PANEL_STYLE } from './vscodeApi';
import { PanelHeader } from './components/PanelHeader';
import { Button } from './components/Button';
import { Alert, FormField, Select } from './components/FormControls';
import { useVsCodeBridge } from './components/useVsCodeBridge';
import { defineUiMessages, useUiMessages, type UiTranslator } from './i18n/uiMessages';

const MESSAGES = defineUiMessages(
  'initKinds',
  {
    entryKinds: 'Initialize Entry Kinds', macroKinds: 'Initialize Macro Kinds', dashboard: 'Dashboard',
    back: 'Back to Dashboard', loading: 'Loading presets…', seedPrefix: 'Seed ',
    seedSuffix: ' from a preset. Presets replace an empty catalog only.',
    busy: '{key} already has {count} {kind}. Applying a preset would clobber them, so this panel is disabled.',
    entryKind: { arg: 'count', one: 'entry kind', other: 'entry kinds' },
    macroKind: { arg: 'count', one: 'macro kind', other: 'macro kinds' },
    preset: 'Preset', optionKinds: { arg: 'count', one: '{count} kind', other: '{count} kinds' },
    emptyPreset: ' Applying this preset writes an empty catalog.', applying: 'Applying…', apply: 'Apply Preset',
    applied: 'Applied “{label}” — {count} {kind} added.'
  },
  {
    entryKinds: '初始化条目类型', macroKinds: '初始化宏类型', dashboard: '仪表板',
    back: '返回仪表板', loading: '正在加载预设…', seedPrefix: '从预设填充 ',
    seedSuffix: '。预设只能替换空目录。',
    busy: '{key} 已有 {count} 个{kind}。应用预设会覆盖它们，因此此面板已禁用。',
    entryKind: { arg: 'count', other: '条目类型' },
    macroKind: { arg: 'count', other: '宏类型' },
    preset: '预设', optionKinds: { arg: 'count', other: '{count} 个类型' },
    emptyPreset: ' 应用此预设会写入空目录。', applying: '正在应用…', apply: '应用预设',
    applied: '已应用“{label}”— 新增 {count} 个{kind}。'
  }
);

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
  const t = useUiMessages(MESSAGES);
  const [presets, setPresets] = useState<PresetOption[]>([]);
  const [existing, setExisting] = useState(0);
  const [selected, setSelected] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const kind = t(domain === 'entry' ? 'entryKind' : 'macroKind', { count: existing });
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

  return <main style={PANEL_STYLE}>
    <PanelHeader title={t(domain === 'entry' ? 'entryKinds' : 'macroKinds')} vsApi={apiRef.current} back={{ label: t('dashboard'), title: t('back'), message: { type: 'nav.openDashboard' } }} />
    {!loaded ? <p style={{ opacity: .7 }}>{t('loading')}</p> : <>
      <p style={{ margin: '0 0 1rem', opacity: .85 }}>
        {t('seedPrefix')}<code>.SNL_Doc/config.json#{copy.configKey}</code>{t('seedSuffix')}
      </p>
      {catalogBusy ? <Alert severity="warning">{t('busy', { key: copy.configKey, count: existing, kind })}</Alert> : null}
      <FormField label={t('preset')}>
        <Select value={selected} onChange={(event) => setSelected(event.target.value)} disabled={catalogBusy || status.kind === 'applying'}>
          {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label} ({t('optionKinds', { count: preset.count })})</option>)}
        </Select>
      </FormField>
      {selectedPreset ? <p style={{ opacity: .75, fontStyle: 'italic' }}>{selectedPreset.description}{selectedPreset.count === 0 ? t('emptyPreset') : ''}</p> : null}
      <Button variant="primary" onClick={apply} disabled={!canApply} loading={status.kind === 'applying'} loadingLabel={t('applying')}>{t('apply')}</Button>
      <InitStatus status={status} presets={presets} kind={kind} t={t} />
    </>}
  </main>;
}

function InitStatus({ status, presets, kind, t }: { status: Status; presets: PresetOption[]; kind: string; t: UiTranslator<typeof MESSAGES.catalogs.en> }): React.ReactElement | null {
  if (status.kind === 'idle' || status.kind === 'applying') return null;
  if (status.kind === 'applied') {
    const label = presets.find((preset) => preset.id === status.presetId)?.label ?? status.presetId;
    return <Alert severity="success">{t('applied', { label, count: status.count, kind })}</Alert>;
  }
  if (status.kind === 'nonEmpty') return <Alert severity="warning">{status.message}</Alert>;
  return 'message' in status
    ? <Alert severity="error">{status.message}</Alert>
    : null;
}
