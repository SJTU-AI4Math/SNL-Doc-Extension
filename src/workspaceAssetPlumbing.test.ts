import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('workspace image broker plumbing', () => {
  it('registers the trusted cache broker and grants its cache root to renderer panels', () => {
    const panelUtil = source('src/panelUtil.ts');
    expect(panelUtil).toContain('cacheWorkspaceAsset({');
    expect(panelUtil).toContain('get_preferences_asset_cache_root()');
    expect(panelUtil).toContain('workspaceRoot && assetCacheRoot ? {');
    expect(panelUtil).toContain('roots.push(assetCacheRoot)');
    expect(panelUtil).not.toContain(
      "roots.push(vscode.Uri.joinPath(workspaceRoot, '.SNL_Doc', 'assets'))"
    );
    expect(panelUtil).not.toContain(
      "webview.asWebviewUri(vscode.Uri.joinPath(workspaceRoot, '.SNL_Doc', 'assets'))"
    );
  });

  it.each([
    'src/dashboardPanel.ts',
    'src/graphPanel.ts',
    'src/infoviewPanel.ts',
    'src/createEntryPanel.ts',
    'src/createMacroPanel.ts',
    'src/packagePanel.ts'
  ])('%s grants the shared renderer resource roots', (path) => {
    expect(source(path)).toContain('webviewLocalResourceRoots(extensionUri)');
  });
});
