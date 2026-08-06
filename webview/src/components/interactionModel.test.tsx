import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  entitySearchKeyAction,
  formatDirectionalLabel,
  listboxKeyAction,
  matchesPendingQuery,
  queryKey,
  shouldStopRowActivation,
  treeDisclosureA11y,
  treeRowCapabilities,
  treeRowStyle,
  TREE_OUTLINE_TOOLBAR_CSS
} from './interactionModel';
import { Disclosure } from './Disclosure';
import { RowPrimaryButton } from './RowPrimaryButton';

describe('TreeOutlineEditor interaction model', () => {
  it('keeps depth indentation when applying vertical padding', () => {
    expect(treeRowStyle(2).padding).toBe('0.3rem 0 0.3rem 3rem');
    expect(treeRowStyle(0).padding).toBe('0.3rem 0');
  });

  it('disables move controls at sibling boundaries', () => {
    expect(treeRowCapabilities(0, 3, false)).toEqual({
      canIndent: false,
      canOutdent: false,
      canMoveUp: false,
      canMoveDown: true
    });
    expect(treeRowCapabilities(2, 3, true)).toEqual({
      canIndent: true,
      canOutdent: true,
      canMoveUp: true,
      canMoveDown: false
    });
  });

  it('does not hit-test a visually hidden toolbar', () => {
    expect(TREE_OUTLINE_TOOLBAR_CSS).toContain('pointer-events: none');
    expect(TREE_OUTLINE_TOOLBAR_CSS).toContain('pointer-events: auto');
  });

  it('exposes disclosure state and its controlled child list', () => {
    expect(treeDisclosureA11y(false, 'children-a')).toEqual({
      'aria-expanded': false,
      'aria-controls': 'children-a'
    });
  });
});

describe('native controls', () => {
  it('renders disclosure state and relationship to its panel', () => {
    const html = renderToStaticMarkup(
      <Disclosure expanded={false} controls="related-context" onToggle={() => {}}>
        Context
      </Disclosure>
    );
    expect(html).toContain('<button');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="related-context"');
  });

  it('renders a real primary-cell button without changing cell text', () => {
    const html = renderToStaticMarkup(
      <RowPrimaryButton label="Edit item" onActivate={() => {}}>Item</RowPrimaryButton>
    );
    expect(html).toContain('<button');
    expect(html).toContain('aria-label="Edit item"');
    expect(html).toContain('>Item</button>');
  });

  it('stops Enter and Space from interactive descendants reaching row activation', () => {
    expect(shouldStopRowActivation('Enter')).toBe(true);
    expect(shouldStopRowActivation(' ')).toBe(true);
    expect(shouldStopRowActivation('Tab')).toBe(false);
  });
});

describe('PanelNav labels', () => {
  it('does not duplicate caller-provided arrows', () => {
    expect(formatDirectionalLabel('back', '← Dashboard')).toBe('← Dashboard');
    expect(formatDirectionalLabel('back', 'Dashboard')).toBe('← Dashboard');
    expect(formatDirectionalLabel('forward', 'Infoview →')).toBe('Infoview →');
  });
});

describe('SNoogL listbox keyboard model', () => {
  it('supports arrows, Home/End, Enter and Escape', () => {
    expect(listboxKeyAction('ArrowDown', 0, 3)).toEqual({ index: 1 });
    expect(listboxKeyAction('ArrowUp', 0, 3)).toEqual({ index: 2 });
    expect(listboxKeyAction('Home', 2, 3)).toEqual({ index: 0 });
    expect(listboxKeyAction('End', 0, 3)).toEqual({ index: 2 });
    expect(listboxKeyAction('Enter', 1, 3)).toEqual({ index: 1, activate: true });
    expect(listboxKeyAction('Escape', 1, 3)).toEqual({ index: 1, blur: true });
  });

  it('creates a stable key so immediate Enter does not duplicate the debounced query', () => {
    const a = queryKey({ q: 'lemma', mode: 'entry', filters: { kindId: 'definition' } });
    const b = queryKey({ q: 'lemma', mode: 'entry', filters: { kindId: 'definition' } });
    expect(a).toBe(b);
    expect(matchesPendingQuery(a, {
      q: 'lemma',
      mode: 'entry',
      filters: { kindId: 'definition' }
    })).toBe(true);
    expect(queryKey({
      q: 'lemma',
      mode: 'entry',
      filters: { kindId: 'definition', counterpartId: 'Logic.imp' }
    })).not.toBe(queryKey({
      q: 'lemma',
      mode: 'entry',
      filters: { kindId: 'definition', counterpartId: 'Logic.and' }
    }));
  });
});

describe('EntityIdSearchBox keyboard model', () => {
  it('does not open or produce index -1 on ArrowDown with zero results', () => {
    expect(entitySearchKeyAction('ArrowDown', 0, 0, false)).toEqual({
      index: 0,
      open: false
    });
  });

  it('Escape closes and blurs as documented', () => {
    expect(entitySearchKeyAction('Escape', 0, 2, true)).toEqual({
      index: 0,
      open: false,
      blur: true
    });
  });
});
