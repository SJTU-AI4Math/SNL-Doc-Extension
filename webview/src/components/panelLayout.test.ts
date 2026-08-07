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

  it('keeps the narrow header language menu right-aligned and viewport-clamped', () => {
    const css = fs.readFileSync(
      path.join(repo, 'webview/src/components/ui.css'),
      'utf8'
    );
    const narrowStart = css.indexOf('@container (max-width:28rem)');
    const narrowEnd = css.indexOf('.snl-empty-action', narrowStart);
    const narrow = css.slice(narrowStart, narrowEnd);
    expect(narrow).toContain('.snl-panel-header__language-menu { left:auto; right:0;');
    expect(narrow).not.toContain('left:0; right:auto');
    expect(css).toContain('max-width:calc(100vw - 1rem)');
  });

  it('renders the shared header logo at the enlarged compact size', () => {
    const css = fs.readFileSync(
      path.join(repo, 'webview/src/components/ui.css'),
      'utf8'
    );
    const rules = [...css.matchAll(/\.snl-panel-header__logo\s*\{([^{}]*)\}/g)];
    expect(rules).toHaveLength(1);
    const declarations = new Map(
      rules[0][1].split(';').map((item) => item.trim()).filter(Boolean).map((item) => {
        const separator = item.indexOf(':');
        return [item.slice(0, separator).trim(), item.slice(separator + 1).trim()];
      })
    );
    expect(declarations.get('width')).toBe('2rem');
    expect(declarations.get('height')).toBe('2rem');
  });

  it('contains Entry preview errors instead of letting long source widen the editor', () => {
    const source = fs.readFileSync(
      path.join(repo, 'webview/src/CreateEntryApp.tsx'),
      'utf8'
    );
    const css = fs.readFileSync(
      path.join(repo, 'webview/src/components/ui.css'),
      'utf8'
    );
    expect(source).toContain('snl-entry-live-preview');
    expect(css).toContain('.snl-entry-live-preview {');
    expect(css).toContain('.snl-entry-live-preview .snl-entry-error');
    expect(css).toContain('.snl-entry-live-preview .snl-entry-error + pre');
    expect(css).toContain('white-space:pre-wrap');
    expect(css).toContain('overflow-wrap:anywhere');
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
