import React, { useEffect, useRef, useState } from 'react';
import { PANEL_STYLE } from './vscodeApi';
import {
  editorDraftKey,
  loadDraft,
  saveDraft,
  usePersistedDraft,
  useSaveShortcut
} from './components/draftState';
import { Button } from './components/Button';
import { Alert } from './components/FormControls';
import { ColorField, ColorPreview, KindTextField } from './components/KindFormFields';
import { EntityIdSearchBox, ENTRY_VALIDATE_RULES } from './components/EntityIdSearchBox';
import { isEntityIdUnique } from './components/formValidation';
import { PanelHeader } from './components/PanelHeader';
import { MissingEditorTarget } from './components/MissingEditorTarget';
import { useVsCodeBridge } from './components/useVsCodeBridge';
import type { EntryOption } from './render/EntrySurface';
import { defineUiMessages, useUiMessages, type UiTranslator } from './i18n/uiMessages';

const MESSAGES = defineUiMessages(
  'kindEditor',
  {
    entryKind: 'Entry Kind', macroKind: 'Macro Kind', edit: 'Edit {kind}', create: 'Create {kind}',
    dashboard: 'Dashboard', back: 'Back to Dashboard', updateConfig: 'Update ',
    immutable: '. IDs are unique and immutable.', unknownError: 'Unknown error',
    idReadonly: 'ID (readonly)', id: 'ID', entryIdExample: 'e.g. theorem', macroIdExample: 'e.g. operator',
    displayName: 'Display name', description: 'Description', defaultCounter: 'Default counter name',
    styleTag: 'Style tag', stroke: 'Stroke', background: 'Background', preview: 'preview',
    updating: 'Updating…', creating: 'Creating…', updateKind: 'Update {kind}', createKind: 'Create {kind}',
    created: 'Created “{name}” ({id}).', updated: 'Updated “{name}” ({id}).'
  },
  {
    entryKind: '条目类型', macroKind: '宏类型', edit: '编辑{kind}', create: '创建{kind}',
    dashboard: '仪表板', back: '返回仪表板', updateConfig: '更新 ',
    immutable: '。ID 必须唯一且不可修改。', unknownError: '未知错误',
    idReadonly: 'ID（只读）', id: 'ID', entryIdExample: '例如 theorem', macroIdExample: '例如 operator',
    displayName: '显示名称', description: '说明', defaultCounter: '默认计数器名称',
    styleTag: '样式标签', stroke: '描边', background: '背景', preview: '预览',
    updating: '正在更新…', creating: '正在创建…', updateKind: '更新{kind}', createKind: '创建{kind}',
    created: '已创建“{name}”（{id}）。', updated: '已更新“{name}”（{id}）。'
  }
);

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
  const t = useUiMessages(MESSAGES);
  const kindName = t(domain === 'entry' ? 'entryKind' : 'macroKind');
  const dirtyRef = useRef(false);
  const revisionRef = useRef<string | undefined>(undefined);
  const [contextReady, setContextReady] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [mode, setMode] = useState<Mode>('create');
  const [targetId, setTargetId] = useState('');
  const [id, setId] = useState('');
  const [existingIds, setExistingIds] = useState<EntryOption[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [stroke, setStroke] = useState('#888888');
  const [background, setBackground] = useState('#eeeeee');
  const [defaultCounterName, setDefaultCounterName] = useState('');
  const [style, setStyle] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [targetState, setTargetState] = useState<'found' | 'notFound'>('found');
  const draftKey = editorDraftKey(
    `${domain}-kind`,
    mode,
    mode === 'edit' ? targetId : ''
  );
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const { apiRef, post } = useVsCodeBridge<{
    type?: string;
    mode?: Mode;
    id?: string;
    existing?: Record<string, unknown> | null;
    kindRevision?: string;
    targetState?: 'found' | 'notFound';
    expectedRevision?: string;
    existingIds?: EntryOption[];
    kind?: { id: string; name: string };
    message?: string;
  }>((msg) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'context') {
      const nextMode = msg.mode === 'edit' ? 'edit' : 'create';
      setMode(nextMode);
      setTargetState(nextMode === 'edit' && msg.targetState === 'notFound' ? 'notFound' : 'found');
      setContextReady(true);
      setTargetId(nextMode === 'edit' ? (msg.id ?? '') : '');
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
      setFormDirty(false);
      saveDraft(apiRef.current, draftKeyRef.current, undefined);
      if (msg.type === 'created') {
        saveDraft(
          apiRef.current,
          editorDraftKey(`${domain}-kind`, 'edit', msg.kind.id),
          undefined
        );
      }
      setStatus({ kind: msg.type, id: msg.kind.id, name: msg.kind.name });
    } else if (['duplicate', 'notFound', 'conflict', 'invalid', 'noSnlDoc', 'noWorkspace', 'error'].includes(msg.type)) {
      if (msg.type === 'notFound') setTargetState('notFound');
      setStatus({ kind: msg.type as Exclude<Status['kind'], 'idle' | 'creating' | 'created' | 'updated'>, message: msg.message ?? t('unknownError') });
    }
  });

  useEffect(() => {
    if (!contextReady) return;
    const restored = loadDraft<{
      id: string;
      name: string;
      description: string;
      stroke: string;
      background: string;
      defaultCounterName: string;
      style: string;
      expectedRevision?: string;
    }>(apiRef.current, draftKey);
    if (!restored) return;
    dirtyRef.current = true;
    setFormDirty(true);
    revisionRef.current = restored.expectedRevision;
    setId(restored.id);
    setName(restored.name);
    setDescription(restored.description);
    setStroke(restored.stroke);
    setBackground(restored.background);
    setDefaultCounterName(restored.defaultCounterName);
    setStyle(restored.style);
  }, [contextReady, draftKey]);

  usePersistedDraft(
    apiRef.current,
    draftKey,
    {
      id,
      name,
      description,
      stroke,
      background,
      defaultCounterName,
      style,
      expectedRevision: mode === 'edit' ? revisionRef.current : undefined
    },
    contextReady && formDirty
  );

  const trimmedId = id.trim();
  const trimmedName = name.trim();
  const canSubmit = targetState !== 'notFound' && trimmedName.length > 0 && isEntityIdUnique(trimmedId, existingIds, mode === 'edit' ? trimmedId : undefined) && status.kind !== 'creating';
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

  if (mode === 'edit' && targetState === 'notFound') {
    return <main style={PANEL_STYLE}>
      <PanelHeader title={t('edit', { kind: kindName })} vsApi={apiRef.current} back={{ label: t('dashboard'), title: t('back'), message: { type: 'nav.openDashboard' } }} />
      <MissingEditorTarget target={domain === 'entry' ? 'entryKind' : 'macroKind'} id={targetId || id} />
    </main>;
  }

  return <main style={PANEL_STYLE} onChangeCapture={() => { dirtyRef.current = true; setFormDirty(true); }}>
    <PanelHeader title={t(mode === 'edit' ? 'edit' : 'create', { kind: kindName })} vsApi={apiRef.current} back={{ label: t('dashboard'), title: t('back'), message: { type: 'nav.openDashboard' } }} />
    <p style={{ opacity: .85 }}>{t('updateConfig')}<code>.SNL_Doc/config.json#{descriptor.configKey}</code>{t('immutable')}</p>
    {mode === 'edit' ? <KindTextField label={t('idReadonly')} value={id} onChange={setId} readOnly mono /> : <EntityIdSearchBox label={t('id')} entries={existingIds} value={id} onChange={setId} validate={ENTRY_VALIDATE_RULES.requireUnique} placeholder={t(domain === 'entry' ? 'entryIdExample' : 'macroIdExample')} inputStyle={{ fontFamily: 'var(--vscode-editor-font-family, monospace)' }} />}
    <KindTextField label={t('displayName')} value={name} onChange={setName} />
    {domain === 'macro' ? <KindTextField label={t('description')} value={description} onChange={setDescription} /> : <>
      <KindTextField label={t('defaultCounter')} value={defaultCounterName} onChange={setDefaultCounterName} mono />
      <KindTextField label={t('styleTag')} value={style} onChange={setStyle} mono />
    </>}
    <div style={{ display: 'flex', gap: '.75rem' }}><ColorField label={t('stroke')} value={stroke} onChange={setStroke} /><ColorField label={t('background')} value={background} onChange={setBackground} /></div>
    <ColorPreview stroke={stroke} background={background} name={trimmedName || t('preview')} />
    <Button variant="primary" onClick={submit} disabled={!canSubmit} loading={status.kind === 'creating'} loadingLabel={t(mode === 'edit' ? 'updating' : 'creating')}>{t(mode === 'edit' ? 'updateKind' : 'createKind', { kind: kindName })}</Button>
    <KindStatus status={status} t={t} />
  </main>;
}

function KindStatus({ status, t }: { status: Status; t: UiTranslator<typeof MESSAGES.catalogs.en> }): React.ReactElement | null {
  if (status.kind === 'idle' || status.kind === 'creating') return null;
  if (status.kind === 'created' || status.kind === 'updated') return <Alert severity="success">{t(status.kind, { name: status.name, id: status.id })}</Alert>;
  const warning = status.kind === 'duplicate' || status.kind === 'notFound' || status.kind === 'invalid';
  return 'message' in status
    ? <Alert severity={warning ? 'warning' : 'error'}>{status.message}</Alert>
    : null;
}
