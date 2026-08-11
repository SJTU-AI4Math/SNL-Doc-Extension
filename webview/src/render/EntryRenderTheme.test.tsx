// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HoverPopoverProvider } from './HoverPopoverProvider';
import { EntryRender, type EntryData, type EntryKind } from './EntryRender';

const entry: EntryData = {
  id: 'dark-entry',
  kind: 'definition',
  title: 'Dark Entry',
  content: { text: 'Readable dark body' },
  contribution_info: null,
  pointer: null
};

const kind: EntryKind = {
  id: 'definition',
  name: 'Definition',
  coloring: {
    light: { stroke: '#111111', background: '#eeeeee' },
    dark: { stroke: '#abcdef', background: '#123456' }
  },
  defaultCounterName: 'Definition',
  style: 'Definition'
};

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.snlColorScheme;
});

describe('published SNL-Basics Entry dark theme integration', () => {
  it('keeps default text light and hover surfaces dark', () => {
    document.documentElement.dataset.snlColorScheme = 'dark';
    const postMessage = () => undefined;
    const view = render(
      <HoverPopoverProvider postMessage={postMessage} entries={[]}>
        <EntryRender
          entry={entry}
          kind={kind}
          entries={[]}
          postMessage={postMessage}
        />
      </HoverPopoverProvider>
    );
    const section = view.container.querySelector<HTMLElement>('section[data-entry-id="dark-entry"]')!;
    const body = section.querySelector<HTMLElement>('[data-entry-body="text"]')!;

    expect(body.style.color).toBe('rgb(245, 245, 245)');
    expect(section.style.background).toBe('rgb(18, 52, 86)');
    fireEvent.pointerEnter(section);
    expect(section.style.background).toBe('rgb(31, 41, 55)');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    expect(section.style.background).toBe('rgb(55, 65, 81)');
  });
});
