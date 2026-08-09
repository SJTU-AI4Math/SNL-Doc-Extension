import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  is_i18n,
  type I18n,
  type Localized
} from '@sjtu-ai4math/snl-basics/runtime';

export interface LocalizedEditLanguageContextValue {
  language: string;
  availableLanguages: readonly string[];
  setLanguage(language: string): void;
  followOuterLanguage(): void;
  followsOuterLanguage: boolean;
}

const LocalizedEditLanguageContext = createContext<LocalizedEditLanguageContextValue | null>(null);

export interface LocalizedEditScopeProps {
  initialLanguage: string;
  availableLanguages: readonly string[];
  onLanguageChange?(language: string): void;
  children: React.ReactNode;
}

/**
 * Owns a language selection for one editor subtree. Changing it never writes to
 * the outer UI preference or to a parent LocalizedEditScope.
 */
export function LocalizedEditScope({
  initialLanguage,
  availableLanguages,
  onLanguageChange,
  children
}: LocalizedEditScopeProps): React.ReactElement {
  const [language, setLanguageState] = useState(initialLanguage);
  const manuallySelectedRef = useRef(false);
  const [followsOuterLanguage, setFollowsOuterLanguage] = useState(true);

  useEffect(() => {
    if (!manuallySelectedRef.current) setLanguageState(initialLanguage);
  }, [initialLanguage]);

  useEffect(() => {
    onLanguageChange?.(language);
  }, [language, onLanguageChange]);

  const setLanguage = useCallback((next: string): void => {
    manuallySelectedRef.current = true;
    setFollowsOuterLanguage(false);
    setLanguageState(next);
  }, []);

  const followOuterLanguage = useCallback((): void => {
    manuallySelectedRef.current = false;
    setFollowsOuterLanguage(true);
    setLanguageState(initialLanguage);
  }, [initialLanguage]);

  const value = useMemo<LocalizedEditLanguageContextValue>(() => ({
    language,
    availableLanguages,
    setLanguage,
    followOuterLanguage,
    followsOuterLanguage
  }), [availableLanguages, followOuterLanguage, followsOuterLanguage, language, setLanguage]);

  return (
    <LocalizedEditLanguageContext.Provider value={value}>
      {children}
    </LocalizedEditLanguageContext.Provider>
  );
}

export function useLocalizedEditLanguage(): LocalizedEditLanguageContextValue {
  const context = useContext(LocalizedEditLanguageContext);
  if (!context) throw new Error('useLocalizedEditLanguage must be used inside LocalizedEditScope');
  return context;
}

export type LocalizedProjectionState = 'invariant' | 'explicit' | 'fallback' | 'missing';

export interface LocalizedBinding<Value> {
  language: string;
  state: LocalizedProjectionState;
  explicitValue: Value | undefined;
  resolvedValue: Value | undefined;
  sourceLanguage: string | undefined;
  canClear: boolean;
  setValue(value: Value): void;
  clearValue(): void;
}

export interface UseLocalizedBindingOptions<Value> {
  value: Localized<string, Value>;
  onChange(value: Localized<string, Value>): void;
  defaultLanguage: string;
}

function inspectLocalized<Value>(
  value: Localized<string, Value>,
  language: string
): Pick<LocalizedBinding<Value>, 'state' | 'explicitValue' | 'resolvedValue' | 'sourceLanguage'> {
  if (!is_i18n(value)) {
    return {
      state: 'invariant',
      explicitValue: value,
      resolvedValue: value,
      sourceLanguage: undefined
    };
  }
  const exact = Object.prototype.hasOwnProperty.call(value.values, language)
    ? value.values[language]
    : undefined;
  if (exact !== undefined) {
    return { state: 'explicit', explicitValue: exact, resolvedValue: exact, sourceLanguage: language };
  }
  const byDefault = Object.prototype.hasOwnProperty.call(value.values, value.default_language)
    ? value.values[value.default_language]
    : undefined;
  if (byDefault !== undefined) {
    return {
      state: 'fallback', explicitValue: undefined,
      resolvedValue: byDefault, sourceLanguage: value.default_language
    };
  }
  for (const sourceLanguage of Object.keys(value.values)) {
    const candidate = value.values[sourceLanguage];
    if (candidate !== undefined) {
      return { state: 'fallback', explicitValue: undefined, resolvedValue: candidate, sourceLanguage };
    }
  }
  return { state: 'missing', explicitValue: undefined, resolvedValue: undefined, sourceLanguage: undefined };
}

/** A generic localized-value lens driven by the nearest local editor scope. */
export function useLocalizedBinding<Value>({
  value,
  onChange,
  defaultLanguage
}: UseLocalizedBindingOptions<Value>): LocalizedBinding<Value> {
  const { language } = useLocalizedEditLanguage();
  const projection = inspectLocalized(value, language);

  const setValue = useCallback((next: Value): void => {
    if (is_i18n(value)) {
      onChange({ ...value, values: { ...value.values, [language]: next } });
      return;
    }
    if (language === defaultLanguage) {
      onChange(next);
      return;
    }
    const promoted: I18n<string, Value> = {
      type: 'i18n',
      default_language: defaultLanguage,
      values: { [defaultLanguage]: value, [language]: next }
    };
    onChange(promoted);
  }, [defaultLanguage, language, onChange, value]);

  const clearValue = useCallback((): void => {
    if (!is_i18n(value) ||
        !Object.prototype.hasOwnProperty.call(value.values, language) ||
        value.values[language] === undefined) return;
    const values = { ...value.values };
    delete values[language];
    const remaining = Object.keys(values).filter((key) => values[key] !== undefined);
    if (remaining.length === 0) return;
    const nextDefault = language === value.default_language
      ? remaining[0]
      : value.default_language;
    onChange({ ...value, default_language: nextDefault, values });
  }, [language, onChange, value]);

  return {
    language,
    ...projection,
    canClear: is_i18n(value) &&
      Object.prototype.hasOwnProperty.call(value.values, language) &&
      value.values[language] !== undefined &&
      Object.values(value.values).filter((item) => item !== undefined).length > 1,
    setValue,
    clearValue
  };
}
