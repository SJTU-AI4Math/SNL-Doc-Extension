import { cleanup, render, waitFor } from '@testing-library/react';
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
});
