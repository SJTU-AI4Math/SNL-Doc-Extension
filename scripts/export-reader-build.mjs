import { resolve } from 'node:path';
import { build } from 'esbuild';

// The shared React reader remains the production entry, including its offline fonts.
export async function buildExportReader(root) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [resolve(root, 'webview/src/reader/BrowserReader.tsx')],
    outfile: resolve(root, 'media/exportRuntime.js'),
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
    // Nonliteral import()/require() calls otherwise survive without metafile edges.
    logOverride: { 'unsupported-dynamic-import': 'error', 'unsupported-require-call': 'error' },
    write: false, metafile: true
  });
  assertSelfContainedReader(result, root);
  return result;
}

// This is an esbuild output contract, not a sandbox or a prebundled-eval audit.
export function assertSelfContainedReader(result, root = process.cwd()) {
  if (!result.metafile || !result.outputFiles) {
    throw new Error('export reader requires in-memory outputs and a metafile');
  }
  const outputs = Object.entries(result.metafile.outputs);
  for (const [path, output] of outputs) {
    // CSS font/SVG data URLs are inline resources, not deferred JS dependencies.
    const imports = path.endsWith('.css')
      ? output.imports.filter((item) => !item.path.startsWith('data:'))
      : output.imports;
    if (imports.length) {
      throw new Error(`export reader has external/deferred imports: ${imports.map((item) => item.path).join(', ')}`);
    }
  }
  for (const [extension, label] of [['js', 'JavaScript'], ['css', 'CSS']]) {
    const expected = outputs.filter(([path]) => path.endsWith(`/exportRuntime.${extension}`) || path === `exportRuntime.${extension}`);
    if (expected.length !== 1) throw new Error(`export reader requires nonempty ${label} output`);
    for (const [path] of outputs.filter(([path]) => path.endsWith(`.${extension}`))) {
      const file = result.outputFiles.find((item) => item.path === resolve(root, path));
      if (!file || !file.text.trim()) throw new Error(`export reader requires nonempty ${label} output: ${path}`);
    }
  }
}
