export interface KindColoringVariant {
  [key: string]: unknown;
  stroke: string;
  background: string;
}

export interface ThemedKindColoring {
  [key: string]: unknown;
  light: KindColoringVariant;
  dark: KindColoringVariant;
}

export interface LegacyKindColoring {
  [key: string]: unknown;
  stroke: string;
  background: string;
}

export type CompatibleKindColoring = ThemedKindColoring | LegacyKindColoring;

export const DEFAULT_LIGHT_KIND_COLORING: Readonly<KindColoringVariant> = {
  stroke: '#475569',
  background: '#F1F5F9'
};

export const DEFAULT_DARK_KIND_COLORING: Readonly<KindColoringVariant> = {
  stroke: '#94A3B8',
  background: '#1E293B'
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requireVariant(value: unknown, path: string): KindColoringVariant {
  const candidate = record(value);
  if (!candidate) throw new Error(`${path} must be an object.`);
  if (typeof candidate.stroke !== 'string' || !candidate.stroke.trim()) {
    throw new Error(`${path}.stroke must be a non-empty string.`);
  }
  if (typeof candidate.background !== 'string' || !candidate.background.trim()) {
    throw new Error(`${path}.background must be a non-empty string.`);
  }
  const { stroke, background, ...extensions } = candidate;
  return { ...extensions, stroke, background } as KindColoringVariant;
}

function compatibilityVariant(value: unknown, path: string): Partial<KindColoringVariant> | null {
  if (value === undefined) return null;
  const candidate = record(value);
  if (!candidate) throw new Error(`${path} must be an object when present.`);
  if ('stroke' in candidate && typeof candidate.stroke !== 'string') {
    throw new Error(`${path}.stroke must be a string when present.`);
  }
  if ('background' in candidate && typeof candidate.background !== 'string') {
    throw new Error(`${path}.background must be a string when present.`);
  }
  const { stroke, background, ...extensions } = candidate;
  return {
    ...extensions,
    ...(typeof stroke === 'string' ? { stroke } : {}),
    ...(typeof background === 'string' ? { background } : {})
  };
}

function nonBlank(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

export function requireThemedKindColoring(value: unknown, path: string): ThemedKindColoring {
  const candidate = record(value);
  if (!candidate) throw new Error(`${path} must be an object.`);
  if ('stroke' in candidate || 'background' in candidate) {
    throw new Error(`${path} must not mix legacy stroke/background with light/dark variants.`);
  }
  const { light, dark, stroke: _stroke, background: _background, ...extensions } = candidate;
  return {
    ...extensions,
    light: requireVariant(light, `${path}.light`),
    dark: requireVariant(dark, `${path}.dark`)
  };
}

export function assertThemedKindCatalogs(value: unknown): void {
  const config = record(value);
  if (!config) throw new Error('config.json must be an object.');
  for (const field of ['entry_kinds', 'macro_kinds'] as const) {
    const catalog = config[field];
    if (!Array.isArray(catalog)) {
      throw new Error(`config.json#${field} must be an array.`);
    }
    const ids = new Set<string>();
    catalog.forEach((item, index) => {
      const kind = record(item);
      if (!kind) throw new Error(`config.json#${field}[${index}] must be an object.`);
      if (typeof kind.id !== 'string' || !kind.id.trim()) {
        throw new Error(`config.json#${field}[${index}].id must be a non-empty string.`);
      }
      if (kind.id.trim() !== kind.id) {
        throw new Error(`config.json#${field}[${index}].id must be canonical without surrounding whitespace.`);
      }
      if (ids.has(kind.id)) {
        throw new Error(`config.json#${field} contains duplicate id ${JSON.stringify(kind.id)}.`);
      }
      ids.add(kind.id);
      const required = field === 'entry_kinds'
        ? ['name', 'defaultCounterName', 'style']
        : ['name', 'description'];
      for (const key of required) {
        if (typeof kind[key] !== 'string') {
          throw new Error(`config.json#${field}[${index}].${key} must be a string.`);
        }
      }
      requireThemedKindColoring(kind.coloring, `config.json#${field}[${index}].coloring`);
    });
  }
}

export function isThemedKindColoring(value: unknown): value is ThemedKindColoring {
  try {
    requireThemedKindColoring(value, 'coloring');
    return true;
  } catch {
    return false;
  }
}

/** Compatibility read for pre-0.0.9 Kind records. Current-version writes are themed. */
export function normalizeKindColoring(value: unknown): ThemedKindColoring {
  const candidate = record(value);
  if (value !== undefined && !candidate) {
    throw new Error('coloring must be an object when present.');
  }
  if (candidate && ('light' in candidate || 'dark' in candidate)) {
    if ('stroke' in candidate || 'background' in candidate) {
      throw new Error('coloring must not mix legacy stroke/background with light/dark variants.');
    }
    const light = compatibilityVariant(candidate.light, 'coloring.light');
    const dark = compatibilityVariant(candidate.dark, 'coloring.dark');
    const {
      light: _light, dark: _dark,
      stroke: _stroke, background: _background,
      ...extensions
    } = candidate;
    return {
      ...extensions,
      light: {
        ...(light ?? dark ?? {}),
        stroke: nonBlank(light?.stroke) ?? nonBlank(dark?.stroke) ?? DEFAULT_LIGHT_KIND_COLORING.stroke,
        background: nonBlank(light?.background) ?? nonBlank(dark?.background) ?? DEFAULT_LIGHT_KIND_COLORING.background
      },
      dark: {
        ...(dark ?? light ?? {}),
        stroke: nonBlank(dark?.stroke) ?? nonBlank(light?.stroke) ?? DEFAULT_DARK_KIND_COLORING.stroke,
        background: nonBlank(dark?.background) ?? nonBlank(light?.background) ?? DEFAULT_DARK_KIND_COLORING.background
      }
    };
  }
  if (candidate && ('stroke' in candidate || 'background' in candidate)) {
    if ('stroke' in candidate && typeof candidate.stroke !== 'string') {
      throw new Error('coloring.stroke must be a string when present.');
    }
    if ('background' in candidate && typeof candidate.background !== 'string') {
      throw new Error('coloring.background must be a string when present.');
    }
    const stroke = nonBlank(candidate.stroke as string | undefined);
    const background = nonBlank(candidate.background as string | undefined);
    const { stroke: _stroke, background: _background, ...extensions } = candidate;
    if (stroke || background) {
      const legacy = {
        stroke: stroke ?? background!,
        background: background ?? stroke!
      };
      return { ...extensions, light: { ...legacy }, dark: { ...legacy } };
    }
  }
  const extensions = candidate
    ? (({ light: _light, dark: _dark, stroke: _stroke, background: _background, ...rest }) => rest)(candidate)
    : {};
  return {
    ...extensions,
    light: { ...DEFAULT_LIGHT_KIND_COLORING },
    dark: { ...DEFAULT_DARK_KIND_COLORING }
  };
}

export function cloneThemedKindColoring(coloring: ThemedKindColoring): ThemedKindColoring {
  return { ...coloring, light: { ...coloring.light }, dark: { ...coloring.dark } };
}

export function mergeThemedKindColoring(
  existing: ThemedKindColoring,
  update: ThemedKindColoring
): ThemedKindColoring {
  return {
    ...existing,
    ...update,
    light: { ...existing.light, ...update.light },
    dark: { ...existing.dark, ...update.dark }
  };
}

export function fillKindColoringDefaults(coloring: ThemedKindColoring): ThemedKindColoring {
  return {
    ...coloring,
    light: {
      ...coloring.light,
      stroke: coloring.light.stroke.trim() || DEFAULT_LIGHT_KIND_COLORING.stroke,
      background: coloring.light.background.trim() || DEFAULT_LIGHT_KIND_COLORING.background
    },
    dark: {
      ...coloring.dark,
      stroke: coloring.dark.stroke.trim() || DEFAULT_DARK_KIND_COLORING.stroke,
      background: coloring.dark.background.trim() || DEFAULT_DARK_KIND_COLORING.background
    }
  };
}
