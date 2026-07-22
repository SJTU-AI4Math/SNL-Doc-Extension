import { useSyncExternalStore } from 'react';
import { getVsCodeApi } from '../vscodeApi';
import {
  ReaderRuntime,
  type LanguageEnvironment
} from '@snl-basics/react';

interface WebviewPreferences {
  language: string;
  color_scheme: string;
  motion: string;
}

export interface PreferencesSnapshotMessage {
  type: 'snl.preferences/snapshot';
  revision: number;
  preferences: WebviewPreferences;
}

let hostRevision = -1;
let renderRevision = 0;
const documentRoot = typeof document !== 'undefined'
  ? document.documentElement
  : ({ lang: 'en', dataset: {} } as unknown as HTMLElement);
let configuredMotion = documentRoot.dataset.snlMotion || 'auto';
const subscribers = new Set<() => void>();

function effective_motion(value: string): string {
  if (value !== 'auto') return value;
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'reduced'
    : 'full';
}

documentRoot.dataset.snlMotion = effective_motion(configuredMotion);

export function create_webview_reader_runtime(
  root: HTMLElement
): ReaderRuntime<LanguageEnvironment<string>> {
  return new ReaderRuntime({
    queries: {
      query_environment: () => ({ language: root.lang || 'en' })
    }
  });
}

export function apply_preferences_snapshot(
  message: PreferencesSnapshotMessage
): boolean {
  if (message.revision <= hostRevision) return false;
  hostRevision = message.revision;
  const root = documentRoot;
  root.lang = message.preferences.language || 'en';
  root.dataset.snlColorScheme = message.preferences.color_scheme;
  configuredMotion = message.preferences.motion;
  root.dataset.snlMotion = effective_motion(configuredMotion);
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

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const value = event.data;
    if (!value || typeof value !== 'object') return;
    const message = value as Partial<PreferencesSnapshotMessage>;
    if (
      message.type !== 'snl.preferences/snapshot' ||
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
  getVsCodeApi()?.postMessage({ type: 'snl.preferences/ready' });
}

/** Shared runtime for all Entry/Macro rendering in this webview document. */
export const webview_language_runtime = create_webview_reader_runtime(
  documentRoot
);
