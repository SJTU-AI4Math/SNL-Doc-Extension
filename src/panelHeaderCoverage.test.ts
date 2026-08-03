import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8');

/** One React app can back multiple Vite entries (Entry/Macro kind init/edit). */
const PANEL_APPS = [
  'App.tsx',
  'EntryInfoviewApp.tsx',
  'CreateLibraryApp.tsx',
  'DashboardApp.tsx',
  'InitKindsApp.tsx',
  'KindEditorApp.tsx',
  'CreateEntryApp.tsx',
  'CreateMacroPackageApp.tsx',
  'PackagePanelApp.tsx',
  'CreateMacroApp.tsx',
  'CreateRelationshipApp.tsx',
  'SnlGraphApp.tsx',
  'SnooglApp.tsx',
  'ExportOptionsApp.tsx'
];

describe('shared panel header coverage', () => {
  it('routes every webview panel app through PanelHeader', () => {
    for (const app of PANEL_APPS) {
      const text = source(`webview/src/${app}`);
      expect(text, app).toContain('<PanelHeader');
      expect(text, `${app} must not grow a second page title outside the shared header`)
        .not.toContain('<h1');
    }
  });

  it('has no live imports of the deleted PanelNav implementation', () => {
    for (const app of PANEL_APPS) {
      expect(source(`webview/src/${app}`), app).not.toContain("./components/PanelNav");
    }
  });
});
