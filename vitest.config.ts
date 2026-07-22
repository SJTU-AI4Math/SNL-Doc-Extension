import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
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
