import React from 'react';
import type { VsCodeApi } from '../vscodeApi';
import { Button } from './Button';
import { formatDirectionalLabel } from './interactionModel';
import {
  use_localized,
  type LocalizedString
} from '../runtime/useLocalized';
import { BUILT_IN_LANGUAGE_CATALOG } from '../../../src/languageCatalog';

export interface PanelHeaderAction {
  /** Text on the button. Kept terse. */
  label: LocalizedString;
  /** Tooltip. Full sentence explaining what happens. */
  title?: LocalizedString;
  /** Message payload posted to the host. Host dispatches via command. */
  message?: Record<string, unknown>;
  /** Local-only navigation, used by the layered Infoview. */
  onClick?: () => void;
}

export interface PanelHeaderProps {
  vsApi: VsCodeApi | undefined;
  /** The page title rendered inside the shared header. */
  title: LocalizedString;
  /** Optional low-emphasis context below the title. */
  subtitle?: LocalizedString;
  /** Left-side action (back / go up). Omit for root panels. */
  back?: PanelHeaderAction;
  /** Optional action that opens the corresponding Infoview surface. */
  viewInInfoview?: PanelHeaderAction;
  /** Additional panel-specific controls placed before the language selector. */
  actions?: React.ReactNode;
  /** Set false only when the host does not implement nav.refresh. */
  showRefresh?: boolean;
}

/**
 * Shared top-level identity, navigation and preference surface for every panel.
 *
 * The language list is deliberately centralized. Today it contains the two
 * built-in locales; a future host-provided language-pack catalog only needs to
 * replace this one source rather than touching every panel.
 */
export function PanelHeader({
  vsApi,
  title,
  subtitle,
  back,
  viewInInfoview,
  actions,
  showRefresh = true
}: PanelHeaderProps): React.ReactElement {
  const resolvedTitle = use_localized(title);
  const resolvedSubtitle = use_localized(subtitle ?? '');
  const backLabel = use_localized(back?.label ?? '');
  const backTitle = use_localized(back?.title ?? back?.label ?? '');
  const viewLabel = use_localized(viewInInfoview?.label ?? '');
  const viewTitle = use_localized(
    viewInInfoview?.title ?? viewInInfoview?.label ?? ''
  );
  const navigationLabel = use_localized({
    type: 'i18n',
    default_language: 'en',
    values: { en: 'Panel navigation', 'zh-CN': '面板导航' }
  });
  const refreshTitle = use_localized({
    type: 'i18n',
    default_language: 'en',
    values: { en: 'Refresh this panel from disk', 'zh-CN': '从磁盘刷新此面板' }
  });
  const languageLabel = use_localized({
    type: 'i18n',
    default_language: 'en',
    values: { en: 'Interface language', 'zh-CN': '界面语言' }
  });
  const root = document.documentElement.dataset;
  const effectiveLanguage = document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en';
  const currentLanguage = root.snlLanguagePreference === 'auto'
    ? ''
    : effectiveLanguage;
  const logo = root.snlColorScheme === 'light' || root.snlColorScheme === 'high-contrast-light'
    ? root.snlLogoBlack
    : root.snlLogoWhite;
  const autoLanguageLabel = use_localized({
    type: 'i18n',
    default_language: 'en',
    values: {
      en: `Following VS Code (${effectiveLanguage}) — choose to override`,
      'zh-CN': `正在跟随 VS Code（${effectiveLanguage}）— 请选择语言以覆盖`
    }
  });
  const languageTitle = use_localized({
    type: 'i18n',
    default_language: 'en',
    values: {
      en: 'Choose an explicit interface language. Restore Auto from VS Code Settings.',
      'zh-CN': '选择明确的界面语言；可在 VS Code 设置中恢复“自动”。'
    }
  });

  return (
    <nav className="snl-panel-header" aria-label={navigationLabel}>
      <div className="snl-panel-header__leading">
        {back ? (
          <Button
            variant="secondary"
            size="md"
            title={backTitle}
            onClick={() => back.onClick
              ? back.onClick()
              : back.message && vsApi?.postMessage(back.message)}
          >
            {formatDirectionalLabel('back', backLabel)}
          </Button>
        ) : null}
        <div className="snl-panel-header__brand">
          <img className="snl-panel-header__logo" src={logo} alt="" aria-hidden="true" />
          <span className="snl-panel-header__watermark">SJTU AI4Math</span>
        </div>
      </div>

      <div className="snl-panel-header__identity">
        <h1>{resolvedTitle}</h1>
        {resolvedSubtitle ? <div className="snl-panel-header__subtitle">{resolvedSubtitle}</div> : null}
      </div>

      <div className="snl-panel-header__actions">
        {showRefresh ? (
          <Button
            variant="secondary"
            size="md"
            title={refreshTitle}
            aria-label={refreshTitle}
            onClick={() => vsApi?.postMessage({ type: 'nav.refresh' })}
          >
            {'↻'}
          </Button>
        ) : null}
        {viewInInfoview ? (
          <Button
            variant="secondary"
            size="md"
            title={viewTitle}
            onClick={() => viewInInfoview.onClick
              ? viewInInfoview.onClick()
              : viewInInfoview.message && vsApi?.postMessage(viewInInfoview.message)}
          >
            {formatDirectionalLabel('forward', viewLabel)}
          </Button>
        ) : null}
        {actions}
        <label className="snl-panel-header__language">
          <span>{languageLabel}</span>
          <select
            className="snl-control"
            aria-label={languageLabel}
            title={languageTitle}
            value={currentLanguage}
            onChange={(event) => {
              vsApi?.postMessage({
                type: 'snl.preferences/set-language',
                language: event.target.value
              });
            }}
          >
            <option value="" disabled hidden>{autoLanguageLabel}</option>
            {BUILT_IN_LANGUAGE_CATALOG.map((option) => (
              <option key={option.id} value={option.id}>
                {option.flag} {option.display_name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </nav>
  );
}
