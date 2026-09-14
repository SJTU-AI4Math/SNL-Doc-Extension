// Explicit compiled-Host acceptance: run npm run compile first.
// Kept outside the source-only default Vitest suite so clean npm test never
// silently consumes a stale/missing out/createMacroPanel.js.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom', 'react/jsx-runtime'], alias: {
    react: resolve(root, 'node_modules/react'),
    'react-dom': resolve(root, 'node_modules/react-dom'),
    'react/jsx-runtime': resolve(root, 'node_modules/react/jsx-runtime.js')
  } },
  test: { environment: 'jsdom', include: ['webview/src/CreateMacroCommittedRevision.acceptance.tsx'] }
});
