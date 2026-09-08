import React, { useState } from 'react';
import { get_kind_color_scheme, get_popover_preferences, use_preferences_revision } from '../runtime/preferencesRuntime';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';
import type { ReaderPlatformApi } from '../runtime/readerPlatform';

const MESSAGES = defineUiMessages('readerPreferences', {
  label: 'Reading preferences', theme: 'Theme', hover: 'Hover popovers', motion: 'Motion',
  light: 'Light', dark: 'Dark', full: 'Full', reduced: 'Reduced'
}, {
  label: '阅读偏好', theme: '主题', hover: '悬停弹窗', motion: '动画',
  light: '浅色', dark: '深色', full: '完整', reduced: '减少'
});
/** Reading preferences are common UI; only persistence belongs to the platform. */
export function ReaderPreferences({ api }: { api?: ReaderPlatformApi }): React.ReactElement {
  use_preferences_revision();
  const [open, setOpen] = useState(false);
  const t = useUiMessages(MESSAGES);
  const change = (preferences: Record<string, unknown>): void => api?.postMessage({ type: 'snl.preferences/set-reading', preferences });
  return <div className="snl-panel-header__language">
    <button type="button" className="snl-control" aria-label={t('label')} aria-expanded={open} onClick={() => setOpen(value => !value)}>⚙</button>
    {open ? <div className="snl-panel-header__language-menu" role="group" aria-label={t('label')}>
      <label>{t('theme')} <select aria-label={t('theme')} value={get_kind_color_scheme()} onChange={event => change({ color_scheme: event.target.value })}>
        <option value="light">{t('light')}</option><option value="dark">{t('dark')}</option>
      </select></label>
      <label>{t('motion')} <select aria-label={t('motion')} value={document.documentElement.dataset.snlMotion ?? 'full'} onChange={event => change({ motion: event.target.value })}>
        <option value="full">{t('full')}</option><option value="reduced">{t('reduced')}</option>
      </select></label>
      <label><input type="checkbox" checked={get_popover_preferences().hoverEnabled} onChange={event => change({ popover_hover_enabled: event.target.checked })} /> {t('hover')}</label>
    </div> : null}
  </div>;
}
