#!/usr/bin/env node
// Production CreateEntry browser probe. Host transport is a fixture, not a real VS Code host.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url);
const {chromium}=require(process.env.SNL_PLAYWRIGHT_PATH||'/tmp/snl-viewer-browser-tools/node_modules/playwright-core');
const out=process.env.SNL_POINTER_EDITOR_EVIDENCE||'/tmp/pointer-exact/editor-browser';mkdirSync(out,{recursive:true});
const bundle=resolve(root,'media/webview'),sha=x=>createHash('sha256').update(x).digest('hex');
const initialPattern=String.raw`theorem\s+foo\b`,changedPattern=String.raw`/--(?:(?!/-|-/)[\s\S])*-/\s*theorem\s+foo\b`;
const fixture={type:'context',mode:'edit',targetState:'found',id:'Pointer.Regex',entryRevision:'fixture-revision',kinds:[{id:'theorem',name:'Theorem',coloring:{light:{stroke:'#555',background:'#eee'},dark:{stroke:'#888',background:'#222'}},numbering:'theorem',style:'default',defaultCounterName:''}],macros:{},macroKinds:[],relationships:[],entryPackages:['_unpackaged'],existingIds:[{id:'Pointer.Regex',title:'Pointer regex'}],existing:{id:'Pointer.Regex',package:'_unpackaged',kind:'theorem',title:'Pointer regex',content:{text:'Exact Pointer range fixture'},pointer:{file:'Main.lean',mode:'regex',pattern:initialPattern,flags:'m',occurrence:2,priority:-.5,beforeLines:999,afterLines:999,opaque:{keep:true}}}};
const html=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/createEntry.css"><style>body{margin:0;font-family:Arial,sans-serif;background:var(--vscode-editor-background);color:var(--vscode-foreground)}</style><script>window.__fixture=${JSON.stringify(fixture).replace(/</g,'\\u003c')};window.__posted=[];window.acquireVsCodeApi=()=>({getState:()=>window.__state,setState:s=>window.__state=s,postMessage:m=>{window.__posted.push(m);if(m.type==='ready')window.dispatchEvent(new MessageEvent('message',{data:window.__fixture}));}});</script></head><body><div id="root"></div><script type="module" src="/createEntry.js"></script></body></html>`;
const server=createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}try{const f=resolve(bundle,'.'+pathname);assert(f.startsWith(bundle+'/'));res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'})[extname(f)]||'application/octet-stream');res.end(readFileSync(f));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.SNL_CHROMIUM_PATH||resolve(process.env.HOME,'.agent-browser/browsers/chrome-152.0.7977.54/chrome'),headless:true,args:['--no-sandbox','--num-raster-threads=1']});const results=[];
try{for(const theme of ['light','dark'])for(const width of [1100,480]){
 const context=await browser.newContext({viewport:{width,height:850}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));const url=`http://127.0.0.1:${server.address().port}/`;await page.goto(url);
 await page.evaluate(theme=>{document.documentElement.dataset.snlColorScheme=theme;for(const [name,value]of Object.entries(theme==='dark'?{'editor-background':'#1e1e1e','foreground':'#ddd','input-background':'#313131','input-foreground':'#ddd','input-border':'#777'}:{'editor-background':'#fff','foreground':'#222','input-background':'#fff','input-foreground':'#222','input-border':'#888'}))document.documentElement.style.setProperty('--vscode-'+name,value);},theme);
 await page.getByLabel('Title',{exact:true}).waitFor();await page.locator('button').filter({has:page.locator('span[role="heading"]',{hasText:/^Pointer$/})}).click();
 const pattern=page.getByLabel(/Regex pattern/i),flags=page.getByLabel(/Flags/i);assert.equal(await pattern.inputValue(),initialPattern);assert.equal(await flags.inputValue(),'m');assert.equal(await page.getByLabel(/Before lines|After lines|前文行数|后文行数/i).count(),0);
 await pattern.scrollIntoViewIfNeeded();const geometry=await pattern.evaluate((p)=>{const f=document.getElementById('snl-entry-pointer-flags');let g=p.parentElement;while(g&&!g.contains(f))g=g.parentElement;if(!g)throw Error('No shared regex frame');const r=e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,right:b.right}};return{pattern:r(p),flags:r(f),group:r(g),slashes:[...g.querySelectorAll('span')].filter(s=>s.textContent==='/').map(r),gap:getComputedStyle(g).gap,overflow:document.documentElement.scrollWidth>innerWidth};});
 assert.equal(geometry.slashes.length,2);assert(Math.abs(geometry.pattern.y-geometry.flags.y)<2);assert(geometry.flags.width<geometry.pattern.width);assert(geometry.flags.x-geometry.pattern.right<30);assert(!geometry.overflow,JSON.stringify(geometry));
 await page.screenshot({path:resolve(out,`${theme}-${width}.png`)});
 await pattern.fill(changedPattern);await pattern.press('Tab');assert(await flags.evaluate(e=>e===document.activeElement));await flags.fill('ms');await page.getByRole('button',{name:/Update Entry/i}).click();await page.waitForFunction(()=>window.__posted.some(m=>m.type==='update'));
 const payload=await page.evaluate(()=>window.__posted.findLast(m=>m.type==='update'));assert.deepEqual(payload.entry.pointer,{file:'Main.lean',mode:'regex',pattern:changedPattern,flags:'ms',occurrence:2,priority:-.5,opaque:{keep:true}});assert.equal(payload.expectedRevision,'fixture-revision');assert.deepEqual(errors,[]);
 results.push({theme,width,url,geometry,pointer:payload.entry.pointer,errors,ok:true});await context.close();
}}finally{await browser.close();await new Promise(r=>server.close(r));writeFileSync(resolve(out,'results.json'),JSON.stringify({bundles:Object.fromEntries(['createEntry.js','createEntry.css'].map(p=>[p,sha(readFileSync(resolve(bundle,p)))])),results},null,2));}
assert.equal(results.length,4);console.log(JSON.stringify(results,null,2));
