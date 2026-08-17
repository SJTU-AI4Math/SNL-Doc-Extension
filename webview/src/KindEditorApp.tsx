import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PANEL_STYLE } from './vscodeApi';
import {
  editorDraftKey,
  loadDraft,
  saveDraft,
  usePersistedDraft,
  useSaveShortcut
} from './components/draftState';
import { Button } from './components/Button';
import { Alert, FormField, Select } from './components/FormControls';
import { ColorField, ColorPreview, KindTextField } from './components/KindFormFields';
import { EntityIdSearchBox, ENTRY_VALIDATE_RULES } from './components/EntityIdSearchBox';
import { isEntityIdUnique } from './components/formValidation';
import { PanelHeader } from './components/PanelHeader';
import { MissingEditorTarget } from './components/MissingEditorTarget';
import {
  LOCALIZED_GENERAL_LANGUAGE,
  LocalizedEditScope,
  materializeLocalizedValueForSave,
  useLocalizedBinding,
  useLocalizedEditLanguage
} from './components/LocalizedEditScope';
import { useVsCodeBridge } from './components/useVsCodeBridge';
import type { EntryOption } from './render/EntrySurface';
import { defineUiMessages, useUiMessages, type UiTranslator } from './i18n/uiMessages';
import {
  DEFAULT_DARK_KIND_COLORING,
  DEFAULT_LIGHT_KIND_COLORING,
  normalizeKindColoring,
  type ThemedKindColoring
} from '../../src/kindColoring';
import type { Localized } from '@sjtu-ai4math/snl-basics/runtime';
import { is_valid_i18n_string, normalize_kind_label, resolve_localized_string } from '../../src/localizedContent';
import { use_content_language } from './runtime/preferencesRuntime';

const MESSAGES = defineUiMessages(
  'kindEditor',
  {
    entryKind: 'Entry Kind', macroKind: 'Macro Kind', edit: 'Edit {kind}', create: 'Create {kind}',
    dashboard: 'Dashboard', back: 'Back to Dashboard', updateConfig: 'Update ',
    immutable: '. IDs are unique and immutable.', unknownError: 'Unknown error',
    idReadonly: 'ID (readonly)', id: 'ID', entryIdExample: 'e.g. theorem', macroIdExample: 'e.g. operator',
    displayName: 'Display name', description: 'Description', defaultCounter: 'Default counter name',
    styleTag: 'Style tag', lightTheme: 'Light theme', darkTheme: 'Dark theme', editLanguage: 'Entry Kind language', generalLanguage: 'General',
    lightStroke: 'Light stroke', lightBackground: 'Light background',
    darkStroke: 'Dark stroke', darkBackground: 'Dark background', preview: 'preview',
    updating: 'Updating…', creating: 'Creating…', updateKind: 'Update {kind}', createKind: 'Create {kind}',
    created: 'Created “{name}” ({id}).', updated: 'Updated “{name}” ({id}).'
  },
  {
    entryKind: '条目类型', macroKind: '宏类型', edit: '编辑{kind}', create: '创建{kind}',
    dashboard: '仪表板', back: '返回仪表板', updateConfig: '更新 ',
    immutable: '。ID 必须唯一且不可修改。', unknownError: '未知错误',
    idReadonly: 'ID（只读）', id: 'ID', entryIdExample: '例如 theorem', macroIdExample: '例如 operator',
    displayName: '显示名称', description: '说明', defaultCounter: '默认计数器名称',
    styleTag: '样式标签', lightTheme: '浅色主题', darkTheme: '深色主题', editLanguage: '条目类型语言', generalLanguage: '通用',
    lightStroke: '浅色描边', lightBackground: '浅色背景',
    darkStroke: '深色描边', darkBackground: '深色背景', preview: '预览',
    updating: '正在更新…', creating: '正在创建…', updateKind: '更新{kind}', createKind: '创建{kind}',
    created: '已创建“{name}”（{id}）。', updated: '已更新“{name}”（{id}）。'
  }
);

export type KindEditorDomain = 'entry' | 'macro';
interface LanguageDescriptor { id: string; display_name: string; }

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
  const contentLanguage = use_content_language();
  const kindName = t(domain === 'entry' ? 'entryKind' : 'macroKind');
  const dirtyRef = useRef(false);
  const revisionRef = useRef<string | undefined>(undefined);
  const preservedColoringRef = useRef<ThemedKindColoring | null>(null);
  const [contextReady, setContextReady] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [mode, setMode] = useState<Mode>('create');
  const [targetId, setTargetId] = useState('');
  const [id, setId] = useState('');
  const [rawExistingIds, setRawExistingIds] = useState<Array<Omit<EntryOption, 'title'> & {
    title: Localized<string, string>;
  }>>([]);
  const existingIds = useMemo(() => rawExistingIds.map((entry) => ({
    ...entry,
    title: resolve_localized_string(entry.title, contentLanguage)
  })), [contentLanguage, rawExistingIds]);
  const [name, setName] = useState<Localized<string, string>>('');
  const [description, setDescription] = useState<Localized<string, string>>('');
  const [languages, setLanguages] = useState<LanguageDescriptor[]>([
    { id: 'en', display_name: 'English (US)' },
    { id: 'zh-CN', display_name: '简体中文（中国大陆）' }
  ]);
  const [editLanguage, setEditLanguage] = useState(LOCALIZED_GENERAL_LANGUAGE);
  const [lightStroke, setLightStroke] = useState(DEFAULT_LIGHT_KIND_COLORING.stroke);
  const [lightBackground, setLightBackground] = useState(DEFAULT_LIGHT_KIND_COLORING.background);
  const [darkStroke, setDarkStroke] = useState(DEFAULT_DARK_KIND_COLORING.stroke);
  const [darkBackground, setDarkBackground] = useState(DEFAULT_DARK_KIND_COLORING.background);
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
    existingIds?: Array<Omit<EntryOption, 'title'> & { title: Localized<string, string> }>;
    languages?: LanguageDescriptor[];
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
      setRawExistingIds(Array.isArray(msg.existingIds) ? msg.existingIds : []);
      if (Array.isArray(msg.languages) && msg.languages.length > 0) setLanguages(msg.languages);
      if (nextMode === 'create') {
        preservedColoringRef.current = null;
        if (!dirtyRef.current) setEditLanguage(LOCALIZED_GENERAL_LANGUAGE);
      }
      if (nextMode === 'edit' && !dirtyRef.current) {
        revisionRef.current = msg.kindRevision;
        setId(msg.id ?? '');
        const existing = msg.existing ?? {};
        const existingName = typeof existing.name === 'string' || is_valid_i18n_string(existing.name) ? existing.name : '';
        const existingDescription = typeof existing.description === 'string' || is_valid_i18n_string(existing.description) ? existing.description : '';
        setName(existingName);
        setDescription(existingDescription);
        setEditLanguage(
          typeof existingName === 'string' && typeof existingDescription === 'string'
            ? LOCALIZED_GENERAL_LANGUAGE
            : contentLanguage
        );
        const coloring = normalizeKindColoring(existing.coloring);
        preservedColoringRef.current = coloring;
        setLightStroke(coloring.light.stroke);
        setLightBackground(coloring.light.background);
        setDarkStroke(coloring.dark.stroke);
        setDarkBackground(coloring.dark.background);
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
      name: Localized<string, string>;
      description: Localized<string, string>;
      editLanguage?: string;
      lightStroke?: string;
      lightBackground?: string;
      darkStroke?: string;
      darkBackground?: string;
      stroke?: string;
      background?: string;
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
    if (restored.editLanguage) setEditLanguage(restored.editLanguage);
    const legacyStroke = restored.stroke;
    const legacyBackground = restored.background;
    setLightStroke(restored.lightStroke ?? legacyStroke ?? DEFAULT_LIGHT_KIND_COLORING.stroke);
    setLightBackground(restored.lightBackground ?? legacyBackground ?? DEFAULT_LIGHT_KIND_COLORING.background);
    setDarkStroke(restored.darkStroke ?? legacyStroke ?? DEFAULT_DARK_KIND_COLORING.stroke);
    setDarkBackground(restored.darkBackground ?? legacyBackground ?? DEFAULT_DARK_KIND_COLORING.background);
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
      editLanguage,
      lightStroke,
      lightBackground,
      darkStroke,
      darkBackground,
      defaultCounterName,
      style,
      expectedRevision: mode === 'edit' ? revisionRef.current : undefined
    },
    contextReady && formDirty
  );

  const trimmedId = id.trim();
  const projectedName = resolve_localized_string(name, editLanguage);
  const projectedDescription = resolve_localized_string(description, editLanguage);
  let validName = false;
  try { normalize_kind_label(name, 'Entry Kind name', true); validName = true; } catch { validName = false; }
  const canSubmit = targetState !== 'notFound' && validName && isEntityIdUnique(trimmedId, existingIds, mode === 'edit' ? trimmedId : undefined) && status.kind !== 'creating';
  const submit = (): void => {
    if (!canSubmit) return;
    setStatus({ kind: 'creating' });
    const payload: Record<string, unknown> = {
      id: trimmedId,
      name: domain === 'entry'
        ? materializeLocalizedValueForSave(name, editLanguage)
        : projectedName.trim(),
      coloring: {
        ...(preservedColoringRef.current ?? {}),
        light: {
          ...(preservedColoringRef.current?.light ?? {}),
          stroke: lightStroke.trim() || DEFAULT_LIGHT_KIND_COLORING.stroke,
          background: lightBackground.trim() || DEFAULT_LIGHT_KIND_COLORING.background
        },
        dark: {
          ...(preservedColoringRef.current?.dark ?? {}),
          stroke: darkStroke.trim() || DEFAULT_DARK_KIND_COLORING.stroke,
          background: darkBackground.trim() || DEFAULT_DARK_KIND_COLORING.background
        }
      }
    };
    if (domain === 'entry') {
      payload.description = materializeLocalizedValueForSave(description, editLanguage);
      payload.defaultCounterName = defaultCounterName.trim();
      payload.style = style.trim();
    } else {
      payload.description = projectedDescription.trim();
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
    {domain === 'entry' ? <LocalizedEditScope
      resetKey={`${mode}:${mode === 'edit' ? targetId : 'new'}`}
      initialLanguage={editLanguage}
      availableLanguages={[LOCALIZED_GENERAL_LANGUAGE, ...languages.map((language) => language.id)]}
      onLanguageChange={setEditLanguage}
    >
      <EntryKindLocalizedFields
        name={name}
        description={description}
        languages={languages}
        generalLabel={t('generalLanguage')}
        languageLabel={t('editLanguage')}
        nameLabel={t('displayName')}
        descriptionLabel={t('description')}
        onName={setName}
        onDescription={setDescription}
      />
    </LocalizedEditScope> : <>
      <KindTextField label={t('displayName')} value={projectedName} onChange={setName} />
      <KindTextField label={t('description')} value={projectedDescription} onChange={setDescription} />
    </>}
    {domain === 'entry' ? <>
      <KindTextField label={t('defaultCounter')} value={defaultCounterName} onChange={setDefaultCounterName} mono />
      <KindTextField label={t('styleTag')} value={style} onChange={setStyle} mono />
    </> : null}
    <KindColorThemeFields
      title={t('lightTheme')}
      strokeLabel={t('lightStroke')}
      backgroundLabel={t('lightBackground')}
      stroke={lightStroke}
      background={lightBackground}
      name={projectedName.trim() || t('preview')}
      onStroke={setLightStroke}
      onBackground={setLightBackground}
    />
    <KindColorThemeFields
      title={t('darkTheme')}
      strokeLabel={t('darkStroke')}
      backgroundLabel={t('darkBackground')}
      stroke={darkStroke}
      background={darkBackground}
      name={projectedName.trim() || t('preview')}
      onStroke={setDarkStroke}
      onBackground={setDarkBackground}
    />
    <Button variant="primary" onClick={submit} disabled={!canSubmit} loading={status.kind === 'creating'} loadingLabel={t(mode === 'edit' ? 'updating' : 'creating')}>{t(mode === 'edit' ? 'updateKind' : 'createKind', { kind: kindName })}</Button>
    <KindStatus status={status} t={t} />
  </main>;
}



function EntryKindLocalizedFields({
  name,
  description,
  languages,
  generalLabel,
  languageLabel,
  nameLabel,
  descriptionLabel,
  onName,
  onDescription
}: {
  name: Localized<string, string>;
  description: Localized<string, string>;
  languages: LanguageDescriptor[];
  generalLabel: string;
  languageLabel: string;
  nameLabel: string;
  descriptionLabel: string;
  onName: (value: Localized<string, string>) => void;
  onDescription: (value: Localized<string, string>) => void;
}): React.ReactElement {
  const editScope = useLocalizedEditLanguage();
  const nameBinding = useLocalizedBinding({ value: name, onChange: onName, defaultLanguage: languages[0]?.id ?? 'en' });
  const descriptionBinding = useLocalizedBinding({ value: description, onChange: onDescription, defaultLanguage: languages[0]?.id ?? 'en' });
  return <>
    <FormField label={languageLabel}>
      <Select value={editScope.language} onChange={(event) => editScope.setLanguage(event.target.value)}>
        <option value={LOCALIZED_GENERAL_LANGUAGE}>{generalLabel}</option>
        {languages.map((language) => <option key={language.id} value={language.id}>{language.display_name}</option>)}
      </Select>
    </FormField>
    <KindTextField label={nameLabel} value={nameBinding.resolvedValue ?? ''} onChange={nameBinding.setValue} />
    <KindTextField label={descriptionLabel} value={descriptionBinding.resolvedValue ?? ''} onChange={descriptionBinding.setValue} />
  </>;
}

function KindColorThemeFields({ title, strokeLabel, backgroundLabel, stroke, background, name, onStroke, onBackground }: {
  title: string;
  strokeLabel: string;
  backgroundLabel: string;
  stroke: string;
  background: string;
  name: string;
  onStroke: (value: string) => void;
  onBackground: (value: string) => void;
}): React.ReactElement {
  return <section aria-label={title} style={{ marginBottom: '1rem' }}>
    <h2 style={{ margin: '0 0 .35rem', fontSize: '1rem' }}>{title}</h2>
    <div style={{ display: 'flex', gap: '.75rem', flexWrap: 'wrap' }}>
      <ColorField label={strokeLabel} value={stroke} onChange={onStroke} />
      <ColorField label={backgroundLabel} value={background} onChange={onBackground} />
    </div>
    <ColorPreview stroke={stroke} background={background} name={`${title} ${name}`} />
  </section>;
}

function KindStatus({ status, t }: { status: Status; t: UiTranslator<typeof MESSAGES.catalogs.en> }): React.ReactElement | null {
  if (status.kind === 'idle' || status.kind === 'creating') return null;
  if (status.kind === 'created' || status.kind === 'updated') return <Alert severity="success">{t(status.kind, { name: status.name, id: status.id })}</Alert>;
  const warning = status.kind === 'duplicate' || status.kind === 'notFound' || status.kind === 'invalid';
  return 'message' in status
    ? <Alert severity={warning ? 'warning' : 'error'}>{status.message}</Alert>
    : null;
}
