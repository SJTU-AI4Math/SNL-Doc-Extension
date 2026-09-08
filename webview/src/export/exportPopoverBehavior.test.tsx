// Execute BrowserReader + production EntrySurface/Basics. No harvested HTML stand-ins.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { advance, cleanupReader, entry, mountReader, move, navigate, node, panels, semantic, setupReader, snapshot } from './sharedReaderFixture';

beforeEach(setupReader);
afterEach(cleanupReader);
async function boot() {
  const view = mountReader();
  const anchor = await waitFor(() => semantic(view.container, 'entry-a'));
  vi.useFakeTimers();
  return { ...view, anchor };
}
// jsdom has zero-sized rectangles. Exercise the production pointer hit-test with
// the zero rect (inside) and an explicit distant point (outside); painted
// viewport geometry is covered by the parent's real-browser checks.
const pointer = (x: number, y: number) => fireEvent(document, new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
const leave = (anchor: Element) => { fireEvent.mouseLeave(anchor.closest('[data-entry-body]') ?? anchor); pointer(1000, 1000); };
const marker = (panel = panels()[0]) => panel.querySelector<HTMLElement>('[data-snl-popover-id]')!;
async function hover(anchor: Element) { move(anchor); await advance(1010); }
async function escape() { fireEvent.keyDown(document, { key: 'Escape' }); await advance(500); }

describe('exported shared reader popovers', () => {
  it('waits the full hover delay and renders the raw referenced Entry with Basics', async () => {
    const { anchor } = await boot();
    move(anchor); await advance(999);
    expect(marker().dataset.snlPopoverPhase).toBe('opening');
    expect(panels()[0].style.opacity).toBe('0');
    expect(panels()[0].style.pointerEvents).toBe('none');
    await advance(11); expect(panels()).toHaveLength(1);
    expect(marker().dataset.snlPopoverPhase).toBe('visible');
    expect(panels()[0].style.opacity).toBe('1');
    expect(marker().dataset.snlPopoverSubject).toBe('entry-a');
    expect(panels()[0].querySelector('[data-entry-id="entry-a"]')).not.toBeNull();
    expect(semantic(panels()[0], 'entry-b')).toBeDefined();
  });

  it('pins on primary click immediately, survives pointer exit, and dismisses outside', async () => {
    const { anchor } = await boot();
    fireEvent.click(anchor); await advance(0);
    expect(panels()).toHaveLength(1); expect(marker().dataset.snlPopoverFrozen).toBe('true');
    leave(anchor); await advance(2000);
    expect(panels()).toHaveLength(1);
    fireEvent.pointerDown(document.body); await advance(500); expect(panels()).toHaveLength(0);
  });

  it.each(['Enter', ' '])('pins an actual accessible Basics reference with %s and Escape dismisses it', async key => {
    const { anchor } = await boot();
    expect(anchor.getAttribute('role')).toBe('button'); expect(anchor.tabIndex).toBe(0);
    fireEvent.keyDown(anchor, { key }); await advance(0);
    expect(panels()).toHaveLength(1); expect(marker().dataset.snlPopoverFrozen).toBe('true');
    await escape(); expect(panels()).toHaveLength(0);
  });

  it('cancels a pending hover when the pointer leaves for ordinary content', async () => {
    const { anchor } = await boot();
    move(anchor); await advance(500);
    leave(anchor); await advance(1500);
    expect(panels()).toHaveLength(0);
  });

  it('retains the hover while the pointer enters its panel then disposes it on exit', async () => {
    const { anchor } = await boot(); await hover(anchor);
    fireEvent.mouseLeave(anchor.closest('[data-entry-body]')!); pointer(0, 0);
    await advance(1000); expect(panels()).toHaveLength(1);
    pointer(1000, 1000); await advance(2000);
    expect(panels()).toHaveLength(0);
  });

  it('closes an unpinned hover when the pointer leaves both anchor and panel', async () => {
    const { anchor } = await boot(); await hover(anchor);
    leave(anchor); await advance(2000);
    expect(panels()).toHaveLength(0);
  });

  it('stacks a child from the actual nested reference and records parent ownership', async () => {
    const { anchor } = await boot(); await hover(anchor);
    const parent = marker();
    await hover(semantic(panels()[0], 'entry-b'));
    expect(panels()).toHaveLength(2);
    expect(marker(panels()[1]).dataset.snlPopoverSubject).toBe('entry-b');
    expect(marker(panels()[1]).dataset.snlPopoverParentId).toBe(parent.dataset.snlPopoverId);
    expect(panels()[1].textContent).toContain('Body of entry-b');
    pointer(1000, 1000); await advance(2000);
    expect(panels()).toHaveLength(0);
  });

  it('does not invent a detail for references absent from the frozen closure', async () => {
    const value = snapshot(); value.entries = value.entries.filter(e => e.id !== 'entry-a');
    const view = mountReader(value);
    const anchor = await waitFor(() => semantic(view.container, 'entry-a'));
    vi.useFakeTimers(); await hover(anchor);
    expect(document.querySelector('[data-entry-id="entry-a"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Body of entry-a');
  });

  it('disposes pending work and portal roots when the reader unmounts', async () => {
    const { anchor, unmount } = await boot();
    move(anchor); unmount(); await advance(2000);
    expect(panels()).toHaveLength(0);
    fireEvent.click(anchor); await advance(2000); expect(panels()).toHaveLength(0);
  });

  it('does not leave pinned Library popovers over a newly routed Entry panel', async () => {
    const { anchor } = await boot(); fireEvent.click(anchor); await advance(0);
    expect(panels()).toHaveLength(1);
    navigate('#/entry/entry-b'); await advance(500);
    expect(screen.getByRole('button', { name: 'Back' })).toBeDefined();
    expect(panels()).toHaveLength(0);
  });

  it('uses the shared viewport-constrained frame; jsdom checks CSS, not painted geometry', async () => {
    const { anchor } = await boot(); await hover(anchor);
    const panel = panels()[0];
    expect(panel.style.boxSizing).toBe('border-box');
    expect(panel.style.maxWidth).toBe('min(720px, calc(100vw - 16px))');
    expect(panel.style.maxHeight).not.toBe('');
    expect(panel.style.overflowY).toBe('auto');
    expect(panel.querySelector('[data-entry-id="entry-a"]')).not.toBeNull();
  });

  it('reopens authored blocks with fresh state and isolates detached controls', async () => {
    const value = snapshot(); value.entries[1] = entry('entry-a', 'Fold(%Summary%, %Hidden detail%)');
    value.entries[0] = entry('root', 'Ref(x)'); value.library.outline = [node('root-node', value.entries[0])];
    const view = mountReader(value); const anchor = await waitFor(() => semantic(view.container, 'entry-a'));
    vi.useFakeTimers(); fireEvent.click(anchor); await advance(0);
    const panel = panels()[0];
    const toggle = panel.querySelector<HTMLButtonElement>('.snl-collapsible__summary > button')!;
    expect(toggle).not.toBeNull(); expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle); expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await escape(); fireEvent.click(anchor); await advance(0);
    const replacement = panels()[0].querySelector<HTMLButtonElement>('.snl-collapsible__summary > button')!;
    expect(replacement).not.toBe(toggle); expect(replacement.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle); expect(replacement.getAttribute('aria-expanded')).toBe('false');
    expect(panels()[0].querySelectorAll('[data-snl-collapsible-controls]')).toHaveLength(1);
  });
});
