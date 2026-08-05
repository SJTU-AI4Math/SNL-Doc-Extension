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
