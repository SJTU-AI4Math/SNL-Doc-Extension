import { describe, expect, it, vi } from 'vitest';
import {
  configureSnlMonaco,
  createSnlTokenState,
  resolveSnlMonacoTheme,
  tokenizeSnlLine
} from './snlMonacoLanguage';

function tokenAt(
  line: string,
  tokens: Array<{ startIndex: number; scopes: string }>,
  needle: string,
  occurrence = 0
): string {
  let index = -1;
  for (let i = 0; i <= occurrence; i += 1) index = line.indexOf(needle, index + 1);
  if (index < 0) throw new Error(`Missing ${needle} occurrence ${occurrence}`);
  return tokens.filter((token) => token.startIndex <= index).at(-1)?.scopes ?? '';
}

describe('SNL Monaco language', () => {
  it('colors $, %, and @ while keeping raw-region commas out of bracket-depth coloring', () => {
    const line = 'root($a,b$, %c,d%, @ref)';
    const result = tokenizeSnlLine(line, createSnlTokenState());

    expect(tokenAt(line, result.tokens, '$', 0)).toBe('delimiter.dollar.snl');
    expect(tokenAt(line, result.tokens, '$', 1)).toBe('delimiter.dollar.snl');
    expect(tokenAt(line, result.tokens, '%', 0)).toBe('delimiter.percent.snl');
    expect(tokenAt(line, result.tokens, '%', 1)).toBe('delimiter.percent.snl');
    expect(tokenAt(line, result.tokens, '@')).toBe('delimiter.at.snl');
    expect(tokenAt(line, result.tokens, ',', 0)).toBe('string.snl');
    expect(tokenAt(line, result.tokens, ',', 1)).toBe('delimiter.comma.depth0.snl');
    expect(tokenAt(line, result.tokens, ',', 2)).toBe('string.snl');
    expect(tokenAt(line, result.tokens, ',', 3)).toBe('delimiter.comma.depth0.snl');
  });

  it('colors commas by their containing bracket depth across lines', () => {
    const first = 'root(a,';
    const firstResult = tokenizeSnlLine(first, createSnlTokenState());
    expect(tokenAt(first, firstResult.tokens, ',')).toBe('delimiter.comma.depth0.snl');

    const second = ' inner(b,c), [d,e])';
    const secondResult = tokenizeSnlLine(second, firstResult.endState);
    expect(tokenAt(second, secondResult.tokens, ',', 0)).toBe('delimiter.comma.depth1.snl');
    expect(tokenAt(second, secondResult.tokens, ',', 1)).toBe('delimiter.comma.depth0.snl');
    expect(tokenAt(second, secondResult.tokens, ',', 2)).toBe('delimiter.comma.depth1.snl');
    expect(secondResult.endState.depth).toBe(0);
  });

  it('keeps double-dollar raw state across lines without shifting later comma depth', () => {
    const first = 'root($$a,b';
    const firstResult = tokenizeSnlLine(first, createSnlTokenState());
    expect(tokenAt(first, firstResult.tokens, '$$', 0)).toBe('delimiter.dollar.snl');
    expect(tokenAt(first, firstResult.tokens, ',')).toBe('string.snl');
    expect(firstResult.endState.rawDelimiter).toBe('$$');

    const second = 'c,d$$, inner(e,f))';
    const secondResult = tokenizeSnlLine(second, firstResult.endState);
    expect(tokenAt(second, secondResult.tokens, ',', 0)).toBe('string.snl');
    expect(tokenAt(second, secondResult.tokens, ',', 1)).toBe('delimiter.comma.depth0.snl');
    expect(tokenAt(second, secondResult.tokens, ',', 2)).toBe('delimiter.comma.depth1.snl');
    expect(secondResult.endState.rawDelimiter).toBeNull();
    expect(secondResult.endState.depth).toBe(0);
  });

  it('registers SNL brackets, tokenizer, and inherited light/dark/high-contrast themes once', () => {
    const setLanguageConfiguration = vi.fn();
    const setTokensProvider = vi.fn();
    const defineTheme = vi.fn();

    configureSnlMonaco({
      languages: { setLanguageConfiguration, setTokensProvider },
      editor: { defineTheme }
    });

    expect(setLanguageConfiguration).toHaveBeenCalledWith('snl', expect.objectContaining({
      brackets: [['(', ')'], ['[', ']'], ['{', '}']],
      colorizedBracketPairs: [['(', ')'], ['[', ']'], ['{', '}']]
    }));
    expect(setTokensProvider).toHaveBeenCalledWith('snl', expect.objectContaining({
      getInitialState: expect.any(Function),
      tokenize: expect.any(Function)
    }));
    expect(defineTheme).toHaveBeenCalledTimes(4);
    expect(defineTheme).toHaveBeenCalledWith('snl-vs-dark', expect.objectContaining({
      base: 'vs-dark',
      inherit: true,
      rules: expect.arrayContaining([
        expect.objectContaining({ token: 'delimiter.dollar.snl' }),
        expect.objectContaining({ token: 'delimiter.percent.snl' }),
        expect.objectContaining({ token: 'delimiter.at.snl' }),
        expect.objectContaining({ token: 'delimiter.comma.depth2.snl' })
      ])
    }));
    for (const themeName of ['snl-vs-dark', 'snl-vs', 'snl-hc-black', 'snl-hc-light']) {
      const call = defineTheme.mock.calls.find(([name]) => name === themeName);
      expect(call).toBeTruthy();
      const data = call?.[1] as {
        rules: Array<{ token: string; foreground: string }>;
        colors: Record<string, string>;
      };
      for (let depth = 0; depth < 6; depth += 1) {
        const comma = data.rules.find((rule) =>
          rule.token === `delimiter.comma.depth${depth}.snl`
        );
        expect(data.colors[`editorBracketHighlight.foreground${depth + 1}`])
          .toBe(`#${comma?.foreground}`);
      }
    }
    expect(resolveSnlMonacoTheme('vs-dark')).toBe('snl-vs-dark');
    expect(resolveSnlMonacoTheme('vs')).toBe('snl-vs');
    expect(resolveSnlMonacoTheme('hc-black')).toBe('snl-hc-black');
    expect(resolveSnlMonacoTheme('hc-light')).toBe('snl-hc-light');
  });
});
