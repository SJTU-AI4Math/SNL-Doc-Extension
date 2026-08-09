// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { I18n } from '@sjtu-ai4math/snl-basics/runtime';
import {
  LocalizedEditScope,
  useLocalizedEditLanguage,
  useLocalizedBinding
} from './LocalizedEditScope';

afterEach(cleanup);

function LanguageProbe({ name }: { name: string }): React.ReactElement {
  const local = useLocalizedEditLanguage();
  return <div>
    <output data-testid={`${name}-language`}>{local.language}</output>
    <button type="button" onClick={() => local.setLanguage('en')}>{name} English</button>
  </div>;
}

describe('LocalizedEditScope', () => {
  it('changes only the wrapped component language and isolates nested scopes', () => {
    const view = render(
      <LocalizedEditScope initialLanguage="zh-CN" availableLanguages={['en', 'zh-CN']}>
        <LanguageProbe name="outer" />
        <LocalizedEditScope initialLanguage="zh-CN" availableLanguages={['en', 'zh-CN']}>
          <LanguageProbe name="inner" />
        </LocalizedEditScope>
      </LocalizedEditScope>
    );
    fireEvent.click(view.getByRole('button', { name: 'inner English' }));
    expect(view.getByTestId('inner-language').textContent).toContain('en');
    expect(view.getByTestId('outer-language').textContent).toContain('zh-CN');
  });

  it('does not mutate an outer UI language source', () => {
    let uiLanguage = 'zh-CN';
    const view = render(
      <LocalizedEditScope initialLanguage={uiLanguage} availableLanguages={['en', 'zh-CN']}>
        <LanguageProbe name="local" />
      </LocalizedEditScope>
    );
    fireEvent.click(view.getByRole('button', { name: 'local English' }));
    expect(uiLanguage).toBe('zh-CN');
  });
});

function BindingProbe({ initial }: { initial: string | I18n<string, string> }): React.ReactElement {
  const [value, setValue] = useState<string | I18n<string, string>>(initial);
  const binding = useLocalizedBinding({ value, onChange: (next) => setValue(next), defaultLanguage: 'en' });
  return <div>
    <output data-testid="state">{binding.state}</output>
    <output data-testid="explicit">{binding.explicitValue ?? ''}</output>
    <output data-testid="resolved">{binding.resolvedValue ?? ''}</output>
    <output data-testid="source">{binding.sourceLanguage ?? ''}</output>
    <output data-testid="can-clear">{String(binding.canClear)}</output>
    <output data-testid="serialized">{JSON.stringify(value)}</output>
    <button type="button" onClick={() => binding.setValue('中文')}>write</button>
    <button type="button" onClick={binding.clearValue}>clear</button>
  </div>;
}

describe('useLocalizedBinding', () => {
  it('reports explicit, fallback, and source language separately', () => {
    const value: I18n<string, string> = {
      type: 'i18n', default_language: 'en', values: { en: 'English' }
    };
    const view = render(
      <LocalizedEditScope initialLanguage="zh-CN" availableLanguages={['en', 'zh-CN']}>
        <BindingProbe initial={value} />
      </LocalizedEditScope>
    );
    expect(view.getByTestId('state').textContent).toContain('fallback');
    expect(view.getByTestId('explicit').textContent).toContain('');
    expect(view.getByTestId('resolved').textContent).toContain('English');
    expect(view.getByTestId('source').textContent).toContain('en');
  });

  it('edits a fallback by creating the current-language projection', () => {
    const value: I18n<string, string> = {
      type: 'i18n', default_language: 'en', values: { en: 'English' }
    };
    const view = render(
      <LocalizedEditScope initialLanguage="zh-CN" availableLanguages={['en', 'zh-CN']}>
        <BindingProbe initial={value} />
      </LocalizedEditScope>
    );
    fireEvent.click(view.getByRole('button', { name: 'write' }));
    expect(view.getByTestId('state').textContent).toContain('explicit');
    expect(view.getByTestId('serialized').textContent).toContain('"en":"English"');
    expect(view.getByTestId('serialized').textContent).toContain('"zh-CN":"中文"');
  });

  it('promotes an invariant value when editing a non-default language', () => {
    const view = render(
      <LocalizedEditScope initialLanguage="zh-CN" availableLanguages={['en', 'zh-CN']}>
        <BindingProbe initial="English" />
      </LocalizedEditScope>
    );
    expect(view.getByTestId('state').textContent).toContain('invariant');
    fireEvent.click(view.getByRole('button', { name: 'write' }));
    expect(view.getByTestId('serialized').textContent).toContain('"default_language":"en"');
    expect(view.getByTestId('serialized').textContent).toContain('"en":"English"');
    expect(view.getByTestId('serialized').textContent).toContain('"zh-CN":"中文"');
  });

  it('ignores inherited exact-language projections and does not offer clear', () => {
    const values = Object.assign(Object.create({ toString: 'Inherited' }), {
      en: 'English', 'zh-CN': '中文'
    });
    const value = { type: 'i18n', default_language: 'en', values } as I18n<string, string>;
    const view = render(
      <LocalizedEditScope initialLanguage="toString" availableLanguages={['en', 'zh-CN', 'toString']}>
        <BindingProbe initial={value} />
      </LocalizedEditScope>
    );
    expect(view.getByTestId('state').textContent).toContain('fallback');
    expect(view.getByTestId('resolved').textContent).toContain('English');
    expect(view.getByTestId('source').textContent).toContain('en');
    expect(view.getByTestId('can-clear').textContent).toBe('false');
    fireEvent.click(view.getByRole('button', { name: 'clear' }));
    expect(view.getByTestId('state').textContent).toContain('fallback');
  });

  it('ignores an inherited declared default and falls back to the first own projection', () => {
    const values = Object.assign(Object.create({ valueOf: 'Inherited' }), { 'zh-CN': '中文' });
    const value = { type: 'i18n', default_language: 'valueOf', values } as I18n<string, string>;
    const view = render(
      <LocalizedEditScope initialLanguage="fr" availableLanguages={['fr', 'zh-CN']}>
        <BindingProbe initial={value} />
      </LocalizedEditScope>
    );
    expect(view.getByTestId('state').textContent).toContain('fallback');
    expect(view.getByTestId('resolved').textContent).toContain('中文');
    expect(view.getByTestId('source').textContent).toContain('zh-CN');
  });

  it('clears only the current projection and restores fallback', () => {
    const value: I18n<string, string> = {
      type: 'i18n', default_language: 'en', values: { en: 'English', 'zh-CN': '中文' }
    };
    const view = render(
      <LocalizedEditScope initialLanguage="zh-CN" availableLanguages={['en', 'zh-CN']}>
        <BindingProbe initial={value} />
      </LocalizedEditScope>
    );
    fireEvent.click(view.getByRole('button', { name: 'clear' }));
    expect(view.getByTestId('state').textContent).toContain('fallback');
    expect(view.getByTestId('resolved').textContent).toContain('English');
    expect(view.getByTestId('serialized').textContent).not.toContain('zh-CN');
  });
});
