import React, { useEffect, useState } from 'react';
import { PanelHeader } from './components/PanelHeader';
import { defineUiMessages, useUiMessages } from './i18n/uiMessages';
import { PANEL_STYLE, useVsCodeApiRef } from './vscodeApi';

const MESSAGES = defineUiMessages('createEntryPackage', {
  title: 'Create Entry Package', dashboard: 'Dashboard', backDashboard: 'Back to Dashboard',
  id: 'Package ID', idHint: 'Stable identity: letters, digits, dots, underscores, or hyphens.',
  name: 'Display name', description: 'Description (optional)', create: 'Create Entry Package',
  creating: 'Creating…', created: 'Entry Package created.', invalidId: 'Enter a valid Package ID.',
  nameRequired: 'Display name is required.'
}, {
  title: '创建条目包', dashboard: '仪表板', backDashboard: '返回仪表板',
  id: '包 ID', idHint: '稳定标识：字母、数字、点、下划线或连字符。',
  name: '显示名称', description: '说明（可选）', create: '创建条目包',
  creating: '正在创建…', created: '条目包已创建。', invalidId: '请输入有效的包 ID。',
  nameRequired: '显示名称为必填项。'
});

const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type Incoming =
  | { type: 'context' }
  | { type: 'created'; packageId: string }
  | { type: 'duplicate' | 'invalid' | 'error' | 'noWorkspace'; message: string };

export function CreateEntryPackageApp(): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const apiRef = useVsCodeApiRef();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const canonicalId = id.trim();
  const idValid = PACKAGE_ID_RE.test(canonicalId) &&
    !canonicalId.toLowerCase().endsWith('.json');
  const canCreate = idValid && name.trim().length > 0 && !busy;

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const msg = event.data as Incoming | undefined;
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'created') {
        setBusy(false);
        setStatus({ kind: 'ok', message: t('created') });
      } else if (msg.type === 'duplicate' || msg.type === 'invalid' ||
                 msg.type === 'error' || msg.type === 'noWorkspace') {
        setBusy(false);
        setStatus({ kind: 'error', message: msg.message });
      }
    };
    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [apiRef, t]);

  const submit = (): void => {
    if (!canCreate) {
      setStatus({ kind: 'error', message: idValid ? t('nameRequired') : t('invalidId') });
      return;
    }
    setBusy(true);
    setStatus(null);
    apiRef.current?.postMessage({
      type: 'create', id: canonicalId, name: name.trim(), description: description.trim()
    });
  };

  return <main style={PANEL_STYLE}>
    <PanelHeader vsApi={apiRef.current} title={t('title')} showRefresh={false}
      back={{ label: t('dashboard'), title: t('backDashboard'), message: { type: 'nav.openDashboard' } }} />
    <form onSubmit={(event) => { event.preventDefault(); submit(); }} style={{ display: 'grid', gap: '0.75rem', maxWidth: '42rem' }}>
      <label>{t('id')}<input aria-label={t('id')} value={id} disabled={busy}
        onChange={(event) => setId(event.target.value)} style={{ display: 'block', width: '100%' }} /></label>
      <small>{t('idHint')}</small>
      <label>{t('name')}<input aria-label={t('name')} value={name} disabled={busy}
        onChange={(event) => setName(event.target.value)} style={{ display: 'block', width: '100%' }} /></label>
      <label>{t('description')}<textarea aria-label={t('description')} value={description} disabled={busy}
        onChange={(event) => setDescription(event.target.value)} style={{ display: 'block', width: '100%', minHeight: '5rem' }} /></label>
      {status ? <p role={status.kind === 'error' ? 'alert' : 'status'}>{status.message}</p> : null}
      <button type="submit" disabled={!canCreate}>{busy ? t('creating') : t('create')}</button>
    </form>
  </main>;
}
