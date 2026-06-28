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
//   - main.js  -> Infoview  (src/main.tsx)
//   - init.js  -> Init guide (src/init.tsx)
//
// `npm run build:webview` runs both passes in sequence (see package.json).
type Entry = 'main' | 'init';

const entry = (process.env.SNL_WEBVIEW_ENTRY as Entry) || 'main';
const inputFile = entry === 'init' ? 'src/init.tsx' : 'src/main.tsx';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: resolve(__dirname, '../media/webview'),
    // Only the first pass clears the dir; the second appends its bundle.
    emptyOutDir: entry === 'main',
    // Emit a single self-contained file per entry (no shared/vendor chunk),
    // so the classic <script> tag in the panels can execute it as-is.
    codeSplitting: false,
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
