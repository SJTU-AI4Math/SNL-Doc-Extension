// SNL Create/Edit Relationship webview (cat 2026-07-10).
//
// A pool-wide relationship is a directed edge between two entries with a
// free-text label + arbitrary `metadata: any`. The editor is deliberately
// minimal — see snlDoc.ts §Relationships for the storage contract and
// createRelationshipPanel.ts for the message protocol.
//
// Layout (top → bottom):
//   1. PanelHeader — shared branding, language, and back to Dashboard
//   2. ID       — string field; requireUnique in create, read-only in edit
//   3. From     — EntityIdSearchBox against the entry pool (requireMatch)
//   4. To       — EntityIdSearchBox against the entry pool (requireMatch)
//   5. Label    — free text
//   6. Metadata — raw JSON textarea (parsed on submit; empty → null)
//   7. Submit + status banner

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  useVsCodeApiRef,
  PANEL_STYLE
} from './vscodeApi';
import { PanelHeader } from './components/PanelHeader';
import { Button } from './components/Button';
import {
  EntityIdSearchBox,
  ENTRY_VALIDATE_RULES,
  resolveEntryOption
} from './components/EntityIdSearchBox';
import type { EntryOption } from './render/EntryRender';
import { useSaveShortcut } from './components/draftState';
import { defineUiMessages, invariantText, useUiMessages } from './i18n/uiMessages';

const MESSAGES = defineUiMessages(
  'relationshipEditor',
  {
    created: 'Created relationship "{id}".', updated: 'Updated relationship "{id}".',
    endpoint: '{message} (endpoint: {endpoint})', invalid: 'Invalid: {reason}',
    metadataInvalid: 'Metadata is not valid JSON: {error}', edit: 'Edit Relationship',
    create: 'Create Relationship', dashboard: 'Dashboard', back: 'Back to SNL Dashboard',
    loading: 'Loading relationship context…', editTitle: 'Edit Relationship — {id}',
    idReadonly: 'ID (read-only)', idRequired: 'ID (required, unique)',
    idPlaceholder: 'e.g. depends.contMul.mulComm', duplicate: 'Id "{id}" already exists.',
    from: 'From (source entry)', fromPlaceholder: 'Pick a source entry id',
    to: 'To (target entry)', toPlaceholder: 'Pick a target entry id',
    label: 'Label (required)', labelPlaceholder: 'e.g. depends-on, generalizes, proves',
    metadata: 'Metadata (optional, raw JSON — empty ⇒ null)', jsonError: 'JSON parse error: {error}',
    saving: 'Saving…', saveChanges: 'Save Changes'
  },
  {
    created: '已创建关系“{id}”。', updated: '已更新关系“{id}”。',
    endpoint: '{message}（端点：{endpoint}）', invalid: '无效：{reason}',
    metadataInvalid: '元数据不是有效的 JSON：{error}', edit: '编辑关系',
    create: '创建关系', dashboard: '仪表板', back: '返回 SNL 仪表板',
    loading: '正在加载关系上下文…', editTitle: '编辑关系 — {id}',
    idReadonly: 'ID（只读）', idRequired: 'ID（必填且唯一）',
    idPlaceholder: '例如 depends.contMul.mulComm', duplicate: 'ID“{id}”已存在。',
    from: '起点（源条目）', fromPlaceholder: '选择源条目 ID',
    to: '终点（目标条目）', toPlaceholder: '选择目标条目 ID',
    label: '标签（必填）', labelPlaceholder: '例如 depends-on、generalizes、proves',
    metadata: '元数据（可选，原始 JSON；留空 ⇒ null）', jsonError: 'JSON 解析错误：{error}',
    saving: '正在保存…', saveChanges: '保存更改'
  }
);

interface RelationshipData {
  id: string;
  from: string;
  to: string;
  label: string;
  metadata: unknown;
}

interface ContextMessage {
  type: 'context';
  mode: 'create' | 'edit';
  id?: string;
  existing?: RelationshipData | null;
  relationshipRevision?: string;
  entryPool: Array<{ id: string; title: string }>;
  existingIds: string[];
}

type IncomingMessage =
  | ContextMessage
  | { type: 'created'; id: string }
  | { type: 'updated'; id: string }
  | { type: 'duplicate'; id: string; message: string }
  | {
      type: 'unknownEndpoint';
      endpoint: 'from' | 'to';
      id: string;
      message: string;
    }
  | { type: 'notFound' | 'conflict'; id: string; message: string }
  | { type: 'invalid'; reason: string }
  | { type: 'noSnlDoc'; message: string }
  | { type: 'noWorkspace'; message: string }
  | { type: 'error'; message: string };

interface Banner {
  kind: 'ok' | 'warn' | 'error';
  text: string;
}

const LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: '0.85rem',
  marginBottom: '0.25rem',
  opacity: 0.85
};

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '0.4rem 0.55rem',
  fontFamily: 'inherit',
  fontSize: '0.95rem',
  border:
    '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
  background: 'var(--vscode-input-background, rgba(255,255,255,0.04))',
  color: 'inherit',
  borderRadius: '3px',
  boxSizing: 'border-box'
};

const MONO_INPUT_STYLE: React.CSSProperties = {
  ...INPUT_STYLE,
  fontFamily: 'var(--vscode-editor-font-family, monospace)'
};

const ROW_STYLE: React.CSSProperties = { marginBottom: '1rem' };

/** Stringify metadata for the textarea. `null`/`undefined` → empty. */
function formatMetadata(v: unknown): string {
  if (v === null || v === undefined) return '';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return '';
  }
}

/** Parse the metadata textarea. Empty → null. Invalid JSON → thrown Error. */
function parseMetadata(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

export function CreateRelationshipApp(): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const tRef = useRef(t);
  tRef.current = t;
  const apiRef = useVsCodeApiRef();
  const dirtyRef = useRef(false);
  const revisionRef = useRef<string | undefined>(undefined);
  const [mode, setMode] = useState<'create' | 'edit'>('create');
  const [id, setId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [label, setLabel] = useState('');
  const [metadata, setMetadata] = useState('');
  const [entryPool, setEntryPool] = useState<EntryOption[]>([]);
  const [existingIds, setExistingIds] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {

    function onMessage(event: MessageEvent): void {
      const msg = event.data as IncomingMessage | undefined;
      if (!msg) return;
      const translate = tRef.current;
      switch (msg.type) {
        case 'context': {
          setMode(msg.mode);
          const pool: EntryOption[] = msg.entryPool.map((e) => ({
            id: e.id,
            title: e.title,
            hasContent: false
          }));
          setEntryPool(pool);
          setExistingIds(msg.existingIds ?? []);
          if (!dirtyRef.current) {
            revisionRef.current = msg.relationshipRevision;
            if (msg.mode === 'edit' && msg.existing) {
              setId(msg.existing.id);
              setFrom(msg.existing.from);
              setTo(msg.existing.to);
              setLabel(msg.existing.label);
              setMetadata(formatMetadata(msg.existing.metadata));
            } else {
              setId('');
              setFrom('');
              setTo('');
              setLabel('');
              setMetadata('');
            }
          }
          setLoaded(true);
          return;
        }
        case 'created':
          dirtyRef.current = false;
          setBanner({ kind: 'ok', text: translate('created', { id: msg.id }) });
          setBusy(false);
          return;
        case 'updated':
          dirtyRef.current = false;
          setBanner({ kind: 'ok', text: translate('updated', { id: msg.id }) });
          setBusy(false);
          return;
        case 'duplicate':
          setBanner({ kind: 'warn', text: msg.message });
          setBusy(false);
          return;
        case 'unknownEndpoint':
          setBanner({
            kind: 'warn',
            text: translate('endpoint', { message: msg.message, endpoint: msg.endpoint })
          });
          setBusy(false);
          return;
        case 'notFound':
        case 'conflict':
        case 'noSnlDoc':
        case 'noWorkspace':
        case 'error':
          setBanner({ kind: 'error', text: msg.message });
          setBusy(false);
          setLoaded(true);
          return;
        case 'invalid':
          setBanner({ kind: 'error', text: translate('invalid', { reason: msg.reason }) });
          setBusy(false);
          return;
      }
    }
    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Validation helpers.
  const trimmedId = id.trim();
  const trimmedLabel = label.trim();
  const trimmedFrom = from.trim();
  const trimmedTo = to.trim();
  const idDupeInCreate =
    mode === 'create' &&
    trimmedId.length > 0 &&
    existingIds.includes(trimmedId);
  const fromResolved = useMemo(
    () => resolveEntryOption(trimmedFrom, entryPool),
    [entryPool, trimmedFrom]
  );
  const toResolved = useMemo(
    () => resolveEntryOption(trimmedTo, entryPool),
    [entryPool, trimmedTo]
  );
  let metadataError: string | null = null;
  try {
    parseMetadata(metadata);
  } catch (err) {
    metadataError = err instanceof Error ? err.message : String(err);
  }

  const canSubmit =
    loaded &&
    !busy &&
    trimmedId.length > 0 &&
    !idDupeInCreate &&
    !!fromResolved &&
    !!toResolved &&
    trimmedLabel.length > 0 &&
    metadataError === null;

  // Ctrl/Cmd+S is the same action as the Create/Update button.
  useSaveShortcut(() => onSubmit(), canSubmit);

  function onSubmit(): void {
    if (!canSubmit) return;
    let parsedMetadata: unknown;
    try {
      parsedMetadata = parseMetadata(metadata);
    } catch (err) {
      setBanner({
        kind: 'error',
        text: t('metadataInvalid', { error: err instanceof Error ? err.message : String(err) })
      });
      return;
    }
    setBusy(true);
    setBanner(null);
    const payload: RelationshipData = {
      id: trimmedId,
      from: trimmedFrom,
      to: trimmedTo,
      label: trimmedLabel,
      metadata: parsedMetadata
    };
    apiRef.current?.postMessage({
      type: mode === 'edit' ? 'update' : 'create',
      relationship: payload,
      expectedRevision: mode === 'edit' ? revisionRef.current : undefined
    });
  }

  if (!loaded) {
    return (
      <main style={PANEL_STYLE}>
        <PanelHeader
          vsApi={apiRef.current}
          title={t(mode === 'edit' ? 'edit' : 'create')}
          back={{
            label: t('dashboard'),
            title: t('back'),
            message: { type: 'nav.openDashboard' }
          }}
        />
        <p style={{ opacity: 0.7 }}>{t('loading')}</p>
      </main>
    );
  }

  return (
    <main style={PANEL_STYLE}>
      <PanelHeader
        vsApi={apiRef.current}
        title={mode === 'edit'
          ? t('editTitle', { id: trimmedId || id })
          : t('create')}
        back={{
          label: t('dashboard'),
          title: t('back'),
          message: { type: 'nav.openDashboard' }
        }}
      />

      <div style={ROW_STYLE}>
        <label htmlFor="rel-id" style={LABEL_STYLE}>
          {t(mode === 'edit' ? 'idReadonly' : 'idRequired')}
        </label>
        <input
          id="rel-id"
          type="text"
          value={id}
          readOnly={mode === 'edit'}
          onChange={(e) => { dirtyRef.current = true; setId(e.target.value); }}
          placeholder={t('idPlaceholder')}
          style={{
            ...MONO_INPUT_STYLE,
            opacity: mode === 'edit' ? 0.7 : 1,
            borderColor: idDupeInCreate
              ? 'var(--vscode-errorForeground, #f14c4c)'
              : MONO_INPUT_STYLE.border as string
          }}
        />
        {idDupeInCreate ? (
          <div
            style={{
              marginTop: '0.25rem',
              fontSize: '0.8rem',
              color: 'var(--vscode-errorForeground, #f14c4c)'
            }}
          >
            {t('duplicate', { id: trimmedId })}
          </div>
        ) : null}
      </div>

      <div style={ROW_STYLE}>
        <EntityIdSearchBox
          label={t('from')}
          entries={entryPool}
          value={from}
          onChange={(value) => { dirtyRef.current = true; setFrom(value); }}
          validate={ENTRY_VALIDATE_RULES.requireMatch}
          placeholder={t('fromPlaceholder')}
          idPrefix="rel-from"
        />
      </div>

      <div style={ROW_STYLE}>
        <EntityIdSearchBox
          label={t('to')}
          entries={entryPool}
          value={to}
          onChange={(value) => { dirtyRef.current = true; setTo(value); }}
          validate={ENTRY_VALIDATE_RULES.requireMatch}
          placeholder={t('toPlaceholder')}
          idPrefix="rel-to"
        />
      </div>

      <div style={ROW_STYLE}>
        <label htmlFor="rel-label" style={LABEL_STYLE}>
          {t('label')}
        </label>
        <input
          id="rel-label"
          type="text"
          value={label}
          onChange={(e) => { dirtyRef.current = true; setLabel(e.target.value); }}
          placeholder={t('labelPlaceholder')}
          style={INPUT_STYLE}
        />
      </div>

      <div style={ROW_STYLE}>
        <label htmlFor="rel-metadata" style={LABEL_STYLE}>
          {t('metadata')}
        </label>
        <textarea
          id="rel-metadata"
          value={metadata}
          onChange={(e) => { dirtyRef.current = true; setMetadata(e.target.value); }}
          placeholder={invariantText('{"weight": 1, "note": "..."}', 'protocol-token')}
          rows={8}
          style={{
            ...MONO_INPUT_STYLE,
            resize: 'vertical',
            borderColor: metadataError
              ? 'var(--vscode-errorForeground, #f14c4c)'
              : MONO_INPUT_STYLE.border as string
          }}
        />
        {metadataError ? (
          <div
            style={{
              marginTop: '0.25rem',
              fontSize: '0.8rem',
              color: 'var(--vscode-errorForeground, #f14c4c)'
            }}
          >
            {t('jsonError', { error: metadataError })}
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <Button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          variant="primary"
        >
          {busy
            ? t('saving')
            : mode === 'edit'
              ? t('saveChanges')
              : t('create')}
        </Button>
        {banner ? (
          <span
            style={{
              fontSize: '0.9rem',
              color:
                banner.kind === 'ok'
                  ? 'var(--vscode-terminal-ansiGreen, #4ec9b0)'
                  : banner.kind === 'warn'
                    ? 'var(--vscode-editorWarning-foreground, #d7a35a)'
                    : 'var(--vscode-errorForeground, #f14c4c)'
            }}
          >
            {banner.text}
          </span>
        ) : null}
      </div>
    </main>
  );
}
