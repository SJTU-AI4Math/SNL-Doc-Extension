import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveMarkdownAssetUrl } from './markdownAssets';

const base = 'vscode-webview://panel/.SNL_Doc/assets';

describe('resolveMarkdownAssetUrl', () => {
  it('maps supported Markdown paths into the workspace asset root', () => {
    expect(resolveMarkdownAssetUrl('assets/proof.png', base)).toBe(`${base}/proof.png`);
    expect(resolveMarkdownAssetUrl('.SNL_Doc/assets/plots/a b.png', base)).toBe(
      `${base}/plots/a%20b.png`
    );
    expect(resolveMarkdownAssetUrl('./diagram.png', base)).toBe(`${base}/diagram.png`);
  });

  it('preserves embedded and absolute URLs and rejects traversal', () => {
    expect(resolveMarkdownAssetUrl('data:image/png;base64,abc', base)).toBe(
      'data:image/png;base64,abc'
    );
    expect(resolveMarkdownAssetUrl('https://example.test/a.png', base)).toBe(
      'https://example.test/a.png'
    );
    expect(resolveMarkdownAssetUrl('../secret.png', base)).toBe('../secret.png');
  });

  it('configures the Infoview host with shared Markdown and brokered-image roots', () => {
    const host = readFileSync(
      new URL('../../../src/infoviewPanel.ts', import.meta.url),
      'utf8'
    );
    const panelUtil = readFileSync(
      new URL('../../../src/panelUtil.ts', import.meta.url),
      'utf8'
    );
    const runtime = readFileSync(
      new URL('../runtime/preferencesRuntime.ts', import.meta.url),
      'utf8'
    );
    expect(panelUtil).not.toContain(
      "roots.push(vscode.Uri.joinPath(workspaceRoot, '.SNL_Doc', 'assets'))"
    );
    expect(panelUtil).toContain('roots.push(assetCacheRoot)');
    expect(runtime).toContain('installWorkspaceAssetBroker(api)');
    expect(host).toContain('localResourceRoots: webviewLocalResourceRoots(extensionUri)');
    expect(host).toContain('assetBaseUri: this.assetBaseUri(root)');
  });
});
