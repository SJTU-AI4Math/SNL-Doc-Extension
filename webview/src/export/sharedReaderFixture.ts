import { createElement } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { vi } from 'vitest';
import { BrowserReader } from '../reader/BrowserReader';
import { getReaderPlatformApi, setReaderPlatformApi } from '../runtime/readerPlatform';
import { apply_preferences_snapshot, set_content_language } from '../runtime/preferencesRuntime';
import type { FrozenReaderSnapshot, FrozenOutlineNode } from '../../../src/sharedReaderSnapshot';

type Entry = FrozenReaderSnapshot['entries'][number];
export const localized = (en: string, zh: string) => ({ type: 'i18n' as const, default_language: 'en', values: { en, 'zh-CN': zh } });
export const entry = (id: string, snl?: string): Entry => ({
  id, kind: 'definition', title: localized(id, '中文' + id), content: snl === undefined ? { text: localized('Body of ' + id, '正文' + id) } : { snl }, contribution_info: null, pointer: null
});
export const node = (nodeId: string, value: Entry | null, children: FrozenOutlineNode[] = []): FrozenOutlineNode => ({
  nodeId, entry: value, kind: value ? kind : null, children, counterLabel: null
});
const kind: FrozenReaderSnapshot['entryKinds'][number] = {
  id: 'definition', defaultCounterName: 'definition', name: localized('Definition', '定义'), style: 'default',
  coloring: { light: { stroke: '#123456', background: '#edf4ff' }, dark: { stroke: '#fedcba', background: '#1a2433' } }
};
const macro = (name: string, sources: string[], block = false): FrozenReaderSnapshot['macros'][string] => ({
  name, description: name, source: { entries: sources, urls: [] }, kind: 'const', dynamic_arity: block, tags: [],
  styles: [{ style_name: 'default', tags: [], template: block
    ? { mode: 'block', body: '#*', separator: '', block_template_name: 'collapsible' }
    : { mode: 'formula_inline', body: '#0' } }]
});
let generation = 0;
export function snapshot(overrides: Partial<FrozenReaderSnapshot> = {}): FrozenReaderSnapshot {
  const root = entry('root', 'Ref(x)');
  const a = entry('entry-a', 'Next(y)');
  const b = entry('entry-b');
  return {
    version: 1, renderSnapshotId: `reader-test-${++generation}`,
    library: { slug: 'demo', title: 'Frozen Library', outline: [node('root-node', root)], warnings: [] },
    entries: [root, a, b], entryKinds: [kind], entryPackages: {},
    macros: { Ref: macro('Ref', ['entry-a']), Next: macro('Next', ['entry-b']), Fold: macro('Fold', [], true), Group: { ...macro('Group', [], true), styles: [{ style_name: 'default', tags: [], template: { mode: 'block', body: '#*' } }] } },
    macroKinds: [], relationships: [], resources: {}, contentLanguage: 'en',
    preferences: { language: 'en', color_scheme: 'light', motion: 'full', popover_hover_enabled: true },
    languages: [{ id: 'en', display_name: 'English' }, { id: 'zh-CN', display_name: '简体中文' }],
    ...overrides
  };
}
let originalHitTest: PropertyDescriptor | undefined;
let hitStack: Element[] = [];
// Explicit jsdom layout seam: only hit-testing is supplied. The semantic tree,
// activation leases, highlight driver, timers, and popovers are all production.
export function move(target: Element, x = 0, y = 0): void {
  hitStack = [target];
  fireEvent.mouseMove(target, { clientX: x, clientY: y });
}
let previousApi: ReturnType<typeof getReaderPlatformApi>;
let previousAttributes: Array<[string, string]>;
export function setupReader(): void {
  originalHitTest = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint');
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => hitStack });
  hitStack = [];
  previousApi = getReaderPlatformApi();
  previousAttributes = Array.from(document.documentElement.attributes, a => [a.name, a.value]);
  localStorage.clear();
  history.replaceState(null, '', '#/library');
  apply_preferences_snapshot({ type: 'snl.preferences/snapshot', generation: `setup-${++generation}`, revision: 1,
    preferences: { language: 'en', color_scheme: 'light', motion: 'full', popover_hover_enabled: true },
    supported_languages: [{ id: 'en', display_name: 'English' }, { id: 'zh-CN', display_name: '简体中文' }] });
  set_content_language('en');
}
export function cleanupReader(): void {
  cleanup();
  if (originalHitTest) Object.defineProperty(document, 'elementsFromPoint', originalHitTest);
  else Reflect.deleteProperty(document, 'elementsFromPoint');
  // The production port is module-global; restore its pre-test value, including absence.
  setReaderPlatformApi(previousApi as Parameters<typeof setReaderPlatformApi>[0]);
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  history.replaceState(null, '', '#/library');
  for (const a of Array.from(document.documentElement.attributes)) document.documentElement.removeAttribute(a.name);
  for (const [name, value] of previousAttributes) document.documentElement.setAttribute(name, value);
  delete (window as unknown as Record<string, unknown>).__snlSources;
}
export const mountReader = (value = snapshot(), hash = '#/library') => {
  history.replaceState(null, '', hash);
  return render(createElement(BrowserReader, { snapshot: value }));
};
export function navigate(hash: string, event: 'hashchange' | 'popstate' = 'hashchange'): void {
  act(() => { history.replaceState(null, '', hash); window.dispatchEvent(new Event(event)); });
}
export const advance = async (milliseconds: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); }); };
export function semantic(scope: ParentNode, source: string): HTMLElement {
  // Macro source metadata is held by Basics' data driver, not duplicated on live DOM.
  const macroName = source === 'entry-a' ? 'Ref' : source === 'entry-b' ? 'Next' : source;
  const result = scope.querySelector<HTMLElement>(`[data-src="${source}"][data-tree-path], [data-name="${macroName}"][data-tree-path][role="button"]`);
  if (!result) throw new Error(`Actual Basics semantic source ${source} not rendered`);
  return result;
}
export const panels = () => Array.from(document.querySelectorAll<HTMLElement>('.snl-entry-hover-popover'));
