import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Mirror webview/vite.config.ts's React dedupe so tests resolve React the same
// way the real bundles do. Without a single pinned copy, a test that renders a
// @sjtu-ai4math/snl-basics component can end up with two React instances and
// the classic "Cannot read properties of null (reading 'useState')".
const reactResolve = {
  dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
  alias: {
    react: resolve(__dirname, 'node_modules/react'),
    'react-dom': resolve(__dirname, 'node_modules/react-dom'),
    'react/jsx-runtime': resolve(__dirname, 'node_modules/react/jsx-runtime.js')
  }
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: reactResolve,
        test: {
          name: 'node',
          include: ['src/**/*.test.ts', 'webview/src/**/*.test.ts'],
          exclude: [
            'webview/src/runtime/preferencesRuntime.test.ts',
            'out/**',
            'external/**',
            'media/**',
            'node_modules/**'
          ],
          environment: 'node'
        }
      },
      {
        resolve: reactResolve,
        test: {
          name: 'webview-dom',
          include: [
            'webview/src/**/*.test.tsx',
            'webview/src/runtime/preferencesRuntime.test.ts'
          ],
          exclude: ['out/**', 'external/**', 'media/**', 'node_modules/**'],
          environment: 'jsdom'
        }
      }
    ]
  }
});
