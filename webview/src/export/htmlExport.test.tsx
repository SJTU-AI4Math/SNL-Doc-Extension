import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { harvestLibraryHtml } from './htmlExport';
import { EntrySurface } from '../render/EntrySurface';
import { HoverPopoverProvider } from '../render/HoverPopoverProvider';
import { resolveMarkdownAssetUrl } from '../render/markdownAssets';

const BASE = 'vscode-webview://abc/ws/.SNL_Doc/assets';

function el(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

describe('harvestLibraryHtml', () => {
  it('rewrites workspace asset images to export-relative paths', () => {
    const { html, assets } = harvestLibraryHtml(
      el(`<p><img src="${BASE}/Dashboard-Panel.png"></p>`),
      BASE
    );
    expect(html).toContain('src="assets/Dashboard-Panel.png"');
    expect(html).not.toContain('vscode-webview:');
    expect(assets).toEqual([
      { path: 'assets/Dashboard-Panel.png', sourceUrl: `${BASE}/Dashboard-Panel.png` }
    ]);
  });

  it('deduplicates an asset used by several entries', () => {
    const { assets } = harvestLibraryHtml(
      el(`<img src="${BASE}/a.png"><img src="${BASE}/a.png"><img src="${BASE}/b.png">`),
      BASE
    );
    expect(assets.map((a) => a.path)).toEqual(['assets/a.png', 'assets/b.png']);
  });

  it('leaves external and data images alone', () => {
    const { html, assets } = harvestLibraryHtml(
      el('<img src="https://example.com/x.png"><img src="data:image/png;base64,AA">'),
      BASE
    );
    expect(html).toContain('https://example.com/x.png');
    expect(html).toContain('data:image/png;base64,AA');
    expect(assets).toEqual([]);
  });

  it('refuses to emit an asset path that escapes the export root', () => {
    const { html, assets } = harvestLibraryHtml(
      el(`<img src="${BASE}/../../etc/passwd">`),
      BASE
    );
    expect(assets).toEqual([]);
    expect(html).not.toContain('assets/../');
    expect(html).not.toContain('vscode-webview:');
    expect(html).toContain('data-export-unresolved');
  });

  it('strips interactive controls that do nothing in a static file', () => {
    const { html } = harvestLibraryHtml(
      el('<section><button>Edit</button><span>keep</span></section>'),
      BASE
    );
    expect(html).not.toContain('<button');
    expect(html).toContain('keep');
  });

  it('does not mutate the live DOM it harvests from', () => {
    const source = el(`<img src="${BASE}/a.png"><button>Edit</button>`);
    harvestLibraryHtml(source, BASE);
    expect(source.querySelector('button')).not.toBeNull();
    expect(source.querySelector('img')?.getAttribute('src')).toBe(`${BASE}/a.png`);
  });
});

describe('end-to-end: a real rendered Entry survives export', () => {
  // Unmount between cases: React 19 schedules work through a macrotask, and a
  // tree still mounted at teardown wakes up after jsdom's `window` is gone.
  afterEach(cleanup);

  function renderEntry(entry: unknown, extra: Record<string, unknown> = {}) {
    return render(
      React.createElement(
        HoverPopoverProvider as never,
        { postMessage: () => {}, entries: [] } as never,
        React.createElement(EntrySurface as never, {
          entry,
          kind: null,
          entries: [],
          postMessage: () => {},
          userMacros: {},
          kindPalette: undefined,
          ...extra
        } as never)
      )
    );
  }

  it('carries a Markdown image Entry through to a portable document', () => {
    const { container } = renderEntry(
      {
        id: 'ui.panel.dashboard.img',
        kind: 'img',
        title: 'Dashboard Image',
        content: { markdown: '![](assets/Dashboard-Panel.png)' },
        contribution_info: null,
        pointer: null
      },
      {
        markdownImageUrlTransform: (s: string) => resolveMarkdownAssetUrl(s, BASE)
      }
    );

    const { html, assets } = harvestLibraryHtml(container, BASE);
    expect(assets).toEqual([
      { path: 'assets/Dashboard-Panel.png', sourceUrl: `${BASE}/Dashboard-Panel.png` }
    ]);

    expect(html).toContain('src="assets/Dashboard-Panel.png"');
    expect(html).not.toContain('vscode-webview:');
  });

  it('keeps inline Entry card styling so the export needs no card CSS', () => {
    const { container } = renderEntry({
      id: 'x',
      kind: 'k',
      title: 'Hello',
      content: { snl: 'foo(a,b)' },
      contribution_info: null,
      pointer: null
    });
    const { html } = harvestLibraryHtml(container, BASE);
    expect(html).toContain('data-entry-id="x"');
    expect(html).toContain('border-left');
  });
});
