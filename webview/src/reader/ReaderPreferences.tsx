import React, { useState } from 'react';
import { get_kind_color_scheme, get_popover_preferences, use_preferences_revision } from '../runtime/preferencesRuntime';
import { use_localized } from '../runtime/useLocalized';
import type { ReaderPlatformApi } from '../runtime/readerPlatform';

/** Reading preferences are common UI; only persistence belongs to the platform. */
export function ReaderPreferences({ api }: { api?: ReaderPlatformApi }): React.ReactElement {
  use_preferences_revision();
  const [open, setOpen] = useState(false);
  const label = use_localized({ type: 'i18n', default_language: 'en', values: { en: 'Reading preferences', 'zh-CN': '阅读偏好' } });
  const theme = use_localized({ type: 'i18n', default_language: 'en', values: { en: 'Theme', 'zh-CN': '主题' } });
  const hover = use_localized({ type: 'i18n', default_language: 'en', values: { en: 'Hover popovers', 'zh-CN': '悬停弹窗' } });
  const motion = use_localized({ type: 'i18n', default_language: 'en', values: { en: 'Motion', 'zh-CN': '动画' } });
  const change = (preferences: Record<string, unknown>): void => api?.postMessage({ type: 'snl.preferences/set-reading', preferences });
  return <div className="snl-panel-header__language">
    <button type="button" className="snl-control" aria-label={label} aria-expanded={open} onClick={() => setOpen(value => !value)}>⚙</button>
    {open ? <div className="snl-panel-header__language-menu" role="group" aria-label={label}>
      <label>{theme} <select aria-label={theme} value={get_kind_color_scheme()} onChange={event => change({ color_scheme: event.target.value })}>
        <option value="light">Light</option><option value="dark">Dark</option>
      </select></label>
      <label>{motion} <select aria-label={motion} value={document.documentElement.dataset.snlMotion ?? 'full'} onChange={event => change({ motion: event.target.value })}>
        <option value="full">Full</option><option value="reduced">Reduced</option>
      </select></label>
      <label><input type="checkbox" checked={get_popover_preferences().hoverEnabled} onChange={event => change({ popover_hover_enabled: event.target.checked })} /> {hover}</label>
    </div> : null}
  </div>;
}
