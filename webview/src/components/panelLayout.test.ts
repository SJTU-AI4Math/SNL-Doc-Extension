import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PANEL_STYLE } from '../vscodeApi';

const repo = path.resolve(__dirname, '../../..');
const webviewRoot = path.join(repo, 'webview/src');
const apps = fs.readdirSync(webviewRoot)
  .filter((file) => file.endsWith('App.tsx'))
  .filter((file) => fs.readFileSync(path.join(webviewRoot, file), 'utf8').includes('<main'));

describe('responsive full-width panel layout', () => {
  it('makes the shared panel surface fill the available webview width', () => {
    expect(PANEL_STYLE).toMatchObject({
      width: '100%',
      maxWidth: 'none',
      minWidth: 0,
      boxSizing: 'border-box'
    });
  });

  it('does not reintroduce max-width constraints on page-level main elements', () => {
    for (const file of apps) {
      const source = fs.readFileSync(path.join(webviewRoot, file), 'utf8');
      expect(source, file).not.toMatch(/<main\b[^>]*maxWidth/s);
    }
  });

  it('defines shared narrow and wide panel adaptations', () => {
    const css = fs.readFileSync(
      path.join(repo, 'webview/src/components/ui.css'),
      'utf8'
    );
    expect(css).toContain('container-type:inline-size');
    expect(css).toContain('.snl-responsive-grid--macro-header');
    expect(css).toContain('.snl-responsive-grid--two');
    expect(css).toContain('.snl-responsive-row');
    expect(css).toContain('.snl-responsive-sidebar-layout');
    expect(css).toContain('@container');
  });

  it('removes scrolling from the GUI Editor Canvas surface and blocks', () => {
    const source = fs.readFileSync(
      path.join(repo, 'webview/src/CreateEntryApp.tsx'),
      'utf8'
    );
    const canvasStart = source.lastIndexOf('data-entry-gui-canvas');
    const canvasEnd = source.indexOf('// GUI Editor (Inductive)', canvasStart);
    const canvas = source.slice(canvasStart, canvasEnd);
    expect(canvas).toContain("overflow: 'visible'");
    expect(canvas).not.toContain("overflow: 'auto'");
    expect(canvas).not.toContain("overflowX: 'auto'");
    expect(canvas).not.toContain("width: '1800px'");
    expect(canvas).not.toContain("height: '1100px'");
  });
});
