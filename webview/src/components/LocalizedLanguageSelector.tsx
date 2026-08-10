import React, { useEffect, useRef, useState } from 'react';
import { LanguageIcon } from './PanelHeader';

export interface LocalizedLanguageDescriptor {
  id: string;
  display_name: string;
}

export function localizedLanguageDisplayName(
  language: string,
  catalog: readonly LocalizedLanguageDescriptor[],
  generalLanguage: string,
  generalLabel: string
): string {
  if (language === generalLanguage) return generalLabel;
  return catalog.find((item) => item.id === language)?.display_name ?? language;
}

export function LocalizedLanguageSelector({
  languages,
  value,
  label,
  generalLanguage,
  generalLabel,
  onChange,
  catalog = []
}: {
  languages: readonly string[];
  value: string;
  label: string;
  generalLanguage: string;
  generalLabel: string;
  onChange: (language: string) => void;
  catalog?: readonly LocalizedLanguageDescriptor[];
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const currentLabel = localizedLanguageDisplayName(
    value, catalog, generalLanguage, generalLabel
  );

  useEffect(() => {
    if (!open) return;
    const selected = [...(rootRef.current
      ?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])]
      .find((option) => option.dataset.language === value);
    selected?.focus();
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [open, value]);

  return (
    <div ref={rootRef} className="snl-panel-header__language">
      <button
        ref={triggerRef}
        type="button"
        className="snl-control snl-panel-header__language-trigger"
        aria-label={`${label}: ${currentLabel}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{ width: 'auto', gap: '0.35rem', paddingInline: '0.5rem' }}
        onClick={() => setOpen((current) => !current)}
      >
        <LanguageIcon language={value} />
        <span>{currentLabel}</span>
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label={label}
          className="snl-panel-header__language-menu"
          style={{ left: 0, right: 'auto' }}
          onKeyDown={(event) => {
            const options = [...event.currentTarget
              .querySelectorAll<HTMLButtonElement>('[role="option"]')];
            if (event.key === 'Escape') {
              event.preventDefault();
              setOpen(false);
              triggerRef.current?.focus();
              return;
            }
            if (event.key === 'Tab') {
              setOpen(false);
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
                options.length === 0) return;
            event.preventDefault();
            const current = Math.max(
              0, options.indexOf(document.activeElement as HTMLButtonElement)
            );
            const next = event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? options.length - 1
                : event.key === 'ArrowUp'
                  ? (current - 1 + options.length) % options.length
                  : (current + 1) % options.length;
            options[next]?.focus();
          }}
        >
          {languages.map((language) => {
            const optionLabel = localizedLanguageDisplayName(
              language, catalog, generalLanguage, generalLabel
            );
            return (
              <button
                key={language}
                type="button"
                role="option"
                data-language={language}
                aria-selected={language === value}
                className="snl-panel-header__language-item"
                onClick={() => {
                  onChange(language);
                  setOpen(false);
                  requestAnimationFrame(() => triggerRef.current?.focus());
                }}
              >
                <LanguageIcon language={language} />
                <span>{optionLabel}</span>
                <span aria-hidden="true" className="snl-panel-header__language-check">
                  {language === value ? '✓' : ''}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
