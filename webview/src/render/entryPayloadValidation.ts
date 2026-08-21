import { is_valid_i18n_string } from '../../../src/localizedContent';
import { isThemedKindColoring } from '../../../src/kindColoring';
import type { Localized } from '@sjtu-ai4math/snl-basics/runtime';
import type { EntryData, EntryKind } from './EntryRender';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyLocalizedLabel = (value: unknown): value is Localized<string, string> =>
  typeof value === 'string'
    ? value.trim().length > 0
    : is_valid_i18n_string(value) &&
      Object.values(value.values).some((projection) =>
        typeof projection === 'string' && projection.trim().length > 0);

export function isEntryDataPayload(value: unknown): value is EntryData {
  return isRecord(value) && typeof value.id === 'string' && typeof value.kind === 'string' &&
    (typeof value.title === 'string' || is_valid_i18n_string(value.title)) &&
    isRecord(value.content);
}

export function isEntryKindPayload(value: unknown): value is EntryKind {
  return isRecord(value) && typeof value.id === 'string' &&
    isNonEmptyLocalizedLabel(value.name) &&
    (value.description === undefined || typeof value.description === 'string' ||
      is_valid_i18n_string(value.description)) &&
    isThemedKindColoring(value.coloring) && typeof value.style === 'string' &&
    (value.numbering === undefined || typeof value.numbering === 'string') &&
    (value.defaultCounterName === undefined || typeof value.defaultCounterName === 'string');
}
