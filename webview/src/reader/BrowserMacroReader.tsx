import React, { useMemo, useState } from 'react';
import { PanelHeader } from '../components/PanelHeader';
import { Button } from '../components/Button';
import { MacroPreview, createMacroPreviewRuntime } from '../render/MacroPreview';
import { use_content_language } from '../runtime/preferencesRuntime';
import { useReaderCapabilities, READER_STYLE } from './ReaderCapabilities';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';
import { resolve_localized_string } from '../../../src/localizedContent';
import type { FrozenReaderSnapshot } from '../../../src/sharedReaderSnapshot';

const MESSAGES = defineUiMessages('browserMacroReader', {
  title: 'Read-only Macro preview', back: '← Back', sourceEntries: 'Source Entries',
  missing: 'Not included in this export', style: 'Style'
}, {
  title: '宏只读预览', back: '← 返回', sourceEntries: '来源条目',
  missing: '未包含在本次导出中', style: '样式'
});

/** Read-only destination for a frozen Macro; rendering is the same shared preview as the Extension. */
export function BrowserMacroReader({ snapshot, name }: { snapshot: FrozenReaderSnapshot; name: string }): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const { api, missingEntryDescription } = useReaderCapabilities();
  const language = use_content_language();
  const [style, setStyle] = useState<string>();
  const runtime = useMemo(() => createMacroPreviewRuntime({ macros: snapshot.macros, macroKinds: snapshot.macroKinds, language }), [snapshot, language]);
  const macro = snapshot.macros[name];
  const entryIds = useMemo(() => new Set(snapshot.entries.map(entry => entry.id)), [snapshot]);
  return <main style={READER_STYLE}>
    <PanelHeader vsApi={api} title={name} subtitle={t('title')} back={{ label: t('back'), message: { type: 'back' } }} />
    {macro.description ? <p>{resolve_localized_string(macro.description, language)}</p> : null}
    <label>{t('style')} <select value={style ?? macro.styles[0]?.style_name ?? ''} onChange={event => setStyle(event.target.value)}>
      {macro.styles.map(item => <option key={item.style_name} value={item.style_name}>{item.style_name}</option>)}
    </select></label>
    <div style={{ margin: '1rem 0' }}><MacroPreview macro={macro} runtime={runtime} styleName={style} label={t('title')} /></div>
    <h2>{t('sourceEntries')}</h2>
    <ul>{macro.source.entries.map(id => <li key={id}>{entryIds.has(id)
      ? <Button onClick={() => api?.postMessage({ type: 'navigateEntry', entryId: id })}>{id}</Button>
      : <span>{id} — {missingEntryDescription ?? t('missing')}</span>}</li>)}</ul>
  </main>;
}
