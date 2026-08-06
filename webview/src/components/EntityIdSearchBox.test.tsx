import React, { useState } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import {
  EntityIdSearchBox,
  ENTRY_VALIDATE_RULES
} from './EntityIdSearchBox';

afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
});

describe('EntityIdSearchBox localization', () => {
  it('separates raw search drafts from committed existing Entry selections', () => {
    const commits: string[] = [];
    function Harness(): React.ReactElement {
      const [value, setValue] = useState('entry-one');
      return (
        <EntityIdSearchBox
          entries={[
            { id: 'entry-one', title: 'One', hasContent: true },
            { id: 'entry-two', title: 'Two', hasContent: true }
          ]}
          value={value}
          onChange={setValue}
          onCommit={(entryId) => commits.push(entryId)}
          onCancel={() => setValue('entry-one')}
          label="Entry ID"
        />
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole('combobox', { name: 'Entry ID' }) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'entry-t' } });
    expect(commits).toEqual([]);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(commits).toEqual(['entry-two']);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'unmatched' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('entry-one');
    expect(commits).toEqual(['entry-two']);
  });

  it('localizes default validation and search-result affordances', () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(
      <EntityIdSearchBox
        entries={[{ id: 'stub-id', title: '', hasContent: false }]}
        value="missing"
        onChange={() => undefined}
        validate={ENTRY_VALIDATE_RULES.requireMatch}
        label="Entry ID"
      />
    );
    expect(view.getByText('当前条目池中没有此 ID 对应的条目。')).toBeTruthy();
    fireEvent.focus(view.getByRole('combobox', { name: 'Entry ID' }));
    expect(view.getByText('没有匹配的条目。')).toBeTruthy();
  });

  it('localizes untitled and stub labels without changing entity data', () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(
      <EntityIdSearchBox
        entries={[{ id: 'stub-id', title: '', hasContent: false }]}
        value="stub-id"
        onChange={() => undefined}
        label="Entry ID"
      />
    );
    expect(view.getByText('（无标题）')).toBeTruthy();
    expect(view.getByText('存根')).toBeTruthy();
    expect(view.getByText('stub-id')).toBeTruthy();
  });
});
