import React, { useRef, useState } from 'react';
import { PANEL_STYLE } from './vscodeApi';
import { useSaveShortcut } from './components/draftState';
import { Button } from './components/Button';
import { Alert } from './components/FormControls';
import { ColorField, ColorPreview, KindTextField } from './components/KindFormFields';
import { EntityIdSearchBox, ENTRY_VALIDATE_RULES } from './components/EntityIdSearchBox';
import { isEntityIdUnique } from './components/formValidation';
import { PanelHeader } from './components/PanelHeader';
import { useVsCodeBridge } from './components/useVsCodeBridge';
import type { EntryOption } from './render/EntrySurface';

export type KindEditorDomain = 'entry' | 'macro';
type Mode = 'create' | 'edit';
type Status =
  | { kind: 'idle' | 'creating' }
  | { kind: 'created' | 'updated'; id: string; name: string }
  | { kind: 'duplicate' | 'notFound' | 'conflict' | 'invalid' | 'noSnlDoc' | 'noWorkspace' | 'error'; message: string };

export function kindEditorDescriptor(domain: KindEditorDomain) {
  const cap = domain === 'entry' ? 'Entry' : 'Macro';
  return {
    cap,
    noun: `${domain} kind`,
    configKey: `${domain}_kinds`,
    extraFields: domain === 'entry' ? ['defaultCounterName', 'style'] : ['description']
  } as const;
}

export function KindEditorApp({ domain }: { domain: KindEditorDomain }): React.ReactElement {
  const descriptor = kindEditorDescriptor(domain);
  const dirtyRef = useRef(false);
  const revisionRef = useRef<string | undefined>(undefined);
  const [mode, setMode] = useState<Mode>('create');
  const [id, setId] = useState('');
  const [existingIds, setExistingIds] = useState<EntryOption[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [stroke, setStroke] = useState('#888888');
  const [background, setBackground] = useState('#eeeeee');
  const [defaultCounterName, setDefaultCounterName] = useState('');
  const [style, setStyle] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const { apiRef, post } = useVsCodeBridge<{
    type?: string;
    mode?: Mode;
    id?: string;
    existing?: Record<string, unknown> | null;
    kindRevision?: string;
    expectedRevision?: string;
    existingIds?: EntryOption[];
    kind?: { id: string; name: string };
    message?: string;
  }>((msg) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'context') {
      const nextMode = msg.mode === 'edit' ? 'edit' : 'create';
      setMode(nextMode);
      setExistingIds(Array.isArray(msg.existingIds) ? msg.existingIds : []);
      if (nextMode === 'edit' && !dirtyRef.current) {
        revisionRef.current = msg.kindRevision;
        setId(msg.id ?? '');
        const existing = msg.existing ?? {};
        setName(typeof existing.name === 'string' ? existing.name : '');
        setDescription(typeof existing.description === 'string' ? existing.description : '');
        const coloring = typeof existing.coloring === 'object' && existing.coloring ? existing.coloring as Record<string, unknown> : {};
        setStroke(typeof coloring.stroke === 'string' ? coloring.stroke : '#888888');
        setBackground(typeof coloring.background === 'string' ? coloring.background : '#eeeeee');
        setDefaultCounterName(typeof existing.defaultCounterName === 'string' ? existing.defaultCounterName : '');
        setStyle(typeof existing.style === 'string' ? existing.style : '');
      }
    } else if ((msg.type === 'created' || msg.type === 'updated') && msg.kind) {
      dirtyRef.current = false;
      setStatus({ kind: msg.type, id: msg.kind.id, name: msg.kind.name });
    } else if (['duplicate', 'notFound', 'conflict', 'invalid', 'noSnlDoc', 'noWorkspace', 'error'].includes(msg.type)) {
      setStatus({ kind: msg.type as Exclude<Status['kind'], 'idle' | 'creating' | 'created' | 'updated'>, message: msg.message ?? 'Unknown error' });
    }
  });

  const trimmedId = id.trim();
  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && isEntityIdUnique(trimmedId, existingIds, mode === 'edit' ? trimmedId : undefined) && status.kind !== 'creating';
  const submit = (): void => {
    if (!canSubmit) return;
    setStatus({ kind: 'creating' });
    const payload: Record<string, string> = {
      id: trimmedId,
      name: trimmedName,
      stroke: stroke.trim() || '#888888',
      background: background.trim() || '#eeeeee'
    };
    if (domain === 'entry') {
      payload.defaultCounterName = defaultCounterName.trim();
      payload.style = style.trim();
    } else {
      payload.description = description.trim();
    }
    post({
      type: mode === 'edit' ? 'update' : 'create',
      payload,
      expectedRevision: mode === 'edit' ? revisionRef.current : undefined
    });
  };

  // Ctrl/Cmd+S is the same action as the Create/Update button.
  useSaveShortcut(() => submit(), canSubmit);

  return <main style={PANEL_STYLE} onChangeCapture={() => { dirtyRef.current = true; }}>
    <PanelHeader title={`${mode === 'edit' ? 'Edit' : 'Create'} ${descriptor.cap} Kind`} vsApi={apiRef.current} back={{ label: 'Dashboard', title: 'Back to Dashboard', message: { type: 'nav.openDashboard' } }} />
    <p style={{ opacity: .85 }}>Update <code>.SNL_Doc/config.json#{descriptor.configKey}</code>. IDs are unique and immutable.</p>
    {mode === 'edit' ? <KindTextField label="ID (readonly)" value={id} onChange={setId} readOnly mono /> : <EntityIdSearchBox label="ID" entries={existingIds} value={id} onChange={setId} validate={ENTRY_VALIDATE_RULES.requireUnique} placeholder={`e.g. ${domain === 'entry' ? 'theorem' : 'operator'}`} inputStyle={{ fontFamily: 'var(--vscode-editor-font-family, monospace)' }} />}
    <KindTextField label="Display name" value={name} onChange={setName} />
    {domain === 'macro' ? <KindTextField label="Description" value={description} onChange={setDescription} /> : <>
      <KindTextField label="Default counter name" value={defaultCounterName} onChange={setDefaultCounterName} mono />
      <KindTextField label="Style tag" value={style} onChange={setStyle} mono />
    </>}
    <div style={{ display: 'flex', gap: '.75rem' }}><ColorField label="Stroke" value={stroke} onChange={setStroke} /><ColorField label="Background" value={background} onChange={setBackground} /></div>
    <ColorPreview stroke={stroke} background={background} name={trimmedName || 'preview'} />
    <Button variant="primary" onClick={submit} disabled={!canSubmit} loading={status.kind === 'creating'} loadingLabel={mode === 'edit' ? 'Updating…' : 'Creating…'}>{mode === 'edit' ? `Update ${descriptor.cap} Kind` : `Create ${descriptor.cap} Kind`}</Button>
    <KindStatus status={status} />
  </main>;
}

function KindStatus({ status }: { status: Status }): React.ReactElement | null {
  if (status.kind === 'idle' || status.kind === 'creating') return null;
  if (status.kind === 'created' || status.kind === 'updated') return <Alert severity="success">{status.kind === 'created' ? 'Created' : 'Updated'} “{status.name}” ({status.id}).</Alert>;
  const warning = status.kind === 'duplicate' || status.kind === 'notFound' || status.kind === 'invalid';
  return 'message' in status
    ? <Alert severity={warning ? 'warning' : 'error'}>{status.message}</Alert>
    : null;
}
