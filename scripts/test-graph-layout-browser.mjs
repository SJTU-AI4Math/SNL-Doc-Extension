#!/usr/bin/env node
// Exercise the actual classic-script graph bundle. The VS Code transport is a
// fixture here; a separate Extension Development Host probe covers host wiring.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = process.env.SNL_GRAPH_QA_OUTPUT || mkdtempSync(resolve(tmpdir(), 'snl-graph-qa-'));
mkdirSync(artifacts, { recursive: true });
if (!process.argv.includes('--no-build')) {
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'webview/vite.config.ts'], {
    cwd: root, env: { ...process.env, SNL_WEBVIEW_ENTRY: 'snlGraph', RAYON_NUM_THREADS: '2' }, stdio: 'inherit'
  });
  assert.equal(build.status, 0, 'production graph bundle must build');
}
const colors = { light: { stroke: '#325777', background: '#e9f2fc' }, dark: { stroke: '#83aed6', background: '#22384f' } };
const node = (id, title, packageId = 'Foundations') => ({ id, title, packageId, kind: 'Theorem', kindId: 'thm', coloring: colors });
const edge = (id, from, to, extra = {}) => ({ id, from, to, label: 'depends', isDependency: true, isAtomic: true, ...extra });
const fixture = {
  type: 'graph', scope: { mode: 'pool' }, title: 'Graph layout browser acceptance', warnings: [],
  nodes: [node('Goal', 'Main conjecture', 'Results'), node('Middle', 'Intermediate result', 'Results'),
    node('Base', 'Foundation'), node('Base2', 'Second foundation'), node('Base3', 'Third foundation'),
    node('Side', 'Auxiliary statement', 'Results'), node('CycleA', 'Cycle A', 'Cycles'), node('CycleB', 'Cycle B', 'Cycles')],
  edges: [edge('e1', 'Goal', 'Middle'), edge('e2', 'Middle', 'Base'), edge('e3', 'Middle', 'Base2'),
    edge('e4', 'Middle', 'Base3'), edge('e5', 'Side', 'Base'), edge('e6', 'CycleA', 'CycleB'),
    edge('e7', 'CycleB', 'CycleA'), edge('self', 'CycleA', 'CycleA')],
  entryOptions: [], macros: {}, macroKinds: []
};
const bundleDir = resolve(root, 'media/webview');
const html = `<!doctype html><html lang="en" data-snl-color-scheme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/snlGraph.css"><style>
:root { --vscode-editor-background:#181c22; --vscode-foreground:#dce5ef; --vscode-editorWidget-background:#222a35; --vscode-input-background:#2b3543; --vscode-input-foreground:#e2eaf3; --vscode-dropdown-background:#2b3543; --vscode-dropdown-foreground:#e2eaf3; --vscode-panel-border:#435064; --vscode-focusBorder:#8cbeef; }
body{margin:0;background:var(--vscode-editor-background);font-family:system-ui;}
:root[data-snl-color-scheme="light"]{--vscode-editor-background:#f7f9fc;--vscode-foreground:#243448;--vscode-editorWidget-background:#e9eef6;--vscode-input-background:white;--vscode-input-foreground:#243448;--vscode-dropdown-background:white;--vscode-dropdown-foreground:#243448;--vscode-panel-border:#8999aa;}
</style><script>window.__fixture=${JSON.stringify(fixture)};window.__posted=[];window.__stateWrites=[];
window.acquireVsCodeApi=()=>({postMessage(m){window.__posted.push(m);if(m.type==='ready'){setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data:window.__fixture})),0);}},getState(){},setState(m){window.__stateWrites.push(m);}});
</script></head><body><div id="root"></div><script src="/snlGraph.js"></script></body></html>`;
const server = createServer((req, res) => {
  const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  if (path === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return; }
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = resolve(bundleDir, path.slice(1));
  if (!file.startsWith(bundleDir + sep) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': ({ '.js':'text/javascript', '.css':'text/css', '.woff2':'font/woff2' })[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(Number(process.env.SNL_GRAPH_QA_PORT || 0), '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
console.log('GRAPH_QA_URL', url, 'ARTIFACTS', artifacts);
if (process.argv.includes('--serve')) {
  process.on('SIGTERM', () => server.close(() => process.exit()));
  await new Promise(() => {});
}
const chromePath = [process.env.SNL_CHROMIUM_PATH,
  resolve(process.env.HOME || '', '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'),
  '/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => p && existsSync(p));
assert.ok(chromePath, 'set SNL_CHROMIUM_PATH to a Chromium executable');
const profile = mkdtempSync(resolve(tmpdir(), 'snl-graph-chrome-'));
const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let log = ''; chrome.stderr.on('data', d => { log += d; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (!m.id) { this.events.push(m); return; }
      const p = this.pending.get(m.id); if (!p) return; clearTimeout(p.timer); this.pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); };
  }
  call(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { this.pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
    this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }));
  }); }
  close() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('closed')); } this.pending.clear(); this.ws.close(); }
}
async function connect(url) { const ws = new WebSocket(url); await new Promise((r,j) => { ws.onopen=r; ws.onerror=j; }); return new Cdp(ws); }
let browser, page;
const evidence = { url, mode: process.argv.includes('--filters') ? 'filters' : 'layouts',
  bundleSha256: createHash('sha256').update(readFileSync(resolve(bundleDir, 'snlGraph.js'))).digest('hex') };
try {
  let devtools;
  for (let i=0;i<200;i++) { devtools=log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]; if(devtools) break; await sleep(25); }
  assert.ok(devtools, log);
  browser=await connect(devtools);
  const { targetId }=await browser.call('Target.createTarget',{url:'about:blank'});
  const targets=await fetch(`http://127.0.0.1:${new URL(devtools).port}/json/list`).then(r=>r.json());
  page=await connect(targets.find(t=>t.id===targetId).webSocketDebuggerUrl);
  await page.call('Runtime.enable'); await page.call('Log.enable'); await page.call('Page.enable');
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await page.call('Page.navigate',{url});
  const evaluate=async expression=>{const r=await page.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const wait=async(expression)=>{for(let i=0;i<160;i++){if(await evaluate(expression))return;await sleep(25);}throw Error('Timed out: '+expression);};
  const screenshot=async name=>{const r=await page.call('Page.captureScreenshot',{format:'png'});writeFileSync(resolve(artifacts,name+'.png'),Buffer.from(r.data,'base64'));};
  await wait(`document.querySelectorAll('svg g[role="button"][data-package-id]').length===8`);
  await evaluate(`(()=>{window.__pointerTrace=[];for(const type of ['pointerover','pointerout'])document.addEventListener(type,e=>window.__pointerTrace.push({type,target:e.target.closest?.('[data-node-id]')?.dataset.nodeId||e.target.tagName,related:e.relatedTarget?.closest?.('[data-node-id]')?.dataset.nodeId||e.relatedTarget?.tagName}),true);})()`);
  // First new-behavior gate also serves as a RED control on the predecessor bundle.
  const controls=await evaluate(`[...document.querySelectorAll('select')].map(s=>({label:s.getAttribute('aria-label'),options:[...s.options].map(o=>({value:o.value,text:o.textContent}))}))`);
  evidence.controls=controls;
  assert.ok(controls.some(c=>c.options.some(o=>/outward|向外/i.test(o.text))), 'missing three-way layout selector');
  const selection=async(kind,pattern)=>{
    await evaluate(`(()=>{const s=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>new RegExp(${JSON.stringify(kind)},'i').test(o.textContent)));const o=[...s.options].find(o=>new RegExp(${JSON.stringify(pattern)},'i').test(o.textContent));if(!o)throw Error('option missing');s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await sleep(100);
  };
  const snapshot=()=>evaluate(`(()=>{const ns=[...document.querySelectorAll('svg g[role="button"][data-package-id]')];return ns.map(n=>{const r=n.querySelector(':scope > rect'),c=n.querySelector(':scope > circle');const t=n.transform.baseVal.consolidate().matrix;const b=n.getBBox();return {id:n.getAttribute('data-node-id')||n.getAttribute('aria-label'),shape:r?'title':c?'dot':'unknown',x:t.e+t.a*(r?+r.getAttribute('x')+(+r.getAttribute('width'))/2:+c.getAttribute('cx')),y:t.f+t.d*(r?+r.getAttribute('y')+(+r.getAttribute('height'))/2:+c.getAttribute('cy')),w:b.width,h:b.height};});})()`);
  const nodeSelector='svg g[role="button"][data-package-id]';
  const move=async(x,y)=>page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  const center=selector=>evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});const r=(n.querySelector(':scope > circle')||n.querySelector(':scope > rect')||n).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  if (process.argv.includes('--filters')) {
    const { verifyGraphFilters } = await import('./test-graph-filters-browser.mjs');
    await verifyGraphFilters({ evaluate, wait, screenshot, page, evidence, url });
  } else {
  for(const mode of ['Rectangle|矩形','Outward|向外','Inward|向内']){
    await selection('Outward|向外',mode);
    await move(10,10);
    const before=await snapshot();assert.equal(before.length,8);assert.ok(before.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y)));
    assert.ok(before.some(n=>n.shape==='dot'),'auto low zoom must display dots');
    const pos=await center(nodeSelector);await move(pos.x,pos.y);
    await wait(`document.querySelectorAll('${nodeSelector} > rect').length>=1`);
    const hovered=await snapshot();
    const anchorMap=Object.fromEntries(before.map(n=>[n.id,[n.x,n.y]]));
    assert.ok(hovered.every(n=>Math.hypot(n.x-anchorMap[n.id][0],n.y-anchorMap[n.id][1])<0.001),'hover must not move layout anchors');
    await move(10,10);await sleep(80);
    evidence[mode+' pointerLeave']=await evaluate(`({events:window.__pointerTrace,active:document.activeElement?.getAttribute('data-node-id'),titles:[...document.querySelectorAll('[data-node-shape="title"]')].map(n=>n.dataset.nodeId)})`);
    await wait(`document.querySelectorAll('${nodeSelector} > circle').length===8`);
    // Focus must reveal a title even after the mouse moves away.
    await evaluate(`document.querySelector('${nodeSelector}').focus()`);await sleep(40);
    evidence[mode+' focus']=await evaluate(`({active:document.activeElement?.getAttribute('data-node-id'),titles:[...document.querySelectorAll('[data-node-shape="title"]')].map(n=>n.dataset.nodeId)})`);
    assert.ok((await snapshot()).some(n=>n.shape==='title'));
    await evaluate('document.activeElement.blur()');await sleep(40);
    evidence[mode+' blur']=await evaluate(`({active:document.activeElement?.tagName,titles:[...document.querySelectorAll('[data-node-shape="title"]')].map(n=>n.dataset.nodeId)})`);
    await selection('Always|始终','Always|始终');
    assert.ok((await snapshot()).every(n=>n.shape==='title'),'always-title mode');
    await screenshot(mode.startsWith('Rect')?'rectangle':mode.startsWith('Out')?'radial-outward':'radial-inward');
    evidence[mode]=await snapshot();
    if (!mode.startsWith('Rect')) {
      const find = id => evidence[mode].find(n=>n.id===id || n.id.endsWith('('+id+')'));
      const [a,b,c] = ['Base','Base2','Base3'].map(find);
      const d = 2*(a.x*(b.y-c.y)+b.x*(c.y-a.y)+c.x*(a.y-b.y));
      assert.ok(Math.abs(d)>1e-6,'three foundations must not collapse on a radial line');
      const q=p=>p.x*p.x+p.y*p.y;
      const cx=(q(a)*(b.y-c.y)+q(b)*(c.y-a.y)+q(c)*(a.y-b.y))/d;
      const cy=(q(a)*(c.x-b.x)+q(b)*(a.x-c.x)+q(c)*(b.x-a.x))/d;
      const radii=['Base','Middle','Goal'].map(id=>{const n=find(id);return Math.hypot(n.x-cx,n.y-cy);});
      assert.ok(mode.startsWith('Out') ? radii[0]<radii[1]&&radii[1]<radii[2] : radii[0]>radii[1]&&radii[1]>radii[2], 'radial height direction must match Spec');
      evidence[mode+' radii']={cx,cy,radii};
      assert.equal(new Set(evidence[mode].map(n=>`${n.x.toFixed(4)},${n.y.toFixed(4)}`)).size,8,'distinct centers');
    }
    await selection('Always|始终','Auto|自动');
    const svgRect=await evaluate(`(()=>{const r=document.getElementById('snl-graph-background').closest('svg').getBoundingClientRect();return {x:r.x+10,y:r.y+10};})()`);
    for(let i=0;i<35;i++)await page.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:svgRect.x,y:svgRect.y,deltaX:0,deltaY:-80});
    await wait(`document.querySelectorAll('${nodeSelector} > rect').length===8`);
    assert.ok((await snapshot()).every(n=>n.shape==='title'),'zoom alone reveals titles');
    const afterZoom=await snapshot();assert.ok(afterZoom.every(n=>Math.hypot(n.x-anchorMap[n.id][0],n.y-anchorMap[n.id][1])<0.001),'zoom must not relayout');
  }
  // Refresh must preserve controls; user view-state does not write canonical data.
  const values=await evaluate(`[...document.querySelectorAll('select')].map(s=>s.value)`);
  await evaluate(`window.dispatchEvent(new MessageEvent('message',{data:{...window.__fixture,title:'Refreshed graph'}}))`);await sleep(100);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('select')].map(s=>s.value)`),values);
  await selection('Outward|向外','Rectangle|矩形');
  await move(10,10);
  const key=async(key,code)=>{await page.call('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:code});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code});};
  await evaluate(`document.querySelector('input[type="range"]').focus()`);
  await key('Home',36);
  await wait(`document.querySelector('input[type="range"]').value==='20'`);
  await wait(`document.querySelectorAll('${nodeSelector} > rect').length===8`);
  await key('End',35);
  await wait(`document.querySelector('input[type="range"]').value==='300'`);
  await wait(`document.querySelectorAll('${nodeSelector} > circle').length===8`);
  evidence.thresholdKeyboard={minimum:20,maximum:300,titleAndDotTransitions:true};
  // Ordinary selection and Ctrl navigation still use the production handlers.
  const hit=await center(nodeSelector);await move(hit.x,hit.y);
  for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,x:hit.x,y:hit.y,button:'left',clickCount:1,modifiers:2});
  await wait(`window.__posted.some(m=>m.type==='openEntryInfoview')`);
  evidence.navigation=await evaluate(`window.__posted.filter(m=>m.type==='openEntryInfoview')`);
  await evaluate('document.activeElement.blur()');
  // Live theme/language changes use the same preference message as the host.
  await move(10,10);
  for(const [revision,scheme,language] of [[1,'light','zh-CN'],[2,'dark','en']]) {
    await evaluate(`window.dispatchEvent(new MessageEvent('message',{data:{type:'snl.preferences/snapshot',generation:'browser-qa',revision:${revision},preferences:{language:${JSON.stringify(language)},color_scheme:${JSON.stringify(scheme)},motion:'none',popover_hover_enabled:false}}}))`);
    await selection('Outward|向外','Outward|向外');
    await selection('Always|始终','Always|始终');
    const fill=await evaluate(`document.querySelector('${nodeSelector} > rect').getAttribute('fill')`);
    assert.equal(fill,scheme==='light'?'#e9f2fc':'#22384f');
    if(language==='zh-CN')assert.ok((await evaluate(`document.body.innerText`)).includes('向外环铺'));
    await screenshot('theme-'+scheme);
  }
  await selection('Always|始终','Auto|自动');
  // A bounded large-library control, not a universal performance guarantee.
  await move(10,10);
  const largeStart=Date.now();
  await evaluate(`(()=>{const f=window.__fixture;const nodes=Array.from({length:600},(_,i)=>({...f.nodes[0],id:'Large'+i,title:'Result '+i,packageId:'Package'+(i%4)}));const edges=nodes.slice(1).map((n,i)=>({...f.edges[0],id:'LE'+i,from:n.id,to:'Large'+Math.floor(i/2)}));window.dispatchEvent(new MessageEvent('message',{data:{...f,nodes,edges}}));})()`);
  await wait(`document.querySelectorAll('${nodeSelector}').length===600`);
  evidence.largeLibrary={nodes:600,edges:599,firstRenderMs:Date.now()-largeStart};
  await selection('Outward|向外','Outward|向外');
  evidence.largeLibrary.outwardReadyMs=Date.now()-largeStart;
  assert.ok((await snapshot()).every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y)));
  await screenshot('large-library-outward');
  evidence.largeLibrary.smallestDot=await evaluate(`Math.min(...[...document.querySelectorAll('${nodeSelector} > circle')].map(n=>n.getBoundingClientRect().width))`);
  assert.ok(evidence.largeLibrary.smallestDot>=3.99,'overview dots retain at least a 2px screen radius');
  const overviewHit=await center(nodeSelector);await move(overviewHit.x,overviewHit.y);
  await wait(`document.querySelectorAll('${nodeSelector} > rect').length>=1`);
  evidence.largeLibrary.hoverCardHeight=await evaluate(`Math.max(...[...document.querySelectorAll('${nodeSelector} > rect')].map(n=>n.getBoundingClientRect().height))`);
  assert.ok(evidence.largeLibrary.hoverCardHeight>=43.9,'overview hover title remains screen-readable');
  await screenshot('large-library-hover');await move(10,10);
  await page.call('Emulation.setDeviceMetricsOverride',{width:430,height:850,deviceScaleFactor:1,mobile:false});
  await selection('Outward|向外','Inward|向内');
  evidence.narrow=await evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,selects:[...document.querySelectorAll('select')].map(s=>{const r=s.getBoundingClientRect();return {left:r.left,right:r.right}})})`);
  assert.ok(evidence.narrow.scrollWidth<=evidence.narrow.width,'narrow viewport must not overflow page');
  await screenshot('narrow-settings');
  await evaluate(`window.dispatchEvent(new MessageEvent('message',{data:{...window.__fixture,nodes:[],edges:[]}}))`);
  await wait(`document.querySelectorAll('${nodeSelector}').length===0`);
  }
  evidence.errors=page.events.filter(e=>e.method==='Runtime.exceptionThrown'||(e.method==='Log.entryAdded'&&e.params.entry.level==='error'));
  assert.deepEqual(evidence.errors,[],'browser errors');
  evidence.success = true;
  console.log('PASS: actual production graph bundle ' + evidence.mode);
  writeFileSync(resolve(artifacts,'evidence.json'),JSON.stringify(evidence,null,2));
} catch(error) {
  if(page){try{const r=await page.call('Page.captureScreenshot',{format:'png'});writeFileSync(resolve(artifacts,'failure.png'),Buffer.from(r.data,'base64'));}catch{}}
  writeFileSync(resolve(artifacts,'failure.json'),JSON.stringify({error:String(error),evidence,events:page?.events},null,2));
  throw error;
} finally {
  page?.close();browser?.close();chrome.kill('SIGTERM');
  await new Promise(r=>{if(chrome.exitCode!==null)return r();chrome.once('exit',r);setTimeout(()=>{chrome.kill('SIGKILL');r();},2000).unref();});
  server.close();rmSync(profile,{recursive:true,force:true});
}
