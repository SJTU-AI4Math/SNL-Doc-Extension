import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MacroDataDriver, type SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import { GuiCanvasEditor } from '../CreateEntryApp';

const driver = new MacroDataDriver({ queries: { query_macro: async () => null } });

const node = (macro_name: string, children: SnlSyntaxTree[] = []): SnlSyntaxTree => ({
  macro_name,
  kind: '',
  mdata: null,
  children
});

const projectionMacro = {
  name: 'projection',
  description: '',
  source: { entries: [], urls: [] },
  tags: [],
  dynamic_arity: false,
  styles: [
    {
      style_name: 'default', tags: [],
      mode: 'formula_inline', template: '#0'
    },
    {
      style_name: 'complete', tags: [],
      mode: 'formula_inline', template: '#0 + #1 + #2'
    }
  ]
} as never;

const projectionDriver = new MacroDataDriver({
  queries: {
    query_macro: async ({ macro_name }: { macro_name: string }) =>
      macro_name === 'projection' ? projectionMacro : null
  }
});

afterEach(cleanup);

describe('Canvas production renderer integration', () => {
  it('renders a temporary Macro child exactly once', async () => {
    const temporary: SnlSyntaxTree = {
      ...node('#0', [node('unique-child-token')]),
      env_mode: 'text'
    };
    const view = render(
      <GuiCanvasEditor
        forest={[temporary]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    await waitFor(() => {
      const matches = Array.from(view.container.querySelectorAll('[data-name="unique-child-token"]'));
      expect(matches).toHaveLength(1);
    });
  });

  it('exposes children omitted by the active render style as structural Canvas nodes', async () => {
    const hiddenChild: SnlSyntaxTree = {
      ...node('hidden-child'),
      env_mode: 'text'
    };
    const view = render(
      <GuiCanvasEditor
        forest={[node('projection', [node('shown-child'), hiddenChild])]}
        macroDataDriver={projectionDriver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );

    await waitFor(() => {
      expect(view.container.querySelector('[data-tree-path="0"]')).toBeTruthy();
      expect(view.container.querySelector('[data-tree-path="1"]')).toBeTruthy();
    });
    expect(view.container.querySelectorAll('[data-tree-path="0"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-tree-path="1"]')).toHaveLength(1);
    const hiddenTarget = view.container.querySelector<HTMLElement>(
      '[data-canvas-structural-fallback="1"]'
    )!;
    fireEvent.click(hiddenTarget);
    expect(hiddenTarget.classList.contains('snl-canvas-focused')).toBe(true);
    fireEvent.keyDown(view.getByLabelText('GUI Editor canvas'), { key: 'F2' });
    const editor = await view.findByRole('textbox', { name: 'Edit focused SNL' });
    expect((editor as HTMLTextAreaElement).value).toBe('%hidden-child%');
  });

  it('keeps nested and sibling omitted paths unique, then removes fallbacks when Style exposes them', async () => {
    const text = (name: string): SnlSyntaxTree => ({ ...node(name), env_mode: 'text' });
    function Harness(): React.ReactElement {
      const [complete, setComplete] = React.useState(false);
      const nested: SnlSyntaxTree = {
        ...node('projection', [text('nested-shown'), text('nested-hidden')]),
        style_name: 'default'
      };
      const root: SnlSyntaxTree = {
        ...node('projection', [nested, text('sibling-hidden'), text('second-hidden')]),
        style_name: complete ? 'complete' : 'default'
      };
      return (
        <>
          <button type="button" onClick={() => setComplete(true)}>show all root arguments</button>
          <GuiCanvasEditor
            forest={[root]}
            macroDataDriver={projectionDriver}
            kindPalette={undefined}
            onForestChange={() => undefined}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);

    await waitFor(() => {
      for (const path of ['0.1', '1', '2']) {
        expect(view.container.querySelector(`[data-canvas-structural-fallback="${path}"]`))
          .toBeTruthy();
      }
    });
    for (const path of ['0', '0.0', '0.1', '1', '2']) {
      expect(view.container.querySelectorAll(`[data-tree-path="${path}"]`)).toHaveLength(1);
    }

    fireEvent.click(view.getByRole('button', { name: 'show all root arguments' }));
    await waitFor(() => {
      expect(view.container.querySelector('[data-canvas-structural-fallback="1"]')).toBeNull();
      expect(view.container.querySelector('[data-canvas-structural-fallback="2"]')).toBeNull();
    });
    expect(view.container.querySelector('[data-canvas-structural-fallback="0.1"]')).toBeTruthy();
    for (const path of ['0', '0.0', '0.1', '1', '2']) {
      expect(view.container.querySelectorAll(`[data-tree-path="${path}"]`)).toHaveLength(1);
    }
  });
});
