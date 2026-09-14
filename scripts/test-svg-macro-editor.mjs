#!/usr/bin/env node
// Production CreateMacro bundle + real Linux publisher + official canonical CLI.
// This is a browser/host-seam gate, not an installed VS Code host certification.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = resolve(process.env.SNL_SVG_EVIDENCE ?? resolve(repo, '../browser-evidence'));
mkdirSync(evidence, { recursive: true });
const workspace = mkdtempSync(resolve(evidence, 'workspace-'));
const snl = process.env.SNL_CLI ?? 'snl';
const receipt = { workspace, cli: snl, operations: [], assertions: [], platform: process.platform };
function cli(args, input, expectOk = true) {
  const command = [...args, '--root', workspace, '--json', ...(input ? ['--input', '-'] : [])];
  const run = spawnSync(snl, command, { encoding: 'utf8', input: input ? JSON.stringify(input) : undefined });
  if (run.error) throw run.error;
  const response = JSON.parse(run.stdout);
  receipt.operations.push({ command, exit: run.status, response });
  writeFileSync(resolve(evidence, 'operations.json'), JSON.stringify(receipt.operations, null, 2) + '\n');
  if (expectOk) assert.equal(response.ok, true, run.stdout + run.stderr);
  return response;
}
cli(['init']);
cli(['validate']);
const packages = cli(['macro-package', 'list']).data.entities;
assert.ok(packages.length);
const packageId = packages.find(p => p.id !== '_unpackaged').id;
const initial = {
  package: packageId, name: 'Diagram.browser', kind: 'const', description: 'Keep description',
  source: { entries: [], urls: [] }, dynamic_arity: false, tags: ['keep-tag'],
  styles: [{ style_name: 'default', tags: ['style-tag'], template: {
    mode: 'block', block_template_name: 'svg_template', body: '#1 #0'
  } }]
};
let entity = cli(['macro', 'create'], initial).data.entity;
let id = entity.id;
let panelMode = 'edit';
let createPrefill;
const require = createRequire(import.meta.url);
const { writeWorkspaceSvgMacroAssets } = require(resolve(repo, 'out/svgMacroAssets.js'));
const RAW = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><path id="art" d="M10 10h20v10H10z" fill="#000000"/><circle cx="70" cy="30" r="8" fill="white"/></svg>';
const importPath = resolve(evidence, 'import.svg');
writeFileSync(importPath, RAW);
let rejectNextSave = false;
let holdNextSave = false;
let releaseSave;
let holdNextMacro = false;
let releaseMacro;
const posts = [];
function context() {
  return { type: 'context', mode: panelMode, file: packageId + '.json', packageName: packageId,
    existingNames: [entity.value.name], macroCandidates: [], macroKinds: [], entries: [],
    existing: panelMode === 'edit' ? entity.value : null, macroRevision: panelMode === 'edit' ? entity.revision : undefined, prefill: panelMode === 'create' ? { macro: createPrefill } : null };
}
async function message(m) {
  posts.push(m);
  if (m.type === 'ready') return context();
  if (m.type === 'svgMacro.writeAssets') {
    try {
      if (rejectNextSave) { rejectNextSave = false; throw new Error('Injected write failure'); }
      const result = await writeWorkspaceSvgMacroAssets({ ...m, workspaceRoot: { scheme: 'file', fsPath: workspace } });
      if (holdNextSave) { holdNextSave = false; await new Promise(resolveRelease => { releaseSave = resolveRelease; }); }
      return { type: 'svgMacro.assetsWritten', requestId: m.requestId, ...result };
    } catch (error) { return { type: 'svgMacro.assetsError', requestId: m.requestId, message: error.message }; }
  }
  if (m.type === 'snl.assets/read-svg') {
    assert.match(m.source, /^svg\/[A-Za-z0-9][A-Za-z0-9._-]*\.svg$/);
    const value = readFileSync(resolve(workspace, '.SNL_Doc/assets', m.source), 'utf8');
    assert.equal('sha256:' + createHash('sha256').update(value).digest('hex'), m.revision);
    return { type: 'snl.assets/svg-source', request_id: m.request_id, source: m.source,
      base_identity: m.base_identity, revision: m.revision, value };
  }
  if (m.type === 'create') {
    const result = cli(['macro', 'create'], { ...m.macro, package: packageId });
    entity = result.data.entity; id = entity.id; panelMode = 'edit';
    const replies = [{ type: 'created', name: entity.value.name, requestId: m.requestId }, { ...context(), savedRequestId: m.requestId }];
    if (holdNextMacro) { holdNextMacro = false; await new Promise(done => { releaseMacro = done; }); }
    return replies;
  }
  if (m.type === 'update') {
    const result = cli(['macro', 'update', id, '--if-match', m.expectedRevision], { ...m.macro, package: packageId }, false);
    if (!result.ok) return { type: 'error', message: 'CAS conflict' };
    entity = result.data.entity;
    const replies = [{ type: 'updated', name: entity.value.name, requestId: m.requestId }, { ...context(), savedRequestId: m.requestId }];
    if (holdNextMacro) { holdNextMacro = false; await new Promise(done => { releaseMacro = done; }); }
    return replies;
  }
  return null;
}
const html = `<!doctype html><html lang="en" data-snl-color-scheme="dark"><head><meta charset="utf-8"><style>body{margin:0;background:#1e1e1e;color:#ddd}</style><link rel="stylesheet" href="/createMacro.css"><script>
window.__posted=[];window.acquireVsCodeApi=()=>({getState:()=>JSON.parse(sessionStorage.getItem('draft')||'null'),setState:s=>sessionStorage.setItem('draft',JSON.stringify(s)),postMessage:m=>{window.__posted.push(m);fetch('/message',{method:'POST',body:JSON.stringify(m)}).then(r=>r.json()).then(data=>{for(const reply of (Array.isArray(data)?data:[data]))if(reply)window.dispatchEvent(new MessageEvent('message',{data:reply}));}).catch(e=>{window.__bridgeError=String(e);});}});
</script></head><body><div id="root"></div><script type="module" src="/createMacro.js"></script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/message') {
      let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 3 * 1024 * 1024) throw Error('request too large'); }
      const result = await message(JSON.parse(text)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return;
    }
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const relative = path.slice(1);
    if (!/^[A-Za-z0-9_.-]+$/.test(relative)) throw Error('invalid asset path');
    const file = resolve(repo, 'media/webview', relative);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
});
await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
const chromePath = [process.env.SNL_CHROMIUM_PATH,
  resolve(process.env.HOME, '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'), '/usr/bin/chromium'].find(p => p && existsSync(p));
assert.ok(chromePath, 'Set SNL_CHROMIUM_PATH');
const profile = mkdtempSync(resolve(evidence, 'chrome-'));
const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--no-zygote', '--renderer-process-limit=1',
  '--disable-dev-shm-usage', '--disable-gpu', '--remote-debugging-port=0', '--no-first-run',
  '--no-default-browser-check', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let endpoint = '', stderr = '';
chrome.stderr.on('data', chunk => { stderr += chunk; endpoint ||= String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1] ?? ''; });
const sockets = [];
class Cdp {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map(); this.events = [];
    socket.addEventListener('message', event => {
      const m = JSON.parse(event.data);
      if (!m.id) { this.events.push(m); return; }
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
    });
  }
  call(method, params = {}) { const id = ++this.next; return new Promise((resolveCall, reject) => {
    this.pending.set(id, { resolve: resolveCall, reject }); this.socket.send(JSON.stringify({ id, method, params }));
  }); }
}
async function connect(url) {
  const socket = new WebSocket(url); sockets.push(socket);
  await new Promise((ok, fail) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', fail, { once: true }); });
  return new Cdp(socket);
}
const delay = ms => new Promise(done => setTimeout(done, ms));
let page;
async function evaluate(expression) {
  const r = await page.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function wait(expression) {
  for (let i = 0; i < 200; i++) { if (await evaluate(`Boolean(${expression})`)) return; await delay(25); }
  throw Error('Timed out: ' + expression);
}
const button = name => `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(name)})`;
const field = label => `[...document.querySelectorAll('.snl-svg-editor-controls label')].find(l=>l.firstChild.textContent.trim()===${JSON.stringify(label)}).querySelector('input,textarea')`;
async function fill(label, value) {
  await evaluate(`(()=>{const e=${field(label)};Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function click(name) { await evaluate(`${button(name)}.click()`); }
function assetSnapshot() {
  const path = resolve(workspace, '.SNL_Doc/assets/svg');
  return Object.fromEntries(readdirSync(path).map(name => [name, createHash('sha256').update(readFileSync(resolve(path, name))).digest('hex')]));
}
try {
  for (let i = 0; i < 160 && !endpoint; i++) { if (chrome.exitCode !== null) break; await delay(25); }
  assert.ok(endpoint, stderr);
  const browser = await connect(endpoint);
  const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
  const targets = await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`).then(r => r.json());
  page = await connect(targets.find(t => t.id === targetId).webSocketDebuggerUrl);
  await page.call('Runtime.enable'); await page.call('Page.enable');
  await page.call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await wait(`document.querySelector('.snl-svg-macro-editor')`);
  await fill('SVG source', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>');
  await click('Load SVG preview');
  await wait(`document.querySelector('[role=alert]')?.textContent.includes('invalid or unsafe')`);
  assert.equal(await evaluate(`document.querySelector('.snl-svg-macro-editor__preview').childElementCount`), 0);
  receipt.assertions.push('dangerous SVG rejected before preview');
  const { root } = await page.call('DOM.getDocument');
  const { nodeId } = await page.call('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await page.call('DOM.setFileInputFiles', { nodeId, files: [importPath] });
  await wait(`${field('SVG source')}.value.includes('id="art"')`);
  await click('Load SVG preview');
  await wait(`document.querySelector('#art')`);
  await evaluate(`document.querySelector('#art').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  await click('Replace selection with slot');
  await wait(`document.querySelector('[data-snl-slot="0"]')`);
  assert.ok(await evaluate(`document.querySelector('[data-snl-slot="0"]').getAttribute('transform').includes('20 15')`));
  await fill('Asset name', 'browser-diagram'); await fill('Accessibility label', 'Diagram title');
  await page.call('Page.reload'); await wait(`document.querySelector('[data-snl-slot="0"]')`);
  assert.equal(await evaluate(`${field('Accessibility label')}.value`), 'Diagram title');
  receipt.assertions.push('real file import, geometric slot replacement, reload draft retention');
  await click('Save SVG Macro Asset'); await wait(`document.querySelector('[role=status]')?.textContent.includes('Asset saved')`);
  const firstAssets = assetSnapshot(); assert.equal(Object.keys(firstAssets).length, 3);
  await click('Update Macro'); await wait(`window.__posted.some(m=>m.type==='update')`);
  for (let i = 0; i < 100 && !entity.value.styles[0].template.svg_template; i++) await delay(25);
  const saved = cli(['macro', 'get', id]).data.entity;
  assert.equal(saved.value.description, 'Keep description');
  assert.deepEqual(saved.value.tags, ['keep-tag']); assert.deepEqual(saved.value.styles[0].tags, ['style-tag']);
  assert.equal(saved.value.styles[0].template.body, '#1 #0');
  assert.equal(saved.value.styles[0].template.svg_template.accessibility.label, 'Diagram title');
  assert.ok(!JSON.stringify(saved.value).includes('svg_editor_drafts'));
  receipt.assertions.push('actual immutable assets and official canonical CAS readback preserve body order, tags and title');
  // SVG-R1: hold the Macro receipt AND its following canonical context, not assetsWritten.
  await page.call('Page.reload');
  await wait(`document.querySelector('.snl-svg-macro-editor')`);
  await wait(`${field('Accessibility label')}.value==='Diagram title'`);
  holdNextMacro = true;
  await click('Update Macro');
  for (let i = 0; i < 100 && !releaseMacro; i++) await delay(25);
  assert.ok(releaseMacro, 'Macro success/context held');
  const newerSource = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g data-snl-slot="1"/><path id="new-art" d="M0 0h5v5z"/></svg>';
  await fill('SVG source', newerSource); await click('Load SVG preview');
  await fill('Accessibility label', 'After Macro submit');
  await fill('Slot index', '3');
  await wait(`sessionStorage.getItem('draft').includes('After Macro submit')`);
  receipt.macroRaceBefore = await evaluate(`JSON.parse(sessionStorage.getItem('draft'))`);
  releaseMacro(); releaseMacro = undefined;
  await wait(`${button('Update Macro')} && !${button('Update Macro')}.textContent.includes('…')`);
  await delay(100);
  receipt.macroRaceAfter = await evaluate(`JSON.parse(sessionStorage.getItem('draft'))`);
  assert.equal(await evaluate(`${field('SVG source')}.value`), newerSource, 'SVG-R1 source after Macro updated/context');
  assert.equal(await evaluate(`${field('Accessibility label')}.value`), 'After Macro submit');
  assert.ok(JSON.stringify(receipt.macroRaceAfter).includes('"saved":false'));
  await page.call('Page.reload');
  await wait(`document.querySelector('.snl-svg-macro-editor')`);
  await wait(`${field('Accessibility label')}.value==='After Macro submit'`);
  assert.equal(await evaluate(`${field('SVG source')}.value`), newerSource);
  assert.equal(await evaluate(`${field('Slot index')}.value`), '3');
  assert.ok(await evaluate(`document.querySelector('#new-art') && document.querySelector('[data-snl-slot="1"]')`));
  receipt.assertions.push('SVG-R1 Macro updated/context preserves post-submit source, label, slot, preview, saved:false and reload');
  // Resume the pre-existing asset failure/stale-success controls from canonical.
  await evaluate(`sessionStorage.removeItem('draft')`); await page.call('Page.reload');
  await wait(`document.querySelector('.snl-svg-macro-editor')`);
  await wait(`${field('Accessibility label')}.value==='Diagram title'`);
  const snapshot = JSON.stringify(cli(['macro', 'get', id]).data.entity);
  rejectNextSave = true;
  await fill('Accessibility label', 'Unsaved title'); await click('Save SVG Macro Asset');
  await wait(`document.querySelector('[role=alert]')?.textContent.includes('Could not save')`);
  assert.deepEqual(assetSnapshot(), firstAssets);
  assert.equal(JSON.stringify(cli(['macro', 'get', id]).data.entity), snapshot);
  receipt.assertions.push('save failure preserves prior assets and canonical authoring');
  holdNextSave = true;
  await click('Save SVG Macro Asset');
  for (let i = 0; i < 100 && !releaseSave; i++) await delay(25);
  assert.ok(releaseSave);
  await fill('Accessibility label', 'Newest draft title'); releaseSave();
  await wait(`document.querySelector('[role=alert]')?.textContent.includes('changed while')`);
  assert.equal(await evaluate(`${field('Accessibility label')}.value`), 'Newest draft title');
  receipt.assertions.push('late success cannot overwrite changed draft');
  const invalid = cli(['macro', 'update', id, '--if-match', saved.revision], { ...saved.value, description: 'External change' }).data.entity;
  const stale = cli(['macro', 'update', id, '--if-match', saved.revision], saved.value, false);
  assert.equal(stale.ok, false); assert.equal(cli(['macro', 'get', id]).data.entity.revision, invalid.revision);
  receipt.assertions.push('canonical stale CAS rejected without overwrite');
  // The same race must survive the create -> edit identity migration.
  panelMode = 'create'; createPrefill = { ...saved.value, name: '' };
  await evaluate(`sessionStorage.removeItem('draft')`); await page.call('Page.reload');
  await wait(`document.querySelector('.snl-svg-macro-editor')`);
  await wait(`${field('Accessibility label')}.value==='Diagram title'`);
  await evaluate(`(()=>{const e=document.getElementById('m-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Diagram.created');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  holdNextMacro = true; await click('Create Macro');
  for (let i = 0; i < 100 && !releaseMacro; i++) await delay(25);
  assert.ok(releaseMacro, 'create receipt/context held');
  await fill('SVG source', newerSource); await click('Load SVG preview');
  await fill('Accessibility label', 'After create submit'); await fill('Slot index', '4');
  await wait(`sessionStorage.getItem('draft').includes('After create submit')`);
  receipt.createRaceBefore = await evaluate(`JSON.parse(sessionStorage.getItem('draft'))`);
  releaseMacro(); releaseMacro = undefined;
  await wait(`document.getElementById('m-name').readOnly`);
  assert.equal(await evaluate(`${field('SVG source')}.value`), newerSource);
  assert.equal(await evaluate(`${field('Accessibility label')}.value`), 'After create submit');
  receipt.createRaceAfter = await evaluate(`JSON.parse(sessionStorage.getItem('draft'))`);
  assert.ok(!Object.keys(receipt.createRaceAfter).some(key => key.includes('macro:create:')));
  assert.ok(JSON.stringify(receipt.createRaceAfter).includes('"saved":false'));
  await page.call('Page.reload'); await wait(`document.querySelector('.snl-svg-macro-editor')`);
  await wait(`${field('Accessibility label')}.value==='After create submit'`);
  assert.equal(await evaluate(`${field('SVG source')}.value`), newerSource);
  assert.equal(await evaluate(`${field('Slot index')}.value`), '4');
  assert.equal(await evaluate(`document.getElementById('m-name').value`), 'Diagram.created');
  assert.ok(await evaluate(`document.querySelector('#new-art') && document.querySelector('[data-snl-slot="1"]')`));
  assert.equal(await evaluate(`${button('Update Macro')}.disabled`), true);
  receipt.assertions.push('SVG-R1 create -> edit preserves newer source/label/slot/preview/saved:false, migrates persisted key and reloads immutable created identity');
  cli(['validate']);
  const errors = page.events.filter(e => e.method === 'Runtime.exceptionThrown'); assert.deepEqual(errors, []);
  assert.equal(await evaluate('window.__bridgeError ?? null'), null);
  writeFileSync(resolve(evidence, 'editor.png'), Buffer.from((await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
  receipt.assets = assetSnapshot(); receipt.canonical = cli(['macro', 'get', id]).data.entity;
  receipt.bundleSha256 = createHash('sha256').update(readFileSync(resolve(repo, 'media/webview/createMacro.js'))).digest('hex');
  receipt.status = 'PASS';
  console.log(JSON.stringify({ status: receipt.status, assertions: receipt.assertions, workspace }, null, 2));
} catch (error) { receipt.status = 'FAIL'; receipt.error = String(error.stack ?? error); throw error; }
finally {
  for (const socket of sockets) socket.close();
  if (chrome.exitCode === null) { chrome.kill('SIGTERM'); await Promise.race([new Promise(done => chrome.once('exit', done)), delay(3000)]); }
  if (chrome.exitCode === null) { chrome.kill('SIGKILL'); await new Promise(done => chrome.once('exit', done)); }
  await new Promise(done => server.close(done));
  rmSync(profile, { recursive: true, force: true });
  receipt.processClosure = { chromeExit: chrome.exitCode, chromeSignal: chrome.signalCode, serverClosed: !server.listening };
  writeFileSync(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
}
