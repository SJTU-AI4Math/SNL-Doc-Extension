import { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import { MenuItemButton } from './MenuItemButton';
import { TabButton, TabList } from './Tabs';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('shared button primitives', () => {
  it('keeps visible text as the accessible name even when title is present', () => {
    render(<Button title="Tooltip detail">Visible action</Button>);
    const button = screen.getByRole('button', { name: 'Visible action' });
    expect(button.getAttribute('title')).toBe('Tooltip detail');
    expect(button.hasAttribute('aria-label')).toBe(false);
  });

  it('forwards refs and exposes loading as busy plus native disabled', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref} loading loadingLabel="Saving">Save</Button>);
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Saving' }));
    expect(ref.current?.disabled).toBe(true);
    expect(ref.current?.getAttribute('aria-busy')).toBe('true');
  });

  it('keeps aria-disabled buttons focusable but functionally inert', () => {
    const activate = vi.fn();
    render(<Button aria-disabled="true" onClick={activate}>Unavailable</Button>);
    const button = screen.getByRole('button', { name: 'Unavailable' });
    expect(button.hasAttribute('disabled')).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(activate).not.toHaveBeenCalled();
  });

  it('gives every icon-only button a stable accessible label and SVG icon', () => {
    render(<IconButton icon="delete" label="Delete style" variant="destructive" />);
    const button = screen.getByRole('button', { name: 'Delete style' });
    expect(button.getAttribute('title')).toBe('Delete style');
    expect(button.classList.contains('snl-btn--icon')).toBe(true);
    expect(button.querySelector('svg[data-snl-icon="delete"]')).toBeTruthy();
  });

  it('renders icons without exposing glyph noise to assistive technology', () => {
    const { container } = render(<Icon name="indent" />);
    const icon = container.querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.getAttribute('focusable')).toBe('false');
  });

  it('uses segmented-button semantics and keyboard navigation', () => {
    const chooseA = vi.fn();
    const chooseB = vi.fn();
    render(
      <TabList aria-label="Editor mode">
        <TabButton active onClick={chooseA}>First</TabButton>
        <TabButton active={false} onClick={chooseB}>Second</TabButton>
      </TabList>
    );
    const group = screen.getByRole('group', { name: 'Editor mode' });
    const first = screen.getByRole('button', { name: 'First' });
    const second = screen.getByRole('button', { name: 'Second' });
    expect(first.getAttribute('aria-pressed')).toBe('true');
    expect(second.getAttribute('aria-pressed')).toBe('false');
    expect(group.querySelector('[role="tab"]')).toBeNull();
    expect(second.getAttribute('tabindex')).toBe('-1');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(chooseB).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(second);
  });

  it('does not steal arrow keys from controls nested near a tab list', () => {
    const activate = vi.fn();
    render(
      <TabList aria-label="Styles">
        <TabButton active onClick={activate}>Default</TabButton>
        <input aria-label="Rename style" defaultValue="compact" />
        <button type="button">Delete style</button>
      </TabList>
    );
    const input = screen.getByRole('textbox', { name: 'Rename style' });
    input.focus();
    expect(fireEvent.keyDown(input, { key: 'ArrowRight' })).toBe(true);
    expect(activate).not.toHaveBeenCalled();
    const auxiliary = screen.getByRole('button', { name: 'Delete style' });
    auxiliary.focus();
    expect(fireEvent.keyDown(auxiliary, { key: 'ArrowLeft' })).toBe(true);
    expect(activate).not.toHaveBeenCalled();
  });

  it('styles menu items through one semantic primitive', () => {
    render(<MenuItemButton danger>Delete node</MenuItemButton>);
    const item = screen.getByRole('menuitem', { name: 'Delete node' });
    expect(item.classList.contains('snl-menu-item')).toBe(true);
    expect(item.getAttribute('data-danger')).toBe('true');
  });

  it('loads one CSS interaction contract for icons, tabs, menus and disabled states', () => {
    const css = readFileSync(resolve(__dirname, 'ui.css'), 'utf8');
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    try {
      render(
        <>
          <IconButton icon="move-up" label="Move up" />
          <MenuItemButton danger>Delete</MenuItemButton>
          <TabButton active>Active</TabButton>
        </>
      );
      const iconStyle = getComputedStyle(screen.getByRole('button', { name: 'Move up' }));
      expect(iconStyle.minWidth).toBe('24px');
      expect(iconStyle.minHeight).toBe('24px');
      expect(iconStyle.display).toBe('inline-flex');
      const menuStyle = getComputedStyle(screen.getByRole('menuitem', { name: 'Delete' }));
      expect(menuStyle.width).toBe('100%');
      expect(menuStyle.justifyContent).toBe('flex-start');
      expect(css).toContain('text-align:left');
      expect(css).toContain(".snl-tab[data-tab-variant='underline'][data-active='true']");
      expect(css).toContain('border-bottom:2px solid');
      expect(css).toContain(".snl-btn--secondary:hover:not(:disabled):not([aria-disabled='true'])");
      expect(css).toContain('@media (forced-colors: active)');
      expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    } finally {
      style.remove();
    }
  });

  it('keeps editor tabs and compact actions on shared primitives', () => {
    const src = resolve(__dirname, '..');
    const entry = readFileSync(resolve(src, 'CreateEntryApp.tsx'), 'utf8');
    const macro = readFileSync(resolve(src, 'CreateMacroApp.tsx'), 'utf8');
    const snoogl = readFileSync(resolve(src, 'SnooglApp.tsx'), 'utf8');
    expect(entry).not.toContain('function TabButton(');
    expect(entry).not.toContain('function SubTabButton(');
    expect(macro).not.toContain('function SmallButton(');
    expect(macro).not.toContain('function TabButton(');
    expect(snoogl).toContain("from './components/Tabs'");
    const dashboard = readFileSync(resolve(src, 'DashboardApp.tsx'), 'utf8');
    const packagePanel = readFileSync(resolve(src, 'PackagePanelApp.tsx'), 'utf8');
    expect(dashboard).not.toContain('✕');
    expect(packagePanel).not.toContain('🗑');
    expect(dashboard).not.toContain('function AddBar(');
    expect(packagePanel).not.toContain('function AddBar(');
  });
});
