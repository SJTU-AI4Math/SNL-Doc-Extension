import React from 'react';
import type { VsCodeApi } from '../vscodeApi';
import { Button } from './Button';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import {
  use_localized,
  type LocalizedString
} from '../runtime/useLocalized';
import { BUILT_IN_LANGUAGE_CATALOG } from '../../../src/languageCatalog';
import { invariantText } from '../i18n/uiMessages';

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
  const currentPreference = root.snlLanguagePreference === 'auto'
    ? 'auto'
    : effectiveLanguage;
  const logo = root.snlColorScheme === 'light' || root.snlColorScheme === 'high-contrast-light'
    ? root.snlLogoBlack
    : root.snlLogoWhite;
  const effectiveDisplayName = BUILT_IN_LANGUAGE_CATALOG.find(
    (language) => language.id === effectiveLanguage
  )?.display_name ?? effectiveLanguage;
  const autoLanguageLabel = use_localized({
    type: 'i18n',
    default_language: 'en',
    values: {
      en: `Follow VS Code (${effectiveDisplayName})`,
      'zh-CN': `跟随 VS Code（${effectiveDisplayName}）`
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
            <Icon name="chevron-left" />
            <span>{backLabel}</span>
          </Button>
        ) : null}
        <div className="snl-panel-header__brand">
          <img className="snl-panel-header__logo" src={logo} alt="" aria-hidden="true" />
          <span className="snl-panel-header__watermark">
            {invariantText('SJTU AI4Math', 'brand')}
          </span>
        </div>
      </div>

      <div className="snl-panel-header__identity">
        <h1>{resolvedTitle}</h1>
        {resolvedSubtitle ? <div className="snl-panel-header__subtitle">{resolvedSubtitle}</div> : null}
      </div>

      <div className="snl-panel-header__actions">
        {showRefresh ? (
          <IconButton
            icon="refresh"
            label={refreshTitle}
            variant="secondary"
            size="md"
            title={refreshTitle}
            onClick={() => vsApi?.postMessage({ type: 'nav.refresh' })}
          />
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
            <Icon name="open" />
            <span>{viewLabel}</span>
          </Button>
        ) : null}
        {actions}
        <LanguageSelector
          vsApi={vsApi}
          label={languageLabel}
          autoLabel={autoLanguageLabel}
          current={currentPreference}
        />
      </div>
    </nav>
  );
}

type HeaderLanguagePreference = 'auto' | 'en' | 'zh-CN';

function LanguageSelector({
  vsApi,
  label,
  autoLabel,
  current
}: {
  vsApi: VsCodeApi | undefined;
  label: string;
  autoLabel: string;
  current: HeaderLanguagePreference;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [activeLanguage, setActiveLanguage] = React.useState<HeaderLanguagePreference>(current);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const currentLanguage = BUILT_IN_LANGUAGE_CATALOG.find((item) => item.id === current);
  const currentLabel = current === 'auto'
    ? autoLabel
    : currentLanguage?.display_name ?? current;

  React.useEffect(() => {
    if (!open) return;
    rootRef.current
      ?.querySelector<HTMLButtonElement>(`[data-language="${activeLanguage}"]`)
      ?.focus();
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [open, activeLanguage]);

  const openMenu = (): void => {
    setActiveLanguage(current);
    setOpen(true);
  };

  const choose = (language: HeaderLanguagePreference): void => {
    vsApi?.postMessage({ type: 'snl.preferences/set-language', language });
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const moveMenuFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]'
    )];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (event.key === 'ArrowDown') next = (index + 1 + items.length) % items.length;
    if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (next !== undefined) {
      event.preventDefault();
      const language = items[next]?.dataset.language as HeaderLanguagePreference | undefined;
      if (language) setActiveLanguage(language);
      items[next]?.focus();
    }
  };

  return (
    <div className="snl-panel-header__language" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="snl-control snl-panel-header__language-trigger"
        aria-label={`${label}: ${currentLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => open ? setOpen(false) : openMenu()}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <LanguageIcon language={current} />
        <span>{currentLabel}</span>
        <span aria-hidden="true" className="snl-panel-header__language-chevron">▾</span>
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          className="snl-panel-header__language-menu"
          onKeyDown={moveMenuFocus}
        >
          <LanguageMenuItem
            language="auto"
            label={autoLabel}
            checked={current === 'auto'}
            active={activeLanguage === 'auto'}
            onFocus={setActiveLanguage}
            onChoose={choose}
          />
          {BUILT_IN_LANGUAGE_CATALOG.map((language) => (
            <LanguageMenuItem
              key={language.id}
              language={language.id}
              label={language.display_name}
              checked={current === language.id}
              active={activeLanguage === language.id}
              onFocus={setActiveLanguage}
              onChoose={choose}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LanguageMenuItem({
  language,
  label,
  checked,
  active,
  onFocus,
  onChoose
}: {
  language: HeaderLanguagePreference;
  label: string;
  checked: boolean;
  active: boolean;
  onFocus: (language: HeaderLanguagePreference) => void;
  onChoose: (language: HeaderLanguagePreference) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-language={language}
      tabIndex={active ? 0 : -1}
      className="snl-panel-header__language-item"
      onFocus={() => onFocus(language)}
      onClick={() => onChoose(language)}
    >
      <LanguageIcon language={language} />
      <span>{label}</span>
      <span className="snl-panel-header__language-check" aria-hidden="true">
        {checked ? '✓' : ''}
      </span>
    </button>
  );
}

function LanguageIcon({ language }: { language: HeaderLanguagePreference }): React.ReactElement {
  if (language === 'zh-CN') {
    return (
      <svg data-language-icon="zh-CN" aria-hidden="true" viewBox="0 0 20 14">
        <rect width="20" height="14" rx="1" fill="#DE2910" />
        <polygon points="4,2 4.65,3.35 6.1,3.55 5.05,4.55 5.3,6 4,5.3 2.7,6 2.95,4.55 1.9,3.55 3.35,3.35" fill="#FFDE00" />
        <circle cx="7.5" cy="2.2" r=".55" fill="#FFDE00" />
        <circle cx="8.7" cy="3.8" r=".55" fill="#FFDE00" />
        <circle cx="8.6" cy="5.7" r=".55" fill="#FFDE00" />
        <circle cx="7.2" cy="7" r=".55" fill="#FFDE00" />
      </svg>
    );
  }
  if (language === 'en') {
    return (
      <svg data-language-icon="en" aria-hidden="true" viewBox="0 0 20 14">
        <rect width="20" height="14" rx="1" fill="#fff" />
        {[0, 2, 4, 6, 8, 10, 12].map((y) => (
          <rect key={y} y={y} width="20" height="1.1" fill="#B22234" />
        ))}
        <rect width="9" height="7.5" fill="#3C3B6E" />
        {[1.5, 3.5, 5.5, 7.5].flatMap((x) => [1.4, 3.6, 5.8].map((y) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r=".35" fill="#fff" />
        )))}
      </svg>
    );
  }
  return (
    <svg data-language-icon="auto" aria-hidden="true" viewBox="0 0 20 14">
      <circle cx="10" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.8 7h10.4M10 1.5c2.7 2.8 2.7 8.2 0 11M10 1.5c-2.7 2.8-2.7 8.2 0 11" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
