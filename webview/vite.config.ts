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
//
// `npm run build:webview` runs all passes in sequence (see package.json).
// Only the first pass (main) clears the output directory.
type Entry =
  | 'main'
  | 'createLibrary'
  | 'dashboard'
  | 'initEntryKinds'
  | 'createEntryKind'
  | 'createEntry';

const ENTRY_TO_INPUT: Record<Entry, string> = {
  main: 'src/main.tsx',
  createLibrary: 'src/createLibrary.tsx',
  dashboard: 'src/dashboard.tsx',
  initEntryKinds: 'src/initEntryKinds.tsx',
  createEntryKind: 'src/createEntryKind.tsx',
  createEntry: 'src/createEntry.tsx'
};

const entry = (process.env.SNL_WEBVIEW_ENTRY as Entry) || 'main';
const inputFile = ENTRY_TO_INPUT[entry] ?? ENTRY_TO_INPUT.main;

export default defineConfig({
  plugins: [react()],
  base: './',
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
        assetFileNames: `${entry}.[ext]`
      }
    }
  }
});
