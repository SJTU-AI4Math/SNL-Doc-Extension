import React from 'react';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';

const MESSAGES = defineUiMessages(
  'missingEditorTarget',
  {
    entry: 'Entry', macro: 'Macro', library: 'Library', macroPackage: 'Macro Package', relationship: 'Relationship',
    entryKind: 'Entry Kind', macroKind: 'Macro Kind', title: '{target} not found',
    detail: '{target} “{id}” no longer exists. It may have been deleted or renamed. Use Refresh to try again, or go Back to recover.'
  },
  {
    entry: '条目', macro: '宏', library: '文库', macroPackage: '宏包', relationship: '关系',
    entryKind: '条目类型', macroKind: '宏类型', title: '未找到{target}',
    detail: '{target}“{id}”已不存在，可能已被删除或重命名。请使用“刷新”重试，或返回上一页恢复。'
  }
);

export type MissingEditorTargetKind =
  | 'entry' | 'macro' | 'library' | 'macroPackage' | 'relationship' | 'entryKind' | 'macroKind';

export function MissingEditorTarget({
  target,
  id
}: {
  target: MissingEditorTargetKind;
  id: string;
}): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const targetLabel = t(target);
  return <section
    role="alert"
    aria-live="assertive"
    style={{
      padding: '1rem',
      border: '1px solid var(--vscode-inputValidation-errorBorder, #be1100)',
      borderRadius: '4px',
      background: 'var(--vscode-inputValidation-errorBackground, rgba(190, 17, 0, 0.08))'
    }}
  >
    <h2 style={{ margin: '0 0 .5rem' }}>{t('title', { target: targetLabel })}</h2>
    <p style={{ margin: 0 }}>{t('detail', { target: targetLabel, id })}</p>
  </section>;
}
