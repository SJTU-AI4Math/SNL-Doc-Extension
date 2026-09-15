import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { assertSelfContainedReader, buildExportReader } from '../scripts/export-reader-build.mjs';

const root = resolve(__dirname, '..');
const exec = promisify(execFile);

async function fixture(source: string, css = true) {
  const dir = await mkdtemp(resolve(tmpdir(), 'snl-reader-build-'));
  await mkdir(resolve(dir, 'scripts'), { recursive: true });
  await mkdir(resolve(dir, 'webview/src/reader'), { recursive: true });
  await symlink(resolve(root, 'node_modules'), resolve(dir, 'node_modules'), 'dir');
  for (const file of ['build-export-runtime.mjs', 'export-reader-build.mjs']) {
    await copyFile(resolve(root, 'scripts', file), resolve(dir, 'scripts', file));
  }
  await writeFile(resolve(dir, 'webview/src/reader/BrowserReader.tsx'),
    (css ? 'import "./reader.css";\n' : '') + source);
  await writeFile(resolve(dir, 'webview/src/reader/reader.css'), 'body { color: red; }');
  return dir;
}

async function rawResult(source: string) {
  return build({
    stdin: { contents: source, resolveDir: root },
    outfile: resolve(tmpdir(), 'snl-reader-output/exportRuntime.js'),
    bundle: true, format: 'iife', platform: 'browser', minify: true,
    write: false, metafile: true
  });
}

const externalSources = [
  ['static external', 'import * as live from "https://example.invalid/live.js"; globalThis.live = live;'],
  ['deferred external', 'globalThis.load = () => import("https://example.invalid/live.js");']
];

describe('production React export reader build gate', () => {
  it('builds the real BrowserReader in memory with React, math and offline font data URLs', async () => {
    const result = await buildExportReader(root);
    expect(() => assertSelfContainedReader(result)).not.toThrow();
    const js = result.outputFiles.find((file) => file.path.endsWith('/exportRuntime.js'));
    const css = result.outputFiles.find((file) => file.path.endsWith('/exportRuntime.css'));
    expect(js?.text.length).toBeGreaterThan(0);
    expect(css?.text).toMatch(/data:(?:font|application)\/[^;]+;base64,/);
    const inputs = Object.keys(result.metafile.inputs).join('\n');
    expect(inputs).toContain('BrowserReader.tsx');
    expect(inputs).toMatch(/node_modules\/react\//);
    expect(inputs).toMatch(/node_modules\/katex\//);
    const jsOutputs = Object.entries(result.metafile.outputs).filter(([path]) => path.endsWith('.js'));
    expect(jsOutputs.length).toBeGreaterThan(0);
    for (const [, output] of jsOutputs) expect(output.imports).toEqual([]);
    expect(Object.values(result.metafile.outputs).some((output) =>
      output.imports.some((item) => item.path.startsWith('data:')))).toBe(true);
  }, 60_000);

  it.each(externalSources)('rejects real esbuild %s output (not fabricated metadata)', async (_name, source) => {
    const result = await rawResult(source);
    const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports);
    expect(imports.some((item) => item.external && item.path.includes('example.invalid'))).toBe(true);
    expect(() => assertSelfContainedReader(result)).toThrow(/imports/);
  });

  it('rejects genuinely empty emitted JavaScript', async () => {
    const result = await build({
      stdin: { contents: '', resolveDir: root },
      outfile: resolve(tmpdir(), 'snl-reader-output/exportRuntime.js'),
      bundle: true, format: 'esm', minify: true, write: false, metafile: true
    });
    expect(result.outputFiles[0].text).toBe('');
    expect(() => assertSelfContainedReader(result)).toThrow(/nonempty JavaScript/);
  });

  it.each([
    'globalThis.load = (path) => import(path);',
    'globalThis.load = (path) => require(path);'
  ])('rejects unresolved deferred loading: %s', async (source) => {
    const dir = await fixture(source);
    try {
      await expect(buildExportReader(dir)).rejects.toThrow(/not be bundled|unsupported/i);
      expect(await readdir(dir)).not.toContain('media');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('requires emitted CSS, not merely a configured filename', async () => {
    const dir = await fixture('globalThis.live = true;', false);
    try {
      await expect(buildExportReader(dir)).rejects.toThrow(/CSS/);
      expect(await readdir(dir)).not.toContain('media');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each([false, true])('actual production CLI rejects before writes (existing output: %s)', async (existing) => {
    const dir = await fixture(externalSources[1][1]);
    const files = ['exportRuntime.js', 'exportRuntime.css', 'exportRuntime.meta.json'];
    try {
      if (existing) {
        await mkdir(resolve(dir, 'media'));
        for (const file of files) await writeFile(resolve(dir, 'media', file), 'previous-good-output');
      }
      let failure: any;
      try {
        await exec(process.execPath, ['--v8-pool-size=2', resolve(dir, 'scripts/build-export-runtime.mjs')],
          { cwd: dir, env: { ...process.env, UV_THREADPOOL_SIZE: '2' } });
      } catch (error) { failure = error; }
      expect(failure, 'unchecked CLI must not successfully publish external JS').toBeDefined();
      expect(failure?.stderr).toMatch(/imports/);
      if (existing) {
        expect((await readdir(resolve(dir, 'media'))).sort()).toEqual([...files].sort());
        for (const file of files) expect(await readFile(resolve(dir, 'media', file), 'utf8')).toBe('previous-good-output');
      } else expect(await readdir(dir)).not.toContain('media');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('actual production CLI publishes validated JS, CSS and metadata in a private directory', async () => {
    const dir = await fixture('globalThis.live = document.querySelector(".react, .katex");');
    try {
      await exec(process.execPath, ['--v8-pool-size=2', resolve(dir, 'scripts/build-export-runtime.mjs')],
        { cwd: dir, env: { ...process.env, UV_THREADPOOL_SIZE: '2' } });
      expect((await readdir(resolve(dir, 'media'))).sort()).toEqual(
        ['exportRuntime.css', 'exportRuntime.js', 'exportRuntime.meta.json']);
      expect(await readFile(resolve(dir, 'media/exportRuntime.js'), 'utf8')).toContain('.react, .katex');
      expect(await readFile(resolve(dir, 'media/exportRuntime.css'), 'utf8')).toContain('color:red');
      const meta = JSON.parse(await readFile(resolve(dir, 'media/exportRuntime.meta.json'), 'utf8'));
      expect(Object.keys(meta.outputs)).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
