import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  RelativePattern: class {},
  Uri: { joinPath: (b: { path: string }, ...p: string[]) => ({ path: [b.path, ...p].join('/') }) },
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
import { buildPanelHtml } from './panelUtil';

function html(): string {
  const webview = {
    asWebviewUri: (uri: { path: string }) => ({ toString: () => `vscode-webview://${uri.path}` }),
    cspSource: 'vscode-webview://test'
  };
  return buildPanelHtml(
    { path: '/ext', fsPath: '/ext' } as never,
    webview as never,
    'createEntry',
    'SNL Create Entry'
  );
}

describe('panel bootstrap tracing', () => {
  it('emits a mark before the bundle script tag', () => {
    const out = html();
    const bootstrap = out.indexOf('document-start');
    const bundle = out.indexOf('createEntry.js');
    expect(bootstrap).toBeGreaterThan(-1);
    expect(bundle).toBeGreaterThan(-1);
    // The whole point: this mark must land BEFORE the bundle is requested.
    expect(bootstrap).toBeLessThan(bundle);
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
