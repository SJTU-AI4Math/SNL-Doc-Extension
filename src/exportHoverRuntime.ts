// Build-time generation of the exported document's hover runtime.
//
// The exported HTML must restore hover highlighting with no React and no host
// bridge. Rather than reimplement SNL-Basics's policy (which is what drifted
// and broke — 猫猫 2026-07-29), we bundle SNL-Basics's OWN
// `applySnlHoverHighlight` / `findMinimalHoverRoot` into a self-contained IIFE
// and ship that. Panel and export then run the same function by construction.
//
// This runs at BUILD time (`npm run build:export-runtime`), not when the user
// hits Export: a packaged VS Code extension has no esbuild to call, and an
// export should not depend on devDependencies being present. The generated file
// is written to `media/exportRuntime.js` and read back at export time.
//
// `@sjtu-ai4math/snl-basics/hover` is a DOM-only subpath entry (3 kB, no React,
// no KaTeX) added for exactly this consumer.

import { build } from 'esbuild';
import { HOVER_ENTRY_SOURCE } from './exportRuntime';

/**
 * Bundle SNL-Basics's hover helpers into an IIFE that installs `__snlHover`.
 *
 * Resolved from `resolveDir` so the real installed package is used — the same
 * copy the webview bundles, so the export cannot silently pin an older policy.
 */
export async function buildHoverRuntimeSource(resolveDir: string): Promise<string> {
  const result = await build({
    stdin: {
      contents: HOVER_ENTRY_SOURCE,
      resolveDir,
      sourcefile: 'snl-hover-entry.js',
      loader: 'js'
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2018',
    minify: true,
    write: false,
    legalComments: 'none'
  });
  const out = result.outputFiles?.[0];
  if (!out) throw new Error('esbuild produced no output for the hover runtime');
  return out.text;
}
