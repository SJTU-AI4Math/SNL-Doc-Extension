import { describe, expect, it } from 'vitest';
import {
  createHostTranslator,
  defineHostMessages,
  formatHostMessage
} from './hostI18n';

const messages = defineHostMessages(
  {
    done: 'Created {name}.',
    count: { arg: 'count', one: '{count} item', other: '{count} items' }
  },
  {
    done: '已创建 {name}。',
    count: { arg: 'count', other: '{count} 项' }
  }
);

describe('host UI localization runtime', () => {
  it('selects the effective built-in language and interpolates values', () => {
    expect(createHostTranslator('en', messages)('done', { name: 'A' })).toBe('Created A.');
    expect(createHostTranslator('zh-CN', messages)('done', { name: 'A' })).toBe('已创建 A。');
  });

  it('formats locale-aware plural messages', () => {
    expect(createHostTranslator('en', messages)('count', { count: 1 })).toBe('1 item');
    expect(createHostTranslator('en', messages)('count', { count: 2 })).toBe('2 items');
    expect(createHostTranslator('zh-CN', messages)('count', { count: 2 })).toBe('2 项');
  });

  it('falls back to English and fails closed on missing parameters', () => {
    expect(createHostTranslator('fr', messages)('done', { name: 'A' })).toBe('Created A.');
    expect(() => formatHostMessage('Created {name}.', {})).toThrow(/name/);
  });

  it('requires host template parameters at compile time', () => {
    const t = createHostTranslator('en', messages);
    if (false) {
      // @ts-expect-error done requires name
      t('done');
      // @ts-expect-error count requires a numeric count value
      t('count', { count: false });
    }
    expect(t('done', { name: 'A' })).toBe('Created A.');
  });

  it('rejects translated host templates that drop dynamic parameters', () => {
    expect(() => defineHostMessages(
      { done: 'Created {name}.' },
      { done: '已创建。' }
    )).toThrow(/done.*name/i);
    expect(() => defineHostMessages(
      { title: 'Title' },
      { title: '标题', obsolete: '旧文案' } as never
    )).toThrow(/extra.*obsolete/i);
  });
});
