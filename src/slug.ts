/**
 * Pure (vscode-free) helpers for SNL Doc initialization.
 *
 * Kept dependency-free so the slug logic can be unit-tested directly by
 * requiring the compiled `out/slug.js` from plain Node, without a VS Code
 * extension host.
 */

/**
 * Slugify a user-supplied library title into a filesystem-safe slug.
 *
 * Rules (see Plan.md / BUILD_BRIEF_init.md):
 * - trim the input;
 * - replace whitespace runs (space/tab/newline) with `_`;
 * - keep only CJK characters, a-z, A-Z, 0-9, `_`, `-` (drop everything else);
 * - if the result is empty (e.g. all symbols), fall back to `library_1`.
 *
 * The original (non-slugified) title is stored elsewhere; this only produces
 * the slug.
 */
export function slugify(title: string): string {
  const trimmed = (title ?? '').trim();

  // Collapse any whitespace (incl. tabs/newlines) into single underscores.
  const underscored = trimmed.replace(/\s+/g, '_');

  // Keep CJK ideographs, ASCII letters/digits, underscore and hyphen.
  // \u4e00-\u9fff covers the common CJK Unified Ideographs block.
  const cleaned = underscored.replace(/[^\u4e00-\u9fffA-Za-z0-9_-]/g, '');

  return cleaned.length > 0 ? cleaned : 'library_1';
}
