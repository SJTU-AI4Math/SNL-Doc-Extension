const COMMA_DEPTH_COUNT = 6;

type RawDelimiter = '$' | '$$' | '%' | null;

export class SnlMonacoTokenState {
  constructor(
    public readonly depth = 0,
    public readonly rawDelimiter: RawDelimiter = null
  ) {}

  clone(): SnlMonacoTokenState {
    return new SnlMonacoTokenState(this.depth, this.rawDelimiter);
  }

  equals(other: unknown): boolean {
    return other instanceof SnlMonacoTokenState
      && other.depth === this.depth
      && other.rawDelimiter === this.rawDelimiter;
  }
}

export function createSnlTokenState(): SnlMonacoTokenState {
  return new SnlMonacoTokenState();
}

export interface SnlMonacoToken {
  startIndex: number;
  scopes: string;
}

export interface SnlTokenizeResult {
  tokens: SnlMonacoToken[];
  endState: SnlMonacoTokenState;
}

function fill(scopes: string[], start: number, length: number, scope: string): void {
  for (let offset = 0; offset < length; offset += 1) scopes[start + offset] = scope;
}

function compressedTokens(scopes: string[]): SnlMonacoToken[] {
  const tokens: SnlMonacoToken[] = [];
  let previous: string | undefined;
  for (let index = 0; index < scopes.length; index += 1) {
    const scope = scopes[index] ?? '';
    if (scope !== previous) {
      tokens.push({ startIndex: index, scopes: scope });
      previous = scope;
    }
  }
  return tokens;
}

/**
 * Stateful SNL tokenizer used by Monaco. Raw `$…$`, `$$…$$`, and `%…%`
 * regions do not participate in structural depth, so punctuation inside raw
 * KaTeX/source text cannot perturb later SNL bracket/comma colors.
 */
export function tokenizeSnlLine(
  line: string,
  initialState: SnlMonacoTokenState
): SnlTokenizeResult {
  const scopes = Array<string>(line.length).fill('');
  let depth = initialState.depth;
  let rawDelimiter = initialState.rawDelimiter;
  let index = 0;

  while (index < line.length) {
    if (rawDelimiter) {
      const close = line.indexOf(rawDelimiter, index);
      if (close < 0) {
        fill(scopes, index, line.length - index, 'string.snl');
        index = line.length;
        continue;
      }
      fill(scopes, index, close - index, 'string.snl');
      const token = rawDelimiter === '%' ? 'delimiter.percent.snl' : 'delimiter.dollar.snl';
      fill(scopes, close, rawDelimiter.length, token);
      index = close + rawDelimiter.length;
      rawDelimiter = null;
      continue;
    }

    if (line.startsWith('$$', index)) {
      fill(scopes, index, 2, 'delimiter.dollar.snl');
      rawDelimiter = '$$';
      index += 2;
      continue;
    }

    const character = line[index];
    if (character === '$') {
      scopes[index] = 'delimiter.dollar.snl';
      rawDelimiter = '$';
    } else if (character === '%') {
      scopes[index] = 'delimiter.percent.snl';
      rawDelimiter = '%';
    } else if (character === '@') {
      scopes[index] = 'delimiter.at.snl';
    } else if (character === '(' || character === '[' || character === '{') {
      scopes[index] = 'delimiter.bracket.snl';
      depth += 1;
    } else if (character === ')' || character === ']' || character === '}') {
      depth = Math.max(0, depth - 1);
      scopes[index] = 'delimiter.bracket.snl';
    } else if (character === ',') {
      const containingBracketDepth = depth > 0 ? depth - 1 : 0;
      scopes[index] = `delimiter.comma.depth${containingBracketDepth % COMMA_DEPTH_COUNT}.snl`;
    }
    index += 1;
  }

  return {
    tokens: compressedTokens(scopes),
    endState: new SnlMonacoTokenState(depth, rawDelimiter)
  };
}

interface MonacoLanguageApi {
  setLanguageConfiguration(language: string, configuration: Record<string, unknown>): unknown;
  setTokensProvider(language: string, provider: Record<string, unknown>): unknown;
}

interface MonacoThemeApi {
  defineTheme(name: string, data: Record<string, unknown>): void;
}

export interface SnlMonacoConfigurationApi {
  languages: MonacoLanguageApi;
  editor: MonacoThemeApi;
}

const configuredLanguageApis = new WeakSet<object>();
const brackets = [['(', ')'], ['[', ']'], ['{', '}']];

const DARK_DEPTH_COLORS = ['FFD700', 'DA70D6', '179FFF', 'FFD700', 'DA70D6', '179FFF'];
const LIGHT_DEPTH_COLORS = ['0431FA', '2B7A2B', '7B3814', '0431FA', '2B7A2B', '7B3814'];

function themeRules(light: boolean): Array<{ token: string; foreground: string }> {
  const depthColors = light ? LIGHT_DEPTH_COLORS : DARK_DEPTH_COLORS;
  return [
    { token: 'delimiter.dollar.snl', foreground: light ? '795E26' : 'DCDCAA' },
    { token: 'delimiter.percent.snl', foreground: light ? 'AF00DB' : 'C586C0' },
    { token: 'delimiter.at.snl', foreground: light ? '267F99' : '4EC9B0' },
    { token: 'string.snl', foreground: light ? 'A31515' : 'CE9178' },
    ...depthColors.map((foreground, depth) => ({
      token: `delimiter.comma.depth${depth}.snl`,
      foreground
    }))
  ];
}

export function configureSnlMonaco(monaco: SnlMonacoConfigurationApi): void {
  if (configuredLanguageApis.has(monaco.languages as object)) return;
  configuredLanguageApis.add(monaco.languages as object);

  monaco.languages.setLanguageConfiguration('snl', {
    brackets,
    colorizedBracketPairs: brackets,
    autoClosingPairs: brackets.map(([open, close]) => ({ open, close })),
    surroundingPairs: brackets.map(([open, close]) => ({ open, close }))
  });
  monaco.languages.setTokensProvider('snl', {
    getInitialState: createSnlTokenState,
    tokenize: (line: string, state: SnlMonacoTokenState) => tokenizeSnlLine(line, state)
  });

  for (const [name, base, light] of [
    ['snl-vs-dark', 'vs-dark', false],
    ['snl-vs', 'vs', true],
    ['snl-hc-black', 'hc-black', false],
    ['snl-hc-light', 'hc-light', true]
  ] as const) {
    const depthColors = light ? LIGHT_DEPTH_COLORS : DARK_DEPTH_COLORS;
    monaco.editor.defineTheme(name, {
      base,
      inherit: true,
      rules: themeRules(light),
      colors: Object.fromEntries(depthColors.map((foreground, depth) => [
        `editorBracketHighlight.foreground${depth + 1}`,
        `#${foreground}`
      ]))
    });
  }
}

const SNL_THEME_BY_BASE: Readonly<Record<string, string>> = {
  'vs-dark': 'snl-vs-dark',
  vs: 'snl-vs',
  'hc-black': 'snl-hc-black',
  'hc-light': 'snl-hc-light'
};

export function resolveSnlMonacoTheme(theme: string): string {
  return SNL_THEME_BY_BASE[theme] ?? theme;
}
