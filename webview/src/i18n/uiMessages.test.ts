import { describe, expect, it } from 'vitest';
import {
  createUiTranslator,
  defineUiMessages,
  formatUiMessage,
  resolveUiLocale
} from './uiMessages';

const messages = defineUiMessages(
  'test.panel',
  {
    title: 'Test panel',
    greeting: 'Hello, {name}',
    itemCount: {
      arg: 'count',
      one: '{count} item',
      other: '{count} items'
    }
  },
  {
    title: '测试面板',
    greeting: '你好，{name}',
    itemCount: {
      arg: 'count',
      other: '{count} 项'
    }
  }
);

describe('UI message runtime', () => {
  it('uses stable namespaced definitions and English defaults', () => {
    const t = createUiTranslator('en', messages);
    expect(messages.namespace).toBe('test.panel');
    expect(t('title')).toBe('Test panel');
    expect(t('greeting', { name: 'Ada' })).toBe('Hello, Ada');
    expect(t('itemCount', { count: 1 })).toBe('1 item');
    expect(t('itemCount', { count: 3 })).toBe('3 items');
  });

  it('normalizes the built-in Chinese locale and selects its catalog', () => {
    expect(resolveUiLocale('zh-cn')).toBe('zh-CN');
    expect(resolveUiLocale('ZH-CN')).toBe('zh-CN');
    const t = createUiTranslator('zh-cn', messages);
    expect(t('title')).toBe('测试面板');
    expect(t('greeting', { name: 'Ada' })).toBe('你好，Ada');
    expect(t('itemCount', { count: 3 })).toBe('3 项');
  });

  it('falls back to English for unsupported or empty locales', () => {
    expect(resolveUiLocale('fr')).toBe('en');
    expect(resolveUiLocale('')).toBe('en');
    expect(createUiTranslator('fr', messages)('title')).toBe('Test panel');
  });

  it('fails closed when an interpolation parameter is missing', () => {
    expect(() => formatUiMessage('Hello, {name}', {})).toThrow(/name/);
  });

  it('rejects locale catalogs that drop placeholders or change plural arguments', () => {
    expect(() => defineUiMessages(
      'bad.placeholder',
      { greeting: 'Hello, {name}' },
      { greeting: '你好' }
    )).toThrow(/greeting.*name/i);
    expect(() => defineUiMessages(
      'bad.plural',
      { count: { arg: 'count', other: '{count} items' } },
      { count: { arg: 'total', other: '{total} 项' } }
    )).toThrow(/count.*plural/i);
  });
});
