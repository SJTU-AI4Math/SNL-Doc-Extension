import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { expect, it } from 'vitest';

it('builds an independent production browser and Node ESM model from the exact shared reader sources', async () => {
  const out = mkdtempSync(resolve(tmpdir(), 'snl-local-build-'));
  const source = mkdtempSync(resolve(tmpdir(), 'snl-local-source-'));
  let dom: JSDOM | undefined;
  try {
    // No generated out/ is copied: a clean source package must build itself.
    for (const item of ['src', 'webview', 'scripts', 'media', 'package.json', 'package-lock.json']) cpSync(resolve(item), resolve(source, item), { recursive: true });
    symlinkSync(resolve('node_modules'), resolve(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const output = execFileSync(process.execPath, ['scripts/build-local-reader.mjs', '--out', out], { encoding: 'utf8', cwd: source });
    expect(output).toContain('Built local workspace reader');
    const html = readFileSync(resolve(out, 'index.html'), 'utf8');
    expect(html).toContain('/__snl/static/reader.js');
    expect(html).toContain('/__snl/static/reader.css');
    expect(readFileSync(resolve(out, 'reader.css'), 'utf8')).toContain('katex');
    const sources = JSON.parse(readFileSync(resolve(out, 'reader.sources.json'), 'utf8'));
    for (const source of ['webview/src/reader/BrowserReader.tsx', 'webview/src/reader/readerRoute.ts', 'webview/src/SnooglApp.tsx', 'webview/src/SnlGraphApp.tsx']) {
      expect(sources[source]).toBe(createHash('sha256').update(readFileSync(source)).digest('hex'));
    }
    const modelUrl = pathToFileURL(resolve(out, 'model.mjs')).href;
    const snapshot = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { buildWorkspaceReaderSnapshot, readerAssetPaths } from ${JSON.stringify(modelUrl)};
      const entry = { id: 'Shared', package: 'P', kind: 'lemma', title: 'Shared title', content: { markdown: 'Production model body' }, pointer: null };
      const snapshot = buildWorkspaceReaderSnapshot({ config: {}, entries: [entry], entryKinds: [], macros: {}, macroKinds: [], relationships: [],
        library: { slug: 'L', metadata: { title: 'Production library' }, counters: [], graph: { nodes: [{ id: 'one', label: 'Entry', props: { entryId: 'Shared' } }], relationships: [] } } });
      if (readerAssetPaths(snapshot).length) throw new Error('Unexpected test assets');
      console.log(JSON.stringify(snapshot));
    `], { encoding: 'utf8', cwd: out }));
    expect(snapshot.library.slug).toBe('L');
    const errors: unknown[] = [];
    const console = new VirtualConsole();
    console.on('jsdomError', error => errors.push(error));
    console.on('error', error => errors.push(error));
    dom = new JSDOM(html, { url: 'http://localhost:4911/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console });
    const calls: string[] = [];
    dom.window.fetch = (async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => url === '/__snl/api/workspace'
        ? { id: 'local', name: 'Production workspace', root: '/folder', libraries: [{ slug: 'L', title: 'Production library' }], capabilities: { edit: false } }
        : snapshot };
    }) as typeof fetch;
    const waitFor = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
      if (predicate()) { resolve(); return; }
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Production DOM did not settle')); }, 3000);
      const observer = new dom!.window.MutationObserver(() => {
        if (predicate()) { clearTimeout(timer); observer.disconnect(); resolve(); }
      });
      observer.observe(dom!.window.document.body, { childList: true, subtree: true, characterData: true });
    });
    dom.window.eval(readFileSync(resolve(out, 'reader.js'), 'utf8'));
    await waitFor(() => !!dom!.window.document.querySelector('a'));
    dom.window.document.querySelector('a')!.click();
    await waitFor(() => dom!.window.document.body.textContent!.includes('Production model body'));
    expect(calls).toEqual(['/__snl/api/workspace', '/__snl/api/snapshot?library=L']);
    expect(dom.window.location.hash).toBe('#/library?library=L');
    expect(dom.window.document.body.textContent).not.toContain('frozen export');
    expect(errors).toEqual([]);
  } finally { dom?.window.close(); rmSync(out, { recursive: true, force: true }); rmSync(source, { recursive: true, force: true }); }
}, 20000);
