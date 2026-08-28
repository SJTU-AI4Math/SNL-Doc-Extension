#!/usr/bin/env node

import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = resolve(root, 'media/webview');
const bundleFiles = ['createLibrary.js', 'createLibrary.css'];
const bundlePaths = bundleFiles.map((file) => resolve(bundleDir, file));
const viteBin = resolve(root, 'node_modules/vite/bin/vite.js');
const previousHashes = Object.fromEntries(bundlePaths
  .filter((file) => existsSync(file))
  .map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
for (const file of bundlePaths) rmSync(file, { force: true });
if (bundlePaths.some((file) => existsSync(file))) {
  throw new Error('Could not remove stale createLibrary production artifacts before the probe.');
}
const buildStartedAt = Date.now();
const build = spawnSync(
  process.execPath,
  [viteBin, 'build', '--config', resolve(root, 'webview/vite.config.ts')],
  {
    cwd: root,
    env: { ...process.env, SNL_WEBVIEW_ENTRY: 'createLibrary' },
    stdio: 'inherit'
  }
);
if (build.status !== 0) process.exit(build.status ?? 1);
const artifactBuild = Object.fromEntries(bundlePaths.map((file) => {
  if (!existsSync(file)) throw new Error(`Canonical createLibrary build did not emit ${file}.`);
  const mtimeMs = statSync(file).mtimeMs;
  if (mtimeMs < buildStartedAt - 1000) {
    throw new Error(`createLibrary artifact is stale after canonical build: ${file}`);
  }
  return [file, {
    mtimeMs,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    previousSha256: previousHashes[file] ?? null
  }];
}));

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
    type: 'graph', graphRevision: 'probe-graph-revision', nodes, relationships, entries,
    kinds: [{
      id: 'definition', name: localized('Definition'),
      description: localized('Definition kind'), defaultCounterName: 'section',
      coloring: {
        light: { stroke: '#123456', background: '#abcdef' },
        dark: { stroke: '#fedcba', background: '#654321' }
      }
    }],
    metricMacroSources: {},
    metricThresholds: { structuralIndexRedBelow: 60, structuralIndexGreenAtLeast: 80 },
    warnings: []
  },
  counters: {
    type: 'countersLoaded',
    countersRevision: 'probe-counters-revision',
    counters: [{ id: 'counter-1', name: 'section', numbering: '1', children: [] }]
  }
};

const visiblePaintMutation = process.env.SNL_LIBRARY_PAINT_MUTATION === 'transparent-visible'
  ? `<style>
      .snl-library-outline-row.snl-library-outline-row > .snl-outline-row-toolbar .snl-tree-operation-dial {
        background-color: transparent;
        background-image: none;
      }
    </style>`
  : '';

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
${visiblePaintMutation}
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
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ?? 'browser evaluation failed');
  }
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
async function setOutlineContentWidth(width) {
  const measured = await evaluate(`(() => {
    const row = document.querySelectorAll('.snl-library-outline-row')[1];
    let container = row?.parentElement ?? null;
    while (container && !getComputedStyle(container).containerName.split(/\\s+/).includes('snl-outline')) {
      container = container.parentElement;
    }
    if (!container) return null;
    Object.assign(container.style, {
      boxSizing: 'content-box',
      width: '${width}px',
      minWidth: '${width}px',
      maxWidth: '${width}px'
    });
    return {
      name: getComputedStyle(container).containerName,
      contentWidth: Number.parseFloat(getComputedStyle(container).width),
      rectWidth: container.getBoundingClientRect().width
    };
  })()`);
  assert(measured !== null, 'named snl-outline container must exist', measured);
  assert(Math.abs(measured.contentWidth - width) < 0.01, 'named container content width must match boundary target', { width, measured });
  await new Promise((resolveWait) => setTimeout(resolveWait, 140));
}
const inspectExpression = `(() => {
  const rows = [...document.querySelectorAll('.snl-library-outline-row')];
  const row = rows[1], previous = rows[0], next = rows[2];
  let outline = row?.parentElement ?? null;
  while (outline && !getComputedStyle(outline).containerName.split(/\\s+/).includes('snl-outline')) {
    outline = outline.parentElement;
  }
  const toolbar = row.querySelector(':scope > .snl-outline-row-toolbar');
  const cluster = toolbar.querySelector('.snl-tree-operation-cluster');
  const dial = toolbar.querySelector('.snl-tree-operation-dial');
  const button = dial.querySelector('button');
  const rect = (element) => { const r = element.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
  const intersection = (a, b) => Math.max(0, Math.min(a.right,b.right)-Math.max(a.left,b.left)) * Math.max(0, Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
  const colorAlpha = (value) => {
    const normalized = String(value).trim().toLowerCase();
    if (!normalized || normalized === 'transparent') return 0;
    const hex = normalized.match(/^#([0-9a-f]{3,8})$/i)?.[1];
    if (hex) {
      if (hex.length === 4) return parseInt(hex[3] + hex[3], 16) / 255;
      if (hex.length === 8) return parseInt(hex.slice(6), 16) / 255;
      return 1;
    }
    const rgb = normalized.match(/^rgba?\\((.*)\\)$/)?.[1];
    if (rgb) {
      const slash = rgb.lastIndexOf('/');
      if (slash >= 0) {
        const alpha = rgb.slice(slash + 1).trim();
        return alpha.endsWith('%') ? parseFloat(alpha) / 100 : parseFloat(alpha);
      }
      const commaParts = rgb.split(',').map((part) => part.trim());
      if (commaParts.length === 4) return parseFloat(commaParts[3]);
      return 1;
    }
    return null;
  };
  const paint = (style) => {
    const backgroundColorAlpha = colorAlpha(style.backgroundColor);
    const gradientColors = style.backgroundImage === 'none'
      ? []
      : style.backgroundImage.match(/rgba?\\([^)]*\\)|#[0-9a-f]{3,8}\\b|transparent\\b/gi) ?? [];
    const gradientStopAlphas = gradientColors.map(colorAlpha);
    const hasPaint = (backgroundColorAlpha ?? 0) > 0 || gradientStopAlphas.some((alpha) => (alpha ?? 0) > 0);
    return {
      backgroundColorAlpha,
      gradientStopAlphas,
      hasPaint,
      opaqueBacking: backgroundColorAlpha !== null && Math.abs(backgroundColorAlpha - 1) < 0.0001
    };
  };
  const transparentGradientControl = document.createElement('div');
  transparentGradientControl.style.backgroundColor = 'transparent';
  transparentGradientControl.style.backgroundImage = 'linear-gradient(rgba(1, 2, 3, 0), transparent)';
  document.body.appendChild(transparentGradientControl);
  const transparentGradientPaint = paint(getComputedStyle(transparentGradientControl));
  transparentGradientControl.remove();
  const rr=rect(row), pr=rect(previous), nr=rect(next), dr=rect(dial), cr=rect(cluster);
  const ds=getComputedStyle(dial), cs=getComputedStyle(cluster), ts=getComputedStyle(toolbar), bs=getComputedStyle(button);
  const dialPaint = paint(ds), clusterPaint = paint(cs), toolbarPaint = paint(ts);
  const pointOwner = (x,y) => { const e=document.elementFromPoint(x,y); return e ? { tag:e.tagName, cls:e.className, label:e.getAttribute('aria-label') } : null; };
  return {
    media:{ hover:matchMedia('(hover: hover)').matches, fine:matchMedia('(pointer: fine)').matches, coarse:matchMedia('(pointer: coarse)').matches },
    container: outline ? {
      exists: true,
      name: getComputedStyle(outline).containerName,
      contentWidth: Number.parseFloat(getComputedStyle(outline).width),
      rectWidth: outline.getBoundingClientRect().width
    } : { exists: false },
    viewportWidth: innerWidth,
    transparentGradientPaint,
    rects:{row:rr,previous:pr,next:nr,dial:dr,cluster:cr},
    overlap:{previous:intersection(dr,pr),next:intersection(dr,nr)},
    paintedOverlap:dialPaint.hasPaint ? intersection(dr,pr)+intersection(dr,nr) : 0,
    styles:{
      dial:{backgroundColor:ds.backgroundColor,backgroundImage:ds.backgroundImage,boxShadow:ds.boxShadow,pointerEvents:ds.pointerEvents,paint:dialPaint},
      cluster:{backgroundColor:cs.backgroundColor,backgroundImage:cs.backgroundImage,boxShadow:cs.boxShadow,paint:clusterPaint},
      toolbar:{backgroundColor:ts.backgroundColor,backgroundImage:ts.backgroundImage,boxShadow:ts.boxShadow,paint:toolbarPaint},
      button:{opacity:bs.opacity,pointerEvents:bs.pointerEvents}
    },
    hits:{dialCenter:pointOwner((dr.left+dr.right)/2,(dr.top+dr.bottom)/2),outsideCluster:pointOwner(cr.left-2,(cr.top+cr.bottom)/2)}
  };
})()`;
function transparent(style) {
  return style.paint.hasPaint === false;
}
function opaqueBacking(style) {
  return style.paint.opaqueBacking === true;
}
function assert(condition, message, value) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(value)}`);
}

try {
  await waitFor(`document.querySelectorAll('.snl-library-outline-row').length >= 3`);
  const kindPreviewEvidence = {};
  for (const scheme of ['light', 'dark']) {
    await evaluate(`(() => {
      document.body.className=${JSON.stringify(scheme === 'dark' ? 'vscode-dark' : 'vscode-light')};
      document.documentElement.dataset.snlColorScheme=${JSON.stringify(scheme)};
    })()`);
    const center = await evaluate(`(() => {
      const preview = document.querySelector('[data-kind-preview="true"][data-kind-id="definition"]');
      const rect = preview.getBoundingClientRect();
      return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
    })()`);
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y });
    await new Promise((resolveWait) => setTimeout(resolveWait, 180));
    const hover = await evaluate(`(() => {
      const preview = document.querySelector('[data-kind-preview="true"][data-kind-id="definition"]');
      const style = getComputedStyle(preview);
      return { backgroundColor: style.backgroundColor, boxShadow: style.boxShadow, cursor: style.cursor };
    })()`);
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 180));
    const ctrlHover = await evaluate(`(() => {
      const preview = document.querySelector('[data-kind-preview="true"][data-kind-id="definition"]');
      const style = getComputedStyle(preview);
      return { backgroundColor: style.backgroundColor, boxShadow: style.boxShadow, cursor: style.cursor };
    })()`);
    kindPreviewEvidence[scheme] = { hover, ctrlHover };
    const expected = scheme === 'dark'
      ? { hover: 'rgb(31, 41, 55)', ctrl: 'rgb(55, 65, 81)', shadowChannels: '254, 220, 186' }
      : { hover: 'rgb(255, 255, 255)', ctrl: 'rgb(243, 244, 246)', shadowChannels: '18, 52, 86' };
    assert(hover.backgroundColor === expected.hover && ctrlHover.backgroundColor === expected.ctrl,
      `${scheme} Kind preview hover backgrounds must match`, kindPreviewEvidence[scheme]);
    assert(hover.boxShadow.includes('inset') && hover.boxShadow.includes(expected.shadowChannels) &&
      ctrlHover.boxShadow.includes('inset') && ctrlHover.boxShadow.includes(expected.shadowChannels) &&
      ctrlHover.cursor === 'pointer',
      `${scheme} Kind preview must retain inset shadow and Ctrl cursor`, kindPreviewEvidence[scheme]);
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  }
  const kindClickEvidence = await evaluate(`(() => {
    const preview = document.querySelector('[data-kind-preview="true"][data-kind-id="definition"]');
    const count = () => window.__snlPosted.filter((message) => message?.type === 'editEntryKind').length;
    const before = count();
    preview.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const ordinary = count() - before;
    preview.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    return { ordinary, ctrl: count() - before - ordinary };
  })()`);
  assert(kindClickEvidence.ordinary === 0 && kindClickEvidence.ctrl === 1,
    'ordinary Kind preview click must route zero times and Ctrl-click exactly once', kindClickEvidence);
  const saveEvidenceStart = await evaluate(`(() => {
    const mutationTypes = new Set(['update', 'graphOp', 'counterOp', 'saveLibraryDraft']);
    const before = window.__snlPosted.filter((message) => mutationTypes.has(message?.type));
    const headings = [...document.querySelectorAll('h2')];
    const outline = headings.find((heading) => heading.textContent?.trim() === 'Outline');
    const save = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Save Changes');
    const updateTitle = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Update Title');
    const title = document.querySelector('#snl-library-title');
    const expandCounters = document.querySelector('button[aria-label="Expand counters"]');
    const outdent = document.querySelectorAll('.snl-library-outline-row')[1]?.querySelector('button[aria-label="Outdent"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(title, 'Local Browser Draft');
    title.dispatchEvent(new Event('input', { bubbles: true }));
    outdent.click();
    expandCounters.click();
    return {
      beforeCount: before.length,
      saveAfterOutline: Boolean(outline && save && (outline.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING)),
      updateTitlePresent: Boolean(updateTitle)
    };
  })()`);
  await waitFor(`document.querySelector('input[aria-label="Counter name"]') !== null`);
  const saveEvidence = await evaluate(`(() => {
    const mutationTypes = new Set(['update', 'graphOp', 'counterOp', 'saveLibraryDraft']);
    const counterName = document.querySelector('input[aria-label="Counter name"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(counterName, 'local-section');
    counterName.dispatchEvent(new Event('input', { bubbles: true }));
    const localMutations = window.__snlPosted.filter((message) => mutationTypes.has(message?.type));
    const save = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Save Changes');
    save.click();
    return {
      ...${JSON.stringify(saveEvidenceStart)},
      localCount: localMutations.length,
      after: window.__snlPosted.filter((message) => mutationTypes.has(message?.type)),
      counterValue: counterName.value
    };
  })()`);
  assert(saveEvidence.beforeCount === 0 && saveEvidence.localCount === 0,
    'title, counter, and graph edits must remain local before Save', saveEvidence);
  assert(saveEvidence.after.length === 1 && saveEvidence.after[0]?.type === 'saveLibraryDraft',
    'Save must emit exactly one complete Library draft mutation', saveEvidence);
  assert(saveEvidence.after[0].title === 'Local Browser Draft' &&
    saveEvidence.after[0].counters?.[0]?.name === 'local-section' &&
    saveEvidence.after[0].graph?.relationships?.length === relationships.length - 1,
    'bulk save must contain all three locally edited surfaces', saveEvidence.after[0]);
  assert(saveEvidence.saveAfterOutline && !saveEvidence.updateTitlePresent,
    'the only save button must follow Outline with no Update Title action above', saveEvidence);
  const schemes = ['light', 'dark', 'high-contrast-light', 'high-contrast'];
  const matrix = [];
  for (const scheme of schemes) {
    await evaluate(`document.documentElement.dataset.snlColorScheme=${JSON.stringify(scheme)}`);
    for (const containerWidth of [959, 960, 961]) {
      await setViewport(1280, false);
      await setOutlineContentWidth(containerWidth);
      await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
      await evaluate(`document.activeElement?.blur(); window.scrollTo(0, 300)`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 140));
      const result = await evaluate(inspectExpression);
      matrix.push({ scheme, containerWidth, state: 'idle', result });
      const desktop = result.container.contentWidth > 960;
      assert(result.container.exists && result.container.name.split(/\s+/).includes('snl-outline'), 'actual named container must be measured', result.container);
      assert(Math.abs(result.container.contentWidth - containerWidth) < 0.01, 'measured container width must classify the query boundary', { containerWidth, measured: result.container });
      assert(result.media.hover && result.media.fine, 'fine-pointer branch was not emulated', result.media);
      assert(
        result.transparentGradientPaint.hasPaint === false &&
        result.transparentGradientPaint.gradientStopAlphas.length >= 2 &&
        result.transparentGradientPaint.gradientStopAlphas.every((alpha) => alpha === 0),
        'fully transparent resolved gradient stops must not count as paint',
        result.transparentGradientPaint
      );
      assert(result.styles.button.opacity === '0' && result.styles.button.pointerEvents === 'none', 'idle buttons must be hidden', result.styles.button);
      assert(transparent(result.styles.cluster) && result.styles.cluster.boxShadow === 'none', 'cluster must stay paint-free', result.styles.cluster);
      assert(transparent(result.styles.toolbar) && result.styles.toolbar.boxShadow === 'none', 'toolbar host must stay paint-free', result.styles.toolbar);
      if (desktop) {
        assert(transparent(result.styles.dial) && result.styles.dial.boxShadow === 'none', 'desktop idle dial must be paint-free', result.styles.dial);
        assert(result.overlap.previous > 0 || result.overlap.next > 0, 'fixture must preserve geometric adjacent-row overlap', result.overlap);
        assert(result.paintedOverlap === 0, 'desktop idle painted overlap must be zero', result);
        assert(!String(result.hits.dialCenter?.cls).includes('snl-tree-operation'), 'idle dial must not win hit testing', result.hits);
      } else {
        assert(opaqueBacking(result.styles.dial), 'reserved-flow narrow dial must have an opaque backing', result.styles.dial);
        assert(result.overlap.previous === 0 && result.overlap.next === 0, 'reserved-flow narrow dial must not overlap rows', result.overlap);
      }
    }

    await setViewport(1280, false);
    await setOutlineContentWidth(961);
    const dialCenter = await evaluate(`(() => { const d=document.querySelectorAll('.snl-library-outline-row')[1].querySelector('.snl-tree-operation-dial').getBoundingClientRect(); return {x:(d.left+d.right)/2,y:(d.top+d.bottom)/2}; })()`);
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dialCenter.x, y: dialCenter.y });
    await new Promise((resolveWait) => setTimeout(resolveWait, 140));
    const hover = await evaluate(inspectExpression);
    matrix.push({ scheme, containerWidth: 961, state: 'hover', result: hover });
    assert(hover.styles.button.opacity === '1' && hover.styles.button.pointerEvents === 'auto', 'hover buttons must be visible', hover.styles.button);
    assert(opaqueBacking(hover.styles.dial), 'hover dial must have an opaque backing', hover.styles.dial);
    assert(transparent(hover.styles.cluster) && transparent(hover.styles.toolbar), 'only the hover dial may be opaque', hover.styles);
    assert(String(hover.hits.dialCenter?.tag) === 'BUTTON', 'hover dial control must win hit testing', hover.hits);

    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await evaluate(`document.querySelectorAll('.snl-library-outline-row')[1].querySelector('.snl-tree-operation-dial button').focus()`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 140));
    const focus = await evaluate(inspectExpression);
    matrix.push({ scheme, containerWidth: 961, state: 'focus', result: focus });
    assert(focus.styles.button.opacity === '1' && opaqueBacking(focus.styles.dial), 'focus must reveal a dial with an opaque backing', focus.styles);
    assert(transparent(focus.styles.cluster) && transparent(focus.styles.toolbar), 'focus must not paint outside the dial', focus.styles);
  }

  await evaluate(`document.documentElement.dataset.snlColorScheme='dark'; document.activeElement?.blur()`);
  await setViewport(1280, true);
  await setOutlineContentWidth(961);
  const coarse = await evaluate(inspectExpression);
  matrix.push({ scheme: 'dark', containerWidth: 961, state: 'coarse', result: coarse });
  assert(coarse.media.coarse, 'coarse-pointer branch was not emulated', coarse.media);
  assert(coarse.styles.button.opacity === '1' && opaqueBacking(coarse.styles.dial), 'coarse board must remain visible with an opaque backing', coarse.styles);
  assert(coarse.overlap.previous === 0 && coarse.overlap.next === 0, 'coarse board must reserve flow without row overlap', coarse.overlap);

  const browserErrors = page.events.filter((event) =>
    event.method === 'Runtime.exceptionThrown' ||
    event.method === 'Log.entryAdded' && ['error', 'warning'].includes(event.params?.entry?.level)
  );
  assert(browserErrors.length === 0, 'production browser emitted errors', browserErrors);
  assert(matrix.length >= 21, 'realistic production matrix must retain at least 21 cases', matrix.length);
  console.log(JSON.stringify({ cases: matrix.length, schemes, boundaryContentWidths: [959, 960, 961], coarse: true, kindPreviewEvidence, kindClickEvidence, saveEvidence, artifactBuild }, null, 2));
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
