#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = resolve(root, 'media/webview');
const viteBin = resolve(root, 'node_modules/vite/bin/vite.js');
const entries = ['main', 'createEntry'];
const requiredBundles = [
  'main.js', 'main.css', 'createEntry.js', 'createEntry.css', 'createEntry2.css'
];
for (const bundle of requiredBundles) {
  rmSync(resolve(bundleDir, bundle), { force: true });
}
for (const entry of entries) {
  const build = spawnSync(
    process.execPath,
    [viteBin, 'build', '--config', resolve(root, 'webview/vite.config.ts')],
    { cwd: root, env: { ...process.env, SNL_WEBVIEW_ENTRY: entry }, stdio: 'inherit' }
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
}
for (const bundle of requiredBundles) {
  if (!existsSync(resolve(bundleDir, bundle))) {
    throw new Error(`Fresh production build did not create ${bundle}.`);
  }
}
console.log('[HARNESS:BUILD_OK]');

const chromeCandidates = [
  process.env.SNL_CHROMIUM_PATH,
  process.env.CHROME_PATH,
  process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && resolve(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  resolve(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'),
  resolve(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1187/chrome-linux/chrome'),
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/microsoft-edge'
].filter(Boolean);
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!chromePath) throw new Error('No Chromium found. Set SNL_CHROMIUM_PATH.');

const macro = {
  name: 'Fold', description: 'Authored Collapsible block',
  source: { entries: [], urls: [] }, dynamic_arity: true, tags: [],
  styles: [{
    style_name: 'default', tags: [],
    template: {
      mode: 'block', body: '#*', separator: '', block_template_name: 'collapsible'
    }
  }]
};
const snl = 'Fold(%Outer summary%, Fold(%Inner summary%, %Inner body%), %Outer body%)';
const entry = {
  id: 'collapsible-probe', kind: 'definition', title: 'Collapsible browser probe',
  content: { snl }, pointer: null, contribution_info: null
};
const kind = {
  id: 'definition', name: 'Definition', description: 'Definition kind',
  coloring: {
    light: { stroke: '#555555', background: '#eeeeee' },
    dark: { stroke: '#aaaaaa', background: '#222222' }
  },
  numbering: '1', style: 'default', defaultCounterName: 'section'
};
const readingFixture = {
  type: 'libraryEntries', slug: 'collapsible-probe', title: 'Collapsible probe',
  entries: [{ id: entry.id, title: entry.title, hasContent: true, snl }],
  outline: [{ nodeId: 'root', entry, kind, counterLabel: null, children: [] }],
  macros: { Fold: macro }, macroKinds: [], warnings: []
};
const editorFixture = {
  type: 'context', mode: 'edit', targetState: 'found', id: entry.id,
  kinds: [kind], macros: { Fold: macro }, macroKinds: [], macroOrigin: {},
  metricThresholds: { structuralIndexRedBelow: 60, structuralIndexGreenAtLeast: 80 },
  entryPackages: ['_unpackaged'], existingIds: [entry.id], relationships: [],
  existing: { ...entry, package: '_unpackaged' }
};

function pageHtml(bundle, fixture) {
  return `<!doctype html><html data-snl-color-scheme="dark"><head>
    <meta charset="utf-8"><link rel="stylesheet" href="/${bundle}.css">
    <script>
      window.__snlErrors = [];
      addEventListener('error', event => window.__snlErrors.push(String(event.error || event.message)));
      window.acquireVsCodeApi = () => ({
        postMessage(message) {
          if (message && message.type === 'ready') {
            window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(fixture)} }));
          }
        },
        getState() { return undefined; }, setState() {}
      });
    </script></head><body><div id="root"></div><script${bundle === 'createEntry' ? ' type="module"' : ''} src="/${bundle}.js"></script></body></html>`;
}
const pages = {
  '/reading': pageHtml('main', readingFixture),
  '/editor': pageHtml('createEntry', editorFixture)
};
const mime = { '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (pages[pathname]) {
    response.writeHead(200, { 'content-type': 'text/html' }); response.end(pages[pathname]); return;
  }
  if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  const file = resolve(bundleDir, pathname.slice(1));
  if (!file.startsWith(bundleDir) || !existsSync(file)) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const port = server.address().port;
const profile = mkdtempSync(resolve(tmpdir(), 'snl-collapsible-chrome-'));
const chrome = spawn(chromePath, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
let devtoolsUrl = '';
let stderr = '';
chrome.stderr.setEncoding('utf8');
chrome.stderr.on('data', (chunk) => {
  stderr += chunk;
  devtoolsUrl ||= chunk.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1] ?? '';
});
for (let attempt = 0; attempt < 120 && !devtoolsUrl; attempt += 1) {
  await new Promise((wait) => setTimeout(wait, 25));
}
if (!devtoolsUrl) throw new Error(`Chromium did not expose DevTools: ${stderr}`);

class Cdp {
  constructor(socket) {
    this.socket = socket; this.nextId = 1; this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
    });
  }
  call(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCall, rejectCall) =>
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall }));
  }
}

const browserSocket = new WebSocket(devtoolsUrl);
await new Promise((open, reject) => {
  browserSocket.addEventListener('open', open, { once: true });
  browserSocket.addEventListener('error', reject, { once: true });
});
const browser = new Cdp(browserSocket);
const results = [];
console.log('[HARNESS:STARTED]');
try {
  for (const surface of ['reading', 'editor']) {
    const { targetId } = await browser.call('Target.createTarget', {
      url: `http://127.0.0.1:${port}/${surface}`
    });
    let pageWs = '';
    for (let attempt = 0; attempt < 120 && !pageWs; attempt += 1) {
      const targets = await fetch(
        `http://127.0.0.1:${new URL(devtoolsUrl).port}/json/list`
      ).then((response) => response.json());
      pageWs = targets.find((target) => target.id === targetId)?.webSocketDebuggerUrl ?? '';
      if (!pageWs) await new Promise((wait) => setTimeout(wait, 25));
    }
    if (!pageWs) throw new Error(`Could not attach to ${surface}.`);
    const pageSocket = new WebSocket(pageWs);
    await new Promise((open, reject) => {
      pageSocket.addEventListener('open', open, { once: true });
      pageSocket.addEventListener('error', reject, { once: true });
    });
    const page = new Cdp(pageSocket);
    const protocolDiagnostics = [];
    pageSocket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        protocolDiagnostics.push({ method: message.method, params: message.params });
      } else if (message.method === 'Runtime.consoleAPICalled' &&
          ['error', 'warning'].includes(message.params?.type)) {
        protocolDiagnostics.push({ method: message.method, params: message.params });
      }
    });
    await page.call('Runtime.enable');
    await page.call('Page.enable');
    const evaluate = async (expression) => {
      const result = await page.call('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluation failed');
      return result.result.value;
    };
    const surfaceSelector = surface === 'editor'
      ? '.snl-entry-live-preview .snl-collapsible'
      : '.snl-collapsible';
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (await evaluate(`document.querySelectorAll(${JSON.stringify(surfaceSelector)}).length === 2`)) break;
      if (attempt === 239) {
        throw new Error(`${surface} did not render two real Live Preview Collapsible blocks: ` +
          JSON.stringify({
            ...(await evaluate(`({
              html: document.body.innerHTML.slice(0, 12000),
              text: document.body.innerText.slice(0, 4000),
              errors: window.__snlErrors,
              collapsibleCount: document.querySelectorAll(${JSON.stringify(surfaceSelector)}).length
            })`)),
            protocolDiagnostics
          }));
      }
      await new Promise((wait) => setTimeout(wait, 25));
    }
    const initial = await evaluate(`(() => {
      const hosts = [...document.querySelectorAll(${JSON.stringify(surfaceSelector)})];
      return hosts.map(host => ({
        expanded: host.querySelector(':scope > .snl-collapsible__summary > button')?.getAttribute('aria-expanded'),
        hidden: host.querySelector(':scope > .snl-collapsible__body')?.hidden,
        bodyText: host.querySelector(':scope > .snl-collapsible__body')?.textContent,
        summaryText: host.querySelector(':scope > .snl-collapsible__summary')?.textContent
      }));
    })()`);
    if (initial.some((state) => state.expanded !== 'false' || state.hidden !== true)) {
      throw new Error(`[ASSERT:DEFAULT-CLOSED] ${surface}: ${JSON.stringify(initial)}`);
    }
    await evaluate(`document.querySelector(${JSON.stringify(surfaceSelector + ' > .snl-collapsible__summary > button')}).click()`);
    const outerOpen = await evaluate(`(() => {
      const host = document.querySelector(${JSON.stringify(surfaceSelector)});
      const inner = host.querySelector(':scope > .snl-collapsible__body .snl-collapsible');
      return {
        expanded: host.querySelector(':scope > .snl-collapsible__summary > button').getAttribute('aria-expanded'),
        hidden: host.querySelector(':scope > .snl-collapsible__body').hidden,
        innerExpanded: inner.querySelector(':scope > .snl-collapsible__summary > button').getAttribute('aria-expanded')
      };
    })()`);
    if (outerOpen.expanded !== 'true' || outerOpen.hidden || outerOpen.innerExpanded !== 'false') {
      throw new Error(`${surface} independent outer toggle failed: ${JSON.stringify(outerOpen)}`);
    }
    await evaluate(`document.querySelector(${JSON.stringify(surfaceSelector + ' ' + surfaceSelector.split(' ').at(-1) + ' > .snl-collapsible__summary > button')}).focus()`);
    await page.call('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
    });
    await page.call('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
    });
    const keyboard = await evaluate(`(() => {
      const hosts = [...document.querySelectorAll(${JSON.stringify(surfaceSelector)})];
      return hosts.map(host => ({
        expanded: host.querySelector(':scope > .snl-collapsible__summary > button').getAttribute('aria-expanded'),
        hidden: host.querySelector(':scope > .snl-collapsible__body').hidden
      }));
    })()`);
    if (keyboard.some((state) => state.expanded !== 'true' || state.hidden)) {
      throw new Error(`${surface} keyboard/ARIA toggle failed: ${JSON.stringify(keyboard)}`);
    }
    let rerender = null;
    if (surface === 'editor') {
      rerender = await evaluate(`(() => {
        const title = document.querySelector('#snl-entry-title');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(title, title.value + ' rerender');
        title.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        rerender = await evaluate(`(() => {
          const hosts = [...document.querySelectorAll(${JSON.stringify(surfaceSelector)})];
          return {
            title: document.querySelector('#snl-entry-title')?.value,
            states: hosts.map(host => ({
              expanded: host.querySelector(':scope > .snl-collapsible__summary > button')?.getAttribute('aria-expanded'),
              hidden: host.querySelector(':scope > .snl-collapsible__body')?.hidden
            }))
          };
        })()`);
        if (rerender.title?.endsWith(' rerender')) break;
        await new Promise((wait) => setTimeout(wait, 25));
      }
      if (!rerender.title?.endsWith(' rerender') ||
          rerender.states.some((state) => state.expanded !== 'true' || state.hidden)) {
        throw new Error(`editor ordinary-draft rerender lost transient state: ${JSON.stringify(rerender)}`);
      }
    }
    const errors = await evaluate('window.__snlErrors');
    if (errors.length || protocolDiagnostics.length) {
      throw new Error(`${surface} browser errors: ${JSON.stringify({ errors, protocolDiagnostics })}`);
    }
    results.push({ surface, initial, outerOpen, keyboard, rerender });
    pageSocket.close();
    await browser.call('Target.closeTarget', { targetId });
  }
  console.log(JSON.stringify({ pass: true, surfaces: results }, null, 2));
} finally {
  browserSocket.close();
  if (process.platform === 'win32') {
    spawnSync(resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'),
      ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    chrome.kill('SIGTERM');
  }
  await Promise.race([
    new Promise((settled) => chrome.once('exit', settled)),
    new Promise((settled) => setTimeout(settled, 1000))
  ]);
  server.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
