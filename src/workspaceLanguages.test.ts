import { describe, expect, it } from 'vitest';
import {
  normalizeSupportedLanguage,
  supportedLanguagesFromConfig
} from './workspaceLanguages';

describe('workspace supported languages', () => {
  it('uses built-ins when config has no catalog', () => {
    expect(supportedLanguagesFromConfig({ version: '0.0.8' })).toEqual([
      { id: 'zh-CN', display_name: '简体中文（中国大陆）' },
      { id: 'en', display_name: 'English (US)' }
    ]);
  });

  it('canonicalizes and appends repo-defined languages without duplicating built-ins', () => {
    expect(supportedLanguagesFromConfig({
      supported_languages: [
        { id: 'fr-fr', display_name: 'Français' },
        { id: 'EN', display_name: 'Duplicate English' }
      ]
    })).toEqual([
      { id: 'zh-CN', display_name: '简体中文（中国大陆）' },
      { id: 'en', display_name: 'English (US)' },
      { id: 'fr-FR', display_name: 'Français' }
    ]);
  });

  it('rejects malformed managed catalog entries instead of silently hiding them', () => {
    expect(() => supportedLanguagesFromConfig({ supported_languages: [{ id: '../fr', display_name: '' }] }))
      .toThrow(/supported_languages/i);
    expect(() => supportedLanguagesFromConfig({ supported_languages: 'fr' }))
      .toThrow(/supported_languages/i);
  });

  it('validates one language before persistence', () => {
    expect(normalizeSupportedLanguage({ id: 'pt_br', display_name: ' Português ' })).toEqual({
      id: 'pt-BR', display_name: 'Português'
    });
    expect(() => normalizeSupportedLanguage({ id: 'fr', display_name: '   ' })).toThrow(/display/i);
    expect(() => normalizeSupportedLanguage({ id: 'auto', display_name: 'Automatic' }))
      .toThrow(/reserved/i);
  });
});
