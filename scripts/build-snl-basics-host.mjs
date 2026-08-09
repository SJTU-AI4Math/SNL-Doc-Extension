import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outfile = fileURLToPath(new URL('../out/snl-basics-host.cjs', import.meta.url));

await build({
  stdin: {
    contents: [
      "export { migrateMacroDocument, migrateMacroV7toV8 } from '@sjtu-ai4math/snl-basics';",
      "export { isSnlIdentifier } from '@sjtu-ai4math/snl-basics/core';"
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
