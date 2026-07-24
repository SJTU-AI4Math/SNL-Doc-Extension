import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

describe('GUI Editor (Canvas) entry point', () => {
  it('is registered in the command palette and opens from the Dashboard', () => {
    const pkg = JSON.parse(read('../../../package.json')) as {
      contributes: { commands: Array<{ command: string; title: string }> };
    };
    expect(pkg.contributes.commands).toContainEqual({
      command: 'snlDoc.openGuiEditor',
      title: '%snlDoc.command.openGuiEditor%'
    });
    expect(read('../../../package.nls.json')).toContain(
      '"snlDoc.command.openGuiEditor": "SNL: Open GUI Editor (Canvas)"'
    );

    expect(read('../../../src/extension.ts')).toContain("'snlDoc.openGuiEditor'");
    expect(read('../../../src/dashboardPanel.ts')).toContain(
      "case 'openGuiEditor':"
    );
    expect(read('../DashboardApp.tsx')).toContain(
      "postMessage({ type: 'openGuiEditor' })"
    );
  });

  it('has a dedicated panel and Vite webview bundle', () => {
    expect(read('../../../src/guiEditorPanel.ts')).toContain("'guiEditor'");
    expect(read('../../vite.config.ts')).toContain("guiEditor: 'src/guiEditor.tsx'");
    expect(read('../../../package.json')).toContain('build:webview:guiEditor');
  });
});
