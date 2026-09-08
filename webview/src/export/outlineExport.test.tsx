// Export routing now mounts the same LibraryLayer as the Extension. No HTML clone/move driver.
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupReader, entry, mountReader, navigate, node, setupReader, snapshot } from './sharedReaderFixture';

beforeEach(setupReader);
afterEach(cleanupReader);
const outlineSnapshot = () => {
  const entries = ['parent', 'middle', 'leaf', 'peer', 'peer-leaf'].map(id => entry(id));
  return snapshot({ entries, library: { slug: 'tree', title: 'Tree', warnings: [], outline: [
    node('parent-node', entries[0], [node('middle-node', entries[1], [node('leaf-node', entries[2])])]),
    node('peer-node', entries[3], [node('peer-leaf-node', entries[4])])
  ] } });
};
const routeNode = (id: string) => document.querySelector<HTMLElement>(`[data-snl-route-id="${id}"]`);

describe('exported shared Library outline', () => {
  it('starts closed and uses the real button and ARIA relationship for every parent', () => {
    mountReader(outlineSnapshot());
    expect(routeNode('leaf-node')).toBeNull();
    const outer = screen.getByRole('button', { name: 'Expand parent' });
    expect(outer.getAttribute('aria-expanded')).toBe('false');
    expect(outer.title).toBe('Expand 2 children');
    fireEvent.click(outer);
    expect(outer.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(outer.getAttribute('aria-controls')!)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Expand middle' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Expand middle' }));
    expect(routeNode('leaf-node')).not.toBeNull();
    fireEvent.click(outer);
    // React removes the subtree, avoiding hidden/display:flex specificity bugs.
    expect(document.getElementById(outer.getAttribute('aria-controls')!)).toBeNull();
    fireEvent.click(outer);
    expect(routeNode('leaf-node')).not.toBeNull();
  });

  it('keeps nested collapse independent and Ctrl-click affects only same-depth peers', () => {
    mountReader(outlineSnapshot());
    fireEvent.click(screen.getByRole('button', { name: 'Expand parent' }), { ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Collapse peer' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Expand middle' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Expand middle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse middle' }));
    expect(routeNode('leaf-node')).toBeNull();
    expect(routeNode('peer-leaf-node')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Collapse parent' })).toBeDefined();
  });

  it('bulk controls expand/collapse the entire structural tree without editing raw data', () => {
    const value = outlineSnapshot(); const original = JSON.stringify(value);
    mountReader(value);
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(routeNode('leaf-node')).not.toBeNull(); expect(routeNode('peer-leaf-node')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Expand all' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(routeNode('middle-node')).toBeNull(); expect(routeNode('peer-leaf-node')).toBeNull();
    expect(JSON.stringify(value)).toBe(original);
  });

  it('deep links reveal nested occurrences in place and never clone or move a React card', () => {
    const clone = vi.spyOn(Node.prototype, 'cloneNode');
    mountReader(outlineSnapshot(), '#/node/leaf-node');
    const child = routeNode('leaf-node')!; const parent = child.parentElement;
    expect(child).not.toBeNull();
    expect(child.closest('#library-outline-children-middle-node')).not.toBeNull();
    navigate('#/library', 'popstate');
    expect(routeNode('leaf-node')).toBe(child); expect(child.parentElement).toBe(parent);
    expect(clone).not.toHaveBeenCalled();
  });

  it('addresses duplicate Entry occurrences by node identity, including encoded slash and space', () => {
    const shared = entry('shared-entry');
    const scrolled: Element[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
    try {
      mountReader(snapshot({ entries: [shared], library: { slug: 'duplicates', title: 'Duplicates', warnings: [], outline: [
        node('first occurrence', shared), node('second/occurrence', shared)
      ] } }), '#/node/second%2Foccurrence');
      const first = routeNode('first occurrence')!; const second = routeNode('second/occurrence')!;
      expect(first.dataset.snlEntryId).toBe('shared-entry'); expect(second.dataset.snlEntryId).toBe('shared-entry');
      expect(scrolled.at(-1)).toBe(second);
      navigate('#/node/first%20occurrence'); expect(scrolled.at(-1)).toBe(first);
      fireEvent.click(within(second).getByText('shared-entry', { exact: true }), { ctrlKey: true });
      expect(location.hash).toContain('#/entry/shared-entry?return=');
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(location.hash).toBe('#/node/second%2Foccurrence');
      expect(routeNode('second/occurrence')).toBe(second);
    } finally { HTMLElement.prototype.scrollIntoView = original; }
  });

  it('unknown and malformed node routes keep the Library usable', () => {
    mountReader(outlineSnapshot(), '#/node/not-in-snapshot');
    expect(screen.getByRole('button', { name: 'Expand parent' })).toBeDefined();
    navigate('#/node/%broken');
    fireEvent.click(screen.getByRole('button', { name: 'Expand parent' }));
    expect(routeNode('middle-node')).not.toBeNull();
  });
});
