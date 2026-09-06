import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { assertDomOnlyHover, buildHoverRuntime } from '../scripts/export-hover-build.mjs';
import { HOVER_ENTRY_SOURCE } from './exportRuntime';

const root = resolve(__dirname, '..');

describe('DOM-only export hover build gate', () => {
  it('accepts DOM class selectors without mistaking markup for libraries', async () => {
    const result = await buildHoverRuntime(
      'globalThis.select = () => document.querySelectorAll(".katex, .react, .katex-html");', root
    );
    expect(result.outputFiles[0].text).toContain('.katex, .react');
  });

  it('tree-shakes the published public hover entry without React symbols or renderer functions', async () => {
    const result = await buildHoverRuntime(HOVER_ENTRY_SOURCE, root);
    const output = Object.values(result.metafile.outputs)[0];
    expect(output.imports).toEqual([]);
    expect(Object.keys(output.inputs).filter((path) => /node_modules[\/]react(?:[\/]|-)/.test(path))).toEqual([]);
    const code = result.outputFiles[0].text;
    expect(code).toContain('.katex'); // the 0.3.4 semantic geometry path survives
    expect(code).not.toMatch(/react\.element|react\.transitional\.element|react\.fragment|snl-block-list|snl-hover-tooltip/);
    const sandbox: Record<string, any> = {};
    runInNewContext(code, sandbox); // no React, require or DOM is needed at initialization
    expect(Object.keys(sandbox.__snlHover).sort()).toEqual(['apply', 'clear', 'resolveRoot']);
    for (const value of Object.values(sandbox.__snlHover)) expect(typeof value).toBe('function');
  });

  it.each([
    ['React', 'import { createElement } from "react"; globalThis.live = createElement("div", null, "live");'],
    ['React JSX', 'import { jsx } from "react/jsx-runtime"; globalThis.live = jsx("div", {children: "live"});'],
    ['KaTeX', 'import katex from "katex"; globalThis.live = katex.renderToString("x");'],
    // The exact shared hover-apply chunk now has LIVE renderer bindings. The
    // scoped sideEffects hint must not replace or discard those real imports.
    ['Basics render hooks', 'import { defaultRenderHooks } from "@sjtu-ai4math/snl-basics"; globalThis.live = defaultRenderHooks.renderers.list;']
  ])('rejects actual live %s usage added to the hover entry', async (_name, source) => {
    await expect(buildHoverRuntime(HOVER_ENTRY_SOURCE + '\n' + source, root)).rejects.toThrow(/React|KaTeX/);
  });

  it.each(['react', 'react/jsx-runtime', 'katex'])('rejects retained external %s imports', async (name) => {
    const result = await build({
      stdin: { contents: `import * as live from ${JSON.stringify(name)}; globalThis.live = live;`, resolveDir: root },
      bundle: true, format: 'iife', platform: 'browser', external: [name],
      write: false, metafile: true, minify: true
    });
    expect(() => assertDomOnlyHover(result)).toThrow(/React|KaTeX/);
  });

  it('rejects a real prebundled KaTeX renderer even when package provenance is flattened', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'snl-hover-gate-'));
    try {
      const packed = await build({
        stdin: { contents: 'export { default } from "katex";', resolveDir: root },
        bundle: true, format: 'esm', platform: 'browser', minify: true,
        write: false, legalComments: 'none'
      });
      const renderer = resolve(dir, 'renderer.js');
      await writeFile(renderer, packed.outputFiles[0].text);
      const result = await build({
        stdin: { contents: `import renderer from ${JSON.stringify(renderer)}; globalThis.live = renderer.renderToString("x");`, resolveDir: root },
        bundle: true, format: 'iife', platform: 'browser', minify: true,
        write: false, metafile: true, legalComments: 'none'
      });
      expect(Object.keys(result.metafile.inputs).some((path) => path.includes('node_modules/katex/'))).toBe(false);
      expect(() => assertDomOnlyHover(result)).toThrow(/KaTeX/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
