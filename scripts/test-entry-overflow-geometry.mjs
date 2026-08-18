#!/usr/bin/env node
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'snl-entry-overflow-'));
const bundle = resolve(temporaryRoot, 'bundle');
const profile = resolve(temporaryRoot, 'profile');
let server;
let chrome;
let browserSocket;
const pageSockets = new Set();

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const closeSocket = (socket) => {
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
};
const cleanup = async () => {
  for (const socket of pageSockets) closeSocket(socket);
  closeSocket(browserSocket);
  if (server) await new Promise((done) => server.close(done));
  if (chrome?.exitCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([new Promise((done) => chrome.once('exit', done)), delay(3000)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
};

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        this.events.push(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }
  call(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall, reject });
    });
  }
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return socket;
}

const long = (prefix) => `${prefix}_${'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(80)}`;
const kind = {
  id: 'definition',
  name: 'Definition',
  description: 'Definition',
  coloring: {
    light: { stroke: '#111111', background: '#eeeeee' },
    dark: { stroke: '#dddddd', background: '#222222' }
  },
  style: ''
};
const option = (id, snl) => ({ id, package: 'geometry', title: id, hasContent: true, ...(snl ? { snl } : {}) });
const entry = (id, content) => ({ id, kind: 'definition', title: id, content, pointer: null });
const details = (fixture, selectedEntry, entries = []) => ({
  type: 'entryDetails',
  fixture,
  entry: selectedEntry,
  kind,
  entries,
  entryPackages: Object.fromEntries(entries.map(({ id }) => [id, 'geometry'])),
  relationshipSections: [],
  relatedEntries: []
});

const fixtures = {
  plain: details('plain', entry('fixture-plain', { text: long('PLAIN_SENTINEL') })),
  snl: {
    ...details('snl', entry('fixture-snl', { snl: `longtext(%snltextsentinel${'a'.repeat(2800)}%)` })),
    macros: {
      longtext: {
        name: 'longtext', description: 'text fixture', source: { entries: [], urls: [] },
        dynamic_arity: false, tags: [],
        styles: [{ style_name: 'default', tags: [], template: { mode: 'text', body: '#0' } }]
      }
    }
  },
  markdown: details('markdown', entry('fixture-markdown', {
    markdown: `${long('MARKDOWN_PROSE_SENTINEL')}\n\n\`\`\`text\n${long('MARKDOWN_CODE_SENTINEL')}\n\`\`\``
  })),
  formula: details('formula', entry('fixture-formula', {
    latex: `\\texttt{FORMULASENTINEL${'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(80)}}`
  })),
  roottext: details('roottext', entry('fixture-roottext', {
    snl: '%RootCM $\\text{RootCM}$%'
  })),
  mixed: {
    ...details('mixed', entry('fixture-mixed', { snl: 'mixedformula()' })),
    macros: {
      mixedformula: {
        name: 'mixedformula', description: 'mixed prose and inline formula fixture',
        source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
        styles: [{
          style_name: 'default', tags: [],
          template: {
            mode: 'text',
            body: `MIXEDPROSESENTINEL${'a'.repeat(720)} $\\texttt{MIXEDFORMULASENTINEL${'0123456789'.repeat(90)}}$ MIXEDTAILSENTINEL${'z'.repeat(720)}`
          }
        }]
      }
    }
  },
  hover: {
    ...details(
      'hover',
      entry('fixture-hover', { snl: 'pair(siblingref@sibling,childref@child)' }),
      [option('child', '@childref'), option('sibling', '@siblingref'), option('grandchild', '@grandref'), option('nested-sibling', '@nestedref')]
    ),
    macros: {
      pair: {
        name: 'pair', description: 'two references', source: { entries: [], urls: [] },
        dynamic_arity: false, tags: [],
        styles: [{ style_name: 'default', tags: [], template: { mode: 'formula_inline', body: '#0 + #1' } }]
      }
    }
  }
};
const popoverEntries = {
  child: entry('child', { snl: 'pair(nestedref@nested-sibling,grandref@grandchild)' }),
  grandchild: entry('grandchild', {
    markdown: `GRANDCHILDSENTINEL\n\n${Array.from({ length: 24 }, (_, index) => `Scrollable line ${index + 1}`).join('\n\n')}\n\n\`\`\`text\nGRANDCHILDCODESENTINEL_${'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(40)}\n\`\`\``
  }),
  sibling: entry('sibling', { text: 'Sibling body sentinel' }),
  'nested-sibling': entry('nested-sibling', { text: 'Nested sibling body sentinel' })
};

function htmlFor(mode) {
  const fixture = fixtures[mode];
  if (!fixture) return null;
  const payload = JSON.stringify({ fixture, popoverEntries, kind });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/entryInfoview.css"><style>html,body{margin:0;max-width:100%}body{font-family:sans-serif}</style><script>window.__geometry=${payload};window.__posted=[];window.__nativeEvents=[];for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>window.__nativeEvents.push({type,src:event.target?.closest?.('[data-src]')?.getAttribute('data-src')??null}),true);window.acquireVsCodeApi=()=>({postMessage(message){window.__posted.push(message);if(message?.type==='ready'){setTimeout(()=>dispatchEvent(new MessageEvent('message',{data:window.__geometry.fixture})),0);return;}if(message?.type==='requestEntryDetails'){const selected=window.__geometry.popoverEntries[message.entryId];setTimeout(()=>dispatchEvent(new MessageEvent('message',{data:{type:'popoverEntryDetails',entryId:message.entryId,entryPackage:message.entryPackage,popoverRequestKey:message.popoverRequestKey,entry:selected??null,kind:selected?window.__geometry.kind:null}})),0);}},getState(){return undefined},setState(){}});</script></head><body><div id="root"></div><button id="outside-target" aria-label="outside" style="position:fixed;right:1px;bottom:1px;width:4px;height:4px;opacity:0"></button><script src="/entryInfoview.js"></script></body></html>`;
}

async function waitFor(evaluate, expression, label, attempts = 240) {
  for (let index = 0; index < attempts; index++) {
    const value = await evaluate(expression);
    if (value) return value;
    await delay(25);
  }
  const debug = await evaluate(`(()=>{const b=document.querySelector('[data-entry-body]');return {tail:b?.innerHTML?.slice(-1200),classes:[...b?.querySelectorAll('*')??[]].map(e=>e.className).filter(x=>typeof x==='string'&&x).slice(-30)}})()`);
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(debug)}`);
}

async function openPage(browser, browserWs, mode, width, port, height = 700) {
  const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
  let pageWs = '';
  for (let index = 0; index < 120 && !pageWs; index++) {
    const targets = await fetch(`http://127.0.0.1:${new URL(browserWs).port}/json/list`).then((response) => response.json());
    pageWs = targets.find((target) => target.id === targetId)?.webSocketDebuggerUrl ?? '';
    if (!pageWs) await delay(25);
  }
  if (!pageWs) throw new Error(`CDP page socket unavailable for ${mode}:${width}`);
  const socket = await connect(pageWs);
  pageSockets.add(socket);
  const page = new Cdp(socket);
  await page.call('Runtime.enable');
  await page.call('Page.enable');
  await page.call('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false
  });
  await page.call('Page.navigate', { url: `http://127.0.0.1:${port}/?fixture=${mode}` });
  const evaluate = async (expression) => {
    const result = await page.call('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await waitFor(
    evaluate,
    `document.querySelector('[data-entry-id]')?.getAttribute('data-entry-id') === ${JSON.stringify(`fixture-${mode}`)}`,
    `${mode} fixture sentinel at ${width}px`
  );
  // KaTeX font swaps can move live origins after content first appears. Native
  // parity starts only once the production document's fonts and paint settle.
  await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  return { targetId, page, socket, evaluate };
}

async function closePage(browser, opened) {
  closeSocket(opened.socket);
  pageSockets.delete(opened.socket);
  await browser.call('Target.closeTarget', { targetId: opened.targetId });
}

function assert(condition, id, detail) {
  if (!condition) throw new Error(`[${id}] ${JSON.stringify(detail)}`);
}

let terminalResult;
try {
  const build = spawnSync(
    process.execPath,
    [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', resolve(root, 'webview/vite.config.ts'), '--outDir', bundle, '--emptyOutDir'],
    { cwd: root, env: { ...process.env, SNL_WEBVIEW_ENTRY: 'entryInfoview' }, stdio: 'inherit' }
  );
  if (build.status !== 0) throw new Error(`production build failed: ${build.status}`);
  for (const artifact of ['entryInfoview.js', 'entryInfoview.css']) {
    if (!existsSync(resolve(bundle, artifact))) throw new Error(`fresh production artifact missing: ${artifact}`);
  }

  const mime = { '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture');
    if (url.pathname === '/') {
      const html = htmlFor(url.searchParams.get('fixture'));
      if (!html) { response.writeHead(400); response.end(); return; }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
      return;
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const file = resolve(bundle, url.pathname.slice(1));
    if (!file.startsWith(`${bundle}/`) || !existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    response.end(readFileSync(file));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));

  const chromePath = [
    process.env.SNL_CHROMIUM_PATH,
    resolve(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'),
    resolve(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1187/chrome-linux/chrome'),
    '/usr/bin/chromium',
    '/usr/bin/google-chrome'
  ].find((candidate) => candidate && existsSync(candidate));
  if (!chromePath) throw new Error('Chromium missing');
  chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserWs = '';
  let chromeStderr = '';
  chrome.stderr.setEncoding('utf8');
  chrome.stderr.on('data', (chunk) => {
    chromeStderr += chunk;
    browserWs ||= chunk.match(/DevTools listening on (ws:\/\/\S+)/)?.[1] ?? '';
  });
  for (let index = 0; index < 160 && !browserWs; index++) await delay(25);
  if (!browserWs) throw new Error(`Chromium CDP unavailable: ${chromeStderr}`);
  browserSocket = await connect(browserWs);
  const browser = new Cdp(browserSocket);
  const widths = [480, 360, 320, 240];
  const evidence = [];

  for (const width of widths) {
    for (const mode of ['plain', 'snl', 'markdown', 'formula']) {
      const opened = await openPage(browser, browserWs, mode, width, server.address().port);
      try {
        const { evaluate } = opened;
        if (mode === 'plain') {
          await waitFor(evaluate, `document.querySelector('[data-entry-body] > pre')?.textContent?.startsWith('PLAIN_SENTINEL_')`, 'plain direct pre');
          const measured = await evaluate(`(()=>{const b=document.querySelector('[data-entry-body]'),p=b.querySelector(':scope > pre'),r=p.getBoundingClientRect();return{body:[b.clientWidth,b.scrollWidth],pre:[p.clientWidth,p.scrollWidth,getComputedStyle(p).whiteSpace,getComputedStyle(p).overflowWrap,r.left,r.right],root:[document.documentElement.clientWidth,document.documentElement.scrollWidth]}})()`);
          assert(measured.body[0] === measured.body[1] && measured.root[0] === measured.root[1] && measured.pre[2] === 'pre-wrap' && measured.pre[3] === 'anywhere', `PLAIN:${width}`, measured);
          evidence.push({ width, mode, measured });
        } else if (mode === 'snl') {
          await waitFor(evaluate, `document.querySelector('[data-entry-body] .snl-text')?.textContent?.startsWith('snltextsentinel')`, 'SNL text leaf');
          const measured = await evaluate(`(()=>{const b=document.querySelector('[data-entry-body]'),t=b.querySelector('.snl-text');return{body:[b.clientWidth,b.scrollWidth],text:[t.clientWidth,t.scrollWidth,getComputedStyle(t).overflowWrap,getComputedStyle(t).wordBreak],root:[document.documentElement.clientWidth,document.documentElement.scrollWidth]}})()`);
          assert(measured.body[0] === measured.body[1] && measured.root[0] === measured.root[1] && measured.text[2] === 'anywhere' && measured.text[3] === 'break-word', `SNL-TEXT:${width}`, measured);
          evidence.push({ width, mode, measured });
        } else if (mode === 'markdown') {
          await waitFor(evaluate, `document.querySelector('.snl-markdown-body p')?.textContent?.startsWith('MARKDOWN_PROSE_SENTINEL_') && document.querySelector('.snl-markdown-body pre code')?.textContent?.startsWith('MARKDOWN_CODE_SENTINEL_')`, 'Markdown prose and fenced code');
          const measured = await evaluate(`(()=>{const b=document.querySelector('[data-entry-body]'),p=b.querySelector('.snl-markdown-body p'),pre=b.querySelector('.snl-markdown-body pre');return{body:[b.clientWidth,b.scrollWidth],prose:[p.clientWidth,p.scrollWidth,getComputedStyle(p).overflowWrap,getComputedStyle(p).wordBreak],code:[pre.clientWidth,pre.scrollWidth,getComputedStyle(pre).overflowX,getComputedStyle(pre).whiteSpace],root:[document.documentElement.clientWidth,document.documentElement.scrollWidth]}})()`);
          assert(measured.body[0] === measured.body[1] && measured.root[0] === measured.root[1] && measured.prose[1] <= measured.prose[0] && measured.code[1] > measured.code[0] && ['auto', 'scroll'].includes(measured.code[2]) && measured.code[3] !== 'pre-wrap', `MARKDOWN:${width}`, measured);
          evidence.push({ width, mode, measured });
        } else {
          await waitFor(evaluate, `document.querySelector('.snl-latex-body .katex')?.textContent?.includes('FORMULA')`, 'KaTeX formula host');
          const measured = await evaluate(`(()=>{const b=document.querySelector('[data-entry-body]'),h=b.querySelector('.snl-latex-body'),k=h.querySelector('.katex');return{body:[b.clientWidth,b.scrollWidth,getComputedStyle(b).overflowX],host:[h.clientWidth,h.scrollWidth,getComputedStyle(h).overflowX],katex:[k.clientWidth,k.scrollWidth,getComputedStyle(k).whiteSpace],root:[document.documentElement.clientWidth,document.documentElement.scrollWidth]}})()`);
          assert(measured.body[1] === measured.body[0] && measured.host[1] > measured.host[0] && ['auto', 'scroll'].includes(measured.host[2]) && measured.katex[2] !== 'pre-wrap' && measured.root[0] === measured.root[1], `FORMULA:${width}`, measured);
          evidence.push({ width, mode, measured });
        }
      } finally {
        await closePage(browser, opened);
      }
    }
  }

  for (const width of [320, 240]) {
    const opened = await openPage(browser, browserWs, 'mixed', width, server.address().port);
    try {
      const { evaluate } = opened;
      await waitFor(
        evaluate,
        `document.querySelector('[data-entry-body] .snl-text .katex')?.textContent?.includes('MIXEDFORMULA') && document.querySelector('[data-entry-body] .snl-text')?.textContent?.startsWith('MIXEDPROSESENTINEL')`,
        'mixed SNL prose and inline KaTeX island'
      );
      const measured = await evaluate(`(()=>{const b=document.querySelector('[data-entry-body]'),t=b.querySelector('.snl-text'),k=t.querySelector('.katex'),m=k.closest('.snl-math-span'),base=k.querySelector('.base'),kr=k.getBoundingClientRect(),br=base.getBoundingClientRect(),walker=document.createTreeWalker(t,NodeFilter.SHOW_TEXT);let prose=null;while(walker.nextNode()){if(walker.currentNode.data.startsWith('MIXEDPROSESENTINEL')){prose=walker.currentNode;break}}const range=document.createRange();range.selectNodeContents(prose);const proseRects=[...range.getClientRects()];const ks=getComputedStyle(k),ts=getComputedStyle(t);return{body:[b.clientWidth,b.scrollWidth,getComputedStyle(b).overflowX],text:[t.clientWidth,t.scrollWidth,ts.overflowWrap,ts.wordBreak],katex:[k.clientWidth,k.scrollWidth,ks.overflowWrap,ks.wordBreak,kr.width,kr.height],math:[m?.clientWidth,m?.scrollWidth,m?getComputedStyle(m).overflowX:null,m?.className],base:[br.width,br.height,base.getClientRects().length],proseLines:proseRects.length,proseSpan:proseRects.length?proseRects.at(-1).bottom-proseRects[0].top:0,root:[document.documentElement.clientWidth,document.documentElement.scrollWidth]}})()`);
      assert(
        measured.text[2] === 'anywhere' && measured.text[3] === 'break-word' &&
        measured.katex[2] === 'normal' && measured.katex[3] === 'normal' &&
        measured.katex[4] > measured.body[0] && measured.katex[5] < 40 &&
        measured.base[0] > measured.body[0] && measured.base[1] < 40 && measured.base[2] === 1 &&
        measured.proseLines > 1 && measured.proseSpan > 40 &&
        measured.body[1] === measured.body[0] && measured.math[2] === 'visible' &&
        measured.root[0] === measured.root[1],
        `MIXED:${width}`,
        measured
      );
      evidence.push({ width, mode: 'mixed', measured });
    } finally {
      await closePage(browser, opened);
    }
  }

  for (const width of [320, 480, 1000]) {
    const opened = await openPage(browser, browserWs, 'roottext', width, server.address().port);
    try {
      const { evaluate } = opened;
      await waitFor(
        evaluate,
        `document.querySelector('[data-entry-body] .katex-html.snl-text')?.textContent?.includes('RootCM') && document.querySelector('[data-entry-body] .katex-html.snl-text .snl-math-span .katex')`,
        'canonical root Text host and inline KaTeX reference'
      );
      const measured = await evaluate(`(()=>{const entry=document.querySelector('[data-entry-id]'),title=entry.querySelector('.snl-entry-title > span'),b=document.querySelector('[data-entry-body]'),h=b.querySelector('.katex-html.snl-text'),m=h.querySelector('.snl-math-span'),k=m.querySelector('.katex'),textEl=k.querySelector('.mord.text')??k.querySelector('.mord'),walker=document.createTreeWalker(h,NodeFilter.SHOW_TEXT);let literal=null;while(walker.nextNode()){if(walker.currentNode.parentElement?.closest('.katex')===k)continue;if(walker.currentNode.data.includes('RootCM')){literal=walker.currentNode;break}}const start=literal.data.indexOf('RootCM'),range=document.createRange();range.setStart(literal,start);range.setEnd(literal,start+6);const lr=range.getBoundingClientRect(),tr=textEl.getBoundingClientRect(),hs=getComputedStyle(h),ts=getComputedStyle(title),ms=getComputedStyle(m),bs=getComputedStyle(b),mr=m.getBoundingClientRect();return{hostClass:h.className,family:hs.fontFamily,titleFamily:ts.fontFamily,titleWeight:ts.fontWeight,fontSize:parseFloat(hs.fontSize),baseSize:parseFloat(bs.fontSize),lineHeight:hs.lineHeight,literal:[lr.left,lr.top,lr.right,lr.bottom,lr.width,lr.height],reference:[tr.left,tr.top,tr.right,tr.bottom,tr.width,tr.height],math:[m.clientWidth,m.scrollWidth,ms.display,ms.overflowX,mr.width,mr.height],mathFont:parseFloat(getComputedStyle(k).fontSize),body:[b.clientWidth,b.scrollWidth],root:[document.documentElement.clientWidth,document.documentElement.scrollWidth]}})()`);
      assert(
        measured.hostClass.split(/\s+/).includes('snl-text') &&
        measured.family.includes('KaTeX_Main') && measured.titleFamily.includes('KaTeX_Main') &&
        Math.abs(measured.fontSize / measured.baseSize - 1.21) < 0.015 &&
        Math.abs(measured.fontSize - measured.mathFont) < 0.1 &&
        Math.abs(measured.literal[4] - measured.reference[4]) < 0.75 &&
        Math.abs(measured.literal[3] - measured.reference[3]) < 3 &&
        measured.math[2] === 'inline' && measured.math[3] === 'visible' && measured.math[5] < 40 &&
        measured.body[0] === measured.body[1] && measured.root[0] === measured.root[1],
        `ROOT-TEXT-CM:${width}`,
        measured
      );
      evidence.push({ width, mode: 'roottext', measured });
    } finally {
      await closePage(browser, opened);
    }
  }

  const viewportScenarios = [
    { width: 320, height: 700 },
    { width: 480, height: 700 },
    { width: 1000, height: 700 },
    // Put a compact root origin near the bottom edge. An above-side frame must
    // stay attached to that origin rather than being pinned to the viewport top.
    { width: 480, height: 260, rootPaddingTop: 40 }
  ];
  const closeEnough = (left, right, tolerance = 0.75) =>
    left.length === right.length && left.every((value, index) => Math.abs(value - right[index]) <= tolerance);
  const samePlacement = (before, after) =>
    before.id === after.id && before.subject === after.subject &&
    before.parentId === after.parentId && before.originPath === after.originPath &&
    before.bounds === after.bounds && closeEnough(before.anchor, after.anchor) &&
    closeEnough(before.originRect, after.originRect) && closeEnough(before.rect, after.rect) &&
    before.side === after.side && Math.abs(before.bodyOverlap - after.bodyOverlap) <= 0.75;

  let edgePlacement = null;
  for (const { width, height, rootPaddingTop = 0 } of viewportScenarios) {
    const opened = await openPage(browser, browserWs, 'hover', width, server.address().port, height);
    try {
      const { page, evaluate } = opened;
      if (rootPaddingTop > 0) {
        await evaluate(`(()=>{document.querySelector('#root').style.paddingTop=${JSON.stringify(`${rootPaddingTop}px`)};return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`);
      }
      const pointFor = (selector, label) => waitFor(
        evaluate,
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`,
        label
      );
      const moveTo = async (selector, label) => {
        const point = await pointFor(selector, label);
        await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
        return point;
      };
      const nativeClick = async (point) => {
        await page.call('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1
        });
        await page.call('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1
        });
      };
      const nativePointerDown = async (point) => {
        await page.call('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1
        });
        await page.call('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1
        });
      };
      const dispatchKey = async (key, code, windowsVirtualKeyCode) => {
        await page.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode });
        await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
        // Chromium animates keyboard scrolling; sample only after its bounded settle.
        await delay(400);
      };
      const snapshot = (subject, originSelector) => evaluate(`(()=>{const marker=[...document.querySelectorAll('[data-snl-popover-id]')].find(e=>e.dataset.snlPopoverSubject===${JSON.stringify(subject)}&&e.dataset.snlPopoverPhase!=='closing');if(!marker)return null;const shell=marker.closest('.snl-entry-hover-popover'),origin=document.querySelector(${JSON.stringify(originSelector)}),r=shell.getBoundingClientRect(),a=origin.getBoundingClientRect(),b=document.querySelector('[data-entry-body]').getBoundingClientRect(),intersection=Math.max(0,Math.min(r.right,b.right)-Math.max(r.left,b.left))*Math.max(0,Math.min(r.bottom,b.bottom)-Math.max(r.top,b.top)),horizontal=r.left>=a.right-0.5?'right':r.right<=a.left+0.5?'left':'overlap-x',vertical=r.top>=a.bottom-0.5?'below':r.bottom<=a.top+0.5?'above':'overlap-y',anchorGap=vertical==='above'?a.top-r.bottom:vertical==='below'?r.top-a.bottom:-1,originHit=origin.contains(document.elementFromPoint(a.left+a.width/2,a.top+a.height/2)),parsed=marker.dataset.snlPopoverOriginRect.split(',').map(Number),requests=window.__posted.filter(m=>m?.type==='requestEntryDetails'&&m.entryId===${JSON.stringify(subject)}).length;return{id:marker.dataset.snlPopoverId,subject:marker.dataset.snlPopoverSubject,parentId:marker.dataset.snlPopoverParentId,originPath:marker.dataset.snlPopoverOriginPath,bounds:marker.dataset.snlPopoverOriginBounds,originRect:parsed,anchor:[a.left,a.top,a.right,a.bottom],rect:[r.left,r.top,r.right,r.bottom],side:horizontal+'/'+vertical,anchorGap,originHit,bodyOverlap:intersection,frozen:marker.dataset.snlPopoverFrozen==='true',phase:marker.dataset.snlPopoverPhase,visible:getComputedStyle(shell).display!=='none'&&getComputedStyle(shell).pointerEvents==='auto',paint:[getComputedStyle(shell).display,getComputedStyle(shell).visibility,getComputedStyle(shell).opacity,getComputedStyle(shell).pointerEvents],viewport:[innerWidth,innerHeight],contained:r.left>=-0.5&&r.top>=-0.5&&r.right<=innerWidth+0.5&&r.bottom<=innerHeight+0.5,shellCount:[...document.querySelectorAll('.snl-entry-hover-popover')].filter(e=>getComputedStyle(e).display!=='none').length,markerCount:[...document.querySelectorAll('[data-snl-popover-id]')].filter(e=>e.dataset.snlPopoverPhase!=='closing').length,requests}})()`);
      const sampleStable = async (subject, originSelector, frozen, label) => {
        const startedAt = Date.now();
        const samples = [];
        for (let frame = 0; frame < 6; frame++) {
          await evaluate('new Promise(requestAnimationFrame)');
          samples.push(await snapshot(subject, originSelector));
        }
        await delay(300);
        for (let frame = 0; frame < 6; frame++) {
          await evaluate('new Promise(requestAnimationFrame)');
          samples.push(await snapshot(subject, originSelector));
        }
        assert(
          samples.length === 12 && Date.now() - startedAt >= 250 &&
          samples.every((sample) => sample && sample.visible && sample.frozen === frozen && samePlacement(samples[0], sample)),
          label,
          { elapsedMs: Date.now() - startedAt, samples }
        );
        return samples.at(-1);
      };
      const activeBranches = () => evaluate(`(()=>[...document.querySelectorAll('[data-snl-popover-id]')].filter(e=>e.dataset.snlPopoverPhase!=='closing').map(e=>({id:e.dataset.snlPopoverId,subject:e.dataset.snlPopoverSubject,parentId:e.dataset.snlPopoverParentId,frozen:e.dataset.snlPopoverFrozen,phase:e.dataset.snlPopoverPhase})))()`);
      const nativeEventCounts = (src) => evaluate(`(()=>Object.fromEntries(['pointerdown','pointerup','click'].map(type=>[type,window.__nativeEvents.filter(event=>event.type===type&&event.src===${JSON.stringify(src)}).length])))()`);

      const rootSelector = '[data-entry-body] [data-src="child"]';
      const rootPoint = await moveTo(rootSelector, `root hover origin ${width}x${height}`);
      await waitFor(evaluate, `[...document.querySelectorAll('[data-snl-popover-id]')].some(e=>e.dataset.snlPopoverSubject==='child'&&e.dataset.snlPopoverPhase==='visible') && document.querySelector('.snl-entry-hover-popover [data-src="grandchild"]') && [...document.querySelectorAll('.snl-entry-hover-popover')].every(e=>{const style=getComputedStyle(e),rect=e.getBoundingClientRect();return style.display!=='none'&&style.visibility==='visible'&&style.opacity==='1'&&style.pointerEvents==='auto'&&rect.width>0&&rect.height>0})`, 'loaded visible root hover preview');
      const hoverRoot = await sampleStable('child', rootSelector, false, `ORIGIN-HOVER-STABLE-ROOT:${width}x${height}`);
      assert(
        hoverRoot.bounds === 'viewport' && hoverRoot.contained && hoverRoot.originHit &&
        hoverRoot.anchorGap >= 7.5 && hoverRoot.anchorGap <= 20,
        `VIEWPORT-ROOT:${width}x${height}`,
        hoverRoot
      );
      await nativeClick(rootPoint);
      await waitFor(evaluate, `[...document.querySelectorAll('[data-snl-popover-id]')].some(e=>e.dataset.snlPopoverSubject==='child'&&e.dataset.snlPopoverFrozen==='true')`, 'root hover-to-click pin');
      const pinnedRoot = await sampleStable('child', rootSelector, true, `ORIGIN-PIN-STABLE-ROOT:${width}x${height}`);
      assert(samePlacement(hoverRoot, pinnedRoot) && pinnedRoot.shellCount === 1 && pinnedRoot.markerCount === 1, `ORIGIN-PIN-ROOT:${width}x${height}`, { hoverRoot, pinnedRoot });

      const rootEventsBefore = await nativeEventCounts('child');
      await nativeClick(rootPoint);
      const repeatedRoot = await sampleStable('child', rootSelector, true, `ORIGIN-REPEAT-STABLE-ROOT:${width}x${height}`);
      const rootEventsAfter = await nativeEventCounts('child');
      assert(samePlacement(pinnedRoot, repeatedRoot) && repeatedRoot.id === pinnedRoot.id && repeatedRoot.markerCount === 1 && repeatedRoot.shellCount === 1 && repeatedRoot.requests === pinnedRoot.requests && repeatedRoot.requests === 1 && ['pointerdown','pointerup','click'].every(type=>rootEventsAfter[type]===rootEventsBefore[type]+1), `ORIGIN-REPEAT-ROOT:${width}x${height}`, { pinnedRoot, repeatedRoot, rootEventsBefore, rootEventsAfter, branches: await activeBranches() });

      const nestedSelector = '.snl-entry-hover-popover [data-src="grandchild"]';
      const nestedPoint = await moveTo(nestedSelector, `nested hover origin ${width}x${height}`);
      await waitFor(evaluate, `[...document.querySelectorAll('[data-snl-popover-id]')].some(e=>e.dataset.snlPopoverSubject==='grandchild'&&e.dataset.snlPopoverPhase==='visible') && [...document.querySelectorAll('.snl-entry-hover-popover')].some(e=>e.textContent.includes('GRANDCHILDSENTINEL')) && [...document.querySelectorAll('.snl-entry-hover-popover')].every(e=>{const style=getComputedStyle(e),rect=e.getBoundingClientRect();return style.display!=='none'&&style.visibility==='visible'&&style.opacity==='1'&&style.pointerEvents==='auto'&&rect.width>0&&rect.height>0})`, 'loaded visible nested hover preview');
      const hoverNested = await sampleStable('grandchild', nestedSelector, false, `ORIGIN-HOVER-STABLE-NESTED:${width}x${height}`);
      assert(hoverNested.bounds === 'viewport' && hoverNested.parentId === pinnedRoot.id, `ORIGIN-HOVER-NESTED:${width}x${height}`, hoverNested);
      const viewport = await evaluate(`(()=>{const marker=[...document.querySelectorAll('[data-snl-popover-id]')].find(e=>e.dataset.snlPopoverSubject==='grandchild'),shell=marker.closest('.snl-entry-hover-popover'),rect=shell.getBoundingClientRect(),style=getComputedStyle(shell),code=shell.querySelector('.snl-markdown-body pre');return{rect:[rect.left,rect.top,rect.right,rect.bottom],clientHeight:shell.clientHeight,scrollHeight:shell.scrollHeight,overflowX:style.overflowX,overflowY:style.overflowY,maxHeight:style.maxHeight,boxSizing:style.boxSizing,code:code?[code.clientWidth,code.scrollWidth,getComputedStyle(code).overflowX]:null}})()`);
      assert(
        viewport.rect[0] >= 7.5 && viewport.rect[1] >= 7.5 &&
        viewport.rect[2] <= width - 7.5 && viewport.rect[3] <= height - 7.5 &&
        viewport.boxSizing === 'border-box' && ['auto', 'scroll'].includes(viewport.overflowX) &&
        ['auto', 'scroll'].includes(viewport.overflowY) &&
        viewport.code && viewport.code[1] > viewport.code[0] && ['auto', 'scroll'].includes(viewport.code[2]),
        `VIEWPORT-NESTED:${width}x${height}`,
        viewport
      );

      await nativeClick(nestedPoint);
      await waitFor(evaluate, `[...document.querySelectorAll('[data-snl-popover-id]')].some(e=>e.dataset.snlPopoverSubject==='grandchild'&&e.dataset.snlPopoverFrozen==='true')`, 'nested hover-to-click pin');
      const pinnedNested = await sampleStable('grandchild', nestedSelector, true, `ORIGIN-PIN-STABLE-NESTED:${width}x${height}`);
      assert(samePlacement(hoverNested, pinnedNested) && pinnedNested.shellCount === 2 && pinnedNested.markerCount === 2, `ORIGIN-PIN-NESTED:${width}x${height}`, { hoverNested, pinnedNested });

      const nestedEventsBefore = await nativeEventCounts('grandchild');
      await nativeClick(nestedPoint);
      const repeatedNested = await sampleStable('grandchild', nestedSelector, true, `ORIGIN-REPEAT-STABLE-NESTED:${width}x${height}`);
      const nestedEventsAfter = await nativeEventCounts('grandchild');
      assert(samePlacement(pinnedNested, repeatedNested) && repeatedNested.id === pinnedNested.id && repeatedNested.markerCount === 2 && repeatedNested.shellCount === 2 && repeatedNested.requests === pinnedNested.requests && repeatedNested.requests === 1 && ['pointerdown','pointerup','click'].every(type=>nestedEventsAfter[type]===nestedEventsBefore[type]+1), `ORIGIN-REPEAT-NESTED:${width}x${height}`, { pinnedNested, repeatedNested, nestedEventsBefore, nestedEventsAfter, branches: await activeBranches() });

      if (height === 260) {
        assert(viewport.scrollHeight > viewport.clientHeight, `SCROLL-RANGE:${width}x${height}`, viewport);
        const wheelPoint = await pointFor('.snl-entry-hover-popover:last-of-type', 'nested popover wheel target');
        const beforeWheel = await evaluate(`(()=>{const marker=[...document.querySelectorAll('[data-snl-popover-id]')].find(e=>e.dataset.snlPopoverSubject==='grandchild'),shell=marker.closest('.snl-entry-hover-popover');return shell.scrollTop})()`);
        await page.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wheelPoint.x, y: wheelPoint.y, deltaX: 0, deltaY: 96 });
        await delay(100);
        const afterWheel = await evaluate(`(()=>{const marker=[...document.querySelectorAll('[data-snl-popover-id]')].find(e=>e.dataset.snlPopoverSubject==='grandchild'),shell=marker.closest('.snl-entry-hover-popover');return shell.scrollTop})()`);
        assert(afterWheel > beforeWheel, `SCROLL-WHEEL:${width}x${height}`, { beforeWheel, afterWheel, viewport });

        const focused = await evaluate(`(()=>{const marker=[...document.querySelectorAll('[data-snl-popover-id]')].find(e=>e.dataset.snlPopoverSubject==='grandchild'),shell=marker.closest('.snl-entry-hover-popover'),surface=shell.querySelector('.snl-entry-overflow-surface');shell.focus({preventScroll:true});return{focused:document.activeElement===shell,frameTabIndex:shell.tabIndex,surfaceHasTabIndex:surface.hasAttribute('tabindex'),surfaceTabIndex:surface.tabIndex,scrollTop:shell.scrollTop}})()`);
        assert(focused.focused && focused.frameTabIndex === 0 && !focused.surfaceHasTabIndex && focused.surfaceTabIndex === -1, `SCROLL-FOCUS:${width}x${height}`, focused);
        await dispatchKey('Home', 'Home', 36);
        const afterHome = await evaluate(`(()=>{const marker=[...document.querySelectorAll('[data-snl-popover-id]')].find(e=>e.dataset.snlPopoverSubject==='grandchild'),shell=marker.closest('.snl-entry-hover-popover');return shell.scrollTop})()`);
        await dispatchKey('PageDown', 'PageDown', 34);
        const afterPageDown = await evaluate(`(()=>{const marker=[...document.querySelectorAll('[data-snl-popover-id]')].find(e=>e.dataset.snlPopoverSubject==='grandchild'),shell=marker.closest('.snl-entry-hover-popover');return shell.scrollTop})()`);
        await dispatchKey('End', 'End', 35);
        const reached = await evaluate(`(()=>{const marker=[...document.querySelectorAll('[data-snl-popover-id]')].find(e=>e.dataset.snlPopoverSubject==='grandchild'),shell=marker.closest('.snl-entry-hover-popover'),code=shell.querySelector('.snl-markdown-body pre'),tail=code.getBoundingClientRect(),frame=shell.getBoundingClientRect();return{scrollTop:shell.scrollTop,max:shell.scrollHeight-shell.clientHeight,tailVisible:tail.bottom<=frame.bottom+0.5&&tail.bottom>=frame.top-0.5}})()`);
        assert(afterHome < afterWheel && afterPageDown > afterHome, `SCROLL-PAGEDOWN:${width}x${height}`, { afterWheel, afterHome, afterPageDown });
        assert(reached.scrollTop > 0 && Math.abs(reached.scrollTop - reached.max) <= 1 && reached.tailVisible, `SCROLL-END-TAIL:${width}x${height}`, reached);
      }
      const nestedSiblingSelector = '.snl-entry-hover-popover [data-src="nested-sibling"]';
      const nestedSiblingPoint = await pointFor(nestedSiblingSelector, `nested sibling origin ${width}x${height}`);
      const nestedSiblingHit = await evaluate(`(()=>{const p=${JSON.stringify(nestedSiblingPoint)},hit=document.elementFromPoint(p.x,p.y),origin=document.querySelector(${JSON.stringify(nestedSiblingSelector)}),r=origin.getBoundingClientRect();return{origin:[r.left,r.top,r.right,r.bottom],hit:hit?.outerHTML?.slice(0,500),hitSubject:hit?.closest?.('[data-src]')?.getAttribute('data-src'),shell:hit?.closest?.('.snl-entry-hover-popover')?.textContent?.slice(0,120)}})()`);
      assert(nestedSiblingHit.hitSubject === 'nested-sibling', `ORIGIN-SIBLING-HIT-NESTED:${width}x${height}`, nestedSiblingHit);
      await nativeClick(nestedSiblingPoint);
      await waitFor(evaluate, `(()=>{const active=[...document.querySelectorAll('[data-snl-popover-id]')].filter(e=>e.dataset.snlPopoverPhase!=='closing');return active.length===2&&document.querySelectorAll('.snl-entry-hover-popover').length===2&&active.some(e=>e.dataset.snlPopoverSubject==='child'&&e.dataset.snlPopoverId===${JSON.stringify(pinnedRoot.id)})&&active.some(e=>e.dataset.snlPopoverSubject==='nested-sibling'&&e.dataset.snlPopoverParentId===${JSON.stringify(pinnedRoot.id)}&&e.dataset.snlPopoverFrozen==='true')&&!active.some(e=>e.dataset.snlPopoverSubject==='grandchild')&&[...document.querySelectorAll('.snl-entry-hover-popover')].some(e=>e.textContent.includes('Nested sibling body sentinel'))})()`, 'loaded nested sibling replaces child branch');
      const nestedSibling = await sampleStable('nested-sibling', nestedSiblingSelector, true, `ORIGIN-SIBLING-STABLE-NESTED:${width}x${height}`);
      assert(nestedSibling.parentId === pinnedRoot.id && nestedSibling.markerCount === 2 && nestedSibling.shellCount === 2, `ORIGIN-SIBLING-NESTED:${width}x${height}`, { nestedSibling, branches: await activeBranches() });

      const rootSiblingSelector = '[data-entry-body] [data-src="sibling"]';
      const rootSiblingPoint = await pointFor(rootSiblingSelector, `root sibling origin ${width}x${height}`);
      const rootSiblingHit = await evaluate(`(()=>{const p=${JSON.stringify(rootSiblingPoint)},hit=document.elementFromPoint(p.x,p.y);return{hit:hit?.outerHTML?.slice(0,500),hitSubject:hit?.closest?.('[data-src]')?.getAttribute('data-src')}})()`);
      assert(rootSiblingHit.hitSubject === 'sibling', `ORIGIN-SIBLING-HIT-ROOT:${width}x${height}`, rootSiblingHit);
      await nativeClick(rootSiblingPoint);
      await waitFor(evaluate, `(()=>{const active=[...document.querySelectorAll('[data-snl-popover-id]')].filter(e=>e.dataset.snlPopoverPhase!=='closing');return active.length===1&&document.querySelectorAll('.snl-entry-hover-popover').length===1&&active[0].dataset.snlPopoverSubject==='sibling'&&active[0].dataset.snlPopoverParentId===''&&active[0].dataset.snlPopoverFrozen==='true'&&document.querySelector('.snl-entry-hover-popover')?.textContent.includes('Sibling body sentinel')})()`, 'loaded root sibling replaces complete root branch');
      const rootSibling = await sampleStable('sibling', rootSiblingSelector, true, `ORIGIN-SIBLING-STABLE-ROOT:${width}x${height}`);
      assert(rootSibling.parentId === '' && rootSibling.markerCount === 1 && rootSibling.shellCount === 1, `ORIGIN-SIBLING-ROOT:${width}x${height}`, { rootSibling, branches: await activeBranches() });

      const outsidePoint = await pointFor('#outside-target', `outside target ${width}x${height}`);
      await nativePointerDown(outsidePoint);
      await waitFor(evaluate, `document.querySelectorAll('[data-snl-popover-id]').length===0 && document.querySelectorAll('.snl-entry-hover-popover').length===0`, 'outside pointerdown dismisses all roots');
      assert((await activeBranches()).length === 0, `ORIGIN-OUTSIDE-DISMISS:${width}x${height}`, await activeBranches());
      if (rootPaddingTop > 0) {
        const placementEvidence = (sample) => ({
          id: sample.id,
          anchor: sample.anchor,
          rect: sample.rect,
          side: sample.side,
          anchorGap: sample.anchorGap,
          originHit: sample.originHit,
          contained: sample.contained,
          frozen: sample.frozen
        });
        edgePlacement = {
          viewport: [width, height],
          hover: placementEvidence(hoverRoot),
          pinned: placementEvidence(pinnedRoot),
          nested: placementEvidence(pinnedNested)
        };
      }
      evidence.push({ width, height, mode: 'origin-native-closure', root: repeatedRoot, nested: repeatedNested, nestedSibling, rootSibling, viewport });
    } finally {
      await closePage(browser, opened);
    }
  }


  terminalResult = {
    kind: 'pass',
    widths,
    desktopHoverWidth: 1000,
    checks: evidence.length,
    edgePlacement,
    measurements: {
      mixed320: evidence.find((item) => item.mode === 'mixed' && item.width === 320)?.measured,
      roottext320: evidence.find((item) => item.mode === 'roottext' && item.width === 320)?.measured
    }
  };
} catch (error) {
  terminalResult = { kind: 'failure', detail: error instanceof Error ? error.message : String(error) };
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (error) {
    terminalResult = { kind: 'infra', stage: 'cleanup', detail: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  }
  console.log(`ENTRY_OVERFLOW_GEOMETRY_RESULT ${JSON.stringify(terminalResult)}`);
}
