export type TableComposition = 'rows' | 'cells';

export interface TableCssColors {
  color: string;
  background: string;
  border: string;
}

export interface TableCssThemes {
  light: TableCssColors;
  dark: TableCssColors;
}

export interface TableTemplateOptions {
  composition: TableComposition;
  css?: TableCssThemes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const TABLE_KEYS = new Set(['composition', 'css']);
const THEME_KEYS = new Set(['light', 'dark']);
const COLOR_KEYS = new Set(['color', 'background', 'border']);

function readColors(value: unknown, path: string): TableCssColors {
  if (!isRecord(value) || Object.keys(value).some((key) => !COLOR_KEYS.has(key)) ||
      typeof value.color !== 'string' || typeof value.background !== 'string' ||
      typeof value.border !== 'string') {
    throw new Error(`${path} must contain string color, background, and border fields.`);
  }
  return { color: value.color, background: value.background, border: value.border };
}

/** Read the Basics 0.3 `TemplateSpec.table` contract at Extension boundaries. */
export function readTableTemplateOptions(
  projection: Record<string, unknown>,
  path: string
): TableTemplateOptions {
  if (projection.table === undefined) return { composition: 'rows' };
  if (projection.mode !== 'block') {
    throw new Error(`${path}.table is valid only in block mode.`);
  }
  const table = projection.table;
  if (!isRecord(table) || Object.keys(table).some((key) => !TABLE_KEYS.has(key)) ||
      (table.composition !== 'rows' && table.composition !== 'cells')) {
    throw new Error(`${path}.table must select composition "rows" or "cells".`);
  }
  if (table.css === undefined) return { composition: table.composition };
  if (!isRecord(table.css) || Object.keys(table.css).some((key) => !THEME_KEYS.has(key)) ||
      !Object.hasOwn(table.css, 'light') || !Object.hasOwn(table.css, 'dark')) {
    throw new Error(`${path}.table.css must contain complete light and dark themes.`);
  }
  return {
    composition: table.composition,
    css: {
      light: readColors(table.css.light, `${path}.table.css.light`),
      dark: readColors(table.css.dark, `${path}.table.css.dark`)
    }
  };
}

export function assertTableTemplateOptions(
  projection: Record<string, unknown>,
  path: string
): void {
  readTableTemplateOptions(projection, path);
}
