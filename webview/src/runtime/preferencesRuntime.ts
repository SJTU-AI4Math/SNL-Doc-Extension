import { useSyncExternalStore } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import { installWorkspaceAssetBroker } from './workspaceAssetBroker';
// Lean subpath: the Reader runtime only, with no path to the React views
// (and therefore none to KaTeX). See vite.runtime.config.ts in SNL-Basics.
import {
  ReaderRuntime,
  type LanguageEnvironment
} from '@sjtu-ai4math/snl-basics/runtime';

interface WebviewPreferences {
  language: string;
  language_preference?: string;
  color_scheme: string;
  motion: string;
  formatter_indent_spaces?: number;
  formatter_inline_parenthesis_depth?: number;
  popover_hover_enabled?: boolean;
}

export interface SupportedLanguageDescriptor {
  id: string;
  display_name: string;
}

export interface FormatterPreferences {
  indentSpaces: number;
  inlineParenthesisDepth: number;
}

export interface PopoverPreferences {
  hoverEnabled: boolean;
}

export interface ContentLanguageStore {
  get(): string;
  set(language: string): void;
  subscribe(subscriber: () => void): () => void;
}

/** One module instance is bundled into each Webview, so this store is Panel-scoped. */
export function create_content_language_store(initialLanguage: string): ContentLanguageStore {
  let language = initialLanguage || 'en';
  const listeners = new Set<() => void>();
  return {
    get: () => language,
    set: (nextLanguage) => {
      const next = nextLanguage.trim();
      if (!next || next === language) return;
      language = next;
      for (const listener of listeners) listener();
    },
    subscribe: (subscriber) => {
      listeners.add(subscriber);
      return () => listeners.delete(subscriber);
    }
  };
}

export interface PreferencesSnapshotMessage {
  type: 'snl.preferences/snapshot';
  generation: string;
  revision: number;
  preferences: WebviewPreferences;
  supported_languages?: SupportedLanguageDescriptor[];
}

let hostRevision = -1;
let hostGeneration: string | undefined;
let renderRevision = 0;
const documentRoot = typeof document !== 'undefined'
  ? document.documentElement
  : ({ lang: 'en', dataset: {} } as unknown as HTMLElement);
const contentLanguageStore = create_content_language_store(
  documentRoot.dataset.snlContentLanguage || documentRoot.lang || 'en'
);
let configuredMotion = documentRoot.dataset.snlMotion || 'auto';
let formatterPreferences: FormatterPreferences = {
  indentSpaces: 4,
  inlineParenthesisDepth: 3
};
let popoverPreferences: PopoverPreferences = { hoverEnabled: true };
// Fail closed until PreferencesHost publishes the repo-authoritative catalog.
let supportedLanguages: SupportedLanguageDescriptor[] = [];
const subscribers = new Set<() => void>();

contentLanguageStore.subscribe(() => {
  documentRoot.dataset.snlContentLanguage = contentLanguageStore.get();
  renderRevision += 1;
  for (const subscriber of subscribers) subscriber();
});

function safe_formatter_integer(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : fallback;
}

export function get_formatter_preferences(): FormatterPreferences {
  return { ...formatterPreferences };
}

export function get_popover_preferences(): PopoverPreferences {
  return { ...popoverPreferences };
}

export function get_supported_languages(): SupportedLanguageDescriptor[] {
  return supportedLanguages.map((language) => ({ ...language }));
}

export function get_content_language(): string {
  return contentLanguageStore.get();
}

export function get_kind_color_scheme(): 'light' | 'dark' {
  const scheme = documentRoot.dataset.snlColorScheme;
  return scheme === 'dark' || scheme === 'high-contrast' ? 'dark' : 'light';
}

export function set_content_language(language: string): void {
  const previous = contentLanguageStore.get();
  contentLanguageStore.set(language);
  if (contentLanguageStore.get() !== previous) {
    getVsCodeApi()?.postMessage({
      type: 'snl.content-language/changed',
      language: contentLanguageStore.get()
    });
  }
}

/**
 * Temporarily project the live reader into one export locale/theme combination.
 * This does not write Preferences or notify the host; the exporter restores the
 * original pair after harvesting every deterministic standalone variant.
 */
export function set_transient_export_preferences(
  language: string,
  colorScheme: string
): void {
  documentRoot.dataset.snlColorScheme = colorScheme;
  if (contentLanguageStore.get() !== language) {
    contentLanguageStore.set(language);
    return;
  }
  renderRevision += 1;
  for (const subscriber of subscribers) subscriber();
}

function effective_motion(value: string): string {
  if (value !== 'auto') return value;
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'reduced'
    : 'full';
}

documentRoot.dataset.snlMotion = effective_motion(configuredMotion);

export function create_webview_reader_runtime(
  _root: HTMLElement
): ReaderRuntime<LanguageEnvironment<string>> {
  return new ReaderRuntime({
    queries: {
      query_environment: () => ({ language: contentLanguageStore.get() })
    }
  });
}

export function create_webview_ui_reader_runtime(
  root: HTMLElement
): ReaderRuntime<LanguageEnvironment<string>> {
  return new ReaderRuntime({
    queries: { query_environment: () => ({ language: root.lang || 'en' }) }
  });
}

export function apply_preferences_snapshot(
  message: PreferencesSnapshotMessage
): boolean {
  if (!message.generation ||
      !Number.isSafeInteger(message.revision) ||
      message.revision < 0) return false;
  if (message.generation === hostGeneration && message.revision <= hostRevision) return false;
  if (message.generation !== hostGeneration) {
    hostGeneration = message.generation;
    hostRevision = -1;
  }
  hostRevision = message.revision;
  const root = documentRoot;
  root.lang = message.preferences.language || 'en';
  root.dataset.snlLanguagePreference = message.preferences.language_preference || 'auto';
  root.dataset.snlColorScheme = message.preferences.color_scheme;
  configuredMotion = message.preferences.motion;
  root.dataset.snlMotion = effective_motion(configuredMotion);
  formatterPreferences = {
    indentSpaces: safe_formatter_integer(
      message.preferences.formatter_indent_spaces,
      4,
      256
    ),
    inlineParenthesisDepth: safe_formatter_integer(
      message.preferences.formatter_inline_parenthesis_depth,
      3,
      Number.MAX_SAFE_INTEGER
    )
  };
  popoverPreferences = {
    hoverEnabled: message.preferences.popover_hover_enabled !== false
  };
  if (Array.isArray(message.supported_languages) && message.supported_languages.every(
    (language) => language && typeof language.id === 'string' &&
      typeof language.display_name === 'string'
  )) {
    supportedLanguages = message.supported_languages.map((language) => ({ ...language }));
  }
  renderRevision += 1;
  for (const subscriber of subscribers) subscriber();
  return true;
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

function get_revision(): number {
  return renderRevision;
}

/** Re-render a React consumer after a valid preference snapshot. */
export function use_preferences_revision(): number {
  return useSyncExternalStore(subscribe, get_revision, get_revision);
}

export function use_supported_languages(): readonly SupportedLanguageDescriptor[] {
  use_preferences_revision();
  return supportedLanguages;
}

export function use_content_language(): string {
  return useSyncExternalStore(
    contentLanguageStore.subscribe,
    contentLanguageStore.get,
    contentLanguageStore.get
  );
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const value = event.data;
    if (!value || typeof value !== 'object') return;
    const message = value as Partial<PreferencesSnapshotMessage>;
    if (
      message.type !== 'snl.preferences/snapshot' ||
      typeof message.generation !== 'string' ||
      typeof message.revision !== 'number' ||
      !message.preferences
    ) {
      return;
    }
    apply_preferences_snapshot(message as PreferencesSnapshotMessage);
  });
  if (typeof window.matchMedia === 'function') {
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener(
      'change',
      () => {
        if (configuredMotion !== 'auto') return;
        document.documentElement.dataset.snlMotion = effective_motion('auto');
        renderRevision += 1;
        for (const subscriber of subscribers) subscriber();
      }
    );
  }
  const api = getVsCodeApi();
  if (api) {
    installWorkspaceAssetBroker(api);
    api.postMessage({ type: 'snl.preferences/ready' });
  }
}

/** Shared runtime for all Entry/Macro rendering in this webview document. */
export const webview_language_runtime = create_webview_reader_runtime(
  documentRoot
);
export const webview_ui_language_runtime = create_webview_ui_reader_runtime(documentRoot);
