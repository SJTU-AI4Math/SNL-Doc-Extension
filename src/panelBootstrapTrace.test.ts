import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  RelativePattern: class {},
  // fsPath matters: buildPanelHtml uses existsSync(cssPath.fsPath) to decide
  // whether to emit the <link>. Without it the stylesheet vanished and every
  // ordering assertion here passed vacuously.
  Uri: {
    joinPath: (b: { path: string; fsPath?: string }, ...p: string[]) => ({
      path: [b.path, ...p].join('/'),
      fsPath: [b.fsPath ?? b.path, ...p].join('/')
    })
  },
  workspace: {
    workspaceFolders: undefined,
    createFileSystemWatcher: () => undefined,
    getConfiguration: () => ({ get: () => undefined })
  },
  window: {
    createOutputChannel: () => undefined,
    activeColorTheme: { kind: 2 },
    onDidChangeActiveColorTheme: () => ({ dispose: () => undefined })
  },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  env: { language: 'en' }
}));

/**
 * The panel HTML carries an inline bootstrap script whose only job is to
 * split "VS Code standing the webview up" from "fetching and parsing our
 * bundle". Cat's first trace showed 1147ms before our bundle's first line
 * ran, and without a mark ahead of the bundle there is no way to tell which
 * half that is. Cat 2026-07-25.
 */
import { resolve } from 'node:path';
import { buildPanelHtml } from './panelUtil';

// Use the real repo root: `buildPanelHtml` only emits the <link> when the
// built CSS exists on disk, so a fake path silently produced a stylesheet-less
// document and every ordering assertion below passed vacuously.
const EXT_ROOT = resolve(__dirname, '..');

function html(): string {
  const webview = {
    asWebviewUri: (uri: { path: string }) => ({ toString: () => `vscode-webview://${uri.path}` }),
    cspSource: 'vscode-webview://test'
  };
  return buildPanelHtml(
    { path: EXT_ROOT, fsPath: EXT_ROOT } as never,
    webview as never,
    'createEntry',
    'SNL Create Entry'
  );
}

describe('panel bootstrap tracing', () => {
  it('marks the very start of the document, above the stylesheet', () => {
    const out = html();
    const headStart = out.indexOf("__snlMark('head-start')") >= 0
      ? out.indexOf("__snlMark('head-start')")
      : out.indexOf("mark('head-start')");
    const css = out.indexOf('rel="stylesheet"');
    const bundle = out.indexOf('createEntry.js');
    expect(headStart).toBeGreaterThan(-1);
    expect(bundle).toBeGreaterThan(-1);
    // A render-blocking <link> delays everything after it, so a probe below
    // the stylesheet would bill CSS wait time to "webview host boot".
    // FIRST stylesheet: nothing render-blocking may precede the probe.
    if (css > -1) expect(headStart).toBeLessThan(css);
    expect(headStart).toBeLessThan(bundle);
  });

  it('brackets the stylesheet so its cost is attributable', () => {
    const out = html();
    const css = out.indexOf('rel="stylesheet"');
    const cssLoaded = out.indexOf("__snlMark('css-loaded')");
    expect(cssLoaded).toBeGreaterThan(-1);
    // The mark must sit AFTER the link (or it measures nothing) and BEFORE
    // the bundle (or it is billing bundle time to CSS).
    if (css > -1) expect(cssLoaded).toBeGreaterThan(css);
    expect(cssLoaded).toBeLessThan(out.indexOf('createEntry.js'));
  });

  it('still marks the point just before the bundle request', () => {
    const out = html();
    expect(out.indexOf("__snlMark('document-start')")).toBeGreaterThan(-1);
    expect(out.indexOf("__snlMark('document-start')")).toBeLessThan(out.indexOf('createEntry.js'));
  });

  it('reports a dom-ready mark too', () => {
    expect(html()).toContain('dom-ready');
  });

  it('acquires the api once and shares it with the bundle', () => {
    const out = html();
    // A second acquireVsCodeApi() call throws, so the bundle must reuse this
    // handle rather than acquiring its own.
    expect(out.match(/acquireVsCodeApi\(\)/g)?.length).toBe(1);
    expect(out).toContain('__snlApi');
  });

  it('runs the bootstrap under the CSP nonce', () => {
    const out = html();
    const nonce = out.match(/nonce-([A-Za-z0-9]+)/)?.[1];
    expect(nonce).toBeTruthy();
    // Every inline/### script must carry the nonce or CSP blocks it.
    for (const tag of out.match(/<script[^>]*>/g) ?? []) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
  });

  it('never lets tracing break the panel', () => {
    // The bootstrap is wrapped so a missing API cannot abort document parse.
    expect(html()).toMatch(/try\s*\{[\s\S]*acquireVsCodeApi[\s\S]*\}\s*catch/);
  });
});
