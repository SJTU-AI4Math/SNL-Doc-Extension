// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.resolve(__dirname, 'CreateLibraryApp.css'), 'utf8');
const dashboardCss = readFileSync(path.resolve(__dirname, 'components/TreeNodeActionDashboard.css'), 'utf8');

function blockBetween(start: string, end?: string): string {
  const from = css.indexOf(start);
  if (from < 0) throw new Error(`missing CSS block: ${start}`);
  const to = end ? css.indexOf(end, from + start.length) : css.length;
  if (to < 0) throw new Error(`missing CSS block: ${end}`);
  return css.slice(from, to);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function declarations(block: string, selector: string): Map<string, string> {
  const matches = [...block.matchAll(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^{}]*)\\}`, 'g'))];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one CSS rule for ${selector}, found ${matches.length}`);
  }
  const match = matches[0];
  return new Map(
    match[1]
      .split(';')
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const separator = declaration.indexOf(':');
        if (separator < 0) throw new Error(`invalid declaration: ${declaration}`);
        return [
          declaration.slice(0, separator).trim(),
          declaration.slice(separator + 1).trim().replace(/\s+/g, ' ')
        ];
      })
  );
}

function expectPlacement(
  block: string,
  selector: string,
  column: string,
  row: string
): void {
  const rule = declarations(block, selector);
  expect(rule.get('grid-column')).toBe(column);
  expect(rule.get('grid-row')).toBe(row);
}

function topLevelCss(source: string): string {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  let cursor = 0;
  let result = '';
  while (cursor < clean.length) {
    const open = clean.indexOf('{', cursor);
    if (open < 0) break;
    const selector = clean.slice(cursor, open).trim();
    let depth = 1;
    let close = open + 1;
    while (close < clean.length && depth > 0) {
      if (clean[close] === '{') depth += 1;
      if (clean[close] === '}') depth -= 1;
      close += 1;
    }
    if (!selector.startsWith('@')) {
      result += `${selector}{${clean.slice(open + 1, close - 1)}}\n`;
    }
    cursor = close;
  }
  return result;
}

const rowMain = '.snl-library-outline-row-main';
const counter = '.snl-library-outline-counter';
const kind = '.snl-library-outline-kind';
const entryId = '.snl-library-outline-entry-id';
const title = '.snl-library-outline-row-main > .snl-outline-row-title';
const metric = '.snl-library-outline-metric';

describe('Library outline responsive grid contract', () => {
  it('keeps the counter clear of Collapse and sizes the centered Kind track to its label', () => {
    const desktop = blockBetween(rowMain, '@container snl-outline (max-width: 60rem)');
    expect(declarations(desktop, rowMain).get('grid-template-columns')).toBe(
      'calc(8rem + var(--snl-library-outline-depth-offset, 0rem)) fit-content(10rem) minmax(7rem, 11rem) minmax(8rem, 1fr)'
    );
    expect(declarations(desktop, rowMain).get('margin-left')).toBe(
      'calc(-1 * var(--snl-library-outline-depth-offset, 0rem))'
    );
    expect(declarations(desktop, rowMain).get('width')).toBe(
      'calc(100% + var(--snl-library-outline-depth-offset, 0rem))'
    );
    expect(declarations(desktop, rowMain).get('pointer-events')).toBe('none');
    expect(declarations(desktop, `${rowMain} > *`).get('pointer-events')).toBe('auto');
    const counterRule = declarations(desktop, counter);
    expect(counterRule.get('transform')).toBe(
      'translateX(var(--snl-library-counter-indent))'
    );
    expect(counterRule.get('width')).toBe(
      'calc(100% - var(--snl-library-counter-indent))'
    );
    expect(counterRule.get('min-width')).toBe('4rem');
    const metricRule = declarations(desktop, metric);
    expect(metricRule.get('margin-right')).toBe('0.35rem');
    expect(metricRule.get('pointer-events')).toBe('auto');
    expect(metricRule.has('grid-column')).toBe(false);
    const libraryRow = declarations(desktop, '.snl-library-outline-row');
    expect(libraryRow.get('padding-right')).toBe('11.3rem !important');
    const kindRule = declarations(desktop, kind);
    expect(kindRule.get('width')).toBe('max-content');
    expect(kindRule.get('justify-self')).toBe('start');
    expect(kindRule.get('text-align')).toBe('center');
    expect(kindRule.get('max-width')).toBe('10rem');
    expect(kindRule.get('min-width')).toBe('0');
    expect(declarations(
      desktop,
      '.snl-library-outline-row:has(.snl-library-outline-row-main--deep) > .snl-outline-row-content'
    ).get('flex')).toBe('1 0 100% !important');
    const libraryToolbar = declarations(
      desktop,
      '.snl-library-outline-row > .snl-outline-row-toolbar'
    );
    expect(libraryToolbar.get('opacity')).toBe('1');
    expect(libraryToolbar.get('pointer-events')).toBe('none');
    const hoverToolbarButtons = declarations(
      desktop,
      '.snl-library-outline-row:hover > .snl-outline-row-toolbar button,\n.snl-library-outline-row:has(> .snl-outline-row-toolbar:focus-within) > .snl-outline-row-toolbar button'
    );
    expect(hoverToolbarButtons.get('opacity')).toBe('1');
    expect(hoverToolbarButtons.get('pointer-events')).toBe('auto');
    expect(css).not.toContain('.snl-library-outline-row:focus-within > .snl-outline-row-toolbar button');
    expect(css).toContain('.snl-library-outline-row:has(> .snl-outline-row-toolbar:focus-within)');
    const revealedDial = declarations(
      dashboardCss,
      '.snl-outline-row:hover > .snl-outline-row-toolbar .snl-tree-operation-dial,\n.snl-outline-row:has(> .snl-outline-row-toolbar:focus-within) > .snl-outline-row-toolbar .snl-tree-operation-dial'
    );
    expect(revealedDial.get('--snl-tree-operation-dial-background-color')).toBe(
      'var(--snl-tree-board-opaque-background)'
    );
    expect(revealedDial.get('--snl-tree-operation-dial-background-image')).toContain(
      'var(--vscode-editorWidget-background, transparent)'
    );
    const medium = blockBetween(
      '@container snl-outline (max-width: 60rem)',
      '@container snl-outline (max-width: 26rem)'
    );
    expect(declarations(medium, rowMain).get('grid-template-columns')).toBe(
      'minmax(calc(5.5rem + var(--snl-library-outline-depth-offset, 0rem)), calc(8rem + var(--snl-library-outline-depth-offset, 0rem))) fit-content(10rem) minmax(0, 1fr)'
    );
    expect(declarations(medium, rowMain).get('--snl-library-counter-indent')).toBe(
      'var(--snl-library-outline-depth-offset, 0rem)'
    );
    expect(declarations(
      medium,
      '.snl-library-outline-row > .snl-outline-row-content'
    ).get('flex')).toBe('1 0 100% !important');
    expectPlacement(medium, counter, '1', '1');
    expectPlacement(medium, kind, '2', '1');
    expectPlacement(medium, entryId, '1 / -1', '2');
    expectPlacement(medium, title, '1 / -1', '3');
    const row = declarations(medium, '.snl-library-outline-row');
    expect(row.get('padding-right')).toBe('0 !important');
    expect(row.get('padding-bottom')).toBe('4.9rem !important');
    const toolbar = declarations(medium, '.snl-library-outline-row > .snl-outline-row-toolbar');
    expect(toolbar.get('top')).toBe('auto');
    expect(toolbar.get('right')).toBe('0.3rem');
    expect(toolbar.get('bottom')).toBe('0.2rem');
    expect(toolbar.get('transform')).toBe('none');
    const reservedDial = declarations(
      medium,
      '.snl-library-outline-row > .snl-outline-row-toolbar .snl-tree-operation-dial'
    );
    expect(reservedDial.get('--snl-tree-operation-dial-background-color')).toBe(
      'var(--snl-tree-board-opaque-background)'
    );
    expect(reservedDial.get('--snl-tree-operation-dial-background-image')).toContain(
      'var(--vscode-editorWidget-background, transparent)'
    );

    const coarse = blockBetween('@media (hover: none), (pointer: coarse)');
    const coarseDial = declarations(
      coarse,
      '.snl-library-outline-row > .snl-outline-row-toolbar .snl-tree-operation-dial'
    );
    expect(coarseDial.get('--snl-tree-operation-dial-background-color')).toBe(
      'var(--snl-tree-board-opaque-background)'
    );

    const gridRules = [...css.matchAll(/([^{}]+)\{([^{}]*grid-template-columns:[^{}]*)\}/g)]
      .filter((match) => match[1].includes(rowMain));
    expect(gridRules).toHaveLength(3);
    expect(gridRules.every((match) => match[1].trim() === rowMain)).toBe(true);
  });

  it('stacks id, title and metric into exact rows at narrow widths', () => {
    const narrow = blockBetween('@container snl-outline (max-width: 26rem)');
    expect(declarations(narrow, rowMain).get('grid-template-columns')).toBe(
      'minmax(calc(4rem + var(--snl-library-outline-depth-offset, 0rem)), calc(8rem + var(--snl-library-outline-depth-offset, 0rem))) minmax(0, 1fr)'
    );
    expectPlacement(narrow, counter, '1', '1');
    expectPlacement(narrow, kind, '2', '1');
    expectPlacement(narrow, entryId, '1 / -1', '2');
    expectPlacement(narrow, title, '1 / -1', '3');
    const narrowKind = declarations(narrow, kind);
    expect(narrowKind.get('width')).toBe('100%');
    expect(narrowKind.get('max-width')).toBe('10rem');
  });

  it('validates the effective desktop grid cascade on the live row element', () => {
    const style = document.createElement('style');
    style.textContent = topLevelCss(css);
    document.head.appendChild(style);
    const row = document.createElement('div');
    row.className = 'snl-library-outline-row-main';
    row.dataset.snlLibraryRowMain = '';
    document.body.appendChild(row);
    expect(getComputedStyle(row).gridTemplateColumns.replace(/\s+/g, ' ').trim()).toBe(
      'calc(8rem + var(--snl-library-outline-depth-offset, 0rem)) fit-content(10rem) minmax(7rem, 11rem) minmax(8rem, 1fr)'
    );
    row.remove();
    style.remove();
  });
});
