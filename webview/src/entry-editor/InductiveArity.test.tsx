
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MacroDataDriver } from '@sjtu-ai4math/snl-basics';
import { GuiInductiveEditor } from '../CreateEntryApp';

afterEach(cleanup);

const macro = (name: string, dynamic: boolean, template: string): never => ({
  name,
  description: '',
  source: { entries: [], urls: [] },
  tags: [],
  dynamic_arity: dynamic,
  styles: [{ style_name: 'default', mode: 'formula_inline', template, tags: [] }]
} as never);

const driver = new MacroDataDriver({
  queries: {
    query_macro: async ({ macro_name }: { macro_name: string }) => {
      if (macro_name === 'pair') return macro('pair', false, '#0 + #1');
      if (macro_name === 'triple') return macro('triple', false, '#0 #1 #2');
      if (macro_name === 'neg') return macro('neg', false, '-#0');
      // Variadic but with a leading fixed slot, so ignoring dynamic_arity
      // would wrongly open a row.
      if (macro_name === 'list') return macro('list', true, '#0: #*');
      if (macro_name === 'atom') return macro('atom', false, 'A');
      if (macro_name === 'top') return macro('top', false, '#0 , #1');
      if (macro_name === 'top3') return macro('top3', false, '#0 #1 #2');
      if (macro_name === 'styled') {
        return {
          name: 'styled',
          description: '',
          source: { entries: [], urls: [] },
          tags: [],
          dynamic_arity: false,
          styles: [
            { style_name: 'default', mode: 'formula_inline', template: 'S', tags: [] },
            { style_name: 'compact', mode: 'formula_inline', template: 's', tags: [] }
          ]
        } as never;
      }
      return null;
    }
  }
});

function renderEditor(initial: string): { view: ReturnType<typeof render>; latest: () => string } {
  let latest = initial;
  const view = render(
    <GuiInductiveEditor
      snl={initial}
      macroDataDriver={driver}
      macroCandidates={[{ id: 'pair', labels: [] }]}
      macroOrigin={{}}
      onOpenMacroEditor={() => undefined}
      onChange={(next) => { latest = next; }}
    />
  );
  return { view, latest: () => latest };
}

describe('Inductive editor arity auto-fill', () => {
  it('keeps Macro identity and Style in separate input channels', async () => {
    const { view, latest } = renderEditor('styled');
    const macroInput = view.getAllByRole('textbox')[0] as HTMLInputElement;
    expect(macroInput.value).toBe('styled');
    expect(macroInput.value).not.toContain('[');
    fireEvent.change(macroInput, { target: { value: 'styled[compact]' } });
    expect(latest()).toBe('styled');

    const style = await waitFor(() =>
      view.getByRole('combobox', { name: 'Macro style for styled' }) as HTMLSelectElement
    );
    expect(style.value).toBe('default');
    expect(Array.from(style.options).map((option) => option.value)).toEqual([
      'default',
      'compact'
    ]);
    fireEvent.change(style, { target: { value: 'compact' } });
    expect(latest()).toBe('styled[compact]');
    expect(macroInput.value).toBe('styled');
    fireEvent.change(style, { target: { value: 'default' } });
    expect(latest()).toBe('styled');
  });

  it('opens child rows once a fixed-arity Macro is matched', async () => {
    let latest = '';
    const view = render(
      <GuiInductiveEditor
        snl="x"
        macroDataDriver={driver}
        macroCandidates={[{ id: 'pair', labels: [] }]}
        macroOrigin={{}}
        onOpenMacroEditor={() => undefined}
        onChange={(next) => { latest = next; }}
      />
    );
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'pair' } });

    await waitFor(() => expect(latest).toBe('pair(,)'), { timeout: 2000 });
  });

  it('opens the right number of rows for a three-argument Macro', async () => {
    const { view, latest } = renderEditor('x');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'triple' } });
    await waitFor(() => expect(latest()).toBe('triple(,,)'), { timeout: 2000 });
  });

  it('opens a row for a one-argument Macro', async () => {
    const { view, latest } = renderEditor('x');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'neg' } });
    // A lone empty slot is pruned on serialize (it has no surface form), so
    // the SNL stays `neg` — but the editor row must still be there to type in.
    await waitFor(() => expect(view.getAllByRole('textbox').length).toBeGreaterThan(1), { timeout: 2000 });
    expect(latest()).toBe('neg');
  });

  it('leaves a variadic Macro alone — its count is the author\'s to set', async () => {
    const { view, latest } = renderEditor('x');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    const before = view.getAllByRole('textbox').length;
    fireEvent.change(box, { target: { value: 'list' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // `list` renders as `#0: #*`, so a template scan alone would open a row.
    // dynamic_arity must veto that — the count is the author's to set.
    expect(view.getAllByRole('textbox').length).toBe(before);
    expect(latest()).toBe('list');
  });

  it('adds no rows for a Macro that takes no arguments', async () => {
    const { view, latest } = renderEditor('x');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'atom' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(latest()).toBe('atom');
  });

  it('never removes rows the author already filled in', async () => {
    // `pair` needs 2; the tree already has 3. Auto-fill only ever grows.
    const { view, latest } = renderEditor('x(a,b,c)');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'pair' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(latest()).toBe('pair(a,b,c)');
  });

  it('does not churn the tree when the arity is already satisfied', async () => {
    // Re-resolving a Macro whose rows already exist must not emit a change;
    // an unguarded effect would fire onChange on every render.
    let changes = 0;
    const view = render(
      <GuiInductiveEditor
        snl="pair(a,b)"
        macroDataDriver={driver}
        macroCandidates={[]}
        macroOrigin={{}}
        onOpenMacroEditor={() => undefined}
        onChange={() => { changes += 1; }}
      />
    );
    await waitFor(() => expect(view.getAllByRole('textbox').length).toBeGreaterThan(2));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(changes).toBe(0);
  });

  it('reclaims empty slots when one Macro is retyped over another', async () => {
    // pair opens two rows; atom needs none, and leaving them behind would
    // serialize as `atom(,)`. Reported by review 2026-07-25.
    const { view, latest } = renderEditor('x');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'pair' } });
    await waitFor(() => expect(latest()).toBe('pair(,)'), { timeout: 2000 });

    fireEvent.change(box, { target: { value: 'atom' } });
    await waitFor(() => expect(latest()).toBe('atom'), { timeout: 2000 });
  });

  it('shrinks to the new Macro\'s arity rather than clearing outright', async () => {
    const { view, latest } = renderEditor('x');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'triple' } });
    await waitFor(() => expect(latest()).toBe('triple(,,)'), { timeout: 2000 });

    fireEvent.change(box, { target: { value: 'pair' } });
    await waitFor(() => expect(latest()).toBe('pair(,)'), { timeout: 2000 });
  });

  it('never discards a slot the author already filled in', async () => {
    const { view, latest } = renderEditor('x(a,b)');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    // `atom` wants zero arguments, but both rows have content — keep them and
    // let the author decide, rather than silently deleting their work.
    fireEvent.change(box, { target: { value: 'atom' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(latest()).toBe('atom(a,b)');
  });

  it('keeps a filled slot even when a later slot is empty', async () => {
    const { view, latest } = renderEditor('x(a,)');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'atom' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The surplus starts at index 0 and is not entirely empty, so nothing goes.
    expect(latest()).toBe('atom(a,)');
  });

  // The production driver is a long-lived useMemo with an LRU cache, so the
  // second lookup of a name is a fast cache hit while a previous MISS may
  // still be in flight. Both bugs below were found by review 2026-07-25 and
  // are invisible to a fresh-driver test.
  describe('under a warm cache and out-of-order answers', () => {
    const slowDriver = new MacroDataDriver({
      queries: {
        query_macro: async ({ macro_name }: { macro_name: string }) => {
          if (macro_name === 'pair') {
            await new Promise((resolve) => setTimeout(resolve, 120));
            return macro('pair', false, '#0 + #1');
          }
          if (macro_name === 'atom') {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return macro('atom', false, 'A');
          }
          if (macro_name === 'list') {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return macro('list', true, '#0: #*');
          }
          return null;
        }
      }
    });

    function renderWith(initial: string): { view: ReturnType<typeof render>; latest: () => string } {
      let latest = initial;
      const view = render(
        <GuiInductiveEditor
          snl={initial}
          macroDataDriver={slowDriver}
          macroCandidates={[]}
          macroOrigin={{}}
          onOpenMacroEditor={() => undefined}
          onChange={(next) => { latest = next; }}
        />
      );
      return { view, latest: () => latest };
    }

    it('still opens slots on a second session with the same driver', async () => {
      const first = renderWith('x');
      fireEvent.change(first.view.getAllByRole('textbox')[0], { target: { value: 'pair' } });
      await waitFor(() => expect(first.latest()).toBe('pair(,)'), { timeout: 3000 });
      cleanup();

      // Warm cache: `pair` now resolves almost instantly, so a stale answer
      // for the initial name could arrive afterwards and wipe it out.
      const second = renderWith('x');
      fireEvent.change(second.view.getAllByRole('textbox')[0], { target: { value: 'pair' } });
      await waitFor(() => expect(second.latest()).toBe('pair(,)'), { timeout: 3000 });
    });

    it('does not let a slow Macro open slots on the name that replaced it', async () => {
      const { view, latest } = renderWith('x');
      const box = view.getAllByRole('textbox')[0] as HTMLInputElement;
      fireEvent.change(box, { target: { value: 'pair' } });
      // Switch away before `pair` resolves; its late answer must be discarded.
      fireEvent.change(box, { target: { value: 'atom' } });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(latest()).toBe('atom');
    });

    it('does not let a slow fixed-arity Macro open slots on a variadic one', async () => {
      const { view, latest } = renderWith('x');
      const box = view.getAllByRole('textbox')[0] as HTMLInputElement;
      fireEvent.change(box, { target: { value: 'pair' } });
      fireEvent.change(box, { target: { value: 'list' } });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(latest()).toBe('list');
    });
  });

  it('lets the author add a child to a fixed-arity row without it snapping back', async () => {
    // The surplus reclaim must not fight the `+ child` button: it applies to
    // a Macro change, not to every render. Review 2026-07-25.
    const { view, latest } = renderEditor('x');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'pair' } });
    await waitFor(() => expect(latest()).toBe('pair(,)'), { timeout: 2000 });

    fireEvent.click(view.getAllByLabelText('Choose add position')[0]);
    fireEvent.click(view.getByRole('menuitem', { name: 'Add child' }));
    await waitFor(() => expect(latest()).toBe('pair(,,)'), { timeout: 2000 });
    // And it stays: nothing reclaims it on a later render.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(latest()).toBe('pair(,,)');
  });

  // Every unfilled sibling's auto-fill effect fires in the SAME commit. When
  // those writes went through `onChange({...node})` each one overwrote the
  // previous sibling's result and only the last row got its slots — a lost
  // update. Found by review 2026-07-25.
  describe('several siblings resolving at once', () => {
    it('gives every sibling its slots, not just the last one', async () => {
      const { latest } = renderEditor('top(pair,triple)');
      await waitFor(() => expect(latest()).toBe('top(pair(,),triple(,,))'), { timeout: 3000 });
    });

    it('holds up with three identical siblings', async () => {
      const { latest } = renderEditor('top3(pair,pair,pair)');
      await waitFor(() => expect(latest()).toBe('top3(pair(,),pair(,),pair(,))'), { timeout: 3000 });
    });

    it('fills a nested row without dropping its parent\'s other branch', async () => {
      const { latest } = renderEditor('top(pair,top(pair,triple))');
      await waitFor(
        () => expect(latest()).toBe('top(pair(,),top(pair(,),triple(,,)))'),
        { timeout: 3000 }
      );
    });
  });
});
