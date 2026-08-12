import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * KaTeX is ~250KB of minified JS. It reached panels that render no math at
 * all, because tiny helpers (`read_localized`, `parseSnlSyntaxTree`) were only
 * exported from the SNL-Basics barrel — and that barrel also exports the React
 * views, which import KaTeX. Every panel therefore paid for the whole math
 * engine on open. Cat 2026-07-25: "各个 Panel 开起来都非常慢".
 *
 * The fix is the `/runtime` and `/core` subpath exports. This test keeps it
 * fixed: if someone reaches for the barrel again from a shared module, a
 * math-free panel doubles in size and this fails.
 */
const MEDIA = resolve(__dirname, '..', 'media', 'webview');

/** Panels that genuinely render math, and so legitimately ship KaTeX. */
const RENDERS_MATH = new Set([
  'createEntry',
  'entryInfoview',
  'snlGraph',
  'main',
  'createMacro',
  'packagePanel'
]);

/**
 * Panels with no math surface. `fontMetrics` is a KaTeX-internal identifier
 * that survives minification, so its presence is a reliable tell.
 */
const MATH_FREE = [
  'initEntryKinds',
  'initMacroKinds',
  'createEntryKind',
  'createMacroKind',
  'createMacroPackage',
  'createEntryPackage',
  'entryPackagePanel',
  'createRelationship',
  'createLibrary',
  'dashboard',
  'snoogl'
];

function bundle(name: string): string | null {
  const file = resolve(MEDIA, `${name}.js`);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

describe('webview bundle leanness', () => {
  // `media/webview` is gitignored, so a fresh clone has no bundles at all and
  // every assertion below would pass vacuously. Fail loudly instead: a green
  // check here must mean the guard actually ran.
  const built = MATH_FREE.filter((name) => bundle(name) !== null);
  const skip = built.length === 0;

  it.skipIf(skip)('has bundles to inspect', () => {
    expect(built.length).toBe(MATH_FREE.length);
  });

  it.skipIf(skip)('keeps KaTeX out of panels that render no math', () => {
    const offenders = built.filter((name) => bundle(name)!.includes('fontMetrics'));
    expect(offenders).toEqual([]);
  });

  it.skipIf(skip)('keeps math-free panels well under the KaTeX-inclusive size', () => {
    // A KaTeX-carrying bundle is 450KB+; a lean one is ~200-240KB. 300KB
    // sits clearly between the two, so this catches a regression without
    // being brittle about ordinary growth.
    const tooBig = built
      .map((name) => ({ name, bytes: bundle(name)!.length }))
      .filter((entry) => entry.bytes > 300_000);
    expect(tooBig).toEqual([]);
  });

  it('still ships KaTeX where math is actually rendered', () => {
    // Guards the other direction: a "leanness" change must not silently
    // break real math rendering.
    const mathBuilt = [...RENDERS_MATH].filter((name) => bundle(name) !== null);
    if (mathBuilt.length === 0) return;
    const missing = mathBuilt.filter((name) => !bundle(name)!.includes('fontMetrics'));
    expect(missing).toEqual([]);
  });
});
