import { fireEvent, render, screen, within } from '@testing-library/react';
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
  styles: [
    {
      style_name: 'default',

      template: { mode: 'formula_inline', body: name },
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

  it.each(['__proto__', 'constructor', 'toString', 'valueOf'])(
    'treats absent prototype-colliding Macro %s as unregistered through the rendered consumer',
    (name) => {
      expect(selectUsedMacros(name, {})).toEqual([]);
      const { container, unmount } = render(
        <EntryMacroSection
          snl={name}
          macros={{}}
          macroKinds={[] as MacroKind[]}
          entryPoolIds={new Set<string>()}
          postMessage={() => undefined}
        />
      );
      const q = within(container);
      fireEvent.click(q.getByRole('button', { name: /Macros/ }));
      expect(q.getByText(/No registered macros/)).toBeTruthy();
      unmount();
    }
  );

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

  it('renders its accessible section copy in Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    const { container } = render(
      <EntryMacroSection
        snl=""
        macros={{}}
        macroKinds={[] as MacroKind[]}
        entryPoolIds={new Set<string>()}
        postMessage={() => undefined}
      />,
      { container: document.body.appendChild(document.createElement('div')) }
    );
    const q = within(container);
    expect(q.getByRole('heading', { name: '宏' })).toBeTruthy();
    fireEvent.click(q.getByRole('button', { name: /宏/ }));
    expect(q.getByText(/没有使用已注册的宏/)).toBeTruthy();
    document.documentElement.lang = 'en';
  });
});
