import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Build the React webview into ../media/webview/.
//
// The extension host loads each bundle via a classic (non-module)
// `<script nonce=... src=...>` tag, so every entry must be a SELF-CONTAINED
// bundle with no top-level `import` (no shared/vendor chunk). We therefore
// build one entry per invocation (selected by SNL_WEBVIEW_ENTRY) and append
// to the same outDir:
//   - main.js            -> Infoview                (src/main.tsx)
//   - createLibrary.js   -> Create Library          (src/createLibrary.tsx)
//   - dashboard.js       -> Dashboard               (src/dashboard.tsx)
//   - initEntryKinds.js  -> Initialize Entry Kinds  (src/initEntryKinds.tsx)
//   - createEntryKind.js -> Create Entry Kind       (src/createEntryKind.tsx)
//   - createEntry.js     -> Create Entry            (src/createEntry.tsx)
//   - createMacroPackage.js -> Create Macro Package (src/createMacroPackage.tsx)
//   - packagePanel.js    -> Macro Package Panel     (src/packagePanel.tsx)
//   - createMacro.js     -> Create Macro editor     (src/createMacro.tsx)
//
// `npm run build:webview` runs all passes in sequence (see package.json).
// Only the first pass (main) clears the output directory.
type Entry =
  | 'main'
  | 'entryInfoview'
  | 'createLibrary'
  | 'dashboard'
  | 'initEntryKinds'
  | 'createEntryKind'
  | 'initMacroKinds'
  | 'createMacroKind'
  | 'createEntry'
  | 'createMacroPackage'
  | 'packagePanel'
  | 'createMacro'
  | 'createRelationship'
  | 'snlGraph'
  | 'snoogl'
  | 'guiEditor';

const ENTRY_TO_INPUT: Record<Entry, string> = {
  main: 'src/main.tsx',
  entryInfoview: 'src/entryInfoview.tsx',
  createLibrary: 'src/createLibrary.tsx',
  dashboard: 'src/dashboard.tsx',
  initEntryKinds: 'src/initEntryKinds.tsx',
  createEntryKind: 'src/createEntryKind.tsx',
  initMacroKinds: 'src/initMacroKinds.tsx',
  createMacroKind: 'src/createMacroKind.tsx',
  createEntry: 'src/createEntry.tsx',
  createMacroPackage: 'src/createMacroPackage.tsx',
  packagePanel: 'src/packagePanel.tsx',
  createMacro: 'src/createMacro.tsx',
  createRelationship: 'src/createRelationship.tsx',
  snlGraph: 'src/snlGraph.tsx',
  snoogl: 'src/snoogl.tsx',
  guiEditor: 'src/guiEditor.tsx'
};

const entry = (process.env.SNL_WEBVIEW_ENTRY as Entry) || 'main';
const inputFile = ENTRY_TO_INPUT[entry] ?? ENTRY_TO_INPUT.main;

export default defineConfig({
  plugins: [react()],
  base: './',
  // Dedupe react across the extension's own node_modules and the
  // SNL-Basics submodule's nested node_modules. Without this, vite
  // resolves `react` twice (once from each side of the file:… dep) and
  // ships two copies of React in the same bundle. React's hooks
  // dispatcher is a module-scoped singleton, so useMemo in a component
  // rendered by SnlSyntaxTreeView (bound to lib React) crashes with
  // "Cannot read properties of null (reading 'useMemo')" the instant
  // it runs. Cat 2026-07-13 hit this after a submodule bump reinstalled
  // external/SNL-Basics/node_modules/react.
  resolve: {
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
    alias: {
      react: resolve(__dirname, '../node_modules/react'),
      'react-dom': resolve(__dirname, '../node_modules/react-dom'),
      'react/jsx-runtime': resolve(
        __dirname,
        '../node_modules/react/jsx-runtime.js'
      )
    }
  },
  build: {
    outDir: resolve(__dirname, '../media/webview'),
    // Only the first pass clears the dir; subsequent passes append.
    emptyOutDir: entry === 'main',
    // Emit a single self-contained file per entry (no shared/vendor chunk),
    // so the classic <script> tag in the panels can execute it as-is. The
    // single-file shape is enforced by the rollup output config below, not
    // by any top-level Vite flag.
    rollupOptions: {
      input: resolve(__dirname, inputFile),
      output: {
        entryFileNames: `${entry}.js`,
        chunkFileNames: `${entry}.js`,
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
            return `${entry}.css`;
          }
          return `${entry}-[name]-[hash][extname]`;
        }
      }
    }
  }
});
