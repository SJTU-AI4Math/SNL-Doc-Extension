import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outfile = fileURLToPath(new URL('../out/snl-basics-host.cjs', import.meta.url));

await build({
  stdin: {
    contents: [
      "export { migrateMacroDocument, migrateMacroV7toV8, readSnlTableRenderOptions } from '@sjtu-ai4math/snl-basics';",
      "export { isSnlIdentifier, parseSnlSyntaxTree } from '@sjtu-ai4math/snl-basics/core';"
    ].join('\n'),
    loader: 'js',
    resolveDir: root
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify: true,
  legalComments: 'none',
  logLevel: 'info'
});

// These contracts are shared with browser code, where public ESM imports are
// correct. Materialize only their host outputs through the existing CJS bridge;
// do not edit the published package or copy its validation algorithms.
await build({
  absWorkingDir: root,
  entryPoints: ['src/tableTemplateOptions.ts', 'src/uiSpecVerifier.ts'],
  outdir: 'out', bundle: true, packages: 'external',
  platform: 'node', format: 'cjs', target: 'node20',
  plugins: [{ name: 'snl-public-host-bridge', setup(b) {
    b.onResolve({ filter: /^@sjtu-ai4math\/snl-basics(?:\/core)?$/ }, () => ({
      path: './snl-basics-host.cjs', external: true,
    }));
  } }],
  logLevel: 'info',
});
