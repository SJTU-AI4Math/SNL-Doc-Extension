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

  it('configures the Infoview host to expose only the workspace asset root', () => {
    const host = readFileSync(
      new URL('../../../src/infoviewPanel.ts', import.meta.url),
      'utf8'
    );
    expect(host).toContain("vscode.Uri.joinPath(workspace, '.SNL_Doc', 'assets')");
    expect(host).toContain('localResourceRoots: infoviewLocalResourceRoots(extensionUri)');
    expect(host).toContain('assetBaseUri: this.assetBaseUri(root)');
  });
});
