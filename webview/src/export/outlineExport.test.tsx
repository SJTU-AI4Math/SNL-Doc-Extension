// End-to-end export test driven by the REAL Library outline component.
//
// 猫猫 2026-07-29: "Library 里条目的 Collapse 还是不 work". The previous round of
// export tests built their own markup by hand, so they proved the runtime
// worked on markup *I* wrote — not on what `OutlineTreeNode` actually renders.
// This test renders the real component, runs the real harvest, builds the real
// document, executes the real runtime, and clicks the result.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { JSDOM } from 'jsdom';
import { LibraryOutline, type OutlineNode } from '../App';
import { harvestLibraryHtml } from './htmlExport';
import { EXPORT_RUNTIME_JS, EXPORT_RUNTIME_CSS } from '../../../src/exportRuntime';
import { buildExportDocument, EXPORT_BASE_CSS } from '../../../src/exportHtmlDocument';

const leaf = (id: string): OutlineNode => ({
  nodeId: id,
  entry: null,
  kind: null,
  counterLabel: id,
  children: []
});

const branch = (id: string, children: OutlineNode[]): OutlineNode => ({
  ...leaf(id),
  children
});

/** Render the outline, harvest it, wrap it, execute the runtime. */
async function exportAndRun(nodes: OutlineNode[]): Promise<Document> {
  const { container } = render(<LibraryOutline nodes={nodes} />);
  const root = container.firstElementChild as HTMLElement;
  const { html } = harvestLibraryHtml(root, 'vscode-webview://x/assets');
  const doc = buildExportDocument({
    title: 'T',
    css: [EXPORT_BASE_CSS, EXPORT_RUNTIME_CSS].join('\n'),
    body: html,
    script: EXPORT_RUNTIME_JS
  });
  const dom = new JSDOM(doc, { runScripts: 'dangerously', pretendToBeVisual: true });
  // The runtime installs on DOMContentLoaded. Without this wait the assertions
  // run against a document still in `readyState: 'loading'` and see zero
  // toggles — a false failure that looks exactly like the real bug.
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  return dom.window.document;
}

const click = (el: Element): void => {
  const w = el.ownerDocument.defaultView!;
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
};

/**
 * Whether the element is ACTUALLY not rendered.
 *
 * Asserting on `.hidden` alone is not enough and was the hole that let the
 * reported bug through: the Entry outline's subtree carries an inline
 * `display: flex`, which outranks the UA's `[hidden] { display: none }`, so
 * the property read `true` while the rows stayed on screen (猫猫 2026-07-29:
 * block collapse worked, outline collapse did not). Only the computed style
 * tells the truth.
 */
function isVisuallyCollapsed(el: HTMLElement): boolean {
  const w = el.ownerDocument.defaultView!;
  return el.hidden && w.getComputedStyle(el).display === 'none';
}

afterEach(cleanup);

describe('Library outline survives export with working collapse', () => {
  it('emits the collapse markers from the real component', () => {
    const { container } = render(
      <LibraryOutline nodes={[branch('sec', [leaf('a'), leaf('b')])]} />
    );
    const host = container.querySelector('[data-snl-collapsible]');
    expect(host).not.toBeNull();
    expect(host!.getAttribute('data-snl-child-count')).toBe('2');
    expect(host!.querySelector(':scope > [data-snl-subtree]')).not.toBeNull();
  });

  it('rebuilds a working toggle for every parent row in the exported file', async () => {
    const D = await exportAndRun([
      branch('sec', [branch('sub', [leaf('leaf1'), leaf('leaf2')]), leaf('other')])
    ]);

    const hosts = Array.from(D.querySelectorAll<HTMLElement>('[data-snl-collapsible]'));
    // Two parents (sec, sub); the three leaves carry no marker.
    expect(hosts).toHaveLength(2);
    expect(D.querySelectorAll('button')).toHaveLength(2);

    for (const host of hosts) {
      const toggle = host.querySelector(':scope > button');
      const subtree = host.querySelector<HTMLElement>(':scope > [data-snl-subtree]');
      expect(toggle).not.toBeNull();
      expect(subtree).not.toBeNull();
      expect(isVisuallyCollapsed(subtree!)).toBe(false);
      click(toggle!);
      expect(isVisuallyCollapsed(subtree!)).toBe(true);
      click(toggle!);
      expect(isVisuallyCollapsed(subtree!)).toBe(false);
    }
  });

  it('collapses a child row without touching its parent', async () => {
    const D = await exportAndRun([branch('sec', [branch('sub', [leaf('leaf1')])])]);
    const [outer, inner] = Array.from(
      D.querySelectorAll<HTMLElement>('[data-snl-collapsible]')
    );
    const innerSub = inner.querySelector<HTMLElement>(':scope > [data-snl-subtree]')!;
    const outerSub = outer.querySelector<HTMLElement>(':scope > [data-snl-subtree]')!;

    click(inner.querySelector(':scope > button')!);
    expect(isVisuallyCollapsed(innerSub)).toBe(true);
    expect(isVisuallyCollapsed(outerSub)).toBe(false);
  });
});
