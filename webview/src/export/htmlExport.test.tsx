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
  it('projects macro Entry sources onto constants for static popovers', () => {
    const { html } = harvestLibraryHtml(
      el('<span data-name="Set" data-kind="const">Set</span><span data-name="T" data-kind="bvar" data-src="ctx-t">T</span>'),
      BASE,
      {
        Set: {
          name: 'Set',
          description: 'sets',
          source: { entries: ['def-set'], urls: [] },
          kind: 'const',
          dynamic_arity: false,
          tags: [],
          styles: [{ style_name: 'default', tags: [], template: { mode: 'formula_inline', body: 'Set(#0)' } }]
        },
        T: {
          name: 'T',
          description: 'must not override a context-resolved source',
          source: { entries: ['wrong'], urls: [] },
          kind: 'fvar',
          dynamic_arity: false,
          tags: [],
          styles: [{ style_name: 'default', tags: [], template: { mode: 'formula_inline', body: '#0' } }]
        }
      }
    );
    expect(html).toContain('data-name="Set" data-kind="const" data-src="def-set"');
    expect(html).toContain('data-name="T" data-kind="bvar" data-src="ctx-t"');
    expect(html).not.toContain('data-src="wrong"');
  });

  it('decodes percent-encoded workspace filenames for filesystem export', () => {
    const { html, assets } = harvestLibraryHtml(
      el(`<p><img src="${BASE}/a%20b.png"></p>`),
      BASE
    );
    expect(html).toContain('src="assets/a b.png"');
    expect(assets).toEqual([
      { path: 'assets/a b.png', sourceUrl: `${BASE}/a%20b.png` }
    ]);
  });

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

  it('rewrites host-brokered image presets from their author path', () => {
    const cached = 'vscode-webview://panel/trusted-cache/abc.png';
    const { html, assets } = harvestLibraryHtml(
      el(`<img src="${cached}" data-snl-asset-path="figures/proof.png">`),
      BASE
    );
    expect(html).toContain('src="assets/figures/proof.png"');
    expect(html).not.toContain(cached);
    expect(assets).toEqual([
      { path: 'assets/figures/proof.png', sourceUrl: cached }
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

describe('collapse structure survives the strip pass', () => {
  it('keeps the markers the exported runtime rebuilds collapse from', () => {
    const { html } = harvestLibraryHtml(
      el(
        '<div data-snl-collapsible="" data-snl-child-count="3">' +
          '<button>toggle</button><section>row</section>' +
          '<div data-snl-subtree=""><section>child</section></div>' +
          '</div>'
      ),
      BASE
    );
    // The React toggle is gone, but the structure it drove is intact.
    expect(html).not.toContain('<button');
    expect(html).toContain('data-snl-collapsible');
    expect(html).toContain('data-snl-child-count="3"');
    expect(html).toContain('data-snl-subtree');
    expect(html).toContain('child');
  });

  it('keeps the markers of a collapsible BLOCK, whose subtree is not a direct child', () => {
    // The block renderer nests the body under a summary row. A direct-children
    // scan found nothing and stripped the markers, killing collapse in every
    // exported block (猫猫 2026-07-29).
    const { html } = harvestLibraryHtml(
      el(
        '<div class="snl-collapsible" data-snl-collapsible="" data-snl-child-count="2" data-snl-collapse-noun="parts">' +
          '<div class="snl-collapsible__summary"><button>t</button><section>sum</section></div>' +
          '<div class="snl-collapsible__body" data-snl-subtree=""><div>part1</div></div>' +
          '</div>'
      ),
      BASE
    );
    expect(html).toContain('data-snl-collapsible');
    expect(html).toContain('data-snl-collapse-noun="parts"');
    expect(html).toContain('data-snl-subtree');
    expect(html).not.toContain('<button');
  });

  it('does not let a parent adopt a nested collapsible\'s subtree', () => {
    // The outer host owns no subtree of its own; only the inner one does. If
    // ownership were ignored the outer host would keep a marker controlling
    // markup it does not contain.
    const { html } = harvestLibraryHtml(
      el(
        '<div id="outer" data-snl-collapsible="" data-snl-child-count="1">' +
          '<div data-snl-collapsible="" data-snl-child-count="1">' +
          '<div data-snl-subtree=""><span>inner</span></div>' +
          '</div></div>'
      ),
      BASE
    );
    const doc = el(`<div>${html}</div>`);
    const hosts = doc.querySelectorAll('[data-snl-collapsible]');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].querySelector(':scope > [data-snl-subtree]')).not.toBeNull();
  });

  it('drops the marker on a row whose subtree was collapsed away', () => {
    // The live Infoview renders collapse by omitting the subtree, so a
    // still-collapsed row reaches the exporter with no children. Leaving the
    // marker would render a toggle that controls nothing.
    const { html } = harvestLibraryHtml(
      el('<div data-snl-collapsible="" data-snl-child-count="3"><section>row</section></div>'),
      BASE
    );
    expect(html).not.toContain('data-snl-collapsible');
    expect(html).not.toContain('data-snl-child-count');
    expect(html).toContain('row');
  });

  it('leaves a childless row unmarked', () => {
    const { html } = harvestLibraryHtml(el('<div><section>leaf</section></div>'), BASE);
    expect(html).not.toContain('data-snl-collapsible');
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
