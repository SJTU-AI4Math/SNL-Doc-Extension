import { describe, it, expect, vi } from 'vitest';
import { buildPopoverClosure, collectEntryRefs } from './popoverClosure';

/** Fake renderer: a static id → markup table, so the WALK is what is tested. */
function renderer(table: Record<string, string>) {
  const calls: string[] = [];
  const renderEntry = vi.fn(async (id: string) => {
    calls.push(id);
    return Object.prototype.hasOwnProperty.call(table, id) ? table[id] : null;
  });
  return { renderEntry, calls };
}

const ref = (id: string): string => `<span data-src="${id}">x</span>`;

describe('collectEntryRefs', () => {
  it('finds references in both quote styles and de-duplicates', () => {
    expect(
      collectEntryRefs(`<i data-src="a"></i><i data-src='b'></i><i data-src="a"></i>`)
    ).toEqual(['a', 'b']);
  });

  it('ignores attributes that merely end in data-src', () => {
    expect(collectEntryRefs('<i data-notdata-src="a"></i>')).toEqual([]);
  });

  it('ignores empty references', () => {
    expect(collectEntryRefs('<i data-src=""></i>')).toEqual([]);
  });
});

describe('buildPopoverClosure', () => {
  it('renders entries referenced directly by the document body', async () => {
    const { renderEntry } = renderer({ a: '<p>A</p>' });
    const result = await buildPopoverClosure(ref('a'), { renderEntry });
    expect(Object.keys(result.fragments)).toEqual(['a']);
    expect(result.fragments.a).toBe('<p>A</p>');
  });

  it('follows indirect references A→B→C to a fixed point', async () => {
    // The whole reason discovery and rendering interleave: B's reference to C
    // is only visible in B's RENDERED markup, not in the body.
    const { renderEntry } = renderer({
      a: `<p>A${ref('b')}</p>`,
      b: `<p>B${ref('c')}</p>`,
      c: '<p>C</p>'
    });
    const result = await buildPopoverClosure(ref('a'), { renderEntry });
    expect(Object.keys(result.fragments).sort()).toEqual(['a', 'b', 'c']);
  });

  it('terminates on a cycle A→B→A and renders each side once', async () => {
    const { renderEntry, calls } = renderer({
      a: `<p>A${ref('b')}</p>`,
      b: `<p>B${ref('a')}</p>`
    });
    const result = await buildPopoverClosure(ref('a'), { renderEntry });
    expect(Object.keys(result.fragments).sort()).toEqual(['a', 'b']);
    expect(calls).toEqual(['a', 'b']);
  });

  it('terminates on a self-reference A→A', async () => {
    const { renderEntry, calls } = renderer({ a: `<p>A${ref('a')}</p>` });
    const result = await buildPopoverClosure(ref('a'), { renderEntry });
    expect(calls).toEqual(['a']);
    expect(Object.keys(result.fragments)).toEqual(['a']);
  });

  it('records an unknown id as missing without failing the export', async () => {
    const { renderEntry } = renderer({ a: `<p>A${ref('ghost')}</p>` });
    const result = await buildPopoverClosure(ref('a'), { renderEntry });
    expect(result.missing).toEqual(['ghost']);
    expect(Object.keys(result.fragments)).toEqual(['a']);
  });

  it('survives a renderer that throws', async () => {
    const renderEntry = vi.fn(async (id: string) => {
      if (id === 'boom') throw new Error('nope');
      return '<p>ok</p>';
    });
    const result = await buildPopoverClosure(`${ref('boom')}${ref('fine')}`, {
      renderEntry
    });
    expect(result.missing).toEqual(['boom']);
    expect(result.fragments.fine).toBe('<p>ok</p>');
  });

  it('asks for each entry only once when two paths reach it', async () => {
    const { renderEntry, calls } = renderer({
      a: `<p>${ref('d')}</p>`,
      b: `<p>${ref('d')}</p>`,
      d: '<p>D</p>'
    });
    await buildPopoverClosure(`${ref('a')}${ref('b')}`, { renderEntry });
    expect(calls.filter((id) => id === 'd')).toHaveLength(1);
  });

  it('cancels an obsolete walk before rendering the next Entry', async () => {
    let cancelled = false;
    const calls: string[] = [];
    const result = await buildPopoverClosure(ref('a'), {
      isCancelled: () => cancelled,
      renderEntry: async (id) => {
        calls.push(id);
        cancelled = true;
        return ref('b');
      }
    });
    expect(calls).toEqual(['a']);
    expect(result.truncated).toBe(true);
    expect(result.fragments.b).toBeUndefined();
  });

  it('stops at maxEntries rather than walking a pathological library', async () => {
    const table: Record<string, string> = {};
    for (let i = 0; i < 20; i++) table[`e${i}`] = `<p>${ref(`e${i + 1}`)}</p>`;
    const { renderEntry } = renderer(table);
    const result = await buildPopoverClosure(ref('e0'), {
      renderEntry,
      maxEntries: 3
    });
    expect(result.truncated).toBe(true);
    expect(Object.keys(result.fragments)).toHaveLength(3);
  });
});
