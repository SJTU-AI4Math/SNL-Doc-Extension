// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntrySurface } from './EntrySurface';
import { HoverPopoverProvider } from './HoverPopoverProvider';
import type { EntryData } from './EntryRender';
import type { MacroRecord } from './macroData';

afterEach(cleanup);

const macros: MacroRecord = {
  Fold: {
    name: 'Fold',
    description: 'Authored Collapsible block',
    source: { entries: [], urls: [] },
    dynamic_arity: true,
    tags: [],
    styles: [{
      style_name: 'default',
      tags: [],
      template: {
        mode: 'block',
        body: '#*',
        separator: '',
        block_template_name: 'collapsible'
      }
    }]
  }
};

function entry(id: string, snl: string): EntryData {
  return {
    id,
    kind: '',
    title: id,
    content: { snl },
    contribution_info: null,
    pointer: null
  };
}

function mountSurface(snl: string) {
  const postMessage = vi.fn();
  return render(
    <HoverPopoverProvider postMessage={postMessage} entries={[]} userMacros={macros}>
      <EntrySurface
        entry={entry('production-surface', snl)}
        kind={null}
        entries={[]}
        postMessage={postMessage}
        userMacros={macros}
      />
    </HoverPopoverProvider>
  );
}

const ownBody = (host: Element): HTMLElement => {
  const body = host.querySelector<HTMLElement>(':scope > .snl-collapsible__body');
  if (!body) throw new Error('Collapsible body was not rendered');
  return body;
};

describe('authored Collapsible blocks on the canonical production EntrySurface', () => {
  it('defaults closed with an operable ARIA relationship', async () => {
    const view = mountSurface('Fold(%Always visible%, %Initially hidden%)');
    const host = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('.snl-collapsible');
      expect(found).not.toBeNull();
      return found!;
    });
    const button = host.querySelector<HTMLButtonElement>(
      ':scope > .snl-collapsible__summary > button'
    )!;
    const body = ownBody(host);

    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
    expect(body.textContent).toContain('Initially hidden');

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
  });

  it('keeps nested authored Collapsible blocks independently closed', async () => {
    const view = mountSurface(
      'Fold(%Outer summary%, Fold(%Inner summary%, %Inner body%), %Outer body%)'
    );
    await waitFor(() => expect(view.container.querySelectorAll('.snl-collapsible')).toHaveLength(2));
    const [outer, inner] = Array.from(
      view.container.querySelectorAll<HTMLElement>('.snl-collapsible')
    );
    const outerButton = outer.querySelector<HTMLButtonElement>(
      ':scope > .snl-collapsible__summary > button'
    )!;
    const innerButton = inner.querySelector<HTMLButtonElement>(
      ':scope > .snl-collapsible__summary > button'
    )!;

    expect(outerButton.getAttribute('aria-expanded')).toBe('false');
    expect(innerButton.getAttribute('aria-expanded')).toBe('false');
    expect(ownBody(outer).hidden).toBe(true);
    expect(ownBody(inner).hidden).toBe(true);

    fireEvent.click(outerButton);
    expect(outerButton.getAttribute('aria-expanded')).toBe('true');
    expect(innerButton.getAttribute('aria-expanded')).toBe('false');
    expect(ownBody(inner).hidden).toBe(true);

    fireEvent.click(innerButton);
    expect(innerButton.getAttribute('aria-expanded')).toBe('true');
    expect(outerButton.getAttribute('aria-expanded')).toBe('true');
  });
});
