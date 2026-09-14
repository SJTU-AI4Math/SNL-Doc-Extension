#!/usr/bin/env node
// Production CreateMacro bundle + real Linux publisher + official canonical CLI.
// This is a browser/host-seam gate, not an installed VS Code host certification.
import { macroPanelHost } from './macro-panel-browser-host.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = process.env.SNL_CAS_RUNTIME ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = resolve(process.env.SNL_SVG_EVIDENCE ?? resolve(repo, '../cas-browser-evidence'));
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
let entity, id;
let readHold, terminal, holdTerminal = false, failRead = false, delivery = Promise.resolve(), inFlight;
const posts = [], hostPosts = [];
const host = macroPanelHost(repo, workspace, m => {
  hostPosts.push(m);
  if (holdTerminal && ['updated', 'created'].includes(m.type)) {
    holdTerminal = false; terminal = m; readHold = host.holdRead(failRead);
  } else deliver(m);
});
function deliver(m) {
  delivery = delivery.then(() => evaluate(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(m)}}))`));
}
async function message(m) {
  posts.push(m);
  if (m.type === 'snl.assets/read-svg') {
    const value = readFileSync(resolve(workspace, '.SNL_Doc/assets', m.source), 'utf8');
    assert.equal('sha256:' + createHash('sha256').update(value).digest('hex'), m.revision);
    return { ...m, type: 'snl.assets/svg-source', value };
  }
  inFlight = host.handle(m); await inFlight; return null;
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
try {
  for (let i = 0; i < 160 && !endpoint; i++) { if (chrome.exitCode !== null) break; await delay(25); }
  assert.ok(endpoint, stderr);
  const browser = await connect(endpoint);
  const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
  const targets = await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`).then(r => r.json());
  page = await connect(targets.find(t => t.id === targetId).webSocketDebuggerUrl);
  await page.call('Runtime.enable'); await page.call('Page.enable');
  receipt.artifacts = Object.fromEntries(['media/webview/createMacro.js', 'out/createMacroPanel.js', 'out/snlDoc.js'].map(p => [p, createHash('sha256').update(readFileSync(resolve(repo, p))).digest('hex')]));
  const scenarios = process.env.SNL_CAS_SCHEDULE ? [process.env.SNL_CAS_SCHEDULE] : ['external', 'watcher', 'read-failure'];
  for (const mode of ['edit', 'create']) for (const schedule of scenarios) {
    hostPosts.length = 0;
    const name = `Diagram.${mode}.${schedule}`;
    const before = { ...initial, name, description: 'R0 initial' };
    entity = mode === 'edit' ? cli(['macro', 'create'], before).data.entity : undefined;
    id = entity?.id;
    if (mode === 'create') cli(['macro', 'create'], { ...before, name: name + '.source' });
    host.configure(mode, packageId, mode === 'edit' ? name : '', mode === 'create' ? { copyFrom: name + '.source' } : null);
    await page.call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await wait(`document.querySelector('.snl-svg-macro-editor')`);
    if (mode === 'create') {
      await wait(`document.getElementById('m-name')`);
      await evaluate(`(()=>{const e=document.getElementById('m-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(name)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    }
    await wait(`document.querySelector('.snl-svg-macro-editor')`);
    const raw = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g data-snl-slot="1"/><path id="r1-art" d="M0 0h3v3z"/></svg>';
    await fill('SVG source', raw); await click('Load SVG preview');
    await fill('Asset name', `cas-${mode}-${schedule}`); await fill('Accessibility label', 'R1 asset');
    await click('Save SVG Macro Asset'); await wait(`document.querySelector('[role=status]')?.textContent.includes('Asset saved')`);
    const description = `[...document.querySelectorAll('textarea,input')].find(e=>e.placeholder==='Short human-readable description')`;
    const setDescription = async value => evaluate(`(()=>{const e=${description};Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await setDescription('R1 submitted');
    terminal = undefined; readHold = undefined; holdTerminal = true; failRead = schedule === 'read-failure';
    await click(mode === 'edit' ? 'Update Macro' : 'Create Macro');
    for (let i = 0; i < 200 && !terminal; i++) await delay(25);
    assert.ok(terminal, 'real Host terminal reached'); await readHold.entered;
    if (!id) id = cli(['macro', 'list']).data.entities.find(e => e.value.name === name)?.id;
    assert.ok(id, 'created identity');
    const r1 = cli(['macro', 'get', id]).data.entity;
    const r1Read = await host.doc.readMacroPackage(host.root, packageId);
    const r1Revision = host.doc.entityRevision(r1Read.macros.find(m => m.name === name));
    assert.equal(r1.value.description, 'R1 submitted');
    if (entity) assert.notEqual(entity.revision, r1.revision, 'R0 differs from R1');
    const newer = raw.replace('r1-art', 'new-art').replace('h3v3', 'h5v5');
    await fill('SVG source', newer); await click('Load SVG preview');
    await fill('Accessibility label', 'Retained newer asset'); await fill('Slot index', '3');
    await setDescription('Retained newer description');
    await wait(`sessionStorage.getItem('draft').includes('Retained newer description')`);
    deliver(terminal); await delivery;
    let r2;
    if (schedule === 'external') {
      r2 = cli(['macro', 'update', id, '--if-match', r1.revision], { ...r1.value, description: 'R2 external writer' }).data.entity;
      assert.notEqual(r1.revision, r2.revision);
    } else if (schedule === 'watcher') {
      host.watcher();
      for (let i = 0; i < 200 && !hostPosts.some(m => m.type === 'context' && !m.savedRequestId && m.existing?.description === 'R1 submitted'); i++) await delay(25);
      assert.ok(hostPosts.some(m => m.type === 'context' && !m.savedRequestId && m.existing?.description === 'R1 submitted'), 'real watcher overtook tagged context');
    }
    const pending = inFlight; readHold.release(); await pending; await delivery;
    const draft = await evaluate(`JSON.parse(sessionStorage.getItem('draft'))`);
    const witness = { mode, schedule, r0: entity?.revision ?? null, r1: r1.revision, r2: r2?.revision, terminal, draft };
    (receipt.scenarios ??= []).push(witness);
    // Full remount retains the draft; NEVER clear it or accept canonical author fields.
    await page.call('Page.reload'); await wait(`${field('Accessibility label')}.value==='Retained newer asset'`);
    assert.equal(await evaluate(`${field('SVG source')}.value`), newer);
    assert.equal(await evaluate(`${description}.value`), 'Retained newer description');
    await click('Save SVG Macro Asset'); await wait(`document.querySelector('[role=status]')?.textContent.includes('Asset saved')`);
    await wait(`!${button('Update Macro')}.disabled`);
    const count = posts.filter(m => m.type === 'update').length;
    await click('Update Macro');
    for (let i = 0; i < 200 && posts.filter(m => m.type === 'update').length === count; i++) await delay(25);
    const next = posts.filter(m => m.type === 'update').at(-1);
    await inFlight; await delivery;
    witness.next = next; witness.final = cli(['macro', 'get', id]).data.entity;
    if (schedule === 'external') {
      assert.equal(witness.final.revision, r2.revision, 'R1-CAS-1 next Webview save must conflict and preserve external R2');
      assert.ok(hostPosts.some(m => m.type === 'error' && m.message.includes('changed after')), 'visible Host CAS conflict');
    } else {
      assert.equal(witness.final.value.description, 'Retained newer description', 'next Webview save must succeed without an external writer');
      assert.notEqual(witness.final.revision, r1.revision);
    }
    assert.equal(next.expectedRevision, r1Revision, 'next save uses committed R1, not R0/R2');
    assert.equal(terminal.committedRevision, r1Revision);
    assert.equal(Object.values(draft).find(d => d.name === name)?.originalRevision, r1Revision);
    receipt.assertions.push(`${mode}/${schedule}: real Host writer → terminal → delayed read → remount → SVG asset save → next Macro CAS`);
  }
  cli(['validate']);
  assert.deepEqual(page.events.filter(e => e.method === 'Runtime.exceptionThrown'), []);
  assert.equal(await evaluate('window.__bridgeError ?? null'), null);
  receipt.status = 'PASS';
  console.log(JSON.stringify({ status: receipt.status, assertions: receipt.assertions }, null, 2));
} catch (error) { receipt.status = 'FAIL'; receipt.error = String(error.stack ?? error); throw error; }
finally {
  readHold?.release();
  await inFlight?.catch(() => {});
  await delivery.catch(() => {});
  host.close();
  for (const socket of sockets) socket.close();
  if (chrome.exitCode === null) { chrome.kill('SIGTERM'); await Promise.race([new Promise(done => chrome.once('exit', done)), delay(3000)]); }
  if (chrome.exitCode === null) { chrome.kill('SIGKILL'); await new Promise(done => chrome.once('exit', done)); }
  await new Promise(done => server.close(done));
  rmSync(profile, { recursive: true, force: true });
  receipt.processClosure = { chromeExit: chrome.exitCode, chromeSignal: chrome.signalCode, serverClosed: !server.listening };
  writeFileSync(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
}
