import { createHash } from 'node:crypto';
// Production LocalWorkspaceReader + actual Node ESM materializer; controlled HTTP/SSE fixture.
// This is not the Toolkit production server or a live VS Code host.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
const evidence = resolve(process.env.SNL_AUTHOR_EVIDENCE || root, 'local-reader'); mkdirSync(evidence,{recursive:true});
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SNL_PLAYWRIGHT_PATH || 'playwright-core');
const { buildWorkspaceReaderSnapshot } = await import(pathToFileURL(resolve(root,'author-local/model.mjs')));
const docs = JSON.parse(readFileSync(resolve(root,'scripts/test-local-reader-author.fixture.json'),'utf8'));
const fixture = resolve(evidence,'entries.json'); writeFileSync(fixture,JSON.stringify(docs));
let revision=1, failure=false;
const streams = new Set(); const requests=[];
const snapshot=slug=>{
 const entries=JSON.parse(readFileSync(fixture,'utf8'));
 return buildWorkspaceReaderSnapshot({config:{version:'0.1.0'},entries,entryKinds:[],macros:{},macroKinds:[],
 relationships:[{id:'fixture-link',from:entries[0].id,to:entries[1].id,label:'related',metadata:null}],
 library:{slug,metadata:{title:'Integration fixture '+slug},counters:[],graph:{nodes:entries.map((entry,i)=>({id:'node-'+i,label:'Entry',props:{entryId:entry.id}})),relationships:[]}}});
};
const server=createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost'); requests.push(req.url);
 if(u.pathname==='/__snl/api/events') {res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});streams.add(res);res.write(`event: change\ndata: {"revision":"${revision}"}\n\n`);req.on('close',()=>streams.delete(res));return;}
 if(u.pathname==='/__snl/api/workspace') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'local',name:'Integration materialization fixture',root:fixture,libraries:['A','B'].map(slug=>({slug,title:'Integration fixture '+slug,entryCount:2,relationshipCount:0})),capabilities:{edit:false}}));return;}
 if(u.pathname==='/__snl/api/snapshot') {res.setHeader('Content-Type','application/json');if(failure){res.writeHead(500);res.end('{}');}else res.end(JSON.stringify(snapshot(u.searchParams.get('library'))));return;}
 try {const name=u.pathname==='/'?'index.html':u.pathname.replace('/__snl/static/','');const file=resolve(root,'author-local',name);assert(file.startsWith(resolve(root,'author-local')+'/'));res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[extname(file)]||'application/octet-stream');res.end(readFileSync(file));}catch{res.writeHead(404);res.end();}
});
const result={assets:Object.fromEntries(['reader.js','reader.css','model.mjs'].map(f=>[f,createHash('sha256').update(readFileSync(resolve(root,'author-local',f))).digest('hex')])),scope:'Controlled HTTP/SSE, production local Reader and Node ESM model, two real canonical Spec Entry payloads in an isolated fixture; not Toolkit/VSCode host acceptance.',cases:[],errors:[],requests};
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try{
 browser=await chromium.launch({executablePath:process.env.SNL_CHROMIUM_PATH,headless:true,args:['--no-sandbox','--num-raster-threads=1']});
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);page.on('pageerror',e=>result.errors.push(String(e)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const change=()=>{revision++;for(const s of streams)s.write(`event: change\ndata: {"revision":"${revision}"}\n\n`);};
 await page.goto(base);await page.getByRole('button',{name:'Open library A',exact:true}).waitFor();
 assert.equal(await page.locator('.snl-panel-header:visible').count(),1);assert.equal(await page.locator('.snl-libraries-table th').count(),4);
 await page.screenshot({path:resolve(evidence,'workspace.png')});result.cases.push('shared-readonly-Library-table');
 await page.getByRole('button',{name:'Open library A',exact:true}).click();await page.locator('[data-snl-route-id="node-0"]').waitFor();
 await page.waitForFunction(()=>document.querySelector('[data-snl-local-watch-status]')?.dataset.snlLocalWatchStatus==='connected');
 await page.evaluate(()=>{window.__header=document.querySelector('.snl-panel-header');window.__card=document.querySelector('[data-snl-route-id="node-0"]');});
 const hash=await page.evaluate(()=>location.hash);
 const changed=structuredClone(docs);changed[0].content.markdown+='\n\nINTEGRATION_REFRESH_SENTINEL';writeFileSync(fixture,JSON.stringify(changed));change();
 await page.getByText('INTEGRATION_REFRESH_SENTINEL',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>location.hash),hash);assert(await page.evaluate(()=>window.__header.isConnected&&window.__card===document.querySelector('[data-snl-route-id="node-0"]')));
 await page.screenshot({path:resolve(evidence,'reader-refreshed.png')});result.cases.push('SSE-refresh-retains-route-header-occurrence');
 failure=true;change();await page.locator('[data-snl-local-read-error="snapshot"]').waitFor();assert(await page.getByText('INTEGRATION_REFRESH_SENTINEL',{exact:true}).isVisible());
 failure=false;change();await page.waitForFunction(()=>!document.querySelector('[data-snl-local-read-error="snapshot"]'));result.cases.push('load-error-retains-content-and-recovers');
 await page.getByRole('button',{name:'Relationship graph',exact:true}).click();await page.locator('svg g[aria-label^="Entry "]').first().waitFor();
 assert.equal(await page.locator('.snl-panel-header:visible').count(),1);await page.screenshot({path:resolve(evidence,'graph.png')});result.cases.push('shared-graph-after-live-refresh');
 await page.getByRole('button',{name:'Workspace',exact:true}).click();await page.getByRole('button',{name:'Open library B',exact:true}).click();await page.getByRole('heading',{name:'Integration fixture B',exact:true}).waitFor();
 assert((await page.evaluate(()=>location.hash)).includes('library=B'));result.cases.push('Library-A-to-B-context');
 await page.setViewportSize({width:420,height:860});await page.getByRole('button',{name:'Panel actions',exact:true}).click();await page.getByRole('button',{name:'Relationship graph',exact:true}).waitFor();
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:resolve(evidence,'narrow-actions.png')});result.cases.push('narrow-unified-header-actions-no-page-overflow');
 result.ok=result.errors.length===0;assert(result.ok,JSON.stringify(result.errors));
}catch(error){result.ok=false;result.failure=String(error);throw error;}
finally{try{await browser?.close();}finally{for(const s of streams)s.end();await new Promise(r=>server.close(r));writeFileSync(resolve(evidence,'results.json'),JSON.stringify(result,null,2));}}
console.log(JSON.stringify(result,null,2));
