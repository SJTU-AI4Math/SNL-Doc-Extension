#!/usr/bin/env node
// Real production Dashboard bundle; controlled host transport, not a VS Code Host.
// Run after building webviews. Statistics contain aggregates, not fabricated Entry records.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--build')) {
 const built = spawnSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', resolve(root, 'webview/vite.config.ts')], {cwd:root, env:{...process.env,SNL_WEBVIEW_ENTRY:'dashboard'},stdio:'inherit'});
 if (built.status !== 0) process.exit(built.status ?? 1);
}
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SNL_PLAYWRIGHT_PATH || '/tmp/snl-viewer-browser-tools/node_modules/playwright-core');
const executablePath = process.env.SNL_CHROMIUM_PATH || resolve(process.env.HOME, '.agent-browser/browsers/chrome-152.0.7977.54/chrome');
const bundle = resolve(process.env.SNL_DASHBOARD_BUNDLE_DIR || resolve(root, 'media/webview'));
const out = resolve(process.env.SNL_DASHBOARD_EVIDENCE || '/tmp/dashboard-perf-acceptance/browser');
assert(existsSync(executablePath), 'Set SNL_CHROMIUM_PATH');
mkdirSync(out, { recursive: true });
const digest = x => createHash('sha256').update(x).digest('hex');
const html = theme => `<!doctype html><html lang="en" data-snl-color-scheme="${theme}"><head><meta charset="utf-8"><script>
window.__posted=[]; window.__long=[];
window.acquireVsCodeApi=()=>({getState:()=>undefined,setState:()=>{},postMessage:m=>window.__posted.push(m)});
window.__frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
new PerformanceObserver(l=>window.__long.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
</script><link rel="stylesheet" href="/dashboard.css"><style>
body{margin:0;background:${theme==='dark'?'#1e1e1e':'#fff'};color:${theme==='dark'?'#ddd':'#222'};--vscode-foreground:${theme==='dark'?'#ddd':'#222'};--vscode-editor-background:${theme==='dark'?'#1e1e1e':'#fff'};--vscode-input-background:${theme==='dark'?'#333':'#fff'};--vscode-input-foreground:inherit;--vscode-input-border:#777;--vscode-button-background:#246;--vscode-button-foreground:#fff}
</style></head><body><div id="root"></div><script src="/dashboard.js"></script></body></html>`;
const server = createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html(url.searchParams.get('theme')||'dark'));return;}
 try{const file=resolve(bundle,'.'+url.pathname);assert(file.startsWith(bundle+'/'));
 res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff'})[extname(file)]||'application/octet-stream');res.end(readFileSync(file));}
 catch{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox','--num-raster-threads=1']});
const results={scope:'Production Dashboard bundle, synthetic aggregate messages and controlled transport. No filesystem/VS Code/Windows timing claim.',bundle,sha256:digest(readFileSync(resolve(bundle,'dashboard.js'))),runs:[]};
const catalog={hasSnlDoc:true,totalEntryCount:null,entryPackages:[{id:'PerfProbe',name:'Performance fixture',description:'Synthetic Package',entryCount:null}],macroPackages:[{file:'BasicMacros',active:true,macroCount:null}],libraries:[{slug:'PerfLibrary',title:'Performance Library',entryCount:null,relationshipCount:null}],entryKinds:[],macroKinds:[],dataStatus:{status:'unchecked',currentVersion:'0.1.0',targetVersion:'0.1.0',pendingCount:0,message:'Data version has not been checked yet.'}};
const stats={totalEntryCount:9000,entryPackages:[{id:'PerfProbe',entryCount:9000}],macroPackages:[{file:'BasicMacros',macroCount:7}],relationshipCount:1,libraries:[{slug:'PerfLibrary',entryCount:100,relationshipCount:0}]};
try{
 for(const theme of ['dark','light']){
  const page=await browser.newPage({viewport:{width:1280,height:960}});page.setDefaultTimeout(4000);
  const run={theme,cases:[],errors:[]};results.runs.push(run);
  page.on('pageerror',e=>run.errors.push(String(e)));page.on('requestfailed',r=>run.errors.push(r.url()+': '+r.failure()?.errorText));
  const send=async message=>page.evaluate(async message=>{window.dispatchEvent(new MessageEvent('message',{data:message}));await window.__frame();},message);
  const click=async(name,type,fields={})=>{
   const n=await page.evaluate(()=>window.__posted.length);await page.getByRole('button',{name,exact:true}).click();
   const posted=await page.evaluate(n=>window.__posted.slice(n),n);
   assert(posted.some(m=>m.type===type&&Object.entries(fields).every(([k,v])=>m[k]===v)),`Missing ${type}: ${JSON.stringify(posted)}`);
  };
  const check=async(name,fn)=>{await fn();run.cases.push(name);};
  try{
   await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
   await page.waitForFunction(()=>window.__posted.some(m=>m.type==='ready'));
   await check('independent-navigation-before-catalog',async()=>{
    await click('View Graph','openInfoviewGraph');await click('Open Infoview →','openInfoview');
   });
   await send({type:'overview',generation:1,overview:catalog});
   await send({type:'dashboardStatistics',generation:1,status:'loading'});
   await check('all-independent-actions-with-statistics-withheld',async()=>{
    await click('View Graph','openInfoviewGraph');await click('Open Infoview →','openInfoview');
    await click('Pointer maintenance','maintainPointers');await click('+ Create Library','createLibrary');
    await click('+ Create Entry Package','createEntryPackage');
    await click('⌕ SNoogL: Entry Search','openSnoogL',{mode:'entry'});
    await click('⌕ SNoogL: Macro Search','openSnoogL',{mode:'macro'});
    await page.getByRole('button',{name:/^Interface language:/}).click();
    assert(await page.getByRole('menu',{name:'Interface language',exact:true}).isVisible());
    await page.getByRole('button',{name:/^Interface language:/}).click();
   });
   const section=title=>page.locator('section').filter({has:page.getByText(title,{exact:true})});
   const entrySection=section('Entry Packages');
   await entrySection.locator('[aria-expanded]').first().click();
   await click('Open Entry Package PerfProbe','openEntryPackage',{packageId:'PerfProbe'});
   const packageButton=page.getByRole('button',{name:'Open Entry Package PerfProbe',exact:true});
   const row=packageButton.locator('xpath=ancestor::tr');
   await check('unknown-count-not-zero',async()=>{assert((await row.innerText()).includes('—'));});
   await packageButton.focus();
   await page.evaluate(()=>{window.__focused=document.activeElement;window.__scroll=scrollY;window.__long=[];});
   await page.screenshot({path:resolve(out,`${theme}-statistics-withheld.png`)});
   await check('aggregate-update-retains-dom-focus-and-disclosure',async()=>{
    run.statisticsUpdateMs=await page.evaluate(async message=>{const t=performance.now();window.dispatchEvent(new MessageEvent('message',{data:message}));await window.__frame();return performance.now()-t;},{type:'dashboardStatistics',generation:1,status:'ready',statistics:stats});
    assert((await row.innerText()).includes('9000'));
    assert(await page.evaluate(()=>document.activeElement===window.__focused&&window.__focused.isConnected&&scrollY===window.__scroll));
    assert.equal(await entrySection.locator('[aria-expanded]').first().getAttribute('aria-expanded'),'true');
   });
   await check('statistics-error-is-local',async()=>{
    await send({type:'overview',generation:2,overview:catalog});
    await send({type:'dashboardStatistics',generation:2,status:'error',message:'Synthetic statistics failure'});
    assert((await page.locator('body').innerText()).includes('Synthetic statistics failure'));
    await click('Open Entry Package PerfProbe','openEntryPackage',{packageId:'PerfProbe'});
    await click('View Graph','openInfoviewGraph');await click('+ Create Library','createLibrary');
   });
   await check('stale-statistics-and-errors-ignored',async()=>{
    await send({type:'dashboardStatistics',generation:2,status:'ready',statistics:stats});
    await send({type:'dashboardStatistics',generation:1,status:'ready',statistics:{...stats,entryPackages:[{id:'PerfProbe',entryCount:123}]}});
    await send({type:'dashboardStatistics',generation:1,status:'error',message:'STALE-ERROR'});
    assert((await row.innerText()).includes('9000'));
    assert(!(await page.locator('body').innerText()).includes('STALE-ERROR'));
   });
   await check('relationship-details-demand-and-navigation',async()=>{
    const n=await page.evaluate(()=>window.__posted.length);
    await section('Relationships').locator('[aria-expanded]').first().click();
    assert(await page.evaluate(n=>window.__posted.slice(n).some(m=>m.type==='loadDashboardRelationships'),n));
    await send({type:'dashboardRelationships',generation:2,status:'ready',relationships:[{id:'rel1',from:'Probe.E00000',to:'Probe.E00001',label:'depends',metadata:{}}],entries:[{id:'Probe.E00000',title:'First endpoint'},{id:'Probe.E00001',title:'Second endpoint'}]});
    await click('Edit relationship rel1','editRelationship',{id:'rel1'});
   });
   await check('unsupported-version-does-not-pretend-to-be-counting',async()=>{
    await send({type:'overview',generation:3,overview:{...catalog,dataStatus:{...catalog.dataStatus,status:'future',currentVersion:'99.0.0'}}});
    assert.equal(await page.getByText('Counting…',{exact:true}).count(),0,'No statistics task is scheduled for a future schema');
    await click('View Graph','openInfoviewGraph');
   });
   await page.screenshot({path:resolve(out,`${theme}-final.png`)});
   run.longTasks=await page.evaluate(()=>window.__long);run.ok=run.errors.length===0;assert(run.ok,JSON.stringify(run.errors));
  }catch(e){run.ok=false;run.failure=String(e);await page.screenshot({path:resolve(out,`${theme}-failure.png`)});throw e;}
  finally{await page.close();writeFileSync(resolve(out,'results.json'),JSON.stringify(results,null,2));}
 }
}finally{await browser.close();await new Promise(r=>server.close(r));writeFileSync(resolve(out,'results.json'),JSON.stringify(results,null,2));}
console.log(JSON.stringify(results,null,2));
assert(results.runs.length===2&&results.runs.every(r=>r.ok),'Dashboard browser acceptance failed');
