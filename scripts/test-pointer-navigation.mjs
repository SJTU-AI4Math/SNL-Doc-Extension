#!/usr/bin/env node
// Production shared-reader + source-viewer browser regressions; not a VS Code Host test.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'), require=createRequire(import.meta.url);
const {buildExportDocument,EXPORT_BASE_CSS}=require('../out/exportHtmlDocument.js');
const {frozenReaderScript}=require('../out/sharedReaderSnapshot.js');
const {compilePointerScope}=require('../out/pointerSync/scope.js');
const {resolvePointerText}=require('../out/pointerSync/text.js');
const {buildSourceAssets}=require('../out/sourceExport/transport.js');
const {chromium}=require(process.env.SNL_PLAYWRIGHT_PATH||'/tmp/snl-viewer-browser-tools/node_modules/playwright-core');
const executablePath=process.env.SNL_CHROMIUM_PATH||resolve(process.env.HOME,'.agent-browser/browsers/chrome-152.0.7977.54/chrome');
assert(existsSync(executablePath),'Set SNL_CHROMIUM_PATH to a real installed browser');
const out=process.env.SNL_SOURCE_EVIDENCE||'/tmp/pointer-035/browser';mkdirSync(out,{recursive:true});
const digest=x=>createHash('sha256').update(x).digest('hex');
const text=['-- 😀 中文 source','def alpha := Nat.zero','def beta := Nat.succ 0',...Array.from({length:180},(_,i)=>`-- row ${i+4}`)].join('\r\n');
const fileId=digest('Main.lean'), bytes=Buffer.from(text), sha=digest(bytes);
const files=[{fileId,displayPath:'Main.lean',kind:'text',language:'lean4',byteLength:bytes.length,sha256:sha,bom:false,eol:'crlf',chunkId:`source-${fileId}.js`}];
const chunks=[{fileId,sha256:sha,base64:bytes.toString('base64')}];
const pointer=(entryId,line,priority=0)=>{const pointer={file:'Main.lean',mode:'lines',line,beforeLines:0,afterLines:0,priority};const resolved=resolvePointerText(pointer,text);assert.equal(resolved.status,'ok');return {entryId,package:'P',pointer,fileId,sourceSha256:sha,status:'ok',range:resolved.range,inverseScope:compilePointerScope(pointer,resolved.range,text)};};
const entry=(id,markdown)=>({id,package:'P',kind:'entry',title:id,content:{markdown},pointer:null});
const entries=[entry('Intro',Array.from({length:40},(_,i)=>`Paragraph ${i}. Long reading body before the target.`).join('\n\n')),entry('Zeta','Zeta tie'),entry('Alpha','Alpha target'),entry('Beta','Beta target'),entry('Hidden','Hidden child target'),entry('Missing','Unavailable source'),entry('Outside','Standalone target')];
const byId=new Map(entries.map(e=>[e.id,e]));
const node=(id,entryId,children=[])=>({nodeId:id,entry:byId.get(entryId),kind:null,counterLabel:null,children});
const outline=[node('intro','Intro'),node('z-alpha','Alpha'),node('zeta','Zeta'),node('a-alpha','Alpha'),node('beta','Beta'),node('parent','Intro',[node('deep','Hidden')]),node('missing','Missing')];
const routes=[];const walk=ns=>ns.forEach(n=>{routes.push({entryId:n.entry.id,nodeId:n.nodeId,hash:'#/node/'+n.nodeId});walk(n.children);});walk(outline);entries.forEach(e=>routes.push({entryId:e.id,hash:'#/entry/'+e.id}));
const pointers=[pointer('Zeta',2),pointer('Alpha',2),pointer('Beta',3),pointer('Hidden',120),pointer('Outside',140),{entryId:'Missing',status:'unavailable',reason:'Source file missing',pointer:{file:'missing.lean',mode:'lines',line:1}}];
const manifest={schemaVersion:'snl.export.sources/v2',exportId:'pointer-browser',renderSnapshotId:'pointer-browser',workspaceName:'Pointer fixture',snapshot:{mode:'disk'},options:{scope:'pointer-files',keep:[],exclude:[],companionFiles:[]},files,directories:[],pointers,entryRoutes:routes};
const snapshot={version:1,renderSnapshotId:'pointer-browser',library:{slug:'Pointer',title:'Pointer fixture',outline,warnings:[]},entries,entryKinds:[],entryPackages:Object.fromEntries(entries.map(e=>[e.id,'P'])),macros:{},macroKinds:[],relationships:[],preferences:{language:'en',color_scheme:'light',motion:'reduced'},contentLanguage:'en',languages:[{id:'en',display_name:'English'}],resources:{}};
const css=EXPORT_BASE_CSS+'\n'+readFileSync(resolve(root,'media/exportRuntime.css'),'utf8')+'\n'+readFileSync(resolve(root,'media/sourceViewer.css'),'utf8');
for(const shape of ['folder','single']){
 const dir=resolve(out,shape);mkdirSync(resolve(dir,'assets'),{recursive:true});writeFileSync(resolve(dir,'assets/sjtu-ai4math-logo.svg'),readFileSync(resolve(root,'media/icons/logoCSS_black.svg')));
 const sources=buildSourceAssets({manifest,chunks},shape==='single');
 for(const f of sources.texts)writeFileSync(resolve(dir,f.path),f.source);
 const script='globalThis.MonacoEnvironment={globalAPI:true};\n'+frozenReaderScript(snapshot)+'\n'+(shape==='single'?sources.texts[0].source:'')+'\n'+readFileSync(resolve(root,'media/exportRuntime.js'),'utf8')+'\n'+readFileSync(resolve(root,'media/sourceViewer.js'),'utf8');
 writeFileSync(resolve(dir,'index.html'),buildExportDocument({title:'Pointer regression',css,body:'<div id="snl-reader-root"></div>',script,scriptSources:shape==='folder'?['sources.js']:[]}));
}
const server=createServer((req,res)=>{try{const p=resolve(out,'.'+new URL(req.url,'http://localhost').pathname);assert(p.startsWith(resolve(out)+'/'));res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.svg')?'image/svg+xml':'text/html');res.end(readFileSync(p));}catch{res.statusCode=404;res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox','--num-raster-threads=1']});const results=[];
try{
 for(const shape of ['folder','single'])for(const protocol of ['http','file']){
  const file=resolve(out,shape,'index.html'),url=protocol==='file'?pathToFileURL(file).href:`http://127.0.0.1:${server.address().port}/${shape}/index.html`;
  const context=await browser.newContext({viewport:{width:1400,height:900}}),page=await context.newPage(),errors=[],cases=[];
  page.on('pageerror',e=>errors.push(String(e)));page.on('requestfailed',r=>errors.push(r.url()+': '+r.failure()?.errorText));
  await page.goto(url);await page.locator('.snl-source-open').click();await page.waitForFunction(()=>window.monaco?.editor.getEditors()[0]?.getModel());
  await page.getByLabel('Follow cursor',{exact:true}).uncheck();
  const position=async line=>page.evaluate(line=>{const e=window.monaco.editor.getEditors()[0];e.setPosition({lineNumber:line,column:1},'probe');e.focus();},line);
  const test=async(name,fn)=>{try{await fn();cases.push({name,ok:true});}catch(e){cases.push({name,ok:false,error:String(e)});await page.screenshot({path:resolve(out,`${shape}-${protocol}-${name}.png`)});}};
  await test('forward-reading-anchor',async()=>{
    await page.getByRole('button',{name:'Hide',exact:true}).click();
    const surface=page.locator('[data-snl-route-id="a-alpha"]');
    await surface.scrollIntoViewIfNeeded();
    await surface.locator('.snl-entry-source-action').click();
    await page.waitForFunction(()=>window.monaco.editor.getEditors()[0]?.getSelection()?.startLineNumber===2);
    const rect=await surface.boundingBox();assert(rect.y>=0&&rect.y<850,`Forward action lost the Entry: ${JSON.stringify(rect)}`);
    assert(await page.evaluate(()=>window.monaco.editor.getEditors()[0].getModel().getValueInRange(window.monaco.editor.getEditors()[0].getSelection()).includes('def alpha')));
  });
  await test('deterministic-shortcut',async()=>{await position(2);await page.keyboard.press('Control+Alt+j');await page.waitForFunction(()=>location.hash==='#/node/a-alpha',null,{timeout:2500});assert.equal(await page.locator('.snl-source-choices button').count(),0);});
  await test('deep-route-marker',async()=>{await position(120);await page.keyboard.press('Control+Alt+j');await page.waitForFunction(()=>document.querySelector('[data-snl-route-id="deep"] [data-snl-source-current]'),null,{timeout:2500});assert.equal(await page.locator('[data-snl-source-current]').count(),1);const box=await page.locator('[data-snl-source-current]').boundingBox();assert(box.y>=0&&box.y<900);});
  await test('standalone-marker',async()=>{await position(140);await page.keyboard.press('Control+Alt+j');await page.waitForFunction(()=>location.hash==='#/entry/Outside'&&document.querySelector('[data-entry-id="Outside"][data-snl-source-current]'),null,{timeout:2500});});
  await test('passive-marker-focus',async()=>{await page.getByLabel('Follow cursor',{exact:true}).check();await position(2);const before=await page.evaluate(()=>history.length);await page.keyboard.press('ArrowDown');await page.waitForFunction(()=>document.querySelector('[data-entry-id="Beta"][data-snl-source-current]'),null,{timeout:2500});assert(await page.evaluate(()=>document.activeElement.closest('.monaco-editor')!==null));assert.equal(await page.evaluate(()=>history.length),before);});
  await test('unavailable-clears-source',async()=>{await page.evaluate(()=>window.dispatchEvent(new CustomEvent('snl-reader-source',{detail:{entryId:'Missing'}})));await page.waitForFunction(()=>document.querySelector('.snl-source-status').textContent.includes('missing'));assert.equal(await page.locator('[data-snl-source-current]').count(),0);assert.equal(await page.locator('.snl-source-editor').isVisible(),false);assert.equal(await page.locator('.snl-source-path').textContent(),'');});
  await page.locator('[data-snl-source-file]').first().click();await page.waitForFunction(()=>!document.querySelector('.snl-source-editor').hidden&&window.monaco.editor.getEditors()[0]?.getModel());
  await test('split-geometry',async()=>{const s=await page.locator('.snl-source-splitter').boundingBox();await page.mouse.move(s.x+3,300);await page.mouse.down();await page.mouse.move(560,300);await page.mouse.up();await page.waitForFunction(()=>Math.abs(document.querySelector('.snl-source-panel').getBoundingClientRect().right-560)<2);await page.waitForFunction(()=>Math.abs(document.querySelector('.monaco-editor').getBoundingClientRect().width-document.querySelector('.snl-source-editor').clientWidth)<2,null,{timeout:2500});const g=await page.evaluate(()=>({panel:document.querySelector('.snl-source-panel').getBoundingClientRect().right,doc:document.querySelector('.snl-export').getBoundingClientRect().left,editor:document.querySelector('.monaco-editor').getBoundingClientRect().width,host:document.querySelector('.snl-source-editor').clientWidth}));assert(Math.abs(g.panel-g.doc)<2&&Math.abs(g.editor-g.host)<2,JSON.stringify(g));});
  await test('short-window',async()=>{await page.setViewportSize({width:900,height:400});const g=await page.locator('.snl-source-editor').boundingBox();assert(g.height>=120,`Editor crushed to ${g.height}px`);assert(await page.getByRole('button',{name:'Hide',exact:true}).isVisible());assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));});
  await page.setViewportSize({width:1400,height:900});await page.screenshot({path:resolve(out,`${shape}-${protocol}-final.png`)});
  results.push({shape,protocol,url,sha256:digest(readFileSync(file)),cases,errors});writeFileSync(resolve(out,'results.json'),JSON.stringify(results,null,2));await context.close();
 }
}finally{await browser.close();await new Promise(r=>server.close(r));}
console.log(JSON.stringify(results,null,2));assert(results.every(r=>r.errors.length===0&&r.cases.every(c=>c.ok)),'Pointer browser regressions failed');
