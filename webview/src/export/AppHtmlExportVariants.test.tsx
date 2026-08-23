// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { App, type OutlineNode } from '../App';
import type { EntryData, EntryKind } from '../render/EntryRender';
import { apply_preferences_snapshot } from '../runtime/preferencesRuntime';
import type { VsCodeApi } from '../vscodeApi';
import { buildExportDocument, EXPORT_BASE_CSS, EXPORT_WATERMARK_LOGO_PATH } from '../../../src/exportHtmlDocument';
import { rewriteBundledCss } from '../../../src/exportDocument';
import { buildExportPayloadScript } from '../../../src/exportPopoverPayload';
import { EXPORT_RUNTIME_CSS } from '../../../src/exportRuntime';

const postMessage = vi.fn();
const api: VsCodeApi = { postMessage, getState: () => undefined, setState: () => undefined };

const parentEntry: EntryData = {
  id: 'entry-parent',
  kind: 'definition',
  title: { type: 'i18n' as const, default_language: 'en', values: { en: 'Parent Entry', 'zh-CN': '父条目' } },
  content: { snl: 'Right(Ref(x), Ref(y))' },
  contribution_info: null,
  pointer: null
};
const childEntry: EntryData = {
  id: 'child',
  kind: 'definition',
  title: { type: 'i18n' as const, default_language: 'en', values: { en: 'Child Entry', 'zh-CN': '子条目' } },
  content: {
    text: { type: 'i18n' as const, default_language: 'en', values: { en: 'English child body', 'zh-CN': '中文子条目正文' } }
  },
  contribution_info: null,
  pointer: null
};
const formulaEntry: EntryData = {
  id: 'formula-child',
  kind: 'definition',
  title: 'Formula child',
  content: { snl: 'Ref(z)' },
  contribution_info: null,
  pointer: null
};

const kind: EntryKind = {
  id: 'definition',
  name: { type: 'i18n' as const, default_language: 'en', values: { en: 'Definition', 'zh-CN': '定义' } },
  coloring: {
    light: { stroke: '#123456', background: '#edf4ff' },
    dark: { stroke: '#fedcba', background: '#1a2433' }
  },
  style: 'default'
};
const outline: OutlineNode[] = [{
  nodeId: 'parent-node', entry: parentEntry, kind, counterLabel: '1', children: [{
    nodeId: 'child-node', entry: childEntry, kind, counterLabel: '1.1', children: []
  }, {
    nodeId: 'formula-node', entry: formulaEntry, kind, counterLabel: '1.2', children: []
  }]
}];

function writeBrowserFixture(payload: any): void {
  const output = process.env.SNL_EXPORT_FIXTURE_DIR;
  if (!output) return;
  const repo = resolve(__dirname, '../../..');
  const media = resolve(repo, 'media/webview');
  const rawCss = readFileSync(resolve(media, 'main.css'), 'utf8');
  const rewritten = rewriteBundledCss(rawCss);
  const runtime = readFileSync(resolve(repo, 'media/exportRuntime.js'), 'utf8');
  const payloadScript = buildExportPayloadScript(payload.popovers, payload.variants);
  const html = buildExportDocument({
    title: payload.title,
    subtitle: payload.subtitle,
    locale: payload.locale,
    colorScheme: payload.variants.initialColorScheme,
    css: [EXPORT_BASE_CSS, EXPORT_RUNTIME_CSS, rewritten.css].join('\n'),
    body: payload.body,
    scriptSources: ['popovers.js'],
    script: runtime
  });
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'index.html'), html);
  writeFileSync(resolve(output, 'popovers.js'), payloadScript);
  for (const font of rewritten.fontFiles) {
    const target = resolve(output, font.exportPath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(media, font.bundleName), target);
  }
  const logoTarget = resolve(output, EXPORT_WATERMARK_LOGO_PATH);
  mkdirSync(dirname(logoTarget), { recursive: true });
  copyFileSync(resolve(repo, 'media/icons/logoCSS_black.svg'), logoTarget);
}

afterEach(() => {
  cleanup();
  postMessage.mockReset();
  delete (globalThis as { __snlApi?: VsCodeApi }).__snlApi;
});

describe('Infoview HTML export variants', () => {
  it('captures every supported content language and theme, including real popover bodies', async () => {
    (globalThis as { __snlApi?: VsCodeApi }).__snlApi = api;
    apply_preferences_snapshot({
      type: 'snl.preferences/snapshot',
      generation: `export-variants-${Date.now()}`,
      revision: 1,
      preferences: { language: 'en', color_scheme: 'high-contrast-light', motion: 'full' },
      supported_languages: [
        { id: 'en', display_name: 'English' },
        { id: 'zh-CN', display_name: '简体中文' }
      ]
    });
    render(<App />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'libraryEntries',
      slug: 'demo',
      title: 'Demo',
      entries: [
        { id: 'entry-parent', title: parentEntry.title, hasContent: true, snl: 'Right(Ref(x), Ref(y))' },
        { id: 'child', title: childEntry.title, hasContent: true, snl: '@x' },
        { id: 'formula-child', title: formulaEntry.title, hasContent: true, snl: 'Ref(z)' },
        { id: 'outside', title: 'Outside Library', hasContent: true }
      ],
      entryRecords: [parentEntry, childEntry, formulaEntry],
      entryKinds: [kind],
      relationships: [{
        id: 'rel-1', from: 'entry-parent', to: 'child', label: 'uses_context', metadata: null
      }],
      macros: {
        Ref: {
          name: 'Ref', description: 'Entry reference',
          source: { entries: ['outside'], urls: [] },
          kind: 'const', dynamic_arity: false, tags: [],
          styles: [{
            style_name: 'default', tags: [],
            template: { mode: 'formula_inline', body: '#0' }
          }]
        },
        Right: {
          name: 'Right', description: 'Right-aligned block',
          source: { entries: [], urls: [] },
          kind: 'const', dynamic_arity: true, tags: [],
          styles: [{
            style_name: 'default', tags: [],
            template: { mode: 'block', body: '#*', block_template_name: 'right' }
          }]
        }
      },
      outline
    } })));
    postMessage.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Export HTML' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export HTML' }));
    await waitFor(() => {
      expect(postMessage.mock.calls.some(([message]) => message?.type === 'exportLibraryHtml')).toBe(true);
    }, { timeout: 8000 });

    const payload = postMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message?.type === 'exportLibraryHtml');
    expect(payload.variants.initialLocale).toBe('en');
    expect(payload.variants.initialColorScheme).toBe('light');
    expect(payload.variants.variants).toHaveLength(4);
    expect(payload.variants.relationships).toEqual([{
      id: 'rel-1', from: 'entry-parent', to: 'child', label: 'uses_context', metadata: null
    }]);
    const byKey = new Map(payload.variants.variants.map((variant: { locale: string; colorScheme: string }) => [
      `${variant.locale}:${variant.colorScheme}`, variant
    ]));
    expect((byKey.get('en:light') as { body: string }).body).toContain('Parent Entry');
    for (const variant of byKey.values() as Iterable<{ body: string }>) {
      expect(variant.body).toContain('snl-block-right');
      expect(variant.body).toMatch(/text-align:\s*right/);
    }
    expect((byKey.get('en:light') as { body: string }).body).toContain('data-src="outside"');
    expect((byKey.get('en:light') as { body: string }).body)
      .toContain('data-snl-keyboard-activation="true"');
    expect((byKey.get('zh-CN:light') as { body: string }).body).toContain('父条目');
    expect((byKey.get('en:light') as { body: string }).body).toContain('rgb(237, 244, 255)');
    expect((byKey.get('en:light') as { body: string }).body).toMatch(/--snl-entry-stroke:\s*rgb\(18, 52, 86\)/);
    expect((byKey.get('en:dark') as { body: string }).body).toContain('rgb(26, 36, 51)');
    expect((byKey.get('en:light') as { popovers: Record<string, string> }).popovers.child)
      .toContain('English child body');
    expect((byKey.get('zh-CN:dark') as { popovers: Record<string, string> }).popovers.child)
      .toContain('中文子条目正文');
    expect((byKey.get('en:light') as { popovers: Record<string, string> }).popovers.outside)
      .toBeUndefined();

    expect(postMessage.mock.calls.some(([message]) => message?.type === 'requestEntryDetails')).toBe(false);
    expect(postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message?.type === 'snl.content-language/changed')).toEqual([]);
    expect(postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message?.type === 'exportLibraryHtml')).toHaveLength(1);
    expect(document.documentElement.dataset.snlColorScheme).toBe('high-contrast-light');
    writeBrowserFixture(payload);
  });
});
