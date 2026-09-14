// Real browser regression against the built production shared Reader.
// node scripts/test-canonical-reader-hover.cjs ENTRIES.json MACROS.json OUTPUT.json
// Set PLAYWRIGHT_MODULE to an installed Playwright module if not locally available.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const [entryFile, macroFile, outputFile] = process.argv.slice(2);
assert(entryFile && macroFile && outputFile, 'Expected canonical entries, macros, and output paths');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const entries = read(entryFile).map(e => e.value);
const macros = Object.fromEntries(read(macroFile).map(m => [m.value.name, m.value]));
const snapshot = { version: 1, renderSnapshotId: 'canonical-hover-regression', library: { slug: 'logic-review', title: 'Canonical hover regression', outline: [], warnings: [] }, entries, entryKinds: [], entryPackages: {}, macros, macroKinds: [], relationships: [], resources: {}, contentLanguage: 'en', preferences: { language: 'en', color_scheme: 'light', motion: 'full', popover_hover_enabled: true }, languages: [{ id: 'en', display_name: 'English' }] };
const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/media/exportRuntime.css"></head><body><div id="snl-reader-root"></div><script>window.__SNL_READER__=' + JSON.stringify(snapshot).replaceAll('<', '\\u003c') + '</script><script src="/media/exportRuntime.js"></script></body></html>';
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (!req.url.startsWith('/media/') || req.url.includes('..')) return res.writeHead(404).end();
  const p = root + req.url.split('?')[0];
  try {
    res.setHeader('Content-Type', p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    let content = fs.readFileSync(p);
    // Explicit negative control: serve the built CSS without this one fix.
    if (process.env.OMIT_EMPTY_VLIST_FIX === '1' && p.endsWith('exportRuntime.css')) {
      content = content.toString().replace(/\.snl-entry-overflow-surface \.katex \.vlist:has\(> ?span:only-child:empty\)\s*\{[^}]*\}/g, '');
    }
    res.end(content);
  } catch { res.writeHead(404).end(); }
});
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
(async () => {
  const out = { root, artifacts: Object.fromEntries([entryFile, macroFile, root + '/media/exportRuntime.js', root + '/media/exportRuntime.css'].map(p => [p, sha256(p)])), cases: [], bindings: [], errors: [], failures: [] };
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    page.on('pageerror', e => out.errors.push(String(e)));
    const ids = ['Denumerable', 'And', 'Iff', 'Exists', 'partialOrderOfSO'];
    for (const id of ids) {
      assert(entries.some(e => e.id === id), 'Missing real canonical Entry: ' + id);
      const url = 'http://127.0.0.1:' + server.address().port + '/#/entry/' + encodeURIComponent(id);
      await page.goto(url);
      await page.waitForSelector('[data-entry-body]');
      await page.waitForFunction(() => !(/Resolving Entry context|Loading entry/i.test(document.body.innerText)));
      await page.evaluate(() => document.fonts.ready);
      const errors = await page.locator('[data-entry-body] .katex-error,[data-entry-body] [role=alert]').allTextContents();
      out.cases.push({ id, url: page.url(), errors });
      assert.equal(errors.length, 0, JSON.stringify({ id, errors }));
      let loc = page.locator('[data-entry-body] [data-kind="bvar"][data-source-path]:visible:not(.katex-mathml *)');
      if (id === 'partialOrderOfSO') loc = loc.filter({ hasText: 'inst' });
      const count = Math.min(await loc.count(), 3);
      assert(count > 0, id + ' has no visible references');
      for (let i = 0; i < count; i++) {
        const target = loc.nth(i);
        await page.mouse.move(1590, 1090);
        await target.scrollIntoViewIfNeeded();
        await page.waitForFunction(() => document.querySelectorAll('.snl-binder-decl').length === 0);
        const hit = await target.evaluate(e => {
          const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
          const actual = document.elementFromPoint(x, y);
          const owner = actual?.closest('[data-kind][data-source-path]');
          return { x, y, text: e.textContent, path: e.getAttribute('data-source-path'), actual: actual?.outerHTML, ownerPath: owner?.getAttribute('data-source-path'), targetHit: !!actual && (actual === e || e.contains(actual)), emptyVlist: !!actual?.matches('.vlist:has(> span:only-child:empty)'), pointerEvents: actual && getComputedStyle(actual).pointerEvents, surface: e.closest('.snl-entry-overflow-surface') !== null };
        });
        await page.mouse.move(hit.x, hit.y);
        const requireBinder = true;
        const expectedDomainPath = id === 'partialOrderOfSO' ? '0.2.1' : null;
        let highlighted = false;
        try {
          await page.waitForFunction(({ expectedDomainPath }) => {
            const marks = [...document.querySelectorAll('[data-entry-body] .snl-binder-decl')];
            return marks.some(e => {
              const r = e.getBoundingClientRect();
              return (!expectedDomainPath || e.getAttribute('data-tree-path') === expectedDomainPath) &&
                r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
            });
          }, { expectedDomainPath }, { timeout: 3000 });
          highlighted = true;
        } catch {}
        const highlightedPaths = await page.locator('[data-entry-body] .snl-binder-decl').evaluateAll(es => es.map(e => e.getAttribute('data-tree-path')));
        out.bindings.push({ id, index: i, ...hit, requireBinder, expectedDomainPath, highlighted, highlightedPaths });
        if (!hit.targetHit || !highlighted || (expectedDomainPath && hit.path !== '0.2.0')) out.failures.push({ id, index: i, path: hit.path, expectedDomainPath, targetHit: hit.targetHit, highlighted, highlightedPaths });
      }
    }
    // Guard the precise empty-only boundary using the production CSS cascade.
    out.boundary = await page.evaluate(() => {
      const host = document.createElement('div');
      host.className = 'snl-entry-overflow-surface';
      host.innerHTML = '<div class="katex"><span class="vlist" id="empty"><span></span></span><span class="vlist" id="visible"><span>x</span></span><span class="vlist" id="multiple"><span></span><span>x</span></span></div><span class="vlist" id="outside"><span></span></span>';
      document.body.append(host);
      const result = Object.fromEntries(['empty', 'visible', 'multiple', 'outside'].map(id => [id, getComputedStyle(host.querySelector('#' + id)).pointerEvents]));
      host.remove(); return result;
    });
    if (out.boundary.empty !== 'none' || ['visible', 'multiple', 'outside'].some(id => out.boundary[id] !== 'auto')) out.failures.push({ boundary: out.boundary });
    out.success = out.failures.length === 0 && out.errors.length === 0;
  } finally {
    fs.writeFileSync(outputFile, JSON.stringify(out, null, 2));
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({ success: out.success, cases: out.cases.length, bindings: out.bindings.length, errors: out.errors, failures: out.failures, boundary: out.boundary }));
  assert.equal(out.success, true, 'Canonical real-pointer hover regression failed; see ' + outputFile);
})().catch(e => { console.error(e); server.close(); process.exitCode = 1; });
