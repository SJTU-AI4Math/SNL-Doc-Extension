import {
  readSnlTableRenderOptions,
  type SnlBlockMacroTemplate,
  type SnlTableComposition,
  type SnlTableCssColors,
  type SnlTableCssThemes,
  type SnlTableRenderOptions
} from '@sjtu-ai4math/snl-basics';

export type TableComposition = SnlTableComposition;
export type TableCssColors = SnlTableCssColors;
export type TableCssThemes = SnlTableCssThemes;
export type TableTemplateOptions = SnlTableRenderOptions;

const SAFE_COLOR_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch',
  'color', 'color-mix', 'light-dark', 'device-cmyk', 'var', 'calc', 'min',
  'max', 'clamp',
]);

/** Legacy renderer-key guard; canonical TemplateSpec validation is Basics-owned. */
export function isSafeCssColorToken(token: string): boolean {
  if (token.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(token)) return false;
  const value = token.trim();
  if (value === '') return true;
  if (/[;{}\\'"]/.test(value) || value.includes('/*') || value.includes('*/')) return false;
  if (/^#[0-9a-f]{3,4}$/i.test(value) || /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) return true;
  if (/^[a-z][a-z0-9-]*$/i.test(value)) return true;
  if (!/^[a-z0-9_#.%(),+*/\s-]+$/i.test(value)) return false;
  const functions = [...value.matchAll(/([a-z][a-z0-9-]*)\s*\(/gi)];
  if (functions.length === 0 || functions[0].index !== 0 ||
      functions.some((match) => !SAFE_COLOR_FUNCTIONS.has(match[1].toLowerCase()))) return false;
  const contentStack: boolean[] = [];
  for (const char of value) {
    if (char === '(') contentStack.push(false);
    else if (char === ')') {
      if (contentStack.length === 0 || !contentStack.pop()) return false;
      if (contentStack.length > 0) contentStack[contentStack.length - 1] = true;
    } else if (contentStack.length > 0 && !/\s/.test(char)) {
      contentStack[contentStack.length - 1] = true;
    }
  }
  return contentStack.length === 0;
}

/** Read exactly the public Basics 0.3 table contract at Extension boundaries. */
export function readTableTemplateOptions(
  projection: Record<string, unknown>,
  path: string
): TableTemplateOptions {
  if (projection.table !== undefined && projection.mode !== 'block') {
    throw new Error(`${path}.table is valid only in block mode.`);
  }
  try {
    return readSnlTableRenderOptions(projection as unknown as SnlBlockMacroTemplate);
  } catch (error) {
    throw new Error(`${path}.table is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function assertTableTemplateOptions(projection: Record<string, unknown>, path: string): void {
  readTableTemplateOptions(projection, path);
}
