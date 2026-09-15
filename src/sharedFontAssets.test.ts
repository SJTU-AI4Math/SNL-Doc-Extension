import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserConfig } from 'vite';

// Exercise the real production output policy, not a copy of its callback.
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
async function assetName(entry: string, name: string, plural = false): Promise<string> {
  vi.stubEnv('SNL_WEBVIEW_ENTRY', entry);
  vi.resetModules();
  const config = (await import('../webview/vite.config')).default as UserConfig;
  const output = config.build?.rollupOptions?.output;
  if (!output || Array.isArray(output) || typeof output.assetFileNames !== 'function') {
    throw new Error('Expected production assetFileNames callback');
  }
  return output.assetFileNames({
    type: 'asset', name, names: plural ? [name] : [],
    originalFileName: undefined, originalFileNames: [], source: ''
  });
}

describe('shared document font sidecars', () => {
  it.each(['woff2', 'woff', 'ttf'])('shares .%s output across independent production entries', async extension => {
    for (const font of [`KaTeX_Main-Regular.${extension}`, `noto-serif-sc-42-400-normal.${extension}`]) {
      expect(await assetName('main', font)).toBe('[name]-[hash][extname]');
      expect(await assetName('entryInfoview', font, true)).toBe('[name]-[hash][extname]');
    }
  });
  it('keeps CSS and non-font assets scoped to their production entry', async () => {
    expect(await assetName('main', 'style.css')).toBe('main.css');
    expect(await assetName('entryInfoview', 'style.css', true)).toBe('entryInfoview.css');
    expect(await assetName('main', 'diagram.svg')).toBe('main-[name]-[hash][extname]');
    expect(await assetName('entryInfoview', 'diagram.svg', true)).toBe('entryInfoview-[name]-[hash][extname]');
  });
});
