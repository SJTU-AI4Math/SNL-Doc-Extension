import React from 'react';
import type { VsCodeApi } from '../vscodeApi';
import { IconButton } from './IconButton';
import {
  use_localized,
  type LocalizedString
} from '../runtime/useLocalized';
import { BUILT_IN_LANGUAGE_CATALOG } from '../../../src/languageCatalog';
import { invariantText } from '../i18n/uiMessages';
import {
  set_content_language,
  use_content_language,
  use_supported_languages
} from '../runtime/preferencesRuntime';

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
  /** Optional panel-specific control rendered beside the title. */
  titleAction?: React.ReactNode;
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
  titleAction,
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
  const contentLanguageLabel = use_localized({
    type: 'i18n',
    default_language: 'en',
    values: { en: 'Content language', 'zh-CN': '内容语言' }
  });
  const supportedLanguages = use_supported_languages();
  const contentLanguage = use_content_language();
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
          <IconButton
            icon="chevron-left"
            label={backTitle || backLabel}
            variant="secondary"
            size="md"
            title={backTitle}
            onClick={() => back.onClick
              ? back.onClick()
              : back.message && vsApi?.postMessage(back.message)}
          />
        ) : null}
        <a
          className="snl-panel-header__brand"
          href="https://sjtu-ai4math.github.io/"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={invariantText('SJTU AI4Math', 'brand')}
        >
          <img className="snl-panel-header__logo" src={logo} alt="" aria-hidden="true" />
          <span className="snl-panel-header__watermark">
            {invariantText('SJTU AI4Math', 'brand')}
          </span>
        </a>
      </div>

      <div className="snl-panel-header__identity">
        <div className="snl-panel-header__title-row">
          <h1>{resolvedTitle}</h1>
          {titleAction}
        </div>
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
          <IconButton
            icon="chevron-right"
            label={viewTitle || viewLabel}
            variant="secondary"
            size="md"
            title={viewTitle}
            onClick={() => viewInInfoview.onClick
              ? viewInInfoview.onClick()
              : viewInInfoview.message && vsApi?.postMessage(viewInInfoview.message)}
          />
        ) : null}
        {actions}
        <ContentLanguageSelector
          label={contentLanguageLabel}
          current={contentLanguage}
          supportedLanguages={supportedLanguages}
        />
        <LanguageSelector
          vsApi={vsApi}
          label={languageLabel}
          autoLabel={autoLanguageLabel}
          current={currentPreference}
          effectiveLanguage={effectiveLanguage}
        />
      </div>
    </nav>
  );
}

type HeaderLanguagePreference = 'auto' | 'en' | 'zh-CN';

function ContentLanguageSelector({
  label,
  current,
  supportedLanguages
}: {
  label: string;
  current: string;
  supportedLanguages: readonly { id: string; display_name: string }[];
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const descriptor = supportedLanguages.find((language) => language.id === current);
  const currentLabel = descriptor?.display_name ?? current;

  React.useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [open]);

  return (
    <div className="snl-panel-header__language" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="snl-control snl-panel-header__language-trigger"
        aria-label={`${label}: ${currentLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <LanguageIcon language={current} />
      </button>
      {open ? (
        <div role="menu" aria-label={label} className="snl-panel-header__language-menu">
          {supportedLanguages.map((language) => (
            <button
              key={language.id}
              type="button"
              role="menuitemradio"
              aria-checked={current === language.id}
              className="snl-panel-header__language-item"
              onClick={() => {
                set_content_language(language.id);
                setOpen(false);
                requestAnimationFrame(() => triggerRef.current?.focus());
              }}
            >
              <LanguageIcon language={language.id} />
              <span>{language.display_name}</span>
              <span className="snl-panel-header__language-check" aria-hidden="true">
                {current === language.id ? '✓' : ''}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LanguageSelector({
  vsApi,
  label,
  autoLabel,
  current,
  effectiveLanguage
}: {
  vsApi: VsCodeApi | undefined;
  label: string;
  autoLabel: string;
  current: HeaderLanguagePreference;
  effectiveLanguage: 'en' | 'zh-CN';
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [activeLanguage, setActiveLanguage] = React.useState<HeaderLanguagePreference>(current);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const currentLanguage = BUILT_IN_LANGUAGE_CATALOG.find((item) => item.id === current);
  const currentLabel = current === 'auto'
    ? autoLabel
    : currentLanguage?.display_name ?? current;
  const [addingLanguage, setAddingLanguage] = React.useState(false);
  const [languageId, setLanguageId] = React.useState('');
  const [languageDisplayName, setLanguageDisplayName] = React.useState('');
  const addLanguageLabel = use_localized({
    type: 'i18n', default_language: 'en',
    values: { en: 'Add authoring language', 'zh-CN': '添加内容语言' }
  });
  const languageTagLabel = use_localized({
    type: 'i18n', default_language: 'en', values: { en: 'Language tag', 'zh-CN': '语言标签' }
  });
  const displayNameLabel = use_localized({
    type: 'i18n', default_language: 'en', values: { en: 'Display name', 'zh-CN': '显示名称' }
  });
  const saveLanguageLabel = use_localized({
    type: 'i18n', default_language: 'en', values: { en: 'Save language', 'zh-CN': '保存语言' }
  });
  const cancelLabel = use_localized({
    type: 'i18n', default_language: 'en', values: { en: 'Cancel', 'zh-CN': '取消' }
  });

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
        <LanguageIcon language={effectiveLanguage} />
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
          <div className="snl-panel-header__authoring-languages">
            {addingLanguage ? (
              <form onSubmit={(event) => {
                event.preventDefault();
                const id = languageId.trim();
                const display_name = languageDisplayName.trim();
                if (!id || !display_name) return;
                vsApi?.postMessage({ type: 'snl.languages/add', language: { id, display_name } });
                setLanguageId('');
                setLanguageDisplayName('');
                setAddingLanguage(false);
                setOpen(false);
              }}>
                <label><span>{languageTagLabel}</span><input aria-label={languageTagLabel}
                  value={languageId} onChange={(event) => setLanguageId(event.target.value)}
                  placeholder="fr-FR" /></label>
                <label><span>{displayNameLabel}</span><input aria-label={displayNameLabel}
                  value={languageDisplayName}
                  onChange={(event) => setLanguageDisplayName(event.target.value)} /></label>
                <div>
                  <button type="submit">{saveLanguageLabel}</button>
                  <button type="button" onClick={() => setAddingLanguage(false)}>{cancelLabel}</button>
                </div>
              </form>
            ) : (
              <button type="button" onClick={() => setAddingLanguage(true)}>{addLanguageLabel}</button>
            )}
          </div>
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

export function LanguageIcon({ language }: { language: string }): React.ReactElement {
  if (language === '__snl_general__') {
    return (
      <svg data-language-icon="general" aria-hidden="true" viewBox="0 0 20 14">
        <circle cx="10" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M4.8 7h10.4M10 1.5c2.7 2.8 2.7 8.2 0 11M10 1.5c-2.7 2.8-2.7 8.2 0 11" fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>
    );
  }
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
    <svg data-language-icon={language === 'auto' ? 'auto' : 'custom'} aria-hidden="true" viewBox="0 0 20 14">
      <circle cx="10" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.8 7h10.4M10 1.5c2.7 2.8 2.7 8.2 0 11M10 1.5c-2.7 2.8-2.7 8.2 0 11" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
