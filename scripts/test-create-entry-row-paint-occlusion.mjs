#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = resolve(root, 'media/webview');
const viteBin = resolve(root, 'node_modules/vite/bin/vite.js');
const entries = ['createLibrary', 'createEntry'];
const bundleFiles = entries.flatMap((entry) => [`${entry}.js`, `${entry}.css`]);
const bundlePaths = bundleFiles.map((file) => resolve(bundleDir, file));
const previousHashes = Object.fromEntries(bundlePaths
  .filter((file) => existsSync(file))
  .map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));

for (const file of bundlePaths) rmSync(file, { force: true });
if (bundlePaths.some((file) => existsSync(file))) {
  throw new Error('Could not remove stale CreateEntry/Library production artifacts before the probe.');
}
const artifactBuild = {};
for (const entry of entries) {
  const entryPaths = [`${entry}.js`, `${entry}.css`].map((file) => resolve(bundleDir, file));
  const buildStartedAt = Date.now();
  const build = spawnSync(
    process.execPath,
    [viteBin, 'build', '--config', resolve(root, 'webview/vite.config.ts')],
    {
      cwd: root,
      env: { ...process.env, SNL_WEBVIEW_ENTRY: entry },
      stdio: 'inherit'
    }
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
  for (const file of entryPaths) {
    if (!existsSync(file)) throw new Error(`Canonical ${entry} build did not emit ${file}.`);
    const mtimeMs = statSync(file).mtimeMs;
    if (mtimeMs < buildStartedAt - 1000) {
      throw new Error(`${entry} artifact is stale after canonical build: ${file}`);
    }
    artifactBuild[file] = {
      mtimeMs,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      previousSha256: previousHashes[file] ?? null
    };
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

const fixture = {
  type: 'context',
  mode: 'edit',
  targetState: 'found',
  id: 'create-entry-paint-probe',
  kinds: [{
    id: 'definition',
    name: 'Definition',
    description: 'Definition kind',
    coloring: {
      light: { stroke: '#555555', background: '#eeeeee' },
      dark: { stroke: '#888888', background: '#222222' }
    },
    numbering: '1',
    style: 'default',
    defaultCounterName: 'section'
  }],
  macros: {
    Root: {
      name: 'Root', description: 'style input race fixture',
      source: { entries: [], urls: [] }, dynamic_arity: true, tags: [],
      styles: [
        { style_name: 'default', tags: [], template: { mode: 'formula_inline', body: '#*' } },
        { style_name: 'compact', tags: [], template: { mode: 'formula_inline', body: '#*' } }
      ]
    },
    'FOL.forall': {
      name: 'FOL.forall', description: 'browser interaction fixture',
      source: { entries: [], urls: [] }, dynamic_arity: true, tags: [],
      styles: [{ style_name: 'default', tags: [], template: { mode: 'formula_inline', body: '#*' } }]
    }
  },
  macroKinds: [],
  macroOrigin: { Root: 'fixture.json', 'FOL.forall': 'fixture.json' },
  metricThresholds: { structuralIndexRedBelow: 60, structuralIndexGreenAtLeast: 80 },
  entryPackages: ['_unpackaged'],
  existingIds: [],
  relationships: [],
  existing: {
    id: 'create-entry-paint-probe',
    title: 'CreateEntry paint probe',
    kind: 'definition',
    package: '_unpackaged',
    content: { snl: 'Root(Child(Leaf), Sibling, Tail)' }
  }
};

const visiblePaintMutation = process.env.SNL_CREATE_ENTRY_PAINT_MUTATION === 'transparent-visible'
  ? `<style>
      .snl-tree-row.snl-tree-row:hover > .snl-tree-row-toolbar .snl-tree-operation-dial,
      .snl-tree-row.snl-tree-row:has(> .snl-tree-row-toolbar:focus-within) > .snl-tree-row-toolbar .snl-tree-operation-dial {
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
<link rel="stylesheet" href="/createEntry.css">
<style>
  html { font-size: 16px; }
  body { margin: 0; color: var(--vscode-foreground, #ddd); background: var(--vscode-editor-background, #1e1e1e); font-family: Arial, sans-serif; }
</style>
${visiblePaintMutation}
<script>
  const baseFixture = ${JSON.stringify(fixture)};
  window.__snlFixture = location.search === '?create'
    ? { ...baseFixture, mode: 'create', id: undefined, seedId: 'entry-id', existing: null }
    : baseFixture;
  window.__snlPosted = [];
  window.acquireVsCodeApi = () => ({
    postMessage(message) {
      window.__snlPosted.push(message);
      if (message && message.type === 'ready') {
        window.dispatchEvent(new MessageEvent('message', { data: window.__snlFixture }));
      }
    },
    getState() { return undefined; },
    setState() {}
  });
</script>
</head>
<body><div id="root"></div><script type="module" src="/createEntry.js"></script></body>
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

const profile = mkdtempSync(resolve(tmpdir(), 'snl-create-entry-paint-chrome-'));
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
  const targets = await fetch(`http://127.0.0.1:${new URL(devtoolsUrl).port}/json/list`).then((response) => response.json());
  pageWs = targets.find((target) => target.id === targetId)?.webSocketDebuggerUrl ?? '';
  if (!pageWs) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
}
if (!pageWs) throw new Error('Could not attach to CreateEntry production harness page.');
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
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await evaluate(expression)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  const diagnostic = await evaluate(`({html:document.body.innerHTML.slice(0,1000), posted:window.__snlPosted, title:document.title})`);
  throw new Error(`Timed out waiting for ${expression}: ${JSON.stringify({ diagnostic, events: page.events.slice(-20) })}`);
}
async function setViewport(width, coarse = false) {
  await page.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.call('Emulation.setTouchEmulationEnabled', { enabled: coarse, maxTouchPoints: coarse ? 5 : 1 });
  await page.call('Emulation.setEmulatedMedia', { media: 'screen' });
  await new Promise((resolveWait) => setTimeout(resolveWait, 140));
}
async function setInductiveContentWidth(width) {
  const measured = await evaluate(`(() => {
    const container = document.querySelector('.snl-inductive-editor');
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
  assert(measured !== null, 'actual named snl-inductive container must exist', measured);
  assert(measured.name.split(/\s+/).includes('snl-inductive'), 'actual container name must be snl-inductive', measured);
  assert(Math.abs(measured.contentWidth - width) < 0.01, 'named container content width must match target', { width, measured });
  await new Promise((resolveWait) => setTimeout(resolveWait, 140));
}

const inspectExpression = `(() => {
  const rows = [...document.querySelectorAll('.snl-tree-row')];
  const row = rows[1] ?? rows[0];
  const toolbar = row?.querySelector(':scope > .snl-tree-row-toolbar');
  const cluster = toolbar?.querySelector('.snl-tree-operation-cluster');
  const dial = toolbar?.querySelector('.snl-tree-operation-dial');
  const button = dial?.querySelector('button');
  const macro = row?.querySelector('[data-macro-id-control]');
  const textarea = macro?.querySelector('textarea');
  let container = row?.parentElement ?? null;
  while (container && !getComputedStyle(container).containerName.split(/\\s+/).includes('snl-inductive')) {
    container = container.parentElement;
  }
  if (!row || !toolbar || !cluster || !dial || !button || !macro || !textarea) return { missing: true, rowCount: rows.length };
  const rect = (element) => { const r = element.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
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
    return {
      backgroundColorAlpha,
      gradientStopAlphas,
      hasPaint: (backgroundColorAlpha ?? 0) > 0 || gradientStopAlphas.some((alpha) => (alpha ?? 0) > 0),
      opaqueBacking: backgroundColorAlpha !== null && Math.abs(backgroundColorAlpha - 1) < 0.0001
    };
  };
  const rs=getComputedStyle(row), ts=getComputedStyle(toolbar), cs=getComputedStyle(cluster), ds=getComputedStyle(dial), bs=getComputedStyle(button), ms=getComputedStyle(macro), xs=getComputedStyle(textarea);
  const rr=rect(row), tr=rect(toolbar), cr=rect(cluster), dr=rect(dial), br=rect(button), mr=rect(macro), xr=rect(textarea);
  return {
    missing: false,
    rowCount: rows.length,
    media:{ hover:matchMedia('(hover: hover)').matches, fine:matchMedia('(pointer: fine)').matches, coarse:matchMedia('(pointer: coarse)').matches },
    container: container ? { exists:true, name:getComputedStyle(container).containerName, contentWidth:Number.parseFloat(getComputedStyle(container).width), rectWidth:container.getBoundingClientRect().width } : { exists:false },
    rects:{row:rr,toolbar:tr,cluster:cr,dial:dr,button:br,macro:mr,textarea:xr},
    styles:{
      macro:{width:ms.width,minWidth:ms.minWidth,flexGrow:ms.flexGrow,flexShrink:ms.flexShrink,flexBasis:ms.flexBasis},
      textarea:{width:xs.width,height:xs.height,overflowX:xs.overflowX,overflowY:xs.overflowY,whiteSpace:xs.whiteSpace},
      row:{backgroundColor:rs.backgroundColor,backgroundImage:rs.backgroundImage,boxShadow:rs.boxShadow,paddingRight:rs.paddingRight,paddingBottom:rs.paddingBottom},
      toolbar:{opacity:ts.opacity,pointerEvents:ts.pointerEvents,backgroundColor:ts.backgroundColor,backgroundImage:ts.backgroundImage,boxShadow:ts.boxShadow,paint:paint(ts)},
      cluster:{backgroundColor:cs.backgroundColor,backgroundImage:cs.backgroundImage,boxShadow:cs.boxShadow,paint:paint(cs)},
      dial:{backgroundColor:ds.backgroundColor,backgroundImage:ds.backgroundImage,boxShadow:ds.boxShadow,paint:paint(ds)},
      button:{opacity:bs.opacity,pointerEvents:bs.pointerEvents,visibility:bs.visibility}
    }
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
async function inspect(state, scheme, containerWidth, matrix) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 140));
  const result = await evaluate(inspectExpression);
  matrix.push({ state, scheme, containerWidth, result });
  assert(!result.missing && result.rowCount >= 3, 'real CreateEntry payload must render populated recursive rows', result);
  assert(result.container.exists && result.container.name.split(/\s+/).includes('snl-inductive'), 'actual named CreateEntry container must be measured', result.container);
  assert(Math.abs(result.container.contentWidth - containerWidth) < 0.01, 'measured named container width must match matrix width', result.container);
  assert(transparent(result.styles.cluster) && result.styles.cluster.boxShadow === 'none', 'CreateEntry action cluster must never gain a plate', result.styles.cluster);
  assert(transparent(result.styles.toolbar) && result.styles.toolbar.boxShadow === 'none', 'CreateEntry toolbar ancestor must never gain a plate', result.styles.toolbar);
  assert(result.styles.macro.flexGrow === '1' && result.styles.macro.minWidth === '0px', 'Inductive Macro wrapper must own the flexible remaining row width', result.styles.macro);
  assert(Math.abs(result.rects.textarea.width - result.rects.macro.width) < 1, 'Inductive textarea must fill its flexible wrapper', result.rects);
  return result;
}

try {
  await waitFor(`document.querySelectorAll('button').length > 3`);
  await evaluate(`(() => {
    const button=[...document.querySelectorAll('button')].find((candidate)=>candidate.textContent?.includes('GUI Editor (Inductive)'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await waitFor(`document.querySelectorAll('.snl-inductive-editor .snl-tree-row').length >= 3`);

  const selectWholeDelimiterInput = async () => evaluate(`(() => {
    const input=document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1];
    if (!input) return false;
    input.focus(); input.setSelectionRange(0,input.value.length); return true;
  })()`);
  const emptyBacktickPair = JSON.stringify(String.fromCharCode(96, 96));
  const filledBacktickPair = JSON.stringify(`${String.fromCharCode(96)}code${String.fromCharCode(96)}`);
  assert(await selectWholeDelimiterInput(), 'production Inductive delimiter input must exist', null);
  const delimiterImeSeed = await evaluate(`(() => { const input=document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1]; return {length:input.value.length,start:input.selectionStart,end:input.selectionEnd}; })()`);
  await page.call('Input.imeSetComposition', {
    text: '`', selectionStart: 1, selectionEnd: 1,
    replacementStart: 0, replacementEnd: delimiterImeSeed.length
  });
  const delimiterImeDuring = await evaluate(`(() => { const input=document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1]; return {value:input.value,start:input.selectionStart}; })()`);
  assert(delimiterImeDuring.value === '`', 'Inductive delimiter pairing must not rewrite active IME preedit text', delimiterImeDuring);
  await page.call('Input.insertText', { text: '`' });
  await waitFor(`document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1]?.value === ${emptyBacktickPair}`);
  const delimiterImeAfter = await evaluate(`(() => { const input=document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1]; return {value:input.value,start:input.selectionStart}; })()`);
  assert(delimiterImeAfter.start === 1, 'committed IME delimiter pair must restore the inner caret', delimiterImeAfter);

  await selectWholeDelimiterInput();
  await page.call('Input.insertText', { text: '%' });
  await waitFor(`document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1]?.value === '%%'`);
  await page.call('Input.insertText', { text: 'Fo' });
  await waitFor(`document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1]?.value === '%Fo%'`);
  const percentEvidence = await evaluate(`(() => {
    const input=document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1];
    const host=input.closest('[data-macro-id-control]');
    const tones=[...host.querySelectorAll('[data-macro-id-highlight-content] [data-tone]')].map(node=>({tone:node.dataset.tone,text:node.textContent,color:getComputedStyle(node).color}));
    return {value:input.value,start:input.selectionStart,tones,suggestions:Boolean(host.querySelector('[role="listbox"]'))};
  })()`);
  assert(percentEvidence.value === '%Fo%' && percentEvidence.start === 3 &&
    percentEvidence.tones.filter(({tone,text,color}) => tone === 'text' && text === '%' && color === 'rgb(78, 201, 176)').length === 2 &&
    !percentEvidence.suggestions,
  'production percent pair must preserve caret, color both delimiters, and suppress autocomplete', percentEvidence);

  await selectWholeDelimiterInput();
  await page.call('Input.insertText', { text: '$' });
  await waitFor(`document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1]?.value === '$$'`);
  await page.call('Input.insertText', { text: 'x' });
  await waitFor(`document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1]?.value === '$x$'`);
  await evaluate(`document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1].setSelectionRange(1,1)`);
  await page.call('Input.insertText', { text: '$' });
  await waitFor(`document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1]?.value === '$$x$$'`);
  const doubleDollarEvidence = await evaluate(`(() => { const input=document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1]; return {value:input.value,start:input.selectionStart}; })()`);
  assert(doubleDollarEvidence.start === 2, 'single-dollar to double-dollar transition must retain the authored-side caret', doubleDollarEvidence);
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await waitFor(`document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1]?.value === '$x$'`);

  await selectWholeDelimiterInput();
  await page.call('Input.insertText', { text: '`' });
  await waitFor(`document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1]?.value === ${emptyBacktickPair}`);
  await page.call('Input.insertText', { text: 'code' });
  await waitFor(`document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1]?.value === ${filledBacktickPair}`);
  const backtickEvidence = await evaluate(`(() => {
    const input=document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1];
    const code=[...input.closest('[data-macro-id-control]').querySelectorAll('[data-tone="code"]')];
    return {value:input.value,colors:code.map(node=>getComputedStyle(node).color),texts:code.map(node=>node.textContent)};
  })()`);
  assert(backtickEvidence.texts.length === 2 && backtickEvidence.texts.every(text=>text === '`') &&
    backtickEvidence.colors.every(color=>color === 'rgb(220, 220, 170)'),
  'production backtick pair must color both delimiter glyphs', backtickEvidence);

  await selectWholeDelimiterInput();
  await page.call('Input.insertText', { text: 'Fo' });
  await waitFor(`Boolean(document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1]?.closest('[data-macro-id-control]')?.querySelector('[role="listbox"]'))`);
  const rearmEvidence = await evaluate(`(() => { const input=document.querySelectorAll(${JSON.stringify('.snl-inductive-editor .snl-tree-row textarea[data-snl-macro-input]')})[1]; return {value:input.value,start:input.selectionStart,suggestions:Boolean(input.closest('[data-macro-id-control]').querySelector('[role="listbox"]'))}; })()`);
  assert(rearmEvidence.value === 'Fo' && rearmEvidence.suggestions,
    'removing all delimiters must let the next real input re-arm autocomplete', rearmEvidence);

  await waitFor(`Boolean(document.querySelector('.snl-tree-style-select:not(:disabled)')?.querySelector('option[value="compact"]'))`);
  const firstStyleSelection = await evaluate(`(() => {
    const select=document.querySelector('.snl-tree-style-select:not(:disabled)');
    const setValue=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
    setValue.call(select,'compact');
    select.dispatchEvent(new Event('input',{bubbles:true}));
    select.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
  assert(firstStyleSelection, 'production Style select must accept the first native input/change sequence', firstStyleSelection);
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  const firstStyleResult = await evaluate(`(() => { const select=document.querySelector('.snl-tree-style-select:not(:disabled)'); return {value:select.value, selected:select.selectedOptions[0]?.value}; })()`);
  assert(firstStyleResult.value === 'compact' && firstStyleResult.selected === 'compact',
    'the first clean-to-dirty Style selection must survive the ancestor dirty render', firstStyleResult);

  const schemes = ['light', 'dark', 'high-contrast-light', 'high-contrast'];
  const matrix = [];
  for (const scheme of schemes) {
    await evaluate(`document.documentElement.dataset.snlColorScheme=${JSON.stringify(scheme)}`);
    for (const containerWidth of [479, 480, 481, 959, 960, 961]) {
      await setViewport(1280, false);
      await setInductiveContentWidth(containerWidth);
      await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
      await evaluate(`document.activeElement?.blur()`);
      const idle = await inspect('idle', scheme, containerWidth, matrix);
      assert(idle.media.hover && idle.media.fine, 'fine-pointer CreateEntry branch must be active', idle.media);
      assert(idle.styles.toolbar.opacity === '0' && idle.styles.toolbar.pointerEvents === 'none', 'fine-pointer idle CreateEntry toolbar must remain hidden and inert', idle.styles.toolbar);
      assert(opaqueBacking(idle.styles.dial), 'shared CreateEntry dial backing remains opaque beneath the hidden idle toolbar', idle.styles.dial);
    }

    await setViewport(1280, false);
    await setInductiveContentWidth(961);
    const rowPoint = await evaluate(`(() => {
      const row=document.querySelectorAll('.snl-tree-row')[1];
      const input=row.querySelector('[data-snl-macro-input] input, [data-snl-macro-input], input');
      const r=(input ?? row).getBoundingClientRect(); return {x:r.left+Math.min(12,r.width/2),y:(r.top+r.bottom)/2};
    })()`);
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowPoint.x, y: rowPoint.y });
    const rowHover = await inspect('row-hover', scheme, 961, matrix);
    assert(rowHover.styles.toolbar.opacity === '1' && rowHover.styles.toolbar.pointerEvents === 'auto', 'row hover must reveal operable CreateEntry controls', rowHover.styles.toolbar);
    assert(opaqueBacking(rowHover.styles.dial), 'visible CreateEntry row-hover controls require an alpha-1 dial backing', rowHover.styles.dial);

    const toolbarPoint = await evaluate(`(() => { const r=document.querySelectorAll('.snl-tree-row')[1].querySelector('.snl-tree-operation-dial').getBoundingClientRect(); return {x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}; })()`);
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: toolbarPoint.x, y: toolbarPoint.y });
    const toolbarHover = await inspect('toolbar-hover', scheme, 961, matrix);
    assert(toolbarHover.styles.toolbar.opacity === '1' && opaqueBacking(toolbarHover.styles.dial), 'direct toolbar hover must retain visible controls over an alpha-1 dial backing', toolbarHover.styles);

    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await evaluate(`document.querySelectorAll('.snl-tree-row')[1].querySelector('.snl-tree-operation-dial button').focus()`);
    const focus = await inspect('focus-within', scheme, 961, matrix);
    assert(focus.styles.toolbar.opacity === '1' && focus.styles.button.visibility === 'visible', 'keyboard focus-within must reveal CreateEntry controls', focus.styles);
    assert(opaqueBacking(focus.styles.dial), 'keyboard-visible CreateEntry controls require an alpha-1 dial backing', focus.styles.dial);

    await evaluate(`document.activeElement?.blur()`);
    await setInductiveContentWidth(479);
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowPoint.x, y: rowPoint.y });
    const narrow = await inspect('narrow-row-hover', scheme, 479, matrix);
    assert(narrow.styles.toolbar.opacity === '1' && opaqueBacking(narrow.styles.dial), 'narrow named-container controls require an opaque backing', narrow.styles);
    assert(Number.parseFloat(narrow.styles.row.paddingBottom) > 60, 'narrow visible dashboard must reserve vertical row space', narrow.styles.row);
  }

  const idleDark = matrix.filter((entry) => entry.state === 'idle' && entry.scheme === 'dark');
  const width479 = idleDark.find((entry) => entry.containerWidth === 479)?.result;
  const width961 = idleDark.find((entry) => entry.containerWidth === 961)?.result;
  assert(width479 && width961 && width961.rects.macro.width - width479.rects.macro.width > 300,
    'short Inductive content must expand with the available container width instead of keeping an intrinsic ch width',
    { width479: width479?.rects.macro, width961: width961?.rects.macro });

  // Real production event paths for two authoring regressions: a parent may
  // split an inline context suffix into a separate field, and pointer-picking
  // a SNoogL result must commit on the first click.
  await setViewport(1280, false);
  await setInductiveContentWidth(961);
  const seededCaretEdit = await evaluate(`(() => {
    const textarea=document.querySelectorAll('.snl-tree-row')[1]?.querySelector('textarea[data-snl-macro-input]');
    if (!textarea) return false;
    textarea.focus();
    const setValue=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    setValue.call(textarea,'ChXild@ctx');
    textarea.setSelectionRange(3,3);
    textarea.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'X'}));
    return true;
  })()`);
  assert(seededCaretEdit, 'production Inductive textarea must accept the caret regression edit', seededCaretEdit);
  await waitFor(`document.querySelectorAll('.snl-tree-row')[1]?.querySelector('textarea[data-snl-macro-input]')?.value === 'ChXild'`);
  const caretResult = await evaluate(`(() => {
    const textarea=document.querySelectorAll('.snl-tree-row')[1].querySelector('textarea[data-snl-macro-input]');
    return { value:textarea.value, start:textarea.selectionStart, end:textarea.selectionEnd, active:document.activeElement===textarea };
  })()`);
  assert(caretResult.active && caretResult.start === 3 && caretResult.end === 3,
    'context projection must preserve the authored middle caret instead of forcing it to the end', caretResult);

  const imeSetup = await evaluate(`(() => {
    const textarea=document.querySelectorAll('.snl-tree-row')[1].querySelector('textarea[data-snl-macro-input]');
    textarea.focus();
    textarea.setSelectionRange(2,2);
    const nativeSetSelectionRange=textarea.setSelectionRange.bind(textarea);
    textarea.__snlImeSelectionCalls=0;
    textarea.setSelectionRange=(...args)=>{ textarea.__snlImeSelectionCalls += 1; return nativeSetSelectionRange(...args); };
    return {value:textarea.value,start:textarea.selectionStart};
  })()`);
  assert(imeSetup.value === 'ChXild' && imeSetup.start === 2,
    'production IME probe must begin in the middle of the Macro editor', imeSetup);
  await page.call('Input.imeSetComposition', {
    text: '猫', selectionStart: 1, selectionEnd: 1, replacementStart: 2, replacementEnd: 2
  });
  const imeDuring = await evaluate(`new Promise(resolve => requestAnimationFrame(() => {
    const textarea=document.querySelectorAll('.snl-tree-row')[1].querySelector('textarea[data-snl-macro-input]');
    resolve({calls:textarea.__snlImeSelectionCalls,value:textarea.value,start:textarea.selectionStart,end:textarea.selectionEnd,active:document.activeElement===textarea});
  }))`);
  assert(imeDuring.calls === 0 && imeDuring.active,
    'controlled Macro input must not call setSelectionRange during active IME composition', imeDuring);
  await page.call('Input.insertText', { text: '猫' });
  const imeAfter = await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
    const textarea=document.querySelectorAll('.snl-tree-row')[1].querySelector('textarea[data-snl-macro-input]');
    resolve({calls:textarea.__snlImeSelectionCalls,value:textarea.value,start:textarea.selectionStart,end:textarea.selectionEnd,active:document.activeElement===textarea});
  })))`);
  assert(imeAfter.value === 'Ch猫Xild' && imeAfter.start === 3 && imeAfter.end === 3 && imeAfter.active,
    'committing the IME composition must preserve its text and final caret', imeAfter);

  await evaluate(`(() => {
    const textarea=document.querySelectorAll('.snl-tree-row')[1].querySelector('textarea[data-snl-macro-input]');
    textarea.focus();
    textarea.setSelectionRange(3,3);
    textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'f',code:'KeyF',ctrlKey:true,bubbles:true,cancelable:true}));
  })()`);
  await waitFor(`document.querySelector('[role="dialog"] [role="option"]')?.textContent?.includes('FOL.forall')`);
  const snooglPoint = await evaluate(`(() => { const r=document.querySelector('[role="dialog"] [role="option"]').getBoundingClientRect(); return {x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}; })()`);
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: snooglPoint.x, y: snooglPoint.y });
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: snooglPoint.x, y: snooglPoint.y });
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: snooglPoint.x, y: snooglPoint.y });
  await waitFor(`!document.querySelector('[role="dialog"]')`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  const snooglResult = await evaluate(`(() => {
    const textarea=document.querySelectorAll('.snl-tree-row')[1].querySelector('textarea[data-snl-macro-input]');
    return { value:textarea.value, active:document.activeElement===textarea };
  })()`);
  assert(snooglResult.value === 'FOL.forall' && snooglResult.active,
    'the first real pointer click must commit a SNoogL result and restore the Macro editor', snooglResult);

  const longMacro = 'Long Macro content that wraps inside the available row width '.repeat(12).trim();
  const longMacroJson = JSON.stringify(longMacro);
  const seededLongEditor = await evaluate(`(() => {
    const textarea=document.querySelectorAll('.snl-tree-row')[1]?.querySelector('textarea[data-snl-macro-input]');
    if (!textarea) return false;
    textarea.value=${longMacroJson};
    return textarea.value === ${longMacroJson};
  })()`);
  assert(seededLongEditor, 'production Inductive textarea must accept the long-content geometry probe', seededLongEditor);
  await setInductiveContentWidth(961);
  const wideEditor = await evaluate(`(() => { const t=document.querySelectorAll('.snl-tree-row')[1].querySelector('textarea[data-snl-macro-input]'), w=t.closest('[data-macro-id-control]'); return { width:w.getBoundingClientRect().width, height:t.getBoundingClientRect().height, scrollHeight:t.scrollHeight, overflowX:getComputedStyle(t).overflowX }; })()`);
  await setInductiveContentWidth(479);
  const narrowEditor = await evaluate(`(() => { const t=document.querySelectorAll('.snl-tree-row')[1].querySelector('textarea[data-snl-macro-input]'), w=t.closest('[data-macro-id-control]'); return { width:w.getBoundingClientRect().width, height:t.getBoundingClientRect().height, scrollHeight:t.scrollHeight, overflowX:getComputedStyle(t).overflowX }; })()`);
  assert(narrowEditor.width < wideEditor.width - 300 && narrowEditor.height > wideEditor.height + 20 && narrowEditor.height >= narrowEditor.scrollHeight,
    'long Inductive content must wrap and grow vertically only after the available width narrows',
    { wideEditor, narrowEditor });

  await evaluate(`document.documentElement.dataset.snlColorScheme='dark'; document.activeElement?.blur()`);
  await setViewport(1280, true);
  await setInductiveContentWidth(961);
  const coarse = await inspect('coarse', 'dark', 961, matrix);
  assert(coarse.media.coarse, 'coarse-pointer branch must be emulated', coarse.media);
  assert(coarse.styles.toolbar.opacity === '1' && coarse.styles.toolbar.pointerEvents === 'auto', 'coarse-pointer CreateEntry controls must remain visible and operable', coarse.styles.toolbar);
  assert(opaqueBacking(coarse.styles.dial), 'coarse-pointer visible controls require an alpha-1 dial backing', coarse.styles.dial);
  assert(Number.parseFloat(coarse.styles.row.paddingBottom) > 60, 'coarse-pointer dashboard must reserve vertical row space', coarse.styles.row);

  await page.call('Page.navigate', { url: `http://127.0.0.1:${port}/?create` });
  await waitFor(`document.querySelector('#snl-entry-id')?.value === 'entry-id'`);
  const seededEntryIdEdit = await evaluate(`(() => {
    const input=document.querySelector('#snl-entry-id');
    window.__entryIdCaretProbe=input;
    input.focus();
    input.setSelectionRange(3,3);
    return {value:input.value,start:input.selectionStart,end:input.selectionEnd};
  })()`);
  assert(seededEntryIdEdit?.value === 'entry-id', 'production Create Entry ID must accept the middle-edit probe', seededEntryIdEdit);
  await page.call('Input.insertText', { text: 'X' });
  const entryIdCaret = await evaluate(`new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const input=document.querySelector('#snl-entry-id');
      resolve({same:input===window.__entryIdCaretProbe,active:document.activeElement===input,value:input?.value,start:input?.selectionStart,end:input?.selectionEnd});
    }));
  })`);
  assert(entryIdCaret.same && entryIdCaret.active && entryIdCaret.value === 'entXry-id' && entryIdCaret.start === 4 && entryIdCaret.end === 4,
    'first clean-to-dirty Entry ID edit must preserve the value and middle caret', entryIdCaret);

  const browserErrors = page.events.filter((event) =>
    event.method === 'Runtime.exceptionThrown' ||
    event.method === 'Log.entryAdded' && ['error', 'warning'].includes(event.params?.entry?.level)
  );
  assert(browserErrors.length === 0, 'CreateEntry production browser emitted errors', browserErrors);
  assert(matrix.length >= 41, 'CreateEntry production matrix must retain all theme/state cases', matrix.length);
  console.log(JSON.stringify({
    cases: matrix.length,
    schemes,
    namedContainerWidths: [479, 480, 481, 959, 960, 961],
    states: ['idle', 'row-hover', 'toolbar-hover', 'focus-within', 'narrow-row-hover', 'coarse'],
    coarse: true,
    interactions: {
      delimiter: {
        imeDuring: delimiterImeDuring,
        imeAfter: delimiterImeAfter,
        percent: percentEvidence,
        doubleDollar: doubleDollarEvidence,
        backtick: backtickEvidence,
        rearm: rearmEvidence
      },
      caret: caretResult, snoogl: snooglResult, firstStyle: firstStyleResult, imeDuring, imeAfter, entryIdCaret
    },
    artifactBuild
  }, null, 2));
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
