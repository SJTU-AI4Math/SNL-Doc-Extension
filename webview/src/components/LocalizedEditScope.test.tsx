// @vitest-environment jsdom
import React, { StrictMode, useCallback, useRef, useState } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { I18n } from '@sjtu-ai4math/snl-basics/runtime';
import {
  LOCALIZED_GENERAL_LANGUAGE,
  LocalizedEditScope,
  materializeLocalizedValueForSave,
  useLocalizedEditLanguage,
  useLocalizedBinding
} from './LocalizedEditScope';

afterEach(cleanup);

function LanguageProbe({ name }: { name: string }): React.ReactElement {
  const local = useLocalizedEditLanguage();
  return <div>
    <output data-testid={`${name}-language`}>{local.language}</output>
    <output data-testid={`${name}-follows`}>{String(local.followsOuterLanguage)}</output>
    <button type="button" onClick={() => local.setLanguage('en')}>{name} English</button>
    <button type="button" onClick={() => local.setLanguage('zh-CN')}>{name} Chinese</button>
    <button type="button" onClick={local.followOuterLanguage}>{name} Follow</button>
  </div>;
}

function StyleSwitchHarness({ callbackBudget }: { callbackBudget: number }): React.ReactElement {
  const [styles, setStyles] = useState([
    { name: 'A', language: 'en' },
    { name: 'B', language: 'zh-CN' }
  ]);
  const [activeStyle, setActiveStyle] = useState(0);
  const callbackCount = useRef(0);
  const current = styles[activeStyle];
  const setActiveLanguage = useCallback((language: string): void => {
    callbackCount.current += 1;
    if (callbackCount.current > callbackBudget) {
      throw new Error(`LocalizedEditScope callback budget exceeded: ${callbackCount.current}`);
    }
    setStyles((previous) => previous.map((style, index) =>
      index === activeStyle && style.language !== language ? { ...style, language } : style));
  }, [activeStyle, callbackBudget]);

  return <div>
    <button type="button" onClick={() => setActiveStyle(0)}>Style A</button>
    <button type="button" onClick={() => setActiveStyle(1)}>Style B</button>
    <output data-testid="style-languages">{styles.map((style) => style.language).join(',')}</output>
    <output data-testid="callback-count">{callbackCount.current}</output>
    <LocalizedEditScope
      resetKey={activeStyle}
      initialLanguage={current.language}
      availableLanguages={['en', 'zh-CN']}
      onLanguageChange={setActiveLanguage}
    >
      <LanguageProbe name="active" />
    </LocalizedEditScope>
  </div>;
}


describe('materializeLocalizedValueForSave', () => {
  const localized = {
    type: 'i18n' as const,
    default_language: 'en',
    extension_flag: 'keep-map-extension',
    values: {
      en: 'GENERAL-EN',
      'zh-CN': 'ZH-SENTINEL',
      ja: 'JA-SENTINEL'
    }
  };

  it('materializes the displayed General projection without serializing the sentinel', () => {
    const before = JSON.stringify(localized);
    expect(materializeLocalizedValueForSave(localized, LOCALIZED_GENERAL_LANGUAGE)).toBe('GENERAL-EN');
    expect(JSON.stringify(localized)).toBe(before);
    expect(JSON.stringify(materializeLocalizedValueForSave(localized, LOCALIZED_GENERAL_LANGUAGE)))
      .not.toContain(LOCALIZED_GENERAL_LANGUAGE);
  });

  it('returns the complete raw localized value for a specific editor language', () => {
    expect(materializeLocalizedValueForSave(localized, 'zh-CN')).toBe(localized);
    expect(materializeLocalizedValueForSave(localized, 'zh-CN')).toEqual(localized);
  });
});

describe('LocalizedEditScope', () => {
  it('switches repeatedly between targets without writing a stale language into the new target', () => {
    const view = render(<StrictMode><StyleSwitchHarness callbackBudget={25} /></StrictMode>);

    for (let index = 0; index < 20; index += 1) {
      const target = index % 2 === 0 ? 'Style B' : 'Style A';
      const expected = index % 2 === 0 ? 'zh-CN' : 'en';
      fireEvent.click(view.getByRole('button', { name: target }));
      expect(view.getByTestId('active-language').textContent).toBe(expected);
      expect(view.getByTestId('style-languages').textContent).toBe('en,zh-CN');
    }

    expect(Number(view.getByTestId('callback-count').textContent)).toBeLessThanOrEqual(25);
  });

  it('notifies a manual selection even when it differs from the authoritative initial language', () => {
    const onLanguageChange = vi.fn();
    const view = render(
      <LocalizedEditScope
        initialLanguage="en"
        availableLanguages={['en', 'zh-CN']}
        onLanguageChange={onLanguageChange}
      >
        <LanguageProbe name="manual" />
      </LocalizedEditScope>
    );
    onLanguageChange.mockClear();

    fireEvent.click(view.getByRole('button', { name: 'manual Chinese' }));

    expect(view.getByTestId('manual-language').textContent).toBe('zh-CN');
    expect(onLanguageChange).toHaveBeenCalledWith('zh-CN');
  });

  it('preserves a same-language manual selection until follow outer language is requested', () => {
    const onLanguageChange = vi.fn();
    const scope = (initialLanguage: string): React.ReactElement => (
      <LocalizedEditScope
        initialLanguage={initialLanguage}
        availableLanguages={['en', 'zh-CN']}
        onLanguageChange={onLanguageChange}
      >
        <LanguageProbe name="manual" />
      </LocalizedEditScope>
    );
    const view = render(scope('en'));

    fireEvent.click(view.getByRole('button', { name: 'manual English' }));
    expect(view.getByTestId('manual-follows').textContent).toBe('false');
    view.rerender(scope('zh-CN'));
    expect(view.getByTestId('manual-language').textContent).toBe('en');

    fireEvent.click(view.getByRole('button', { name: 'manual Follow' }));
    expect(view.getByTestId('manual-follows').textContent).toBe('true');
    expect(view.getByTestId('manual-language').textContent).toBe('zh-CN');
    expect(onLanguageChange).toHaveBeenLastCalledWith('zh-CN');
  });

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
  it('keeps a general edit as an invariant string', () => {
    const view = render(
      <LocalizedEditScope initialLanguage="__snl_general__" availableLanguages={['__snl_general__', 'en']}>
        <BindingProbe initial="" />
      </LocalizedEditScope>
    );
    fireEvent.click(view.getByRole('button', { name: 'write' }));
    expect(view.getByTestId('serialized').textContent).toBe('"中文"');
    expect(view.getByTestId('state').textContent).toContain('invariant');
  });

  it('promotes an empty general value without creating an empty default projection', () => {
    const view = render(
      <LocalizedEditScope initialLanguage="zh-CN" availableLanguages={['zh-CN', 'en']}>
        <BindingProbe initial="" />
      </LocalizedEditScope>
    );
    fireEvent.click(view.getByRole('button', { name: 'write' }));
    expect(view.getByTestId('serialized').textContent).toBe(
      '{"type":"i18n","default_language":"zh-CN","values":{"zh-CN":"中文"}}'
    );
  });

  it('falls back from a missing declared default to the first partial projection', () => {
    const value: I18n<string, string> = {
      type: 'i18n', default_language: 'en', values: { 'zh-CN': '中文标题' }
    };
    const view = render(
      <LocalizedEditScope initialLanguage="en" availableLanguages={['en', 'zh-CN']}>
        <BindingProbe initial={value} />
      </LocalizedEditScope>
    );
    expect(view.getByTestId('resolved').textContent).toBe('中文标题');
    expect(view.getByTestId('source').textContent).toBe('zh-CN');
  });

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

  it('turns a General value into the explicitly selected language without relabeling it as English', () => {
    const view = render(
      <LocalizedEditScope initialLanguage="zh-CN" availableLanguages={['en', 'zh-CN']}>
        <BindingProbe initial="General text" />
      </LocalizedEditScope>
    );
    expect(view.getByTestId('state').textContent).toContain('invariant');
    fireEvent.click(view.getByRole('button', { name: 'write' }));
    expect(view.getByTestId('serialized').textContent).toContain('"default_language":"zh-CN"');
    expect(view.getByTestId('serialized').textContent).not.toContain('"en"');
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
