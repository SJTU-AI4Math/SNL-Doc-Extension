import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('preference plumbing architecture', () => {
  it('initializes one host and registers every buildPanelHtml webview', () => {
    expect(source('src/extension.ts')).toContain('initialize_preferences_host(context)');
    expect(source('src/panelUtil.ts')).toContain('register_preferences_webview(webview)');
    expect(source('src/preferencesHost.ts')).toContain("snl.preferences/ready");
    expect(source('src/preferencesHost.ts')).toContain("inspect<string>('locale')");
    expect(source('src/preferencesHost.ts')).toContain('showErrorMessage(message)');
    expect(source('src/panelUtil.ts')).toContain('ownerDisposables?.push(preferencesDisposable)');
    expect(source('src/preferencesHost.ts')).toContain('WeakRef<vscode.Webview>');
    expect(source('webview/src/runtime/preferencesRuntime.ts')).toContain("snl.preferences/ready");
    expect(source('webview/src/DashboardApp.tsx')).toContain('use_preferences_revision');
  });

  it('has visible consumers for theme and reduced motion', () => {
    const css = source('webview/src/components/ui.css');
    expect(css).toContain("data-snl-color-scheme='light'");
    expect(css).toContain("data-snl-color-scheme='high-contrast'");
    expect(css).toContain("data-snl-motion='reduced'");
  });

  it('remounts asynchronous SNL renderers after a preference revision', () => {
    expect(source('webview/src/render/EntryRender.tsx')).toContain('key={`preferences-${preferencesRevision}`}');
    expect(source('webview/src/PackagePanelApp.tsx')).toContain('key={`preferences-${preferencesRevision}`}');
    expect(source('webview/src/CreateMacroApp.tsx')).toContain('preferencesRevision');
  });

  it('routes UI/content localization through the Basics Reader runtime', () => {
    expect(source('src/preferences.ts')).toContain('new ReaderRuntime<ExtensionPreferences>');
    expect(source('webview/src/runtime/preferencesRuntime.ts')).toContain('new ReaderRuntime');
    expect(source('webview/src/runtime/useLocalized.ts')).toContain('read_localized');
    expect(source('webview/src/render/EntryRender.tsx')).toContain('<BasicsEntrySurface');
    expect(source('webview/src/render/EntryRender.tsx')).toContain(
      'reader_runtime={webview_language_runtime}'
    );
  });
});
