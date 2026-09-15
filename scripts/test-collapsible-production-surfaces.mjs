#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalPath,
  cleanupOwnedProcessRegistry,
  destroyOwnedProcessRegistry,
  ensureOwnedProcessRegistry,
  fileCensus,
  restoreFiles,
  sameFileCensus,
  snapshotFiles,
  spawnTracked,
  terminateProcessTree,
  verifyOwnedProcessRegistryClean
} from './library-depth-harness-utils.mjs';

const root = canonicalPath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

if (!existsSync(resolve(root, '.browser-author-overlay.json')) || existsSync(resolve(root, '.git'))) throw new Error('Run only in an owned browser-author-overlay.py snapshot');
const bundleDir = resolve(root, 'media/webview');
const buildScript = resolve(root, 'scripts/browser-author-build.mjs');
const manifest = JSON.parse(readFileSync(resolve(root, 'webview/productionEntries.json'), 'utf8'));
const mutation = process.env.SNL_COLLAPSIBLE_MUTATION ?? '';
const forcedFailure = process.env.SNL_COLLAPSIBLE_FORCE_FAILURE ?? '';

let ownershipRegistry = null;
let artifactSnapshot = null;
let artifactFilesBefore = [];
let artifactCensusBefore = null;
let artifactDirectoriesBefore = [];
let server = null;
let chrome = null;
let profile = null;
let browserSocket = null;
const pageSockets = new Set();

function walkArtifactTree(directory) {
  if (!existsSync(directory)) return { files: [], directories: [] };
  const files = [];
  const directories = [];
  const visit = (current) => {
    const currentStat = lstatSync(current);
    if (!currentStat.isDirectory()) throw new Error(`artifact root is not a directory: ${current}`);
    directories.push({
      path: current,
      relative: relative(directory, current),
      mode: currentStat.mode,
      atimeMs: currentStat.atimeMs,
      mtimeMs: currentStat.mtimeMs
    });
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = resolve(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
      else throw new Error(`unsupported generated artifact type: ${child}`);
    }
  };
  visit(directory);
  files.sort();
  directories.sort((left, right) => left.path.length - right.path.length);
  return { files, directories };
}

function snapshotArtifacts() {
  const tree = walkArtifactTree(bundleDir);
  artifactFilesBefore = tree.files;
  artifactDirectoriesBefore = tree.directories;
  artifactSnapshot = snapshotFiles(tree.files);
  artifactCensusBefore = fileCensus(tree.files);
}

function restoreArtifacts() {
  rmSync(bundleDir, { recursive: true, force: true });
  if (!artifactDirectoriesBefore.length) return;
  for (const record of artifactDirectoriesBefore) {
    mkdirSync(record.path, { recursive: true });
    chmodSync(record.path, record.mode);
  }
  restoreFiles(artifactSnapshot);
  for (const record of [...artifactDirectoriesBefore].reverse()) {
    chmodSync(record.path, record.mode);
    utimesSync(record.path, record.atimeMs / 1000, record.mtimeMs / 1000);
  }
  const after = walkArtifactTree(bundleDir);
  const beforeNames = artifactFilesBefore.map((file) => relative(bundleDir, file));
  const afterNames = after.files.map((file) => relative(bundleDir, file));
  if (JSON.stringify(beforeNames) !== JSON.stringify(afterNames) ||
      !sameFileCensus(artifactCensusBefore, fileCensus(after.files))) {
    throw new Error(`artifact census changed: ${JSON.stringify({ beforeNames, afterNames })}`);
  }
}

function findChromium() {
  const candidates = [
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
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function closeServer(instance) {
  if (!instance) return;
  await new Promise((resolveClose, rejectClose) => {
    instance.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error
        ? pending.reject(new Error(JSON.stringify(message.error)))
        : pending.resolve(message.result);
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
    });
  }
}

async function openSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
  return socket;
}

const macro = {
  name: 'Fold',
  description: 'Authored Collapsible block',
  source: { entries: [], urls: [] },
  dynamic_arity: true,
  tags: [],
  styles: [{
    style_name: 'default',
    tags: [],
    template: { mode: 'block', body: '#*', separator: '', block_template_name: 'collapsible' }
  }]
};
const summaryTokens = ['OUTER_SUMMARY_UNIQUE_7D91', 'INNER_SUMMARY_UNIQUE_A42C'];
const bodyTokens = ['OUTER_BODY_UNIQUE_F84E', 'INNER_BODY_UNIQUE_1B35'];
const snl = `Fold(%${summaryTokens[0]}%, Fold(%${summaryTokens[1]}%, %${bodyTokens[1]}%), %${bodyTokens[0]}%)`;
const entry = {
  id: 'collapsible-probe',
  kind: 'definition',
  title: 'Collapsible browser probe',
  content: { snl },
  pointer: null,
  contribution_info: null
};
const kind = {
  id: 'definition',
  name: 'Definition',
  description: 'Definition kind',
  coloring: {
    light: { stroke: '#555555', background: '#eeeeee' },
    dark: { stroke: '#aaaaaa', background: '#222222' }
  },
  numbering: '1',
  style: 'default',
  defaultCounterName: 'section'
};
const readingFixture = {
  type: 'libraryEntries',
  slug: 'collapsible-probe',
  title: 'Collapsible probe',
  entries: [{ id: entry.id, title: entry.title, hasContent: true, snl }],
  outline: [{ nodeId: 'root', entry, kind, counterLabel: null, children: [] }],
  macros: { Fold: macro },
  macroKinds: [],
  warnings: []
};
const editorFixture = {
  type: 'context',
  mode: 'edit',
  targetState: 'found',
  id: entry.id,
  kinds: [kind],
  macros: { Fold: macro },
  macroKinds: [],
  macroOrigin: {},
  metricThresholds: { structuralIndexRedBelow: 60, structuralIndexGreenAtLeast: 80 },
  entryPackages: ['_unpackaged'],
  existingIds: [entry.id],
  relationships: [],
  existing: { ...entry, package: '_unpackaged' }
};

function pageHtml(bundle, fixture) {
  const visibilityMutation = mutation === 'visibility-override'
    ? '<style>.snl-collapsible__body[hidden]{display:block!important;visibility:visible!important;content-visibility:visible!important}</style>'
    : '';
  return `<!doctype html><html data-snl-color-scheme="dark"><head>
    <meta charset="utf-8"><link rel="stylesheet" href="/${bundle}.css">${visibilityMutation}
    <script>
      window.__snlErrors = [];
      window.__snlPosted = [];
      addEventListener('error', event => window.__snlErrors.push(String(event.error || event.message)));
      window.acquireVsCodeApi = () => ({
        postMessage(message) {
          window.__snlPosted.push(message);
          if (message && message.type === 'ready') {
            window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(fixture)} }));
          }
        },
        getState() { return undefined; },
        setState() {}
      });
    </script></head><body><div id="root"></div><script${bundle === 'createEntry' ? ' type="module"' : ''} src="/${bundle}.js"></script></body></html>`;
}

function classifyError(error) {
  const message = error?.stack || String(error);
  const ids = [...message.matchAll(/\[ASSERT:([A-Z0-9-]+)\]/g)].map((match) => match[1]);
  if (ids.length === 1) return { terminal: { kind: 'assertion', id: ids[0] }, message: error.message || String(error) };
  return { terminal: { kind: 'infra', stage: 'HARNESS', detail: message }, message: null };
}

async function runHarness() {
  snapshotArtifacts();
  rmSync(bundleDir, { recursive: true, force: true });
  if (existsSync(bundleDir)) throw new Error('[ASSERT:BUILD-FRESH-ABSENT] generated output survived deletion');
  const buildStartedAt = Date.now();
  const build = spawnSync(process.execPath, [buildScript], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) throw new Error(`canonical webview build failed with ${build.status ?? 'no status'}`);
  for (const productionEntry of manifest.entries.filter(e => ['main', 'createEntry'].includes(e.name))) {
    const output = resolve(bundleDir, productionEntry.output);
    if (!existsSync(output)) throw new Error(`[ASSERT:BUILD-FRESH-CREATED] missing ${productionEntry.output}`);
    if (statSync(output).mtimeMs < buildStartedAt) {
      throw new Error(`[ASSERT:BUILD-FRESH-MTIME] ${productionEntry.output} predates the build`);
    }
  }
  const buildHashes = Object.fromEntries(
    ['main.js', 'main.css', 'createEntry.js', 'createEntry.css', 'createEntry2.css'].map((name) => [
      name,
      createHash('sha256').update(readFileSync(resolve(bundleDir, name))).digest('hex')
    ])
  );
  console.log('[HARNESS:BUILD_OK]');
  if (forcedFailure === 'after-build') throw new Error('[ASSERT:FORCED-AFTER-BUILD] cleanup contract probe');

  const pages = {
    '/reading': pageHtml('main', readingFixture),
    '/editor': pageHtml('createEntry', editorFixture)
  };
  const mime = { '.js': 'text/javascript', '.css': 'text/css' };
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pages[pathname]) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(pages[pathname]);
      return;
    }
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    const file = resolve(bundleDir, pathname.slice(1));
    if (!(file === bundleDir || file.startsWith(`${bundleDir}${sep}`)) || !existsSync(file)) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    response.end(readFileSync(file));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  if (forcedFailure === 'after-server') throw new Error('[ASSERT:FORCED-AFTER-SERVER] cleanup contract probe');

  const chromePath = findChromium();
  if (!chromePath) throw new Error('No Chromium found. Set SNL_CHROMIUM_PATH.');
  profile = mkdtempSync(resolve('/tmp', 'snl-ca-'));
  chrome = spawnTracked(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--num-raster-threads=1', '--disable-background-networking', '--disable-default-apps', '--disable-extensions',
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
  browserSocket = await openSocket(devtoolsUrl);
  const browser = new Cdp(browserSocket);
  console.log('[HARNESS:STARTED]');
  if (forcedFailure === 'after-browser') throw new Error('[ASSERT:FORCED-AFTER-BROWSER] cleanup contract probe');

  const results = [];
  for (const surface of ['reading', 'editor']) {
    const { targetId } = await browser.call('Target.createTarget', { url: `http://127.0.0.1:${server.address().port}/${surface}` });
    let pageSocket = null;
    try {
      let pageUrl = '';
      for (let attempt = 0; attempt < 120 && !pageUrl; attempt += 1) {
        const targets = await fetch(`http://127.0.0.1:${new URL(devtoolsUrl).port}/json/list`).then((response) => response.json());
        pageUrl = targets.find((target) => target.id === targetId)?.webSocketDebuggerUrl ?? '';
        if (!pageUrl) await new Promise((wait) => setTimeout(wait, 25));
      }
      if (!pageUrl) throw new Error(`Could not attach to ${surface}.`);
      pageSocket = await openSocket(pageUrl);
      pageSockets.add(pageSocket);
      const page = new Cdp(pageSocket);
      const protocolDiagnostics = [];
      pageSocket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') protocolDiagnostics.push(message);
        if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params?.type)) {
          protocolDiagnostics.push(message);
        }
      });
      await page.call('Runtime.enable');
      await page.call('Page.enable');
      const evaluate = async (expression) => {
        const result = await page.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluation failed');
        return result.result.value;
      };
      const expectedBoundarySelector = surface === 'editor'
        ? '.snl-entry-live-preview > .snl-entry-overflow-surface'
        : '.snl-entry-overflow-surface';
      const locateBoundary = `(() => {
        const expected = ${JSON.stringify(expectedBoundarySelector)};
        const candidates = [...document.querySelectorAll(expected)].filter((candidate) => {
          const summaries = [...candidate.querySelectorAll('.snl-collapsible__summary')].map((node) => node.textContent.trim());
          return summaries.some((text) => text.includes(${JSON.stringify(summaryTokens[0])})) && summaries.some((text) => text.includes(${JSON.stringify(summaryTokens[1])}));
        });
        if (candidates.length !== 1) return { ok: false, reason: 'candidate-count', count: candidates.length };
        const boundary = candidates[0];
        const blocks = [...boundary.querySelectorAll('.snl-collapsible:not(.snl-collapsible--flat)')];
        const allPageBlocks = [...document.querySelectorAll('.snl-collapsible:not(.snl-collapsible--flat)')];
        if (blocks.length !== 2) return { ok: false, reason: 'block-count', count: blocks.length, pageCount: allPageBlocks.length };
        const outer = blocks.find((block) => block.querySelector(':scope > .snl-collapsible__summary')?.textContent.includes(${JSON.stringify(summaryTokens[0])}));
        const inner = blocks.find((block) => block.querySelector(':scope > .snl-collapsible__summary')?.textContent.includes(${JSON.stringify(summaryTokens[1])}));
        if (!outer || !inner || !outer.querySelector(':scope > .snl-collapsible__body')?.contains(inner)) {
          return { ok: false, reason: 'nested-identity' };
        }
        window.__snlCollapsibleBoundary = boundary;
        window.__snlCollapsibleOuter = outer;
        window.__snlCollapsibleInner = inner;
        return { ok: true, boundaryClass: boundary.className, blockCount: blocks.length, pageCount: allPageBlocks.length };
      })()`;
      let boundary = null;
      for (let attempt = 0; attempt < 240; attempt += 1) {
        boundary = await evaluate(locateBoundary);
        if (boundary.ok) break;
        if (attempt === 239) {
          const diagnostics = await evaluate(`({ html: document.body.innerHTML.slice(0, 12000), text: document.body.innerText.slice(0, 4000), errors: window.__snlErrors })`);
          throw new Error(`[ASSERT:SURFACE-BOUNDARY] ${surface}: ${JSON.stringify({ boundary, diagnostics, protocolDiagnostics })}`);
        }
        await new Promise((wait) => setTimeout(wait, 25));
      }

      const inspect = `(() => {
        const inspectBody = (host) => {
          const button = host.querySelector(':scope > .snl-collapsible__summary > button');
          const body = host.querySelector(':scope > .snl-collapsible__body');
          const style = getComputedStyle(body);
          const rect = body.getBoundingClientRect();
          return {
            expanded: button?.getAttribute('aria-expanded'), hidden: body?.hidden,
            display: style.display, visibility: style.visibility, contentVisibility: style.contentVisibility,
            checkVisibility: typeof body.checkVisibility === 'function' ? body.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : null,
            rect: { width: rect.width, height: rect.height }, rectCount: body.getClientRects().length,
            offsetParent: body.offsetParent !== null, bodyText: body.textContent
          };
        };
        return [inspectBody(window.__snlCollapsibleOuter), inspectBody(window.__snlCollapsibleInner)];
      })()`;
      const isEffectivelyClosed = (state) => state.expanded === 'false' && state.hidden === true &&
        (state.display === 'none' || state.visibility === 'hidden' || state.contentVisibility === 'hidden') &&
        state.checkVisibility !== true && state.rect.width === 0 && state.rect.height === 0 &&
        state.rectCount === 0 && state.offsetParent === false;
      const isEffectivelyOpen = (state) => state.expanded === 'true' && state.hidden === false &&
        state.display !== 'none' && state.visibility !== 'hidden' && state.contentVisibility !== 'hidden' &&
        state.checkVisibility !== false && state.rect.width > 0 && state.rect.height > 0 &&
        state.rectCount > 0 && state.offsetParent === true;

      const initial = await evaluate(inspect);
      if (initial.some((state) => state.expanded !== 'false' || state.hidden !== true)) {
        throw new Error(`[ASSERT:DEFAULT-CLOSED] ${surface}: ${JSON.stringify(initial)}`);
      }
      if (initial.some((state) => !isEffectivelyClosed(state))) {
        throw new Error(`[ASSERT:DEFAULT-CLOSED-VISIBILITY] ${surface}: ${JSON.stringify(initial)}`);
      }

      await evaluate(`window.__snlCollapsibleOuter.querySelector(':scope > .snl-collapsible__summary > button').click()`);
      const outerOpen = await evaluate(inspect);
      if (!isEffectivelyOpen(outerOpen[0]) || !isEffectivelyClosed(outerOpen[1]) ||
          !outerOpen[0].bodyText.includes(bodyTokens[0]) ||
          !outerOpen[0].bodyText.includes(bodyTokens[1])) {
        throw new Error(`[ASSERT:OUTER-TOGGLE-VISIBILITY] ${surface}: ${JSON.stringify(outerOpen)}`);
      }

      await evaluate(`window.__snlCollapsibleInner.querySelector(':scope > .snl-collapsible__summary > button').focus()`);
      await page.call('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
      });
      await page.call('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
      });
      const keyboard = await evaluate(inspect);
      if (!isEffectivelyOpen(keyboard[0]) || !isEffectivelyOpen(keyboard[1]) ||
          !keyboard[1].bodyText.includes(bodyTokens[1])) {
        throw new Error(`[ASSERT:KEYBOARD-ARIA-VISIBILITY] ${surface}: ${JSON.stringify(keyboard)}`);
      }

      let rerender = null;
      if (surface === 'editor') {
        const draftToken = `CONTROLLED_DRAFT_${Date.now()}_D9E2`;
        await evaluate(`(() => {
          const title = document.querySelector('#snl-entry-title');
          const surface = window.__snlCollapsibleBoundary;
          window.__snlRerenderProbe = {
            surface,
            outer: window.__snlCollapsibleOuter,
            mutations: 0,
            observer: new MutationObserver((records) => { window.__snlRerenderProbe.mutations += records.length; })
          };
          window.__snlRerenderProbe.observer.observe(surface, { subtree: true, childList: true, characterData: true, attributes: true });
          if (${JSON.stringify(mutation)} === 'rerender-dom-only') {
            title.value = ${JSON.stringify(draftToken)};
          } else {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(title, ${JSON.stringify(draftToken)});
            title.dispatchEvent(new Event('input', { bubbles: true }));
            title.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()`);
        for (let attempt = 0; attempt < 160; attempt += 1) {
          rerender = await evaluate(`(() => {
            const probe = window.__snlRerenderProbe;
            const states = ${inspect};
            return {
              inputValue: document.querySelector('#snl-entry-title')?.value,
              previewHasDraft: probe.surface.textContent.includes(${JSON.stringify(draftToken)}),
              mutations: probe.mutations,
              sameSurface: probe.surface === window.__snlCollapsibleBoundary,
              sameOuter: probe.outer === window.__snlCollapsibleOuter,
              states
            };
          })()`);
          if (rerender.previewHasDraft && rerender.mutations > 0) break;
          await new Promise((wait) => setTimeout(wait, 25));
        }
        await evaluate('window.__snlRerenderProbe.observer.disconnect()');
        if (rerender.inputValue !== draftToken || !rerender.previewHasDraft || rerender.mutations < 1 ||
            !rerender.sameSurface || rerender.states.some((state) => !isEffectivelyOpen(state))) {
          throw new Error(`[ASSERT:RERENDER-CONTROLLED] editor: ${JSON.stringify(rerender)}`);
        }
      }

      const errors = await evaluate('window.__snlErrors');
      if (errors.length || protocolDiagnostics.length) {
        throw new Error(`[ASSERT:BROWSER-CONSOLE-CLEAN] ${surface}: ${JSON.stringify({ errors, protocolDiagnostics })}`);
      }
      results.push({ surface, boundary, initial, outerOpen, keyboard, rerender });
    } finally {
      if (pageSocket) {
        pageSockets.delete(pageSocket);
        try { pageSocket.close(); } catch { /* browser cleanup is authoritative */ }
      }
      try { await browser.call('Target.closeTarget', { targetId }); } catch { /* browser cleanup is authoritative */ }
    }
  }
  console.log(JSON.stringify({ pass: true, buildHashes, surfaces: results }));
}

async function cleanupHarness() {
  const errors = [];
  for (const socket of pageSockets) {
    try { socket.close(); } catch (error) { errors.push(error); }
  }
  pageSockets.clear();
  if (browserSocket?.readyState === WebSocket.OPEN) {
    try { await Promise.race([new Cdp(browserSocket).call('Browser.close'), new Promise(r => setTimeout(r, 1500))]); } catch { /* close can end transport before reply */ }
  }
  try { browserSocket?.close(); } catch (error) { errors.push(error); }
  if (chrome && chrome.exitCode === null) await new Promise(r => { chrome.once('exit', r); setTimeout(r, 2000); });
  try { await terminateProcessTree(chrome); } catch (error) { errors.push(error); }
  try { await closeServer(server); } catch (error) { errors.push(error); }
  try {
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) { errors.push(error); }
  try { if (artifactSnapshot) restoreArtifacts(); } catch (error) { errors.push(error); }
  if (ownershipRegistry) {
    try {
      await cleanupOwnedProcessRegistry(ownershipRegistry);
      await verifyOwnedProcessRegistryClean(ownershipRegistry);
    } catch (error) { errors.push(error); }
    try { destroyOwnedProcessRegistry(ownershipRegistry); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new Error(errors.map((error) => error?.stack || String(error)).join('\n'));
}

let terminalResult;
let assertionMessage = null;
try {
  ownershipRegistry = ensureOwnedProcessRegistry();
  await runHarness();
  terminalResult = { kind: 'pass' };
} catch (error) {
  const classified = classifyError(error);
  terminalResult = classified.terminal;
  assertionMessage = classified.message;
} finally {
  try {
    await cleanupHarness();
  } catch (error) {
    terminalResult = { kind: 'infra', stage: 'CLEANUP', detail: error?.stack || String(error) };
    assertionMessage = null;
  }
}
if (assertionMessage) console.error(assertionMessage);
console.log(JSON.stringify(terminalResult));
process.exitCode = terminalResult.kind === 'pass' ? 0 : 1;
