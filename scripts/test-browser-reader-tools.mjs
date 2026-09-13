#!/usr/bin/env node
// Production BrowserReader browser gate. Optional real Host exports use the same QA corpus.
// This assembly path is not itself an Extension Host export claim.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { buildExportDocument, EXPORT_BASE_CSS } = require('../out/exportHtmlDocument.js');
const { frozenReaderScript } = require('../out/sharedReaderSnapshot.js');
const { chromium } = require(process.env.SNL_PLAYWRIGHT_PATH || '/tmp/snl-viewer-browser-tools/node_modules/playwright-core');
const executablePath = process.env.SNL_CHROMIUM_PATH || resolve(process.env.HOME, '.agent-browser/browsers/chrome-152.0.7977.54/chrome');
assert(existsSync(executablePath), 'Set SNL_CHROMIUM_PATH');
const out = process.env.SNL_READER_EVIDENCE || mkdtempSync(resolve(tmpdir(), 'snl-reader-tools-'));
mkdirSync(out, { recursive: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const localize = (en, zh) => ({ type: 'i18n', default_language: 'en', values: { en, 'zh-CN': zh } });
const kinds = ['entry', 'section'].map(id => ({ id, name: localize(id, id === 'entry' ? '条目' : '节'), style: id === 'section' ? 'section' : '', defaultCounterName: id,
  coloring: { light: { stroke: '#0369a1', background: '#e0f2fe' }, dark: { stroke: '#7dd3fc', background: '#313131' } } }));
const entry = (id, title, content, kind = 'entry') => ({ id, package: 'P', kind, title, content, pointer: null, contribution_info: null });
const entries = [entry('Alpha', localize('Alpha definition', '甲定义'), { snl: 'Ref(x)' }),
  entry('Beta', localize('Beta source', '乙来源'), { markdown: localize('Beta source body.\n\n![Frozen image](assets/probe.svg)', '乙来源正文。\n\n![冻结图片](assets/probe.svg)') }),
  entry('Gamma', localize('Gamma section', '丙章节'), { markdown: localize('Gamma documentation', '丙文档') }, 'section'),
  entry('Delta', localize('Delta neighbor', '丁邻接'), { text: localize('Delta manual relationship body', '丁手工关系正文') })];
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="60"><rect width="180" height="60" fill="#1769aa"/><text x="16" y="37" fill="white">Frozen asset</text></svg>';
const snapshot = { version: 1, renderSnapshotId: 'browser-tools-qa', library: { slug: 'BrowserTools', title: 'Browser Tools QA', warnings: [], outline: entries.slice(0, 3).map((e, i) => ({ nodeId: ['alpha-node', 'beta-node', 'gamma-node'][i], entry: e, kind: kinds.find(k => k.id === e.kind), children: [], counterLabel: null })) },
  entries, entryKinds: kinds, entryPackages: Object.fromEntries(entries.map(e => [e.id, e.package])),
  macros: { Ref: { name: 'Ref', description: 'Reference macro', kind: 'const', dynamic_arity: false, source: { entries: ['Beta'], urls: [] }, tags: [], styles: [{ style_name: 'default', tags: [], template: { mode: 'formula_inline', body: '\\mathsf{Ref}(#0)' } }] } },
  macroKinds: [], relationships: [
    { id: 'alpha-beta', from: 'Alpha', to: 'Beta', label: 'depends', metadata: { generator: 'macro-source-scan', isAtomic: true } },
    { id: 'alpha-gamma', from: 'Alpha', to: 'Gamma', label: 'depends', metadata: { generator: 'macro-source-scan', isAtomic: false } },
    { id: 'beta-gamma', from: 'Beta', to: 'Gamma', label: 'related', metadata: {} },
    { id: 'gamma-delta', from: 'Gamma', to: 'Delta', label: 'related', metadata: {} }],
  preferences: { language: 'en', color_scheme: 'light', motion: 'reduced' }, contentLanguage: 'en', languages: [{ id: 'en', display_name: 'English' }, { id: 'zh-CN', display_name: '简体中文' }],
  resources: { 'probe.svg': { url: 'data:image/svg+xml;base64,' + Buffer.from(image).toString('base64'), text: image, revision: digest(image) } } };
const artifacts = {};
for (const shape of ['folder', 'single']) {
  const supplied = process.env[shape === 'folder' ? 'SNL_READER_FOLDER' : 'SNL_READER_SINGLE'];
  if (supplied) { artifacts[shape] = resolve(supplied); continue; }
  const dir = resolve(out, shape); mkdirSync(resolve(dir, 'assets'), { recursive: true });
  writeFileSync(resolve(dir, 'assets/sjtu-ai4math-logo.svg'), readFileSync(resolve(root, 'media/icons/logoCSS_black.svg')));
  if (shape === 'folder') writeFileSync(resolve(dir, 'readerSnapshot.js'), frozenReaderScript(snapshot));
  const script = (shape === 'single' ? frozenReaderScript(snapshot) : '') + '\n' + readFileSync(resolve(root, 'media/exportRuntime.js'), 'utf8');
  artifacts[shape] = resolve(dir, 'index.html');
  writeFileSync(artifacts[shape], buildExportDocument({ title: 'Browser Tools QA', css: EXPORT_BASE_CSS + '\n' + readFileSync(resolve(root, 'media/exportRuntime.css'), 'utf8'), body: '<div id="snl-reader-root"></div>', script, scriptSources: shape === 'folder' ? ['readerSnapshot.js'] : [] }));
}
const server = createServer((req, res) => {
  try {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean), shape = parts.shift();
    assert(shape in artifacts); const base = dirname(artifacts[shape]);
    const path = resolve(base, ...parts); assert(path.startsWith(base + '/'));
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' })[extname(path)] ?? 'text/html');
    res.end(readFileSync(path));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--num-raster-threads=1'] });
const results = [];
try {
  for (const shape of ['folder', 'single']) for (const protocol of ['http', 'file']) {
    const url = protocol === 'file' ? pathToFileURL(artifacts[shape]).href : `http://127.0.0.1:${server.address().port}/${shape}/${artifacts[shape].split('/').at(-1)}`;
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    // Test instrumentation exposes the existing Monaco instance; exported bytes stay unchanged.
    await context.addInitScript(() => { globalThis.MonacoEnvironment = { globalAPI: true }; });
    if (protocol === 'file') await context.setOffline(true);
    const page = await context.newPage(), errors = [], cases = [];
    page.setDefaultTimeout(5000);
    page.on('pageerror', e => errors.push(String(e)));
    page.on('requestfailed', r => errors.push(r.url() + ': ' + r.failure()?.errorText));
    await page.route('**/*', route => /^https?:/.test(route.request().url()) && !route.request().url().startsWith('http://127.0.0.1:') ? route.abort() : route.continue());
    const step = async (name, action) => { await action(); cases.push(name); };
    const hash = () => page.evaluate(() => location.hash);
    const back = () => page.getByRole('button', { name: /^(← )?Back$/ }).click();
    try {
      await page.goto(url);
      await step('scope', async () => {
        const data = await page.evaluate(() => ({ entries: window.__SNL_READER__.entries.map(e => e.id).sort(), edges: window.__SNL_READER__.relationships.length }));
        assert.deepEqual(data, { entries: ['Alpha', 'Beta', 'Delta', 'Gamma'], edges: 4 });
      });
      await step('search-and-filter', async () => {
        await page.getByRole('button', { name: 'SNoogL', exact: true }).click();
        await page.getByRole('listbox').waitFor();
        assert.equal(await page.locator('li[role="option"]').count(), 4);
        const input = page.getByPlaceholder(/Search entries/);
        await input.fill('Alpha'); await input.press('Enter');
        await page.waitForFunction(() => document.querySelector('[role="option"]')?.textContent.includes('Alpha'));
        assert((await page.locator('li[role="option"]').first().innerText()).includes('Alpha'));
        await page.locator('li[role="option"]').first().click();
        await page.waitForFunction(() => location.hash.startsWith('#/entry/Alpha'));
        await back(); await input.waitFor(); assert.equal(await input.inputValue(), 'Alpha');
        await page.reload(); await input.waitFor(); assert.equal(await input.inputValue(), 'Alpha');
        await input.fill(''); await input.press('Enter');
        await page.getByLabel(/^Kind/).selectOption('section');
        await page.waitForFunction(() => document.querySelectorAll('li[role="option"]').length === 1 && document.querySelector('li[role="option"]').textContent.includes('Gamma'));
        await page.getByLabel(/^Kind/).selectOption('');
        await page.getByLabel(/^Uses Macro ID/).selectOption('Ref');
        await page.waitForFunction(() => document.querySelectorAll('li[role="option"]').length === 1 && document.querySelector('li[role="option"]').textContent.includes('Alpha'));
        await page.screenshot({ path: resolve(out, `${shape}-${protocol}-search.png`) });
        const contrast = await page.locator('li[role="option"]').first().evaluate(e => {
          const rgba = s => { const x = s.match(/[\d.]+/g)?.map(Number); return x?.length >= 3 ? [x[0], x[1], x[2], x[3] ?? 1] : [0, 0, 0, 0]; };
          const blend = (a, b) => a.slice(0, 3).map((v, i) => v * a[3] + b[i] * (1 - a[3]));
          const ancestors = []; for (let n = e; n; n = n.parentElement) ancestors.unshift(n);
          let bg = [255, 255, 255]; for (const n of ancestors) bg = blend(rgba(getComputedStyle(n).backgroundColor), bg);
          const fg = blend(rgba(getComputedStyle(e).color), bg);
          const luma = rgb => rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
          const a = luma(fg), b = luma(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
        assert(contrast >= 4.5, `Search text contrast ${contrast}: dark-host fallback on light reader`);
      });
      await step('macro-preview-and-source', async () => {
        await page.getByRole('button', { name: 'Macro', exact: true }).click();
        const input = page.getByPlaceholder(/Search macros/); await input.fill('Ref'); await input.press('Enter');
        await page.locator('li[role="option"]').first().click();
        await page.getByText('Read-only Macro preview', { exact: true }).waitFor();
        assert(await page.locator('.katex').count() > 0);
        await page.getByRole('button', { name: 'Beta', exact: true }).click();
        await page.waitForFunction(() => location.hash.startsWith('#/entry/Beta'));
        await page.locator('img[alt="Frozen image"]:visible').first().waitFor();
        assert(await page.locator('img[alt="Frozen image"]:visible').first().evaluate(i => i.complete && i.naturalWidth > 0));
        await back(); await page.getByText('Read-only Macro preview', { exact: true }).waitFor();
        await back(); await input.waitFor(); assert.equal(await input.inputValue(), 'Ref');
      });
      await step('same-kind-search-history', async () => {
        await page.getByRole('button', { name: 'SNoogL', exact: true }).click();
        const input = page.getByPlaceholder(/Search entries/); await input.waitFor();
        assert.equal(await input.inputValue(), '');
        await input.fill('Alpha'); await input.press('Enter');
        await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('q') === 'Alpha');
        await page.getByRole('button', { name: 'SNoogL', exact: true }).click();
        assert.equal(await input.inputValue(), '');
        await input.fill('Beta'); await input.press('Enter');
        await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('q') === 'Beta');
        await page.goBack();
        await page.waitForFunction(() => document.querySelector('input[type="text"]')?.value === 'Alpha');
        assert((await page.locator('li[role="option"]').first().innerText()).includes('Alpha'));
      });
      await step('graph-filters-pan-zoom-navigation', async () => {
        await page.getByRole('button', { name: 'Relationship graph', exact: true }).click();
        const nodes = page.locator('svg [role="button"][aria-label^="Entry "]');
        await nodes.first().waitFor(); assert.equal(await nodes.count(), 4);
        await page.getByRole('button', { name: /◀ Filters/ }).click();
        const atomic = page.getByLabel('atomic deps only', { exact: true }); assert(await atomic.isChecked());
        const edges = page.locator('svg [aria-label^="Relationship "]'); assert.equal(await edges.count(), 3);
        await atomic.uncheck(); assert.equal(await edges.count(), 4);
        await page.getByRole('button', { name: 'none', exact: true }).click(); assert.equal(await nodes.count(), 0);
        await page.getByRole('button', { name: 'all', exact: true }).click(); await nodes.first().waitFor(); assert.equal(await nodes.count(), 4);
        await page.getByRole('button', { name: 'Entry Beta source (Beta)', exact: true }).hover();
        const preview = page.locator('.snl-entry-hover-popover:visible'); await preview.waitFor();
        assert((await preview.innerText()).includes('Beta source body'));
        assert(await preview.locator('img').evaluate(i => i.complete && i.naturalWidth > 0));
        await page.mouse.move(5, 5); await preview.waitFor({ state: 'hidden' });
        const svg = page.locator('svg:has(g[aria-label^="Entry "])');
        const viewport = svg.locator('g[transform]').first(); const before = await viewport.getAttribute('transform');
        const box = await svg.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -200);
        await page.waitForFunction(before => document.querySelector('svg g[transform]')?.getAttribute('transform') !== before, before);
        const afterZoom = await viewport.getAttribute('transform');
        await page.mouse.move(box.x + 12, box.y + 12); await page.mouse.down(); await page.mouse.move(box.x + 60, box.y + 35); await page.mouse.up();
        assert.notEqual(await viewport.getAttribute('transform'), afterZoom);
        await page.screenshot({ path: resolve(out, `${shape}-${protocol}-graph.png`) });
        const beta = nodes.filter({ hasText: 'Beta' }); await beta.click({ modifiers: ['Control'] });
        await page.waitForFunction(() => location.hash.startsWith('#/entry/Beta'));
        await back(); await nodes.first().waitFor();
        await page.reload(); await nodes.first().waitFor(); assert((await hash()).startsWith('#/graph'));
      });
      if (await page.evaluate(() => Boolean(window.__snlSources))) await step('reused-source-document-sync', async () => {
        await page.getByRole('button', { name: 'SNoogL', exact: true }).click();
        const input = page.getByPlaceholder(/Search entries/); await input.fill('Alpha'); await input.press('Enter');
        await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('q') === 'Alpha' && document.querySelector('li[role="option"]')?.textContent.startsWith('Alpha'));
        await page.locator('li[role="option"]').first().click();
        await page.locator('.snl-entry-source-action:visible').click();
        await page.waitForFunction(() => window.monaco?.editor.getEditors()[0]?.getSelection()?.startLineNumber === 2);
        assert(await page.evaluate(() => window.monaco.editor.getEditors()[0].getRawOptions().readOnly));
        await page.getByLabel('Follow cursor', { exact: true }).check();
        await page.evaluate(() => { const e = window.monaco.editor.getEditors()[0]; e.setPosition({ lineNumber: 3, column: 5 }); e.focus(); });
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => document.querySelector('[data-entry-id="Beta"][data-snl-source-current]'));
        assert(await page.evaluate(() => document.activeElement.closest('.monaco-editor') !== null));
        await page.getByLabel('Follow cursor', { exact: true }).uncheck();
        await page.evaluate(() => { const e = window.monaco.editor.getEditors()[0]; e.setPosition({ lineNumber: 2, column: 5 }); e.focus(); });
        await page.keyboard.press('Control+Alt+j');
        await page.waitForFunction(() => location.hash === '#/node/alpha-node' && document.querySelector('[data-snl-route-id="alpha-node"] [data-snl-source-current]'));
        await page.screenshot({ path: resolve(out, `${shape}-${protocol}-source-sync.png`) });
        await page.getByRole('button', { name: 'Hide', exact: true }).click();
        await page.getByRole('button', { name: 'Relationship graph', exact: true }).click();
      });
      await step('theme-language-and-narrow', async () => {
        await page.getByRole('button', { name: 'Reading preferences', exact: true }).click();
        await page.getByLabel('Theme', { exact: true }).selectOption('dark');
        assert.equal(await page.locator('html').getAttribute('data-snl-color-scheme'), 'dark');
        await page.getByRole('button', { name: 'Reading preferences', exact: true }).click();
        await page.getByRole('button', { name: /^Content language:/ }).click();
        await page.getByRole('menuitemradio', { name: /简体中文/ }).click();
        await page.getByRole('button', { name: /Entry 乙来源/ }).waitFor();
        await page.getByRole('button', { name: /^Interface language:/ }).click();
        await page.getByRole('menuitemradio', { name: /简体中文/ }).click();
        await page.getByRole('button', { name: '关系图', exact: true }).waitFor();
        await page.setViewportSize({ width: 620, height: 800 });
        await page.waitForFunction(() => {
          const nodes = [...document.querySelectorAll('svg g[role="button"]')];
          return nodes.length === 4 && nodes.every(n => { const r = n.getBoundingClientRect(), v = n.closest('svg').getBoundingClientRect(); return r.width > 0 && r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom; });
        }, null, { timeout: 3000 });
        await page.screenshot({ path: resolve(out, `${shape}-${protocol}-dark-cn-narrow.png`) });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      });
      assert.deepEqual(errors, []);
      results.push({ shape, protocol, url, sha256: digest(readFileSync(artifacts[shape])), cases, errors, ok: true });
    } catch (e) {
      await page.screenshot({ path: resolve(out, `${shape}-${protocol}-failed.png`) });
      const controls = await page.locator('button, select, [role="option"]').evaluateAll(xs => xs.filter(x => x.getClientRects().length).map(x => ({ tag: x.tagName, role: x.getAttribute('role'), aria: x.getAttribute('aria-label'), text: x.textContent?.slice(0, 160) })));
      const geometry = await page.locator('svg g[role="button"]').evaluateAll(xs => xs.map(n => ({ label: n.getAttribute('aria-label'), rect: n.getBoundingClientRect().toJSON(), svg: n.closest('svg').getBoundingClientRect().toJSON() })));
      results.push({ shape, protocol, url, sha256: digest(readFileSync(artifacts[shape])), cases, errors, controls, geometry, ok: false, error: String(e) });
      throw e;
    } finally {
      writeFileSync(resolve(out, 'results.json'), JSON.stringify(results, null, 2)); await context.close();
    }
  }
} finally { await browser.close(); await new Promise(r => server.close(r)); console.log(JSON.stringify({ out, results }, null, 2)); }
