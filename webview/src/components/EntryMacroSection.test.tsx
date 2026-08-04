import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  EntryMacroSection,
  selectUsedMacros
} from './EntryMacroSection';
import type {
  MacroKind,
  MacroPackageEntry
} from '../PackagePanelApp';

vi.mock('../PackagePanelApp', async () => {
  const ReactModule = await import('react');
  return {
    MacroTable: ({ macros }: { macros: MacroPackageEntry[] }) =>
      ReactModule.createElement(
        'div',
        { 'data-testid': 'shared-macro-table' },
        macros.map((macro) => ReactModule.createElement('span', { key: macro.name }, macro.name))
      )
  };
});

const macro = (name: string): MacroPackageEntry => ({
  name,
  description: `${name} description`,
  source: { entries: [], urls: [] },
  dynamic_arity: false,
  default_style: { en: 'default' },
  styles: [
    {
      style_name: 'default',
      mode: 'formula_inline',
      template: name,
      tags: []
    }
  ],
  tags: []
});

describe('EntryMacroSection', () => {
  it('limits the shared macro list to registered macros used by the entry', () => {
    const macros = { alpha: macro('alpha'), beta: macro('beta') };

    expect(selectUsedMacros('beta(missing,beta,alpha)', macros)).toEqual([
      macros.beta,
      macros.alpha
    ]);
  });

  it('renders the package-panel Macro List UI inside a collapsed Entry section', () => {
    const postMessage = vi.fn();
    render(
      <EntryMacroSection
        snl="alpha"
        macros={{ alpha: macro('alpha'), beta: macro('beta') }}
        macroKinds={[] as MacroKind[]}
        entryPoolIds={new Set<string>()}
        postMessage={postMessage}
      />
    );

    expect(screen.getByRole('heading', { name: 'Macros' })).toBeTruthy();
    expect(screen.queryByText('alpha')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Macros/ }));
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.queryByText('beta')).toBeNull();
  });
});
