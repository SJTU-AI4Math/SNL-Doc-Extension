// SNL Create/Edit Macro Package webview.
//
// Create mode: file name + display name + optional description; host creates
// an empty canonical macro package at .SNL_Doc/term_macros/<file>.json.
//
// Edit mode: file name is readonly (renaming == delete + recreate). Only the
// display name and description are editable.

import React, { useEffect, useRef, useState } from 'react';
import { useSaveShortcut } from './components/draftState';
import {
  getVsCodeApi,
  PANEL_STYLE,
  type VsCodeApi
} from './vscodeApi';
import { PanelHeader } from './components/PanelHeader';
import { Button } from './components/Button';
import { defineUiMessages, useUiMessages, type UiTranslator } from './i18n/uiMessages';

const MESSAGES = defineUiMessages(
  'macroPackageEditor',
  {
    editTitle: 'Edit Macro Package', createTitle: 'Create Macro Package', dashboard: 'Dashboard',
    back: 'Back to Dashboard', editIntro: 'Update this package’s display name and description. The file name is immutable — renaming means delete + recreate.',
    createIntro: 'Create an empty macro Package. Workspace 0.0.5 stores its manifest under .SNL_Doc/packages/; its immutable ID determines the canonical filename.',
    fileReadonly: 'File name (readonly)', file: 'File name', filePlaceholder: 'e.g. mathlib_basic',
    immutable: 'File names are immutable; delete + recreate to rename',
    invalidFilePrefix: 'Package IDs start with a letter or digit and may also contain ', separator: ', ', separatorLast: ', and ',
    invalidFileSuffix: '; no slashes and no .json suffix.', packageId: 'Package ID: ',
    displayName: 'Display name', namePlaceholder: 'e.g. Mathlib Basic', description: 'Description',
    optional: '(optional)', descriptionPlaceholder: 'What this package is for…', updating: 'Updating…',
    creating: 'Creating…', update: 'Update Package', create: 'Create Package',
    created: '✅ Created package "{file}".', updated: '✅ Updated package "{file}" (name: {name}).',
    invalid: '❌ Invalid: {reason}', error: '❌ Error: {message}'
  },
  {
    editTitle: '编辑宏包', createTitle: '创建宏包', dashboard: '仪表板',
    back: '返回仪表板', editIntro: '更新此宏包的显示名称和说明。文件名不可修改；重命名需要删除后重新创建。',
    createIntro: '创建空宏包。工作区 0.0.5 将清单存储在 .SNL_Doc/packages/ 下；不可修改的 ID 决定规范文件名。',
    fileReadonly: '文件名（只读）', file: '文件名', filePlaceholder: '例如 mathlib_basic',
    immutable: '文件名不可修改；如需重命名，请删除后重新创建',
    invalidFilePrefix: '宏包 ID 必须以字母或数字开头，还可以包含 ', separator: '、', separatorLast: '、',
    invalidFileSuffix: '；不能包含斜杠，也不能以 .json 结尾。', packageId: '宏包 ID：',
    displayName: '显示名称', namePlaceholder: '例如 Mathlib Basic', description: '说明',
    optional: '（可选）', descriptionPlaceholder: '说明此宏包的用途…', updating: '正在更新…',
    creating: '正在创建…', update: '更新宏包', create: '创建宏包',
    created: '✅ 已创建宏包“{file}”。', updated: '✅ 已更新宏包“{file}”（名称：{name}）。',
    invalid: '❌ 无效：{reason}', error: '❌ 错误：{message}'
  }
);

type Mode = 'create' | 'edit';

interface ExistingPackage {
  file: string;
  name: string;
  description: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; file: string }
  | { kind: 'updated'; file: string; name: string }
  | { kind: 'duplicate'; file: string; message: string }
  | { kind: 'notFound'; file: string; message: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'noSnlDoc'; message: string }
  | { kind: 'noWorkspace'; message: string }
  | { kind: 'error'; message: string };

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.4rem 0.55rem',
  color: 'var(--vscode-input-foreground, #ddd)',
  background: 'var(--vscode-input-background, #2a2a2a)',
  border:
    '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
  borderRadius: '2px',
  fontFamily: 'inherit',
  fontSize: '0.95rem'
};

const readonlyStyle: React.CSSProperties = {
  ...inputStyle,
  color: 'var(--vscode-descriptionForeground, #999)',
  opacity: 0.7,
  cursor: 'not-allowed',
  fontFamily: 'var(--vscode-editor-font-family, monospace)'
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: '0.35rem',
  fontWeight: 600
};

export function CreateMacroPackageApp(): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const [mode, setMode] = useState<Mode>('create');
  const [file, setFile] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const apiRef = useRef<VsCodeApi | undefined>(undefined);
  const packageRevisionRef = useRef<string | undefined>(undefined);
  const formDirtyRef = useRef(false);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | {
            type: 'context';
            mode: Mode;
            file?: string;
            packageRevision?: string;
            existing?: ExistingPackage | null;
          }
        | { type: 'created'; file: string }
        | { type: 'updated'; file: string; name: string }
        | { type: 'duplicate'; file: string; message: string }
        | { type: 'notFound'; file: string; message: string }
        | { type: 'invalid'; reason: string }
        | { type: 'noSnlDoc'; message: string }
        | { type: 'noWorkspace'; message: string }
        | { type: 'error'; message: string }
        | undefined;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'context':
          setMode(msg.mode);
          if (msg.mode === 'edit') {
            setFile(msg.file ?? '');
            if (msg.existing && !formDirtyRef.current) {
              packageRevisionRef.current = msg.packageRevision;
              setName(msg.existing.name);
              setDescription(msg.existing.description);
            }
          }
          break;
        case 'created':
          formDirtyRef.current = false;
          setStatus({ kind: 'created', file: msg.file });
          setFile('');
          setName('');
          setDescription('');
          break;
        case 'updated':
          formDirtyRef.current = false;
          setStatus({ kind: 'updated', file: msg.file, name: msg.name });
          break;
        case 'duplicate':
          setStatus({
            kind: 'duplicate',
            file: msg.file,
            message: msg.message
          });
          break;
        case 'notFound':
          setStatus({
            kind: 'notFound',
            file: msg.file,
            message: msg.message
          });
          break;
        case 'invalid':
          setStatus({ kind: 'invalid', reason: msg.reason });
          break;
        case 'noSnlDoc':
          setStatus({ kind: 'noSnlDoc', message: msg.message });
          break;
        case 'noWorkspace':
          setStatus({ kind: 'noWorkspace', message: msg.message });
          break;
        case 'error':
          setStatus({ kind: 'error', message: msg.message });
          break;
        default:
          break;
      }
    }

    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const trimmedFile = file.trim();
  const trimmedName = name.trim();
  const fileValid = mode === 'edit'
    ? true
    : FILE_RE.test(trimmedFile) && !trimmedFile.toLowerCase().endsWith('.json');
  const canSubmit =
    fileValid && trimmedName.length > 0 && status.kind !== 'creating';

  // Ctrl/Cmd+S is the same action as the Create/Update button.
  useSaveShortcut(() => handleSubmit(), canSubmit);

  function handleSubmit(): void {
    if (!canSubmit) {
      return;
    }
    setStatus({ kind: 'creating' });
    apiRef.current?.postMessage({
      type: mode === 'edit' ? 'update' : 'create',
      file: trimmedFile,
      name: trimmedName,
      description: description.trim(),
      expectedRevision: mode === 'edit' ? packageRevisionRef.current : undefined
    });
  }

  return (
    <main style={PANEL_STYLE}>
      <PanelHeader
        vsApi={apiRef.current}
        title={t(mode === 'edit' ? 'editTitle' : 'createTitle')}
        back={{ label: t('dashboard'), title: t('back'), message: { type: 'nav.openDashboard' } }}
      />
      <p style={{ margin: '0 0 1rem', opacity: 0.8 }}>
        {mode === 'edit'
          ? t('editIntro')
          : t('createIntro')}
      </p>

      <label htmlFor="pkg-file" style={labelStyle}>
        {t(mode === 'edit' ? 'fileReadonly' : 'file')}
      </label>
      <input
        id="pkg-file"
        type="text"
        value={file}
        readOnly={mode === 'edit'}
        placeholder={t('filePlaceholder')}
        onChange={(e) => {
          formDirtyRef.current = true;
          setFile(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleSubmit();
          }
        }}
        title={
          mode === 'edit'
            ? t('immutable')
            : undefined
        }
        style={{
          ...(mode === 'edit' ? readonlyStyle : inputStyle),
          marginBottom: '0.35rem',
          borderColor:
            mode !== 'edit' && trimmedFile.length > 0 && !fileValid
              ? 'var(--vscode-inputValidation-errorBorder, #be1100)'
              : undefined
        }}
      />
      {mode !== 'edit' && trimmedFile.length > 0 && !fileValid ? (
        <p
          style={{
            margin: '0 0 0.6rem',
            fontSize: '0.85rem',
            color: 'var(--vscode-errorForeground, #f48771)'
          }}
        >
          {t('invalidFilePrefix')}
          <code>_</code>{t('separator')}<code>-</code>{t('separatorLast')}<code>.</code>
          <code>.json</code>{t('invalidFileSuffix')}
        </p>
      ) : mode !== 'edit' ? (
        <p style={{ margin: '0 0 0.6rem', fontSize: '0.85rem', opacity: 0.7 }}>
          {t('packageId')}<code>{fileValid ? trimmedFile : '<package-id>'}</code>
        </p>
      ) : (
        <div style={{ height: '0.6rem' }} />
      )}

      <label htmlFor="pkg-name" style={labelStyle}>
        {t('displayName')}
      </label>
      <input
        id="pkg-name"
        type="text"
        value={name}
        placeholder={t('namePlaceholder')}
        onChange={(e) => {
          formDirtyRef.current = true;
          setName(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleSubmit();
          }
        }}
        style={{ ...inputStyle, marginBottom: '0.9rem' }}
      />

      <label htmlFor="pkg-desc" style={labelStyle}>
        {t('description')} <span style={{ opacity: 0.6 }}>{t('optional')}</span>
      </label>
      <textarea
        id="pkg-desc"
        value={description}
        placeholder={t('descriptionPlaceholder')}
        rows={3}
        onChange={(e) => {
          formDirtyRef.current = true;
          setDescription(e.target.value);
        }}
        style={{ ...inputStyle, marginBottom: '1rem', resize: 'vertical' }}
      />

      <Button
        variant="primary"
        onClick={handleSubmit}
        disabled={!canSubmit}
      >
        {status.kind === 'creating'
          ? t(mode === 'edit' ? 'updating' : 'creating')
          : t(mode === 'edit' ? 'update' : 'create')}
      </Button>

      <StatusLine status={status} t={t} />
    </main>
  );
}

function StatusLine({
  status,
  t
}: {
  status: Status;
  t: UiTranslator<typeof MESSAGES.catalogs.en>;
}): React.ReactElement | null {
  if (status.kind === 'idle' || status.kind === 'creating') {
    return null;
  }

  let text = '';
  let color = 'var(--vscode-foreground, #ddd)';
  if (status.kind === 'created') {
    text = t('created', { file: status.file });
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'updated') {
    text = t('updated', { file: status.file, name: status.name });
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'duplicate' || status.kind === 'notFound') {
    text = `\u26a0\ufe0f ${status.message}`;
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else if (status.kind === 'invalid') {
    text = t('invalid', { reason: status.reason });
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (
    status.kind === 'noSnlDoc' ||
    status.kind === 'noWorkspace'
  ) {
    text = `\u274c ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'error') {
    text = t('error', { message: status.message });
    color = 'var(--vscode-errorForeground, #f48771)';
  }

  return (
    <p style={{ marginTop: '1rem', marginBottom: 0, color, fontWeight: 600 }}>
      {text}
    </p>
  );
}
