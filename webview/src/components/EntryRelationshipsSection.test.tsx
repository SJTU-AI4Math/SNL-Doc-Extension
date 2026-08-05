import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  EntryRelationshipsSection,
  type EntryRelationshipRow
} from './EntryRelationshipsSection';

const row = (over: Partial<EntryRelationshipRow> = {}): EntryRelationshipRow => ({
  id: 'r1',
  label: 'depends',
  direction: 'outgoing',
  otherId: 'alpha',
  otherTitle: 'Alpha',
  ...over
});

/**
 * Render into a fresh container and return a scoped query set. Vitest runs
 * without globals here, so Testing Library's auto-cleanup is not installed
 * and unscoped `screen` queries would see every previous render.
 */
const mount = (
  relationships: EntryRelationshipRow[],
  onOpenEntry?: (id: string) => void
) => {
  const { container } = render(
    <EntryRelationshipsSection
      relationships={relationships}
      onOpenEntry={onOpenEntry}
    />,
    { container: document.body.appendChild(document.createElement('div')) }
  );
  const q = within(container);
  const toggle = q.getByRole('button', { name: /^Relationships \(/ });
  return { q, toggle, expand: () => fireEvent.click(toggle) };
};

describe('EntryRelationshipsSection', () => {
  it('shows the relationship count in the header', () => {
    const { toggle } = mount([row(), row({ id: 'r2' })]);
    expect(toggle.getAttribute('aria-label')).toMatch(/^Relationships \(2\)/);
  });

  it('renders a row per relationship with label, title and id', () => {
    const { q, expand } = mount([row()]);
    expand();
    expect(q.getAllByRole('listitem')).toHaveLength(1);
    expect(q.getByText('depends')).toBeTruthy();
    expect(q.getByText('Alpha')).toBeTruthy();
    expect(q.getByText('alpha')).toBeTruthy();
  });

  it('falls back to the id when the other entry has no title', () => {
    const { q, expand } = mount([row({ otherId: 'ghost', otherTitle: '' })]);
    expand();
    expect(q.getAllByText('ghost').length).toBeGreaterThan(0);
  });

  it('renders an empty-state hint instead of an empty list', () => {
    const { q, expand } = mount([]);
    expand();
    expect(q.queryByRole('list')).toBeNull();
    expect(q.getByText(/no relationships yet/i)).toBeTruthy();
  });

  it('keeps the body collapsed until the header is toggled', () => {
    const { q } = mount([row()]);
    expect(q.queryByRole('listitem')).toBeNull();
  });

  it('opens the other entry when a row is clicked', () => {
    const onOpenEntry = vi.fn();
    const { q, expand } = mount([row()], onOpenEntry);
    expand();
    fireEvent.click(q.getByRole('button', { name: 'Alpha' }));
    expect(onOpenEntry).toHaveBeenCalledWith('alpha');
  });

  it('renders whatever rows it is handed, with no client-side filtering', () => {
    // Direction filtering is the host's job (src/entryRelationships.ts); this
    // component must not silently drop incoming rows it was given.
    const { q, expand } = mount([
      row({ id: 'out', direction: 'outgoing' }),
      row({
        id: 'in',
        direction: 'incoming',
        label: 'proves',
        otherId: 'beta',
        otherTitle: 'Beta'
      })
    ]);
    expand();
    expect(q.getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders the relationship section and empty state in Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    const { container } = render(
      <EntryRelationshipsSection relationships={[]} />,
      { container: document.body.appendChild(document.createElement('div')) }
    );
    const q = within(container);
    const toggle = q.getByRole('button', { name: /^关系（0）/ });
    fireEvent.click(toggle);
    expect(q.getByText(/尚无关系/)).toBeTruthy();
    document.documentElement.lang = 'en';
  });
});
