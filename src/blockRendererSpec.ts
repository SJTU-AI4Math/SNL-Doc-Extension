import {
  isSafeCssColorToken,
  readTableTemplateOptions,
  type TableTemplateOptions
} from './tableTemplateOptions';

export interface BlockRendererSpec {
  name: string;
  params: Record<string, string>;
}

export const BLOCK_RENDERER_SPEC_PREFIX = 'snl-ext-preset:v1:';
const MAX_SPEC_LENGTH = 2048;
const ABSOLUTE_OR_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/|\\|\/\/)/i;
const ENUMERATE_MARKERS = new Set([
  'decimal',
  'lower-alpha',
  'upper-alpha',
  'disc',
  'ellipsis'
]);

function validateTraversal(path: string): void {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error('image path must be relative to .SNL_Doc/assets');
  }
  if (decoded.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new Error('image path must be relative to .SNL_Doc/assets');
  }
}

function normalizeImagePath(value: string): string {
  let path = value.trim().replace(/^\.\//, '');
  path = path.replace(/^\.SNL_Doc\/assets\//, '').replace(/^assets\//, '');
  if (!path || /[\\?#\0]/.test(path) || ABSOLUTE_OR_SCHEME.test(path)) {
    throw new Error('image path must be relative to .SNL_Doc/assets');
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('image path must be relative to .SNL_Doc/assets');
  }
  validateTraversal(path);
  return segments.join('/');
}

function normalizeParams(name: string, params: Record<string, string>): Record<string, string> {
  if (name === 'enumerate') {
    const keys = Object.keys(params);
    if (keys.some((key) => key !== 'marker')) throw new Error('unknown enumerate parameter');
    const marker = params.marker;
    if (!marker || !ENUMERATE_MARKERS.has(marker)) throw new Error('invalid enumerate marker');
    return { marker };
  }
  if (name === 'table') {
    const order = [
      'composition',
      'light-color', 'light-background', 'light-border',
      'dark-color', 'dark-background', 'dark-border'
    ];
    const keys = Object.keys(params);
    if (keys.some((key) => !order.includes(key))) throw new Error('unknown table parameter');
    if (params.composition !== 'rows' && params.composition !== 'cells') {
      throw new Error('table composition must be rows or cells');
    }
    const normalized: Record<string, string> = { composition: params.composition };
    const colorKeys = order.slice(1);
    const provided = colorKeys.filter((key) => Object.hasOwn(params, key));
    if (provided.length !== 0 && provided.length !== colorKeys.length) {
      throw new Error('table CSS must contain complete light and dark colors');
    }
    for (const key of provided) {
      const value = params[key];
      if (!isSafeCssColorToken(value)) {
        throw new Error('invalid table CSS color');
      }
      normalized[key] = value;
    }
    return normalized;
  }
  if (name === 'image') {
    const keys = Object.keys(params);
    if (keys.some((key) => !['src', 'layout', 'alt'].includes(key))) {
      throw new Error('unknown image parameter');
    }
    const src = normalizeImagePath(params.src ?? '');
    const layout = params.layout === 'inline' ? 'inline' : params.layout === 'block' ? 'block' : null;
    if (!layout) throw new Error('image layout must be inline or block');
    const alt = (params.alt ?? '').trim() || src.split('/').at(-1) || src;
    if (alt.length > 500) throw new Error('image alt text is too long');
    return { src, layout, alt };
  }
  throw new Error(`unknown parameterized block renderer: ${name}`);
}

const PARAMETER_ORDER: Record<string, string[]> = {
  enumerate: ['marker'],
  table: [
    'composition',
    'light-color', 'light-background', 'light-border',
    'dark-color', 'dark-background', 'dark-border'
  ],
  image: ['src', 'layout', 'alt']
};

export function serializeBlockRendererSpec(
  name: string,
  params: Record<string, string>
): string {
  const normalized = normalizeParams(name, params);
  const query = (PARAMETER_ORDER[name] ?? Object.keys(normalized))
    .filter((key) => Object.hasOwn(normalized, key))
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(normalized[key])}`)
    .join('&');
  const encoded = `${BLOCK_RENDERER_SPEC_PREFIX}${name}?${query}`;
  if (encoded.length > MAX_SPEC_LENGTH) throw new Error('block renderer spec is too long');
  return encoded;
}

export function parseBlockRendererSpec(value: string): BlockRendererSpec {
  if (value.length > MAX_SPEC_LENGTH) throw new Error('block renderer spec is too long');
  if (!value.startsWith('snl-ext-preset:')) {
    if (value.includes('?')) throw new Error('unversioned parameterized renderer key');
    return { name: value, params: {} };
  }
  if (!value.startsWith(BLOCK_RENDERER_SPEC_PREFIX)) {
    throw new Error('unsupported block renderer spec version');
  }
  const payload = value.slice(BLOCK_RENDERER_SPEC_PREFIX.length);
  const queryIndex = payload.indexOf('?');
  if (queryIndex <= 0) throw new Error('parameterized renderer query is required');
  const name = payload.slice(0, queryIndex);
  const query = payload.slice(queryIndex + 1);
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) throw new Error('malformed block renderer parameter');
    let key: string;
    let parameter: string;
    try {
      key = decodeURIComponent(pair.slice(0, separator));
      parameter = decodeURIComponent(pair.slice(separator + 1));
    } catch {
      throw new Error('malformed block renderer parameter encoding');
    }
    if (Object.hasOwn(params, key)) throw new Error(`duplicate block renderer parameter: ${key}`);
    params[key] = parameter;
  }
  return { name, params: normalizeParams(name, params) };
}


const TABLE_COLOR_PARAMS = {
  light: {
    color: 'light-color', background: 'light-background', border: 'light-border'
  },
  dark: {
    color: 'dark-color', background: 'dark-background', border: 'dark-border'
  }
} as const;

export function serializeTableRendererSpec(options: TableTemplateOptions): string {
  const params: Record<string, string> = { composition: options.composition };
  if (options.css) {
    for (const scheme of ['light', 'dark'] as const) {
      for (const field of ['color', 'background', 'border'] as const) {
        params[TABLE_COLOR_PARAMS[scheme][field]] = options.css[scheme][field];
      }
    }
  }
  return serializeBlockRendererSpec('table', params);
}

export function tableOptionsFromRendererParams(
  params: Record<string, string>
): TableTemplateOptions {
  const normalized = normalizeParams('table', params);
  const colorKeys = Object.values(TABLE_COLOR_PARAMS).flatMap((theme) => Object.values(theme));
  return {
    composition: normalized.composition as 'rows' | 'cells',
    ...(colorKeys.every((key) => Object.hasOwn(normalized, key)) ? {
      css: {
        light: {
          color: normalized['light-color'],
          background: normalized['light-background'],
          border: normalized['light-border']
        },
        dark: {
          color: normalized['dark-color'],
          background: normalized['dark-background'],
          border: normalized['dark-border']
        }
      }
    } : {})
  };
}


/** Accept the native Basics 0.3 table key; verify legacy 0.2 transport when present. */
export function assertTableRendererTransport(
  projection: Record<string, unknown>,
  path: string
): void {
  if (projection.table === undefined) return;
  const options = readTableTemplateOptions(projection, path);
  if (typeof projection.block_template_name !== 'string') {
    throw new Error(`${path}.table requires a table renderer key.`);
  }
  const spec = parseBlockRendererSpec(projection.block_template_name);
  if (spec.name !== 'table') {
    throw new Error(`${path}.table is valid only for the built-in table renderer.`);
  }
  if (Object.keys(spec.params).length === 0) return;
  const transported = tableOptionsFromRendererParams(spec.params);
  if (JSON.stringify(transported) !== JSON.stringify(options)) {
    throw new Error(`${path}.table disagrees with its compatibility renderer key.`);
  }
}
