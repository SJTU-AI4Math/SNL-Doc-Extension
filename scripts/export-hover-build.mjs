import { build } from 'esbuild';

const forbiddenPackage = /(?:^|[/\\])(?:react|react-dom|katex)(?:[/\\]|$)/;

export function assertDomOnlyHover(result) {
  for (const output of Object.values(result.metafile.outputs)) {
    for (const [path, input] of Object.entries(output.inputs)) {
      if (input.bytesInOutput > 0 && forbiddenPackage.test(path)) {
        throw new Error(`hover runtime retained React or KaTeX: ${path} (${input.bytesInOutput} bytes)`);
      }
    }
    // A self-contained IIFE must not defer dependencies to the exported page.
    if (output.imports.length) {
      throw new Error(`hover runtime has external imports (React/KaTeX forbidden): ${output.imports.map((item) => item.path).join(', ')}`);
    }
  }
  // A prebundled renderer can lose its original node_modules provenance.
  // These are engine diagnostics/symbols, not legal .katex/.react markup.
  const engineFingerprint = /KaTeX parse error:|KaTeX doesn't work in quirks mode|react\.(?:transitional\.)?element|react\.fragment/;
  if (result.outputFiles.some((file) => engineFingerprint.test(file.text))) {
    throw new Error('hover runtime retained a prebundled React or KaTeX engine');
  }
}

function unusedHoverReactEdges() {
  return {
    name: 'unused-hover-react-edges',
    setup(build) {
      build.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, async (args) => {
        // Basics 0.3.4's public ./hover shares this chunk with hooks/defaultRenderHooks.
        // Its unused renderer functions leave CJS React initialization edges behind.
        // Only these two known imports may skip evaluation when UNUSED: this is
        // esbuild's onResolve sideEffects contract, not an empty module/alias.
        // A live React binding still resolves to the real package and fails the
        // retained-byte guard above. Do not mark the whole Basics chunk pure.
        if (args.pluginData?.hoverReactResolved ||
            !/[/\\]@sjtu-ai4math[/\\]snl-basics[/\\]dist-lib[/\\]chunks[/\\]hover-apply-[^/\\]+\.js$/.test(args.importer)) return;
        const resolved = await build.resolve(args.path, {
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: { hoverReactResolved: true }
        });
        return { ...resolved, sideEffects: false };
      });
    }
  };
}

export async function buildHoverRuntime(contents, resolveDir) {
  const result = await build({
    stdin: { contents, resolveDir, sourcefile: 'snl-hover-entry.js', loader: 'js' },
    bundle: true, format: 'iife', platform: 'browser', target: 'es2018',
    minify: true, write: false, legalComments: 'none', metafile: true,
    plugins: [unusedHoverReactEdges()]
  });
  assertDomOnlyHover(result);
  return result;
}
