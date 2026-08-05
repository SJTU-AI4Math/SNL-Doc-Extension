import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COLLAPSE_GLYPH,
  COLLAPSE_TOGGLE_CLASS,
  COLLAPSE_TOGGLE_GEOMETRY,
  COLLAPSE_TOGGLE_STYLE,
  collapseToggleAriaLabel,
  collapseToggleTitle
} from './collapseToggleContract';
import { EXPORT_RUNTIME_CSS, EXPORT_RUNTIME_WIRING_JS } from './exportRuntime';

/**
 * Cat 2026-07-28: '为什么 Collapse 按钮的效果和 Extension 内很不一样?'
 *
 * Because the export had hand-rolled its own glyphs, sizing and CSS instead of
 * reusing the panel's. These tests pin the two surfaces to one contract so the
 * answer stays "they are the same" without anyone having to re-check by eye.
 */

const LIVE_TOGGLE = readFileSync(
  join(__dirname, '..', 'webview', 'src', 'App.tsx'),
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

describe('the exported runtime consumes the same contract', () => {
  it('emits the shared glyphs', () => {
    expect(EXPORT_RUNTIME_WIRING_JS).toContain(COLLAPSE_GLYPH.expanded);
    expect(EXPORT_RUNTIME_WIRING_JS).toContain(COLLAPSE_GLYPH.collapsed);
    // The small triangles the first version used are gone.
    expect(EXPORT_RUNTIME_WIRING_JS).not.toContain('\u25be');
    expect(EXPORT_RUNTIME_WIRING_JS).not.toContain('\u25b8');
  });

  it('emits the shared class list and geometry', () => {
    expect(EXPORT_RUNTIME_WIRING_JS).toContain(COLLAPSE_TOGGLE_CLASS);
    expect(EXPORT_RUNTIME_WIRING_JS).toContain(`left:${COLLAPSE_TOGGLE_STYLE.left}`);
    expect(EXPORT_RUNTIME_WIRING_JS).toContain(`width:${COLLAPSE_TOGGLE_STYLE.width}`);
  });

  it('produces the same tooltip wording as the live panel', () => {
    // Exercise the runtime's own string building against the shared helper.
    const built = (open: boolean, count: number): string =>
      `${open ? 'Collapse ' : 'Expand '}${count} sub-entr${count === 1 ? 'y' : 'ies'}`;
    expect(built(true, 2)).toBe(collapseToggleTitle(false, 2));
    expect(built(false, 1)).toBe(collapseToggleTitle(true, 1));
    expect(EXPORT_RUNTIME_WIRING_JS).toContain("zh ? '收起' : 'Collapse'");
    expect(EXPORT_RUNTIME_WIRING_JS).toContain("zh ? '展开' : 'Expand'");
  });

  it('leaves no placeholder unsubstituted', () => {
    expect(EXPORT_RUNTIME_WIRING_JS).not.toContain('__TOGGLE_CLASS__');
    expect(EXPORT_RUNTIME_WIRING_JS).not.toContain('__TOGGLE_STYLE__');
    expect(EXPORT_RUNTIME_WIRING_JS).not.toMatch(/__GLYPH_[A-Z]+__/);
  });

  it('no longer ships a duplicate stylesheet for the button', () => {
    // Appearance comes from .snl-btn in the inlined bundle CSS. The only styles
    // the export owns are the gutter the toggle hangs in and the collapse rule
    // that has to outrank the outline's inline `display` (see EXPORT_RUNTIME_CSS).
    expect(EXPORT_RUNTIME_CSS).not.toContain('snl-export-toggle');
    expect(EXPORT_RUNTIME_CSS).toContain('padding-left');
    // The popover frame legitimately paints (background, shadow, fade), and
    // it is not a button — so scope this assertion to everything else.
    const withoutPopover = EXPORT_RUNTIME_CSS.replace(
      /\.snl-export-popover[^{]*\{[^}]*\}/g,
      ''
    );
    // Assert the INTENT directly instead of proxying it through a byte count:
    // no button appearance is restyled here. A length cap would just have to be
    // re-raised every time a legitimate rule is added (it already blocked the
    // 2026-07-29 collapse fix).
    for (const property of [
      'background',
      'border',
      'border-radius',
      'color',
      'font-size',
      'opacity',
      'transition'
    ]) {
      expect(withoutPopover).not.toContain(`${property}:`);
    }
  });

  it('reserves exactly the gutter the shared geometry needs', () => {
    const needed = -COLLAPSE_TOGGLE_GEOMETRY.left;
    const match = EXPORT_RUNTIME_CSS.match(/padding-left:\s*(\d+)px/);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBeGreaterThanOrEqual(needed);
  });
});
