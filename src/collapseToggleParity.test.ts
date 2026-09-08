import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COLLAPSE_GLYPH,
  COLLAPSE_TOGGLE_CLASS,
  collapseToggleAriaLabel,
  collapseToggleTitle
} from './collapseToggleContract';

/**
 * Cat 2026-07-28: '为什么 Collapse 按钮的效果和 Extension 内很不一样?'
 *
 * Because the export had hand-rolled its own glyphs, sizing and CSS instead of
 * reusing the panel's. These tests pin the two surfaces to one contract so the
 * answer stays "they are the same" without anyone having to re-check by eye.
 */

const LIVE_TOGGLE = readFileSync(
  join(__dirname, '..', 'webview', 'src', 'reader', 'LibraryReader.tsx'),
  'utf8'
);

describe('collapse toggle: one contract, two drivers', () => {
  it('uses the classic filled triangles, not some other glyph pair', () => {
    expect(COLLAPSE_GLYPH.collapsed).toBe('\u25b6');
    expect(COLLAPSE_GLYPH.expanded).toBe('\u25bc');
  });

  it('reuses the shared .snl-btn styling rather than a bespoke class', () => {
    expect(COLLAPSE_TOGGLE_CLASS).toContain('snl-btn');
    expect(COLLAPSE_TOGGLE_CLASS).toContain('snl-btn--ghost');
  });

  it('puts the child count in the tooltip, never on the button face', () => {
    expect(collapseToggleTitle(false, 2)).toBe('Collapse 2 sub-entries');
    expect(collapseToggleTitle(true, 1)).toBe('Expand 1 sub-entry');
    expect(collapseToggleAriaLabel(true)).toBe('Expand');
    expect(collapseToggleTitle(false, 2, 'zh-CN')).toBe('收起 2 个子条目');
    expect(collapseToggleAriaLabel(true, 'zh-CN')).toBe('展开');
  });
});

describe('the live panel consumes the contract', () => {
  it('does not hard-code glyphs, geometry, or label strings', () => {
    expect(LIVE_TOGGLE).toContain('COLLAPSE_GLYPH');
    expect(LIVE_TOGGLE).toContain('COLLAPSE_TOGGLE_STYLE');
    expect(LIVE_TOGGLE).toContain('collapseChildren');
    // The literals that used to be inlined must be gone.
    expect(LIVE_TOGGLE).not.toContain("'▶'");
    expect(LIVE_TOGGLE).not.toContain("'▼'");
    expect(LIVE_TOGGLE).not.toContain('sub-entr${');
  });
});

describe('the exported reader consumes the very same React toggle', () => {
  const browser = readFileSync(join(__dirname, '..', 'webview', 'src', 'reader', 'BrowserReader.tsx'), 'utf8');
  const adapter = readFileSync(join(__dirname, '..', 'webview', 'src', 'App.tsx'), 'utf8');
  it('mounts LibraryLayer in the browser and the LibraryReader dispatcher in the Extension', () => {
    expect(browser).toContain('<LibraryLayer');
    expect(browser).toContain("from './LibraryReader'");
    expect(adapter).toContain('renderCurrentView(view,');
    expect(adapter).toContain("from './reader/LibraryReader'");
    expect(LIVE_TOGGLE).toContain('<LibraryLayer');
  });
  it('keeps button creation, geometry, glyphs, and localized names in the shared surface', () => {
    expect(browser).not.toContain('COLLAPSE_GLYPH');
    expect(browser).not.toContain('createElement("button")');
    expect(LIVE_TOGGLE).toContain('<CollapseToggle');
    expect(LIVE_TOGGLE).toContain('COLLAPSE_TOGGLE_STYLE as React.CSSProperties');
    expect(LIVE_TOGGLE).toContain('COLLAPSE_GLYPH.collapsed : COLLAPSE_GLYPH.expanded');
    expect(LIVE_TOGGLE).toContain("t(collapsed ? 'expandChildren' : 'collapseChildren'");
    expect(LIVE_TOGGLE).toContain("t(collapsed ? 'expand' : 'collapse')");
  });
  it('delegates individual, peer, and bulk state changes to the same structural-tree model', () => {
    expect(LIVE_TOGGLE).toContain('toggleStructuralNode(prev, descriptors, nodeId, sameDepth)');
    expect(LIVE_TOGGLE).toContain('toggle(node.nodeId, event.ctrlKey)');
    expect(LIVE_TOGGLE).toContain('setAllStructuralNodes(descriptors, false)');
    expect(LIVE_TOGGLE).toContain('setAllStructuralNodes(descriptors, true)');
  });
  it('uses React-owned subtree lifetime and never a DOM clone/move collapse driver', () => {
    expect(LIVE_TOGGLE).toContain('hasChildren && !isCollapsed ?');
    expect(LIVE_TOGGLE).toContain('aria-controls={controlsId}');
    expect(LIVE_TOGGLE).toContain('aria-expanded={!collapsed}');
    expect(browser).not.toContain('.cloneNode(');
    expect(browser).not.toContain('.appendChild(');
  });
});
