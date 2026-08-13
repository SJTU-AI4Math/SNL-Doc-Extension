#!/usr/bin/env node

import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = resolve(root, 'media/webview');
for (const file of ['createLibrary.js', 'createLibrary.css']) {
  if (!existsSync(resolve(bundleDir, file))) {
    throw new Error(`Missing production bundle ${file}; build createLibrary before this probe.`);
  }
}

const chromeCandidates = [
  process.env.SNL_CHROMIUM_PATH,
  resolve(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'),
  resolve(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1187/chrome-linux/chrome'),
  '/usr/bin/chromium',
  '/usr/bin/google-chrome'
].filter(Boolean);
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!chromePath) {
  throw new Error('No Chromium found. Set SNL_CHROMIUM_PATH to run the production-browser probe.');
}

const localized = (value) => ({
  type: 'localized',
  values: { en: value, 'zh-CN': value },
  default_language: 'en'
});
const nodes = Array.from({ length: 10 }, (_, index) => ({
  id: `node-${index + 1}`,
  label: 'entry',
  props: { entryId: `entry-${index + 1}` }
}));
const relationships = nodes.slice(1).map((node, index) => ({
  from: nodes[index].id,
  to: node.id,
  label: 'branch'
}));
const entries = nodes.map((node, index) => ({
  id: node.props.entryId,
  kind: 'definition',
  title: localized(`Realistic adjacent library row ${index + 1}`),
  content: { snl: `Definition(Row${index + 1})` }
}));
const fixture = {
  context: {
    type: 'context', mode: 'edit', targetState: 'found', slug: 'paint-probe',
    libraryRevision: 'probe-revision', existing: { slug: 'paint-probe', title: 'Paint Probe' }
  },
  graph: {
    type: 'graph', nodes, relationships, entries,
    kinds: [{
      id: 'definition', name: localized('Definition'),
      description: localized('Definition kind'), defaultCounterName: 'section'
    }],
    metricMacroSources: {},
    metricThresholds: { structuralIndexRedBelow: 60, structuralIndexGreenAtLeast: 80 },
    warnings: []
  },
  counters: {
    type: 'countersLoaded',
    counters: [{ id: 'counter-1', name: 'section', numbering: '1', children: [] }]
  }
};

const html = `<!doctype html>
<html data-snl-color-scheme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/createLibrary.css">
<style>
  html { font-size: 16px; }
  body { margin: 0; color: var(--vscode-foreground, #ddd); background: var(--vscode-editor-background, #1e1e1e); font-family: Arial, sans-serif; }
</style>
<script>
  window.__snlFixture = ${JSON.stringify(fixture)};
  window.__snlPosted = [];
  window.acquireVsCodeApi = () => ({
    postMessage(message) {
      window.__snlPosted.push(message);
      if (message && message.type === 'ready') {
        for (const payload of [window.__snlFixture.context, window.__snlFixture.graph, window.__snlFixture.counters]) {
          window.dispatchEvent(new MessageEvent('message', { data: payload }));
        }
      }
    },
    getState() { return undefined; },
    setState() {}
  });
</script>
</head>
<body><div id="root"></div><script src="/createLibrary.js"></script></body>
</html>`;

const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
    return;
  }
  if (pathname === '/favicon.ico') {
    response.writeHead(204); response.end(); return;
  }
  const file = resolve(bundleDir, pathname.slice(1));
  if (!file.startsWith(bundleDir) || !existsSync(file)) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
});
await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
const port = server.address().port;

const profile = mkdtempSync(resolve(tmpdir(), 'snl-library-paint-chrome-'));
const needsXvfb = !process.env.DISPLAY;
const xvfbDisplay = `:${100 + process.pid % 500}`;
const xvfb = needsXvfb && existsSync('/usr/bin/Xvfb')
  ? spawn('/usr/bin/Xvfb', [xvfbDisplay, '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' })
  : null;
if (needsXvfb && !xvfb) {
  throw new Error('A desktop display or Xvfb is required for fine-pointer hover media queries.');
}
if (xvfb) await new Promise((resolveWait) => setTimeout(resolveWait, 150));
const chrome = spawn(chromePath, [
  '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DISPLAY: process.env.DISPLAY ?? xvfbDisplay } });
let devtoolsUrl = '';
let stderr = '';
chrome.stderr.setEncoding('utf8');
chrome.stderr.on('data', (chunk) => {
  stderr += chunk;
  devtoolsUrl ||= chunk.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1] ?? '';
});
for (let attempt = 0; attempt < 100 && !devtoolsUrl; attempt += 1) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 25));
}
if (!devtoolsUrl) throw new Error(`Chromium did not expose DevTools: ${stderr}`);

class Cdp {
  constructor(socket) {
    this.socket = socket; this.nextId = 1; this.pending = new Map(); this.events = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
      } else {
        this.events.push(message);
      }
    });
  }
  call(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCall, rejectCall) => this.pending.set(id, { resolve: resolveCall, reject: rejectCall }));
  }
}

const browserSocket = new WebSocket(devtoolsUrl);
await new Promise((resolveOpen, rejectOpen) => {
  browserSocket.addEventListener('open', resolveOpen, { once: true });
  browserSocket.addEventListener('error', rejectOpen, { once: true });
});
const browser = new Cdp(browserSocket);
const { targetId } = await browser.call('Target.createTarget', { url: `http://127.0.0.1:${port}/` });
let pageWs = '';
for (let attempt = 0; attempt < 100 && !pageWs; attempt += 1) {
  const targets = await fetch(`http://127.0.0.1:${new URL(devtoolsUrl).port}/json/list`).then((r) => r.json());
  pageWs = targets.find((target) => target.id === targetId)?.webSocketDebuggerUrl ?? '';
  if (!pageWs) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
}
if (!pageWs) throw new Error('Could not attach to production harness page.');
const pageSocket = new WebSocket(pageWs);
await new Promise((resolveOpen, rejectOpen) => {
  pageSocket.addEventListener('open', resolveOpen, { once: true });
  pageSocket.addEventListener('error', rejectOpen, { once: true });
});
const page = new Cdp(pageSocket);
await page.call('Runtime.enable');
await page.call('Page.enable');
await page.call('Log.enable');

async function evaluate(expression) {
  const result = await page.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'browser evaluation failed');
  return result.result.value;
}
async function waitFor(expression) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await evaluate(expression)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}
async function setViewport(width, coarse = false) {
  await page.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.call('Emulation.setTouchEmulationEnabled', { enabled: coarse, maxTouchPoints: coarse ? 5 : 1 });
  await page.call('Emulation.setEmulatedMedia', { media: 'screen' });
  await new Promise((resolveWait) => setTimeout(resolveWait, 140));
}
const inspectExpression = `(() => {
  const rows = [...document.querySelectorAll('.snl-library-outline-row')];
  const row = rows[1], previous = rows[0], next = rows[2];
  const toolbar = row.querySelector(':scope > .snl-outline-row-toolbar');
  const cluster = toolbar.querySelector('.snl-tree-operation-cluster');
  const dial = toolbar.querySelector('.snl-tree-operation-dial');
  const button = dial.querySelector('button');
  const rect = (element) => { const r = element.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
  const intersection = (a, b) => Math.max(0, Math.min(a.right,b.right)-Math.max(a.left,b.left)) * Math.max(0, Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
  const rr=rect(row), pr=rect(previous), nr=rect(next), dr=rect(dial), cr=rect(cluster);
  const ds=getComputedStyle(dial), cs=getComputedStyle(cluster), ts=getComputedStyle(toolbar), bs=getComputedStyle(button);
  const opaque = ds.backgroundColor !== 'rgba(0, 0, 0, 0)' || ds.backgroundImage !== 'none';
  const pointOwner = (x,y) => { const e=document.elementFromPoint(x,y); return e ? { tag:e.tagName, cls:e.className, label:e.getAttribute('aria-label') } : null; };
  return {
    media:{ hover:matchMedia('(hover: hover)').matches, fine:matchMedia('(pointer: fine)').matches, coarse:matchMedia('(pointer: coarse)').matches },
    container:{ width:row.closest('[data-snl-tree-outline]')?.getBoundingClientRect().width ?? row.parentElement.getBoundingClientRect().width },
    rects:{row:rr,previous:pr,next:nr,dial:dr,cluster:cr},
    overlap:{previous:intersection(dr,pr),next:intersection(dr,nr)},
    paintedOverlap:opaque ? intersection(dr,pr)+intersection(dr,nr) : 0,
    styles:{
      dial:{backgroundColor:ds.backgroundColor,backgroundImage:ds.backgroundImage,boxShadow:ds.boxShadow,pointerEvents:ds.pointerEvents},
      cluster:{backgroundColor:cs.backgroundColor,backgroundImage:cs.backgroundImage,boxShadow:cs.boxShadow},
      toolbar:{backgroundColor:ts.backgroundColor,backgroundImage:ts.backgroundImage,boxShadow:ts.boxShadow},
      button:{opacity:bs.opacity,pointerEvents:bs.pointerEvents}
    },
    hits:{dialCenter:pointOwner((dr.left+dr.right)/2,(dr.top+dr.bottom)/2),outsideCluster:pointOwner(cr.left-2,(cr.top+cr.bottom)/2)}
  };
})()`;
function transparent(style) {
  return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.backgroundImage === 'none';
}
function assert(condition, message, value) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(value)}`);
}

try {
  await waitFor(`document.querySelectorAll('.snl-library-outline-row').length >= 3`);
  const schemes = ['light', 'dark', 'high-contrast-light', 'high-contrast'];
  const matrix = [];
  for (const scheme of schemes) {
    await evaluate(`document.documentElement.dataset.snlColorScheme=${JSON.stringify(scheme)}`);
    for (const viewport of [1007, 1008, 1009]) {
      await setViewport(viewport, false);
      await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
      await evaluate(`document.activeElement?.blur(); window.scrollTo(0, 300)`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 140));
      const result = await evaluate(inspectExpression);
      matrix.push({ scheme, viewport, state: 'idle', result });
      const desktop = viewport === 1009;
      assert(result.media.hover && result.media.fine, 'fine-pointer branch was not emulated', result.media);
      assert(result.styles.button.opacity === '0' && result.styles.button.pointerEvents === 'none', 'idle buttons must be hidden', result.styles.button);
      assert(transparent(result.styles.cluster) && result.styles.cluster.boxShadow === 'none', 'cluster must stay paint-free', result.styles.cluster);
      assert(transparent(result.styles.toolbar) && result.styles.toolbar.boxShadow === 'none', 'toolbar host must stay paint-free', result.styles.toolbar);
      if (desktop) {
        assert(transparent(result.styles.dial) && result.styles.dial.boxShadow === 'none', 'desktop idle dial must be paint-free', result.styles.dial);
        assert(result.overlap.previous > 0 || result.overlap.next > 0, 'fixture must preserve geometric adjacent-row overlap', result.overlap);
        assert(result.paintedOverlap === 0, 'desktop idle painted overlap must be zero', result);
        assert(!String(result.hits.dialCenter?.cls).includes('snl-tree-operation'), 'idle dial must not win hit testing', result.hits);
      } else {
        assert(!transparent(result.styles.dial), 'reserved-flow narrow dial must be opaque', result.styles.dial);
        assert(result.overlap.previous === 0 && result.overlap.next === 0, 'reserved-flow narrow dial must not overlap rows', result.overlap);
      }
    }

    await setViewport(1009, false);
    const dialCenter = await evaluate(`(() => { const d=document.querySelectorAll('.snl-library-outline-row')[1].querySelector('.snl-tree-operation-dial').getBoundingClientRect(); return {x:(d.left+d.right)/2,y:(d.top+d.bottom)/2}; })()`);
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dialCenter.x, y: dialCenter.y });
    await new Promise((resolveWait) => setTimeout(resolveWait, 140));
    const hover = await evaluate(inspectExpression);
    matrix.push({ scheme, viewport: 1009, state: 'hover', result: hover });
    assert(hover.styles.button.opacity === '1' && hover.styles.button.pointerEvents === 'auto', 'hover buttons must be visible', hover.styles.button);
    assert(!transparent(hover.styles.dial), 'hover dial must be opaque', hover.styles.dial);
    assert(transparent(hover.styles.cluster) && transparent(hover.styles.toolbar), 'only the hover dial may be opaque', hover.styles);
    assert(String(hover.hits.dialCenter?.tag) === 'BUTTON', 'hover dial control must win hit testing', hover.hits);

    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await evaluate(`document.querySelectorAll('.snl-library-outline-row')[1].querySelector('.snl-tree-operation-dial button').focus()`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 140));
    const focus = await evaluate(inspectExpression);
    matrix.push({ scheme, viewport: 1009, state: 'focus', result: focus });
    assert(focus.styles.button.opacity === '1' && !transparent(focus.styles.dial), 'focus must reveal an opaque dial', focus.styles);
    assert(transparent(focus.styles.cluster) && transparent(focus.styles.toolbar), 'focus must not paint outside the dial', focus.styles);
  }

  await evaluate(`document.documentElement.dataset.snlColorScheme='dark'; document.activeElement?.blur()`);
  await setViewport(1009, true);
  const coarse = await evaluate(inspectExpression);
  matrix.push({ scheme: 'dark', viewport: 1009, state: 'coarse', result: coarse });
  assert(coarse.media.coarse, 'coarse-pointer branch was not emulated', coarse.media);
  assert(coarse.styles.button.opacity === '1' && !transparent(coarse.styles.dial), 'coarse board must remain visible and opaque', coarse.styles);
  assert(coarse.overlap.previous === 0 && coarse.overlap.next === 0, 'coarse board must reserve flow without row overlap', coarse.overlap);

  const browserErrors = page.events.filter((event) =>
    event.method === 'Runtime.exceptionThrown' ||
    event.method === 'Log.entryAdded' && ['error', 'warning'].includes(event.params?.entry?.level)
  );
  assert(browserErrors.length === 0, 'production browser emitted errors', browserErrors);
  console.log(JSON.stringify({ cases: matrix.length, schemes, boundaryViewports: [1007,1008,1009], coarse: true }, null, 2));
} finally {
  pageSocket.close();
  browserSocket.close();
  server.close();
  chrome.kill('SIGTERM');
  await new Promise((resolveExit) => {
    if (chrome.exitCode !== null) resolveExit();
    else {
      chrome.once('exit', resolveExit);
      setTimeout(resolveExit, 1000);
    }
  });
  if (xvfb) xvfb.kill('SIGTERM');
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
