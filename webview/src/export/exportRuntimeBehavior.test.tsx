import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { advance, cleanupReader, entry, mountReader, move, navigate, node, panels, semantic, setupReader, snapshot } from './sharedReaderFixture';

beforeEach(setupReader);
afterEach(cleanupReader);
const blocks = 'Group(Fold(%Outer%, Fold(%Inner%, %Nested body%), %Outer body%), Fold(%Peer%, %Peer body%))';
async function blockReader(snl = blocks) {
  const value = snapshot(); const root = entry('root', snl);
  value.entries[0] = root; value.library.outline = [node('root-node', root)];
  const view = mountReader(value);
  await waitFor(() => expect(view.container.querySelector('.snl-collapsible')).not.toBeNull());
  return view;
}
const hosts = () => Array.from(document.querySelectorAll<HTMLElement>('.snl-collapsible'));
const toggle = (host: Element) => host.querySelector<HTMLButtonElement>(':scope > .snl-collapsible__summary > button')!;
const body = (host: Element) => host.querySelector<HTMLElement>(':scope > .snl-collapsible__body')!;

describe('exported BrowserReader uses native Entry/Basics behavior', () => {
  it('renders authored collapsibles closed with the shared summary gutter and accessible controls', async () => {
    await blockReader(); expect(hosts()).toHaveLength(3);
    for (const host of hosts()) {
      expect(toggle(host)).not.toBeNull(); expect(toggle(host).getAttribute('aria-expanded')).toBe('false');
      expect(body(host).hidden).toBe(true);
      expect(document.getElementById(toggle(host).getAttribute('aria-controls')!)).toBe(body(host));
    }
    expect(body(hosts()[0]).textContent).toContain('Outer body');
  });

  it('collapses/reopens a block whose body is not the outline subtree, without losing nested state', async () => {
    await blockReader(); const [outer, inner, peer] = hosts();
    fireEvent.click(toggle(outer)); expect(body(outer).hidden).toBe(false); expect(body(inner).hidden).toBe(true);
    fireEvent.click(toggle(inner)); expect(body(inner).hidden).toBe(false); expect(body(peer).hidden).toBe(true);
    fireEvent.click(toggle(outer)); expect(body(outer).hidden).toBe(true);
    fireEvent.click(toggle(outer)); expect(body(inner).hidden).toBe(false);
  });

  it('Ctrl-click changes authored same-depth peers, not nested blocks', async () => {
    await blockReader(); const [outer, inner, peer] = hosts();
    fireEvent.click(toggle(outer), { ctrlKey: true });
    expect(body(outer).hidden).toBe(false); expect(body(peer).hidden).toBe(false); expect(body(inner).hidden).toBe(true);
    fireEvent.click(toggle(inner), { ctrlKey: true });
    expect(body(inner).hidden).toBe(false); expect(body(outer).hidden).toBe(false);
  });

  it('keeps one contextual bulk control pair per Entry render scope', async () => {
    await blockReader();
    const controls = document.querySelectorAll<HTMLElement>('[data-snl-collapsible-controls]'); expect(controls).toHaveLength(1);
    const expand = within(controls[0]).getByRole('button', { name: 'Expand all collapsible blocks in Entry root' });
    const collapse = within(controls[0]).getByRole('button', { name: 'Collapse all collapsible blocks in Entry root' });
    fireEvent.click(expand); expect(hosts().every(h => !body(h).hidden)).toBe(true);
    expect((expand as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(collapse); expect(hosts().every(h => body(h).hidden)).toBe(true);
  });

  it('adds no authored-block bulk controls to an Entry without foldable content', async () => {
    const view = mountReader(); await waitFor(() => semantic(view.container, 'entry-a'));
    expect(document.querySelectorAll('[data-snl-collapsible-controls]')).toHaveLength(0);
  });

  it('separates Library and Entry routes, supports direct refresh, history and unknown Entry state', async () => {
    mountReader(snapshot(), '#/entry/entry-b');
    expect(screen.getByRole('button', { name: 'Back' })).toBeDefined();
    expect(screen.getByText('Body of entry-b')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Back' })); expect(location.hash).toBe('#/library');
    navigate('#/entry/entry-b', 'popstate'); expect(screen.getByText('Body of entry-b')).toBeDefined();
    navigate('#/entry/absent'); expect(screen.getByText('Entry not found in this workspace.')).toBeDefined();
    navigate('#/library', 'popstate'); expect(screen.getByText('Frozen Library')).toBeDefined();
  });

  it('Ctrl-clicks source references into the Entry reader rather than navigating a legacy DOM outlet', async () => {
    const view = mountReader(); const anchor = await waitFor(() => semantic(view.container, 'entry-a'));
    fireEvent.click(anchor, { ctrlKey: true });
    expect(location.hash).toContain('#/entry/entry-a');
    expect(screen.getByRole('button', { name: 'Back' })).toBeDefined();
    expect(document.querySelector('[data-snl-route-outlet]')).toBeNull();
  });

  it('derives collapsed relationship sections from raw edges and renders related Entries canonically', () => {
    const value = snapshot({ relationships: [{ id: 'relationship-a', from: 'root', to: 'entry-b', label: 'uses_context', metadata: { isAtomic: true } }] });
    mountReader(value, '#/entry/root');
    const control = screen.getByRole('button', { name: 'Context · Outgoing' });
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-relationship-id="relationship-a"]')).toBeNull();
    fireEvent.click(control);
    const row = document.querySelector<HTMLElement>('[data-relationship-id="relationship-a"]')!;
    expect(row.querySelector('[data-entry-id="entry-b"]')).not.toBeNull(); expect(row.textContent).toContain('atomic');
    fireEvent.click(within(row).getByText('entry-b', { exact: true }), { ctrlKey: true });
    expect(location.hash).toContain('#/entry/entry-b');
  });

  it('rerenders theme and independent UI/content languages from raw localized data', async () => {
    await blockReader();
    const card = () => document.querySelector<HTMLElement>('[data-entry-id="root"]')!;
    fireEvent.click(screen.getByRole('button', { name: 'Reading preferences' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), { target: { value: 'dark' } });
    expect(document.documentElement.dataset.snlColorScheme).toBe('dark');
    await waitFor(() => expect(card().style.background).toBe('rgb(26, 36, 51)'));
    fireEvent.click(screen.getByRole('button', { name: /^Interface language:/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /简体中文/ }));
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(screen.getByRole('button', { name: '阅读偏好' })).toBeDefined();
    expect(card().textContent).toContain('root'); expect(card().textContent).not.toContain('中文root');
    fireEvent.click(screen.getByRole('button', { name: /^内容语言:/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /简体中文/ }));
    await waitFor(() => expect(card().textContent).toContain('中文root'));
    expect(card().textContent).toContain('定义');
    await waitFor(() => expect(hosts()).toHaveLength(3));
    expect(within(card()).queryByRole('button', { name: /编辑|Edit/ })).toBeNull();
    expect(document.querySelectorAll('[data-snl-collapsible-controls]')).toHaveLength(1);
  });

  it('retains the mounted Entry and authored fold state across a theme change', async () => {
    await blockReader();
    const card = document.querySelector('[data-entry-id="root"]');
    fireEvent.click(toggle(hosts()[0]));
    fireEvent.click(screen.getByRole('button', { name: 'Reading preferences' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), { target: { value: 'dark' } });
    await waitFor(() => expect(hosts()).toHaveLength(3));
    expect(body(hosts()[0]).hidden).toBe(false);
    expect(document.querySelector('[data-entry-id="root"]')).toBe(card);
  });

  it('keeps binder declarations and bound-variable clicks from tunneling into a source-backed macro', async () => {
    const value = snapshot(); const root = entry('root', 'Ref(@x, x)');
    value.macros.Ref.styles[0].template = { mode: 'formula_inline', body: '#0 #1' };
    value.entries[0] = root; value.library.outline = [node('root-node', root)];
    const view = mountReader(value);
    await waitFor(() => expect(view.container.querySelector('[data-kind="bvar"]')).not.toBeNull());
    vi.useFakeTimers();
    for (const target of view.container.querySelectorAll<HTMLElement>('[data-kind="binder"], [data-kind="bvar"]')) {
      move(target); await advance(1010); expect(panels()).toHaveLength(0);
      fireEvent.click(target); fireEvent.click(target, { ctrlKey: true });
      expect(location.hash).toBe('#/library'); expect(panels()).toHaveLength(0);
    }
  });

  it('highlights the bound occurrence and declaration only in its own parsed scope', async () => {
    const value = snapshot(); const root = entry('root', 'Group(Ref(@x, x), Ref(@x, x))');
    value.macros.Ref.styles[0].template = { mode: 'formula_inline', body: '#0 #1' };
    value.entries[0] = root; value.library.outline = [node('root-node', root)];
    const view = mountReader(value);
    await waitFor(() => expect(view.container.querySelectorAll('[data-kind="bvar"]')).toHaveLength(2));
    const [first, second] = view.container.querySelectorAll<HTMLElement>('[data-kind="bvar"]');
    const [firstBinder, secondBinder] = view.container.querySelectorAll<HTMLElement>('[data-kind="binder"]');
    vi.useFakeTimers();
    move(first);
    expect(first.classList.contains('snl-single-hover')).toBe(true);
    expect(firstBinder.classList.contains('snl-binder-decl')).toBe(false);
    await advance(1010);
    expect(firstBinder.classList.contains('snl-binder-decl')).toBe(true);
    expect(first.classList.contains('snl-bvar-scope')).toBe(false);
    await advance(1000);
    expect(first.classList.contains('snl-bvar-scope')).toBe(true);
    expect(firstBinder.classList.contains('snl-binder-decl')).toBe(true);
    expect(second.classList.contains('snl-bvar-scope')).toBe(false);
    expect(secondBinder.classList.contains('snl-binder-decl')).toBe(false);
    const bodyElement = first.closest<HTMLElement>('[data-entry-body]')!;
    expect(bodyElement.querySelector('[style*="--snl-base-text-color"]')).not.toBeNull();
    // Basics locks phase 2; an outside primary-pointer interaction releases it.
    fireEvent.pointerDown(document.body);
    await advance(0);
    fireEvent.mouseLeave(bodyElement);
    expect(view.container.querySelectorAll('.snl-bvar-scope, .snl-binder-decl')).toHaveLength(0);
  });

  it('keeps a free variable single-node hover from acquiring another binder scope', async () => {
    const value = snapshot(); const root = entry('root', 'Group(x, Ref(@x, x))');
    value.macros.Ref.styles[0].template = { mode: 'formula_inline', body: '#0 #1' };
    value.entries[0] = root; value.library.outline = [node('root-node', root)];
    const view = mountReader(value);
    const orphan = await waitFor(() => {
      const target = view.container.querySelector<HTMLElement>('[data-kind="fvar"][data-name="x"]');
      expect(target).not.toBeNull(); return target!;
    });
    move(orphan);
    expect(view.container.querySelectorAll('.snl-bvar-scope, .snl-binder-decl')).toHaveLength(0);
    expect(view.container.querySelectorAll('.snl-single-hover')).toHaveLength(1);
  });

  it('never enables host authoring/graph/export actions in the frozen reader', () => {
    mountReader();
    expect(screen.queryByRole('button', { name: /Edit this Library|View Graph|Export HTML/ })).toBeNull();
    expect(screen.getByRole('note').textContent).toContain('Source is not included');
  });
});
