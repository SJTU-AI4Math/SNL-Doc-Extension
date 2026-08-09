import { BUILT_IN_LANGUAGE_CATALOG } from './languageCatalog';

export interface SupportedLanguageDescriptor {
  id: string;
  display_name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeSupportedLanguage(value: unknown): SupportedLanguageDescriptor {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.display_name !== 'string') {
    throw new Error('supported_languages entries require string id and display_name fields');
  }
  const inputId = value.id.trim().replace(/_/g, '-');
  if (inputId.toLowerCase() === 'auto') {
    throw new Error('supported_languages language id "auto" is reserved');
  }
  let id: string;
  try {
    const canonical = Intl.getCanonicalLocales(inputId);
    if (canonical.length !== 1) throw new Error('not one locale');
    [id] = canonical;
  } catch {
    throw new Error(`supported_languages contains an invalid language id: ${JSON.stringify(value.id)}`);
  }
  const display_name = value.display_name.trim();
  if (!display_name || display_name.length > 80) {
    throw new Error('supported_languages display_name must contain 1–80 characters');
  }
  return { id, display_name };
}

export function supportedLanguagesFromConfig(rawConfig: unknown): SupportedLanguageDescriptor[] {
  if (!isRecord(rawConfig)) throw new Error('config.json must be an object');
  const raw = rawConfig.supported_languages;
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new Error('config.json supported_languages must be an array');
  }
  if (Array.isArray(raw) && raw.length > 100) {
    throw new Error('config.json supported_languages may contain at most 100 entries');
  }
  const result: SupportedLanguageDescriptor[] = BUILT_IN_LANGUAGE_CATALOG.map((item) => ({ ...item }));
  const seen = new Set(result.map((item) => item.id.toLowerCase()));
  for (const candidate of raw ?? []) {
    const language = normalizeSupportedLanguage(candidate);
    const identity = language.id.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(language);
  }
  if (result.length > 100) {
    throw new Error('config.json supported_languages may contain at most 100 unique entries');
  }
  return result;
}
