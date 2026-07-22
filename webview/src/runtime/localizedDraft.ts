import {
  write_localized,
  type I18n
} from '@snl-basics/react';

/** Preserve fallback semantics until the user actually edits this locale. */
export function merge_localized_projection(
  original: I18n<string, string>,
  projection: string,
  language: string,
  dirty: boolean
): I18n<string, string> {
  if (!dirty) return original;
  return write_localized<string, string>(original, projection)({ language }) as I18n<string, string>;
}
