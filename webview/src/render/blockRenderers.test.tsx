import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import { COLLAPSE_TOGGLE_GEOMETRY } from '../../../src/collapseToggleContract';
import { CollapsibleRenderer, extensionRenderers } from './blockRenderers';

const assetPostMessage = vi.fn();
(globalThis as { __snlApi?: unknown }).__snlApi = { postMessage: assetPostMessage };

// This project does not enable vitest `globals`, so testing-library's automatic
// cleanup hook is not installed. Unmount explicitly or renders pile up in the
// same document and `getByRole` finds several toggles.
afterEach(() => {
  cleanup();
  assetPostMessage.mockClear();
  document.documentElement.lang = 'en';
});

function node(text: string, mdata: unknown = null): SnlSyntaxTree {
  return { macro_name: text, kind: '', mdata, children: [] } as unknown as SnlSyntaxTree;
}

function blockNode(children: SnlSyntaxTree[], mdata: unknown = null): SnlSyntaxTree {
  return { macro_name: 'demo', kind: '', mdata, children } as unknown as SnlSyntaxTree;
}

const renderChild = (child: SnlSyntaxTree) => (
  <span data-testid={`child-${child.macro_name}`}>{child.macro_name}</span>
);

function mount(tree: SnlSyntaxTree) {
  return render(
    <CollapsibleRenderer
      node={tree}
      macro_data_driver={{} as never}
      renderChild={renderChild}
    />
  );
}

describe('extensionRenderers', () => {
  // Regression lock: the view SHALLOW-merges hooks, so passing `renderers`
  // replaces the whole registry. If someone drops the `...defaultRenderers`
  // spread, every built-in block renderer silently disappears.
  it('keeps all four SNL-Basics built-ins alongside collapsible', () => {
    for (const key of ['list', 'enumerate', 'table', 'centered']) {
      expect(typeof extensionRenderers[key]).toBe('function');
    }
    expect(extensionRenderers.collapsible).toBe(CollapsibleRenderer);
  });

  it('resolves parameterized enumerate and host-brokered image renderer keys', async () => {
    const Enumerate = extensionRenderers['snl-ext-preset:v1:enumerate?marker=upper-alpha'];
    expect(typeof Enumerate).toBe('function');
    const ParameterizedEnumerate = Enumerate!;
    const numbered = render(
      <ParameterizedEnumerate
        node={blockNode([node('first')])}
        macro_data_driver={{} as never}
        renderChild={renderChild}
      />
    );
    expect((numbered.container.querySelector('ol') as HTMLOListElement).style.listStyleType)
      .toBe('upper-alpha');
    numbered.unmount();


    const Image = extensionRenderers[
      'snl-ext-preset:v1:image?src=figures%2Fmy%20plot.png&layout=inline&alt=My%20plot'
    ];
    expect(typeof Image).toBe('function');
    const ParameterizedImage = Image!;
    const renderedImage = render(
      <ParameterizedImage
        node={blockNode([])}
        macro_data_driver={{} as never}
        renderChild={renderChild}
      />
    );
    const request = assetPostMessage.mock.calls[0]?.[0] as {
      type: string; request_id: string; path: string;
    };
    expect(request).toMatchObject({
      type: 'snl.assets/resolve', path: 'figures/my plot.png'
    });
    expect(renderedImage.queryByRole('img')).toBeNull();
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved',
      request_id: request.request_id,
      path: request.path,
      url: 'vscode-webview://panel/trusted-cache/proof.png'
    } }));
    await waitFor(() => expect(renderedImage.getByRole('img')).toBeTruthy());
    const image = renderedImage.getByRole('img');
    expect(image.getAttribute('src')).toBe('vscode-webview://panel/trusted-cache/proof.png');
    expect(image.getAttribute('data-snl-asset-path')).toBe('figures/my plot.png');
    expect(image.getAttribute('data-snl-image-layout')).toBe('inline');
    expect(image.getAttribute('alt')).toBe('My plot');
    expect(extensionRenderers[
      'snl-ext-preset:v1:image?src=..%2Fsecret.png&layout=block&alt=secret'
    ]).toBeUndefined();
  });

  it('styles inline and block image presets without overflowing the reader', async () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(__dirname, '../components/ui.css'), 'utf8');
    document.head.append(style);
    try {
      document.documentElement.dataset.snlAssetBaseUri = 'vscode-webview://panel/assets';
      const Inline = extensionRenderers[
        'snl-ext-preset:v1:image?src=figure.png&layout=inline&alt=figure'
      ]!;
      const rendered = render(
        <Inline node={blockNode([])} macro_data_driver={{} as never} renderChild={renderChild} />
      );
      const request = assetPostMessage.mock.calls[0]?.[0] as {
        request_id: string; path: string;
      };
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'snl.assets/resolved',
        request_id: request.request_id,
        path: request.path,
        url: 'vscode-webview://panel/trusted-cache/figure.png'
      } }));
      await waitFor(() => expect(rendered.queryByRole('img')).toBeTruthy());
      const { container } = rendered;
      const wrapper = container.querySelector<HTMLElement>('.snl-macro-image--inline')!;
      const image = wrapper.querySelector<HTMLImageElement>('img')!;
      expect(getComputedStyle(wrapper).display).toBe('inline-flex');
      expect(getComputedStyle(image).maxWidth).toBe('100%');
    } finally {
      style.remove();
    }
  });

  it('renders enumerate markers in a dedicated first-line grid column', () => {
    const Enumerate = extensionRenderers.enumerate!;
    const tree = blockNode([node('first'), node('second')], {
      start: 3,
      listStyle: 'lower-alpha'
    });
    const { container } = render(
      <Enumerate
        node={tree}
        macro_data_driver={{} as never}
        renderChild={(child) => (
          <span style={{ display: 'inline-block' }}>
            {child.macro_name}<br />continued
          </span>
        )}
      />
    );
    const list = container.querySelector('ol.snl-block-enumerate') as HTMLOListElement;
    expect(list.start).toBe(3);
    expect(list.style.listStyleType).toBe('lower-alpha');
    const items = list.querySelectorAll(':scope > li');
    expect(items).toHaveLength(2);
    for (const [index, item] of [...items].entries()) {
      const marker = item.querySelector<HTMLElement>(':scope > .snl-enumerate-item-marker');
      expect(marker?.getAttribute('aria-hidden')).toBe('true');
      expect(marker?.style.counterSet).toBe(`list-item ${index + 3}`);
      expect(item.querySelector(':scope > .snl-enumerate-item-content')).toBeTruthy();
    }
  });

  it('leaves the default list style unset so themes can control it', () => {
    const Enumerate = extensionRenderers.enumerate!;
    const { container } = render(
      <Enumerate
        node={blockNode([node('first')])}
        macro_data_driver={{} as never}
        renderChild={renderChild}
      />
    );
    const list = container.querySelector('ol.snl-block-enumerate') as HTMLOListElement;
    expect(list.style.listStyleType).toBe('');
    const marker = list.querySelector<HTMLElement>('.snl-enumerate-item-marker')!;
    expect(marker.style.listStyleType).toBe('');
  });

  it('loads the real CSS contract that pins native markers to the first grid row', () => {
    const style = document.createElement('style');
    style.textContent = `${readFileSync(
      resolve(__dirname, '../components/ui.css'),
      'utf8'
    )}\n.snl-block-enumerate { list-style-type: lower-roman; }`;
    document.head.append(style);
    try {
      const Enumerate = extensionRenderers.enumerate!;
      const { container } = render(
        <Enumerate
          node={blockNode([node('first')])}
          macro_data_driver={{} as never}
          renderChild={(child) => (
            <span style={{ display: 'inline-block' }}>
              {child.macro_name}<br />continued
            </span>
          )}
        />
      );
      const item = container.querySelector<HTMLElement>('.snl-block-enumerate > li')!;
      const marker = item.querySelector<HTMLElement>('.snl-enumerate-item-marker')!;
      const content = item.querySelector<HTMLElement>('.snl-enumerate-item-content')!;
      const itemStyle = getComputedStyle(item);
      const markerStyle = getComputedStyle(marker);
      const contentStyle = getComputedStyle(content);
      expect(itemStyle.display).toBe('grid');
      expect(itemStyle.gridTemplateColumns).toContain('max-content');
      expect(markerStyle.display).toBe('list-item');
      expect(markerStyle.listStylePosition).toBe('inside');
      expect(markerStyle.listStyleType).toBe('lower-roman');
      expect(markerStyle.gridColumn).toBe('1');
      expect(contentStyle.gridColumn).toBe('2');
    } finally {
      style.remove();
    }
  });
});

describe('CollapsibleRenderer', () => {
  /**
   * The body stays MOUNTED when collapsed and is hidden with the `hidden`
   * attribute instead. `harvestLibraryHtml` snapshots the live DOM, so an
   * unmounted body would be silently dropped from an exported document —
   * losing content, not just a control (猫猫 2026-07-29). `hidden` gives the
   * same `display:none` semantics, so nothing is rendered or focusable.
   */
  const bodyHost = (): HTMLElement => {
    const el = document.querySelector<HTMLElement>('.snl-collapsible__body');
    if (!el) throw new Error('body host not rendered');
    return el;
  };

  it('toggles body visibility on click', () => {
    mount(blockNode([node('summary'), node('body1'), node('body2')]));
    expect(screen.getByTestId('child-summary')).toBeTruthy();
    expect(bodyHost().hidden).toBe(false);

    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(btn);
    // Content is still in the DOM (so export can harvest it) but hidden.
    expect(screen.queryByTestId('child-body1')).toBeTruthy();
    expect(screen.queryByTestId('child-body2')).toBeTruthy();
    expect(bodyHost().hidden).toBe(true);
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
    // Summary always visible.
    expect(screen.getByTestId('child-summary')).toBeTruthy();

    fireEvent.click(screen.getByRole('button'));
    expect(bodyHost().hidden).toBe(false);
  });

  it('exposes the export markers the static runtime rebuilds collapse from', () => {
    mount(blockNode([node('summary'), node('body1'), node('body2')]));
    const host = document.querySelector<HTMLElement>('.snl-collapsible')!;
    expect(host.hasAttribute('data-snl-collapsible')).toBe(true);
    // Counts the FOLDABLE parts, not every child — the summary never folds.
    expect(host.getAttribute('data-snl-child-count')).toBe('2');
    expect(host.getAttribute('data-snl-collapse-noun')).toBe('parts');
    expect(bodyHost().hasAttribute('data-snl-subtree')).toBe(true);
  });

  it('starts collapsed when mdata.collapsed === true', () => {
    mount(blockNode([node('summary'), node('body1')], { collapsed: true }));
    expect(bodyHost().hidden).toBe(true);
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
    // The export carries that state across, singular noun and all.
    const host = document.querySelector<HTMLElement>('.snl-collapsible')!;
    expect(host.getAttribute('data-snl-collapsed')).toBe('true');
    expect(host.getAttribute('data-snl-collapse-noun')).toBe('part');
  });

  it('starts expanded for other mdata shapes', () => {
    mount(blockNode([node('summary'), node('body1')], { collapsed: 'true' }));
    expect(bodyHost().hidden).toBe(false);
  });

  it('renders no toggle when there are fewer than two children', () => {
    mount(blockNode([node('only')]));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('child-only')).toBeTruthy();

    const empty = render(
      <CollapsibleRenderer
        node={blockNode([])}
        macro_data_driver={{} as never}
        renderChild={renderChild}
      />
    );
    expect(empty.container.querySelector('button')).toBeNull();
  });

  it('exposes an aria-label on the toggle', () => {
    mount(blockNode([node('summary'), node('body1')]));
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Collapse');
  });

  it('localizes collapse accessibility copy and export vocabulary in Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    mount(blockNode([node('summary'), node('body1'), node('body2')]));
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-label')).toBe('收起');
    expect(button.getAttribute('title')).toBe('收起 2 个部分');
    expect(document.querySelector('.snl-collapsible')?.getAttribute('data-snl-collapse-noun'))
      .toBe('个部分');
  });

  // Regression lock (found by rendering a real proof entry in a browser): a
  // block renderer walks `node.children` and never sees the style template, so
  // the template's `separator` does NOT apply. Without a block-level wrapper
  // per child the steps concatenate as inline text — the Rolle proof rendered
  // as "…exists there.hence F'(c) = 0…".
  it('wraps each body child in its own block so steps do not run together', () => {
    const { container } = mount(
      blockNode([node('summary'), node('body1'), node('body2')])
    );
    const parts = container.querySelectorAll('.snl-collapsible__body > .snl-collapsible__part');
    expect(parts.length).toBe(2);
    // Each wrapper holds exactly one rendered child.
    expect(parts[0].querySelector('[data-testid="child-body1"]')).toBeTruthy();
    expect(parts[1].querySelector('[data-testid="child-body2"]')).toBeTruthy();
  });

  // Regression lock (cat, 2026-07-29: "箭头会跑到左侧外面去"): the shared
  // COLLAPSE_TOGGLE_STYLE is `position:absolute; left:-20px`, i.e. the glyph
  // hangs in a gutter OUTSIDE the row's content box. That only lands correctly
  // if (a) the host reserves the gutter with padding-left, and (b) the
  // SUMMARY ROW is the positioning context — if `position:relative` sits on
  // the host instead, the offset is measured from the padding box's outer edge
  // and the arrow escapes past the left border again.
  //
  // jsdom does not do layout, so the geometry itself is asserted in the
  // browser harness. What is checkable here is the DOM contract the CSS keys
  // off: the toggle must be a direct child of `.snl-collapsible__summary`,
  // which must be a direct child of `.snl-collapsible`.
  it('nests the toggle inside the summary row so the gutter offset resolves', () => {
    const { container } = mount(blockNode([node('summary'), node('body1')]));
    const host = container.querySelector('.snl-collapsible');
    expect(host).toBeTruthy();
    const row = host!.querySelector(':scope > .snl-collapsible__summary');
    expect(row).toBeTruthy();
    const btn = row!.querySelector(':scope > button');
    expect(btn).toBeTruthy();
    // The absolute offset comes from the shared contract, not a local literal.
    expect((btn as HTMLElement).style.position).toBe('absolute');
    expect((btn as HTMLElement).style.left).toBe(`${COLLAPSE_TOGGLE_GEOMETRY.left}px`);
    // Presentation lives in ui.css; the renderer must not re-inline it.
    expect((host as HTMLElement).getAttribute('style')).toBeNull();
    expect((row as HTMLElement).getAttribute('style')).toBeNull();
  });
});
