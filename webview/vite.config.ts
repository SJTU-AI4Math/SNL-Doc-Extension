import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import productionEntries from './productionEntries.json';

// Build the React webview into ../media/webview/.
//
// The extension host loads each bundle via a classic (non-module)
// `<script nonce=... src=...>` tag, so every entry must be a SELF-CONTAINED
// bundle with no top-level `import` (no shared/vendor chunk). We therefore
// build one entry per invocation (selected by SNL_WEBVIEW_ENTRY) and append to
// the same outDir. productionEntries.json locks every input and output, and
// `npm run build:webview` runs every manifest entry in sequence.
// Only the first pass (main) clears the output directory.
const requestedEntry = process.env.SNL_WEBVIEW_ENTRY ?? 'main';
const entry = productionEntries.entries.find(
  (candidate) => candidate.name === requestedEntry
);
if (!entry) {
  throw new Error(`Unknown production webview entry: ${requestedEntry}`);
}

export default defineConfig({
  plugins: [react()],
  base: './',
  // Pin React to a single copy. @sjtu-ai4math/snl-basics ships components
  // that call hooks; if vite ever resolves `react` twice (a nested copy under
  // the dependency, a linked dev checkout, a hoisting quirk) the bundle gets
  // two React instances. The hooks dispatcher is a module-scoped singleton, so
  // useMemo inside SnlSyntaxTreeView then crashes with "Cannot read properties
  // of null (reading 'useMemo')". Cat 2026-07-13 hit exactly this.
  resolve: {
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
    alias: {
      react: resolve(__dirname, '../node_modules/react'),
      'react-dom': resolve(__dirname, '../node_modules/react-dom'),
      'react/jsx-runtime': resolve(
        __dirname,
        '../node_modules/react/jsx-runtime.js'
      ),
      'monaco-editor/esm/vs/editor/editor.api.js': resolve(
        __dirname,
        '../node_modules/monaco-editor/esm/vs/editor/editor.api.js'
      ),
      'monaco-editor-editor-worker': resolve(
        __dirname,
        '../node_modules/monaco-editor/esm/vs/editor/editor.worker.js'
      )
    }
  },
  build: {
    outDir: resolve(__dirname, '../media/webview'),
    // Keep even tiny font subsets as files. The export pipeline rewrites and
    // copies font URLs; Vite's default base64 inlining would strand Noto data
    // URLs in every captured locale/theme variant.
    assetsInlineLimit: 0,
    // Only the first pass clears the dir; subsequent passes append.
    emptyOutDir: entry.name === 'main',
    // Emit a single self-contained file per entry (no shared/vendor chunk),
    // so the classic <script> tag in the panels can execute it as-is. The
    // single-file shape is enforced by the rollup output config below, not
    // by any top-level Vite flag.
    rollupOptions: {
      input: resolve(__dirname, entry.input),
      output: {
        entryFileNames: entry.output,
        chunkFileNames: `${entry.name}-[name]-[hash].js`,
        // CSS must be a predictable sibling (`<entry>.css`) so buildPanelHtml
        // can <link> it. Every other asset (KaTeX web-fonts pulled in via the
        // `katex.min.css` import) keeps a hashed name so the many font files
        // don't collide under the single `${entry}.[ext]` pattern. Fonts are
        // referenced by the rewritten CSS url() and served from `media/` (same
        // webview source), so no CSP/font-src change is needed.
        assetFileNames: (asset): string => {
          const info = asset as { name?: string; names?: string[] };
          const name = info.names?.[0] ?? info.name ?? '';
          if (name.endsWith('.css')) {
            return `${entry.name}.css`;
          }
          return `${entry.name}-[name]-[hash][extname]`;
        }
      }
    }
  }
});
