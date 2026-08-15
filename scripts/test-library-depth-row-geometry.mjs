#!/usr/bin/env node
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPath, fileCensus, requireExternalPath, restoreFiles, sameFileCensus, snapshotFiles, spawnTracked, terminateProcessTree } from './library-depth-harness-utils.mjs';

const root=canonicalPath(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
let server=null, chrome=null, xvfb=null, profile=null, out=null, p=null, bs=null, ps=null;
let artifactPaths=[], artifactSnapshot=null, artifactCensusBefore=null;

async function runHarness(){
const explicitOut=process.env.SNL_LIBRARY_GEOMETRY_OUT ? requireExternalPath(root, process.env.SNL_LIBRARY_GEOMETRY_OUT, 'ARTIFACT-OUTSIDE-REPO') : null;
  out=explicitOut||mkdtempSync(resolve(tmpdir(),'snl-library-geometry-'));
  const bundle=resolve(root,'media/webview');
  mkdirSync(out,{recursive:true});
const viteBin=resolve(root,'node_modules/vite/bin/vite.js');
const artifactNames=['createLibrary.js','createLibrary.css'];
  artifactPaths=artifactNames.map(f=>resolve(bundle,f));
  artifactSnapshot=snapshotFiles(artifactPaths);
  artifactCensusBefore=fileCensus(artifactPaths);
  const priorArtifacts=Object.fromEntries(artifactCensusBefore.map((record,index)=>[artifactNames[index],record.absent?null:{hash:record.sha256,mtimeMs:record.mtimeMs}]));
for(const f of artifactNames) rmSync(resolve(bundle,f),{force:true});
if(artifactNames.some(f=>existsSync(resolve(bundle,f)))) throw new Error('[ASSERT:BUILD-FRESH-ABSENT] canonical artifacts survived pre-build deletion');
const buildStartedAt=Date.now();
const build=spawnSync(process.execPath,[viteBin,'build','--config',resolve(root,'webview/vite.config.ts')],{cwd:root,env:{...process.env,SNL_WEBVIEW_ENTRY:'createLibrary'},stdio:'inherit'});
if(build.status!==0)throw new Error(`[ASSERT:BUILD-SUCCEEDED] vite exited ${build.status??'without status'}`);
for(const f of artifactNames) if(!existsSync(resolve(bundle,f))) throw new Error(`[ASSERT:BUILD-FRESH-CREATED] missing production artifact ${f}`);
for(const f of artifactNames) if(statSync(resolve(bundle,f)).mtimeMs<buildStartedAt) throw new Error(`[ASSERT:BUILD-FRESH-MTIME] ${f} predates this invocation (${statSync(resolve(bundle,f)).mtimeMs} < ${buildStartedAt})`);
console.log('[HARNESS:BUILD_OK]');
if(process.env.SNL_LIBRARY_GEOMETRY_FORCE_FAILURE==='after-build') throw new Error('[ASSERT:FORCED-AFTER-BUILD] deterministic restoration failure probe');
const localized=(v)=>({type:'localized',values:{en:v,'zh-CN':`超长本地化${v}`},default_language:'en'});
const ids=Array.from({length:9},(_,d)=>`entry-depth-${d}-identifier-with-a-deliberately-long-editable-suffix-${'ABCDEFGHIJKLMN'.repeat(d===0?14:1)}`);
const nodes=ids.map((id,d)=>({id:`node-depth-${d}`,label:'Entry',props:{entryId:id,counterId:'counter-long'}}));
const fixture={
 context:{type:'context',mode:'edit',targetState:'found',slug:'deep-width-probe',libraryRevision:'probe',existing:{slug:'deep-width-probe',title:'Deep width probe'}},
 graph:{type:'graph',nodes,relationships:nodes.slice(1).map((n,i)=>({from:nodes[i].id,to:n.id,label:'branch'})),entries:ids.map((id,d)=>({id,kind:'localized-kind',title:localized(`Measured title floor at depth ${d}`),content:{snl:`Definition(Depth${d})`}})),kinds:[{id:'localized-kind',name:localized('Extraordinarily Long Localized Definition Kind Badge'),description:localized('Long kind description'),defaultCounterName:'section'}],metricMacroSources:{},metricThresholds:{structuralIndexRedBelow:60,structuralIndexGreenAtLeast:80},warnings:[]},
 counters:{type:'countersLoaded',counters:[{id:'counter-long',name:'a-very-long-localized-counter-name',numbering:'1',children:[]}]}
};
const mutation=process.env.SNL_LIBRARY_GEOMETRY_MUTATION||'';
const mutationCss={
  'reservation-11.3':'.snl-library-outline-row{--snl-library-toolbar-reservation:9.8rem!important}',
  'reveal-5.1':'.snl-library-outline-row.snl-library-outline-row:hover,.snl-library-outline-row.snl-library-outline-row:has(>.snl-outline-row-toolbar:focus-within){--snl-library-toolbar-reservation:9.8rem!important}',
  'depth-wrap':'.snl-library-outline-row:has([data-snl-library-row-main][style*="4.5rem"])>.snl-outline-row-content{flex:1 0 100%!important}',
  'title-8rem':'.snl-library-outline-row-main:not(.snl-pressure-probe) .snl-outline-row-title{max-width:8rem!important}',
  'medium-max-content':'@container snl-outline (min-width:26.0625rem) and (max-width:60rem){.snl-library-outline-row-main[style*="12rem"]{grid-template-columns:minmax(calc(4rem + var(--snl-library-outline-depth-offset,0rem)),calc(8rem + var(--snl-library-outline-depth-offset,0rem))) 101px minmax(0,1fr)!important}}',
  'suggestions-in-flow':'.snl-library-outline-entry-id [role="listbox"]{position:fixed!important}',
  'add-form-overflow':'.snl-tree-add-menu{position:relative!important;overflow:visible!important}.snl-tree-add-menu::after{content:"";position:absolute;left:calc(100% + 2px);top:0;width:2px;height:1px}',
  'add-id-clipping':'.snl-tree-add-menu [role="listbox"]{overflow-x:hidden!important}.snl-tree-add-menu [role="option"]>span:first-child{overflow:hidden!important;white-space:nowrap!important;text-overflow:ellipsis!important;overflow-wrap:normal!important}',
  'add-menu-missing':'.snl-tree-add-menu{display:none!important}',
  'blank-phase-missing':'.snl-pressure-probe{grid-template-columns:calc(4rem + var(--snl-library-outline-depth-offset,0rem)) minmax(0,10rem) minmax(6rem,11rem) fit-content(100%)!important}',
  'title-phase-missing':'.snl-pressure-probe{grid-template-columns:calc(4rem + var(--snl-library-outline-depth-offset,0rem)) minmax(0,10rem) minmax(6rem,11rem) minmax(16rem,1fr)!important}',
  'id-phase-missing':'.snl-pressure-probe{grid-template-columns:calc(4rem + var(--snl-library-outline-depth-offset,0rem)) minmax(0,10rem) 11rem minmax(0,1fr)!important}',
  'id-below-floor':'.snl-pressure-probe{grid-template-columns:calc(4rem + var(--snl-library-outline-depth-offset,0rem)) minmax(0,10rem) minmax(2rem,11rem) minmax(0,1fr)!important}'
}[mutation]||'';
const html=`<!doctype html><html lang="en" data-snl-color-scheme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/createLibrary.css"><style>html{font-size:16px}body{margin:0;color:#ddd;background:#1e1e1e;font-family:Arial,sans-serif}${mutationCss}</style><script>window.__posted=[];window.acquireVsCodeApi=()=>({postMessage(m){__posted.push(m);if(m?.type==='ready'){for(const p of ${JSON.stringify([fixture.context,fixture.graph,fixture.counters])})dispatchEvent(new MessageEvent('message',{data:p}))}},getState(){},setState(){}})</script></head><body><div id="root"></div><script src="/createLibrary.js"></script></body></html>`;
const mime={'.js':'text/javascript','.css':'text/css'};
server=createServer((req,res)=>{const p=new URL(req.url,'http://x').pathname;if(p==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(html);return}if(p==='/favicon.ico'){res.writeHead(204);res.end();return}const f=resolve(bundle,p.slice(1));if(!f.startsWith(bundle)||!existsSync(f)){res.writeHead(404);res.end();return}res.writeHead(200,{'content-type':mime[extname(f)]||'application/octet-stream'});res.end(readFileSync(f))});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const chromeCandidates=[process.env.SNL_CHROMIUM_PATH,process.env.CHROME_PATH,process.env.PROGRAMFILES&&resolve(process.env.PROGRAMFILES,'Google/Chrome/Application/chrome.exe'),process.env['PROGRAMFILES(X86)']&&resolve(process.env['PROGRAMFILES(X86)'],'Microsoft/Edge/Application/msedge.exe'),'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',resolve(process.env.HOME||'','.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'),'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/usr/bin/microsoft-edge'].filter(Boolean);
const chromePath=chromeCandidates.find(existsSync);if(!chromePath)throw new Error('chromium missing');
profile=mkdtempSync(resolve(tmpdir(),'snl-depth-width-'));let display=process.env.DISPLAY;
if(process.platform==='linux'&&!display){const xvfbPath=['/usr/bin/Xvfb','/usr/local/bin/Xvfb'].find(existsSync);if(!xvfbPath)throw new Error('[ASSERT:BROWSER-INFRA] DISPLAY is unset and Xvfb is unavailable');display=`:${300+process.pid%300}`;xvfb=spawnTracked(xvfbPath,[display,'-screen','0','1600x2000x24','-nolisten','tcp','-ac'],{stdio:'ignore'});await new Promise(r=>setTimeout(r,150));}
const chromeArgs=['--no-sandbox','--disable-gpu','--hide-scrollbars','--no-first-run','--disable-background-networking','--disable-default-apps','--disable-extensions','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--window-size=1600,2000','about:blank'];
chrome=spawnTracked(chromePath,chromeArgs,{stdio:['ignore','ignore','pipe'],env:{...process.env,...(display?{DISPLAY:display}:{})}});
let ws='',stderr='';chrome.stderr.setEncoding('utf8');chrome.stderr.on('data',c=>{stderr+=c;ws||=c.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]||''});for(let i=0;i<120&&!ws;i++)await new Promise(r=>setTimeout(r,25));if(!ws)throw new Error(stderr);
class Cdp{constructor(s){this.s=s;this.n=1;this.p=new Map;this.events=[];s.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=this.p.get(m.id);if(!p)return;this.p.delete(m.id);m.error?p.j(Error(JSON.stringify(m.error))):p.r(m.result)}else this.events.push(m)})}call(method,params={}){const id=this.n++;this.s.send(JSON.stringify({id,method,params}));return new Promise((r,j)=>this.p.set(id,{r,j}))}}
async function open(url){const bs=new WebSocket(ws);await new Promise((r,j)=>{bs.addEventListener('open',r,{once:true});bs.addEventListener('error',j,{once:true})});const b=new Cdp(bs);const {targetId}=await b.call('Target.createTarget',{url});let pws='';for(let i=0;i<100&&!pws;i++){const a=await fetch(`http://127.0.0.1:${new URL(ws).port}/json/list`).then(r=>r.json());pws=a.find(x=>x.id===targetId)?.webSocketDebuggerUrl||'';if(!pws)await new Promise(r=>setTimeout(r,25))}const ps=new WebSocket(pws);await new Promise((r,j)=>{ps.addEventListener('open',r,{once:true});ps.addEventListener('error',j,{once:true})});const p=new Cdp(ps);await p.call('Runtime.enable');await p.call('Page.enable');await p.call('Log.enable');return{b,p,bs,ps}}
({p,bs,ps}=await open(`http://127.0.0.1:${port}/`));
async function evalv(expression){const q=await p.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(q.exceptionDetails)throw new Error(JSON.stringify(q.exceptionDetails));return q.result.value}
for(let i=0;i<200;i++){if(await evalv(`document.querySelectorAll('.snl-library-outline-row').length===9`))break;await new Promise(r=>setTimeout(r,25))}
if(!(await evalv(`document.querySelectorAll('.snl-library-outline-row').length===9`)))throw new Error('[ASSERT:HARNESS-READY] expected nine production rows');
console.log('[HARNESS:STARTED]');
async function setWidth(w,coarse=false){await p.call('Emulation.setDeviceMetricsOverride',{width:1400,height:1800,deviceScaleFactor:1,mobile:false});await p.call('Emulation.setTouchEmulationEnabled',{enabled:coarse,maxTouchPoints:coarse?5:1});await evalv(`(()=>{let c=document.querySelector('.snl-library-outline-row');while(c&&!getComputedStyle(c).containerName.split(/\\s+/).includes('snl-outline'))c=c.parentElement;if(!c)throw Error('named container missing');Object.assign(c.style,{boxSizing:'content-box',width:'${w}px',minWidth:'${w}px',maxWidth:'${w}px'});document.querySelectorAll('input[aria-expanded="true"]').forEach(e=>{e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))});document.activeElement?.blur();scrollTo(0,0)})()`);await p.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2});await new Promise(r=>setTimeout(r,160))}
const inspect=`(()=>{const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{left:+r.left.toFixed(2),right:+r.right.toFixed(2),top:+r.top.toFixed(2),bottom:+r.bottom.toFixed(2),width:+r.width.toFixed(2),height:+r.height.toFixed(2)}};const css=e=>{if(!e)return null;const s=getComputedStyle(e);return{display:s.display,boxSizing:s.boxSizing,width:s.width,minWidth:s.minWidth,maxWidth:s.maxWidth,paddingLeft:s.paddingLeft,paddingRight:s.paddingRight,gap:s.gap,marginLeft:s.marginLeft,flex:s.flex,gridTemplateColumns:s.gridTemplateColumns,overflow:s.overflow,whiteSpace:s.whiteSpace,opacity:s.opacity,pointerEvents:s.pointerEvents,transform:s.transform}};const rows=[...document.querySelectorAll('.snl-library-outline-row')];let container=rows[0];while(container&&!getComputedStyle(container).containerName.split(/\\s+/).includes('snl-outline'))container=container.parentElement;return{media:{hover:matchMedia('(hover:hover)').matches,fine:matchMedia('(pointer:fine)').matches,coarse:matchMedia('(pointer:coarse)').matches},viewport:{innerWidth,docClient:document.documentElement.clientWidth,docScroll:document.documentElement.scrollWidth},container:{rect:rect(container),clientWidth:container.clientWidth,scrollWidth:container.scrollWidth,css:css(container)},rows:rows.map((row,depth)=>{const q=s=>row.querySelector(s),main=q('[data-snl-library-row-main]'),content=q(':scope > .snl-outline-row-content'),disc=q(':scope > button[aria-expanded], :scope > .snl-outline-disclosure-spacer'),counter=q('.snl-library-outline-counter'),kind=q('.snl-library-outline-kind'),id=q('.snl-library-outline-entry-id'),input=id?.querySelector('input'),title=q('.snl-outline-row-title'),toolbar=q(':scope > .snl-outline-row-toolbar'),cluster=q('.snl-tree-operation-cluster'),dial=q('.snl-tree-operation-dial'),metric=q('.snl-library-outline-metric'),menu=q('.snl-tree-add-menu');const rr=rect(row),mr=rect(main),tr=rect(title),ir=rect(input),tb=rect(toolbar);const hit=disc?document.elementFromPoint((rect(disc).left+rect(disc).right)/2,(rect(disc).top+rect(disc).bottom)/2):null;return{depth,leaf:!disc?.matches('button'),rects:{row:rr,disclosure:rect(disc),content:rect(content),main:mr,counter:rect(counter),kind:rect(kind),idSlot:rect(id),input:ir,title:tr,toolbar:tb,cluster:rect(cluster),dial:rect(dial),metric:rect(metric),menu:rect(menu)},css:{row:css(row),content:css(content),main:css(main),counter:css(counter),kind:css(kind),idSlot:css(id),input:css(input),title:css(title),toolbar:css(toolbar)},intrinsic:{kindClient:kind?.clientWidth,kindScroll:kind?.scrollWidth,inputClient:input?.clientWidth,inputScroll:input?.scrollWidth,titleClient:title?.clientWidth,titleScroll:title?.scrollWidth},spaces:{beforeMain:mr&&rr?+(mr.left-rr.left).toFixed(2):null,afterMain:mr&&rr?+(rr.right-mr.right).toFixed(2):null,titleToToolbar:tr&&tb?+(tb.left-tr.right).toFixed(2):null,mainToToolbar:mr&&tb?+(tb.left-mr.right).toFixed(2):null},oneLine:ir&&tr?Math.abs(ir.top-tr.top)<1:false,overflow:{main:main.scrollWidth-main.clientWidth,row:row.scrollWidth-row.clientWidth},disclosureHit:hit?{tag:hit.tagName,cls:String(hit.className),label:hit.getAttribute('aria-label')}:null}}),buttons:[...document.querySelectorAll('.snl-library-outline-row button')].map(b=>({label:b.getAttribute('aria-label'),title:b.title,cls:b.className}))}})()`;
const widths=[1200,1100,1000,961,960,959,600,480,417,416,415,360];const matrix=[];
async function capture(name){const {data}=await p.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,fromSurface:true});writeFileSync(resolve(out,name),Buffer.from(data,'base64'))}
for(const w of widths){await setWidth(w,false);matrix.push({width:w,state:'idle',data:await evalv(inspect)});if(w===1000)await capture('depth-width-1000-idle.png');if([1200,1000,961,960,417,416,415,360].includes(w)){const r=await evalv(`(()=>{const x=document.querySelectorAll('.snl-library-outline-row')[4].getBoundingClientRect();return{x:(x.left+x.right)/2,y:(x.top+x.bottom)/2}})()`);await p.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:r.x,y:r.y});await new Promise(r=>setTimeout(r,140));matrix.push({width:w,state:'hover-depth4',data:await evalv(inspect)});if([1000,960,416,360].includes(w))await capture(`depth-width-${w}-hover.png`);await p.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2});await evalv(`(()=>{const i=document.querySelectorAll('.snl-library-outline-row')[4].querySelector('input');i.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'entry-depth');i.dispatchEvent(new Event('input',{bubbles:true}))})()`);await new Promise(r=>setTimeout(r,140));const focusData=await evalv(inspect);focusData.suggestions=await evalv(`(()=>{const e=document.querySelectorAll('.snl-library-outline-row')[4].querySelector('[role="listbox"]');if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return{position:s.position,top:+r.top.toFixed(2),bottom:+r.bottom.toFixed(2),height:+r.height.toFixed(2)}})()`);matrix.push({width:w,state:'focus-id-depth4',data:focusData});if(w===1000)await capture('depth-width-1000-focus-id.png');await evalv(`(()=>{const i=document.querySelectorAll('.snl-library-outline-row')[4].querySelector('input');i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.querySelectorAll('.snl-library-outline-row')[4].querySelector('.snl-tree-operation-dial button:not(:disabled)').focus()})()`);await new Promise(r=>setTimeout(r,140));matrix.push({width:w,state:'focus-toolbar-depth4',data:await evalv(inspect)})}}
for(const w of [1000,960,416,360]){await setWidth(w,true);matrix.push({width:w,state:'coarse',data:await evalv(inspect)})}
const hitTests=[];for(const w of [1000,417,416,360]){await setWidth(w,false);for(let depth=0;depth<9;depth++){hitTests.push({width:w,depth,...await evalv(`(()=>{const row=document.querySelectorAll('.snl-library-outline-row')[${depth}],d=row.querySelector(':scope > button[aria-expanded], :scope > .snl-outline-disclosure-spacer');d.scrollIntoView({block:'center'});const r=d.getBoundingClientRect(),e=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return{expected:d.matches('button')?'button':'spacer',hitTag:e?.tagName||null,hitLabel:e?.getAttribute('aria-label')||null,hitClass:String(e?.className||''),exact:e===d||d.contains(e)}})()`)});}}
const addInteractions=[];
async function openAdd(depth,method){await setWidth(1000,false);const action=depth===0?'addParent':'addSibling';const point=await evalv(`(()=>{const b=document.querySelectorAll('.snl-library-outline-row')[${depth}]?.querySelector('[data-snl-tree-action="${action}"]');if(!b)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()`);if(!point){addInteractions.push({depth,method,error:'[ASSERT:ADD-ACTION-EXISTS]'});return}if(method==='pointer'){await p.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y});await new Promise(r=>setTimeout(r,80));await p.call('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});await p.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1})}else{await evalv(`document.querySelectorAll('.snl-library-outline-row')[${depth}].querySelector('[data-snl-tree-action="${action}"]').focus()`);await new Promise(r=>setTimeout(r,50));await p.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await p.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13})}await new Promise(r=>setTimeout(r,100));const opened=await evalv(`(()=>{const form=document.querySelector('.snl-tree-add-menu'),input=form?.querySelector('input[role="combobox"]'),list=form?.querySelector('[role="listbox"]'),container=document.querySelector('[style*="container-name: snl-outline"],ol');const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};const option=list?.querySelector('[role="option"]'),idSpan=option?.querySelector('span:first-child'),range=document.createRange();if(idSpan)range.selectNodeContents(idSpan);const optionRect=rect(option),hit=optionRect?document.elementFromPoint((optionRect.left+optionRect.right)/2,(optionRect.top+optionRect.bottom)/2):null,s=idSpan?getComputedStyle(idSpan):null,rangeRects=idSpan?[...range.getClientRects()].map(r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height})):[];return{formExists:!!form,inputExists:!!input,listExists:!!list,expanded:input?.getAttribute('aria-expanded'),activeDescendant:input?.getAttribute('aria-activedescendant')??null,form:rect(form),input:rect(input),list:rect(list),container:rect(container),overflow:container?container.scrollWidth-container.clientWidth:null,formDepth:form?.dataset.snlTreeAddDepth??null,idVisual:idSpan?{text:idSpan.textContent,optionId:option?.id??null,clientWidth:idSpan.clientWidth,scrollWidth:idSpan.scrollWidth,clientHeight:idSpan.clientHeight,scrollHeight:idSpan.scrollHeight,whiteSpace:s.whiteSpace,overflow:s.overflow,overflowWrap:s.overflowWrap,textOverflow:s.textOverflow,rangeRects,pointerReachable:hit===option||option.contains(hit)}:null}})()`);let selectedValue=null,selectionMethod=null;if(opened.listExists&&(depth===0||depth===1)){selectionMethod=depth===0?'keyboard':'pointer';if(selectionMethod==='keyboard'){await p.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await p.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13})}else{const optionPoint=await evalv(`(()=>{const r=document.querySelector('.snl-tree-add-menu [role="option"]').getBoundingClientRect();return{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()`);await p.call('Input.dispatchMouseEvent',{type:'mousePressed',x:optionPoint.x,y:optionPoint.y,button:'left',clickCount:1});await p.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:optionPoint.x,y:optionPoint.y,button:'left',clickCount:1})}await new Promise(r=>setTimeout(r,50));selectedValue=await evalv(`document.querySelector('.snl-tree-add-menu input[role="combobox"]')?.value??null`)}addInteractions.push({depth,method,...opened,selectionMethod,selectedValue});if(opened.formExists){if(depth===4)await capture('depth-width-1000-add-form.png');await evalv(`(()=>{const b=[...document.querySelectorAll('.snl-tree-add-menu button')].find(x=>/cancel/i.test(x.textContent||''));b?.click()})()`);await new Promise(r=>setTimeout(r,50))}}
for(let depth=0;depth<9;depth++)await openAdd(depth,depth===0||depth%2?'keyboard':'pointer');
const menuMeta=await evalv(`[...document.querySelectorAll('[data-snl-tree-action]')].slice(0,12).map(b=>({action:b.dataset.snlTreeAction,label:b.getAttribute('aria-label')}))`);
await setWidth(1000,false);
await setWidth(961,false);const pressure=[];await evalv(`(()=>{const m=document.querySelectorAll('[data-snl-library-row-main]')[8],w=m.getBoundingClientRect().width;m.classList.add('snl-pressure-probe');Object.assign(m.style,{width:w+'px',minWidth:w+'px',maxWidth:w+'px',flex:'none'})})()`);for(let depth=0;depth<=32;depth++){pressure.push(await evalv(`(()=>{const main=document.querySelectorAll('[data-snl-library-row-main]')[8],title=main.querySelector('.snl-outline-row-title'),input=main.querySelector('input');main.style.setProperty('--snl-library-outline-depth-offset','${depth*1.5}rem');const tr=title.getBoundingClientRect(),ir=input.getBoundingClientRect(),s=getComputedStyle(main),range=document.createRange();range.selectNodeContents(title);return{depth:${depth},title:+tr.width.toFixed(2),titleNatural:+range.getBoundingClientRect().width.toFixed(2),id:+ir.width.toFixed(2),tracks:s.gridTemplateColumns,mainOverflow:main.scrollWidth-main.clientWidth}})()`));}await evalv(`(()=>{const m=document.querySelectorAll('[data-snl-library-row-main]')[8];m.style.width='';m.style.setProperty('--snl-library-outline-depth-offset','12rem')})()`);
const errors=p.events.filter(e=>e.method==='Runtime.exceptionThrown'||e.method==='Log.entryAdded'&&['error','warning'].includes(e.params?.entry?.level));
const artifactBuild=Object.fromEntries(['createLibrary.js','createLibrary.css'].map(f=>[f,{sha256:createHash('sha256').update(readFileSync(resolve(bundle,f))).digest('hex')} ]));
const failures=[];
const check=(ok,message)=>{if(!ok)failures.push(message)};
const near=(a,b,tolerance=0.2)=>Math.abs(a-b)<=tolerance;
const intersection=(a,b)=>!a||!b?0:Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
for(const sample of matrix){
  check(sample.data.container.scrollWidth-sample.data.container.clientWidth<=1,`[ASSERT:CONTAINER-BOUNDED] ${sample.width}/${sample.state} overflow ${sample.data.container.scrollWidth-sample.data.container.clientWidth}px`);
  for(const row of sample.data.rows){
    check(row.overflow.row<=1&&row.overflow.main<=1,`[ASSERT:ROW-BOUNDED] ${sample.width}/${sample.state}/d${row.depth} row overflow`);
    check(intersection(row.rects.counter,row.rects.kind)<0.1,`[ASSERT:COUNTER-KIND-NO-OVERLAP] ${sample.width}/${sample.state}/d${row.depth}`);
    check(intersection(row.rects.disclosure,row.rects.counter)<0.1,`[ASSERT:DISCLOSURE-COUNTER-NO-OVERLAP] ${sample.width}/${sample.state}/d${row.depth}`);
    if(sample.width>=961&&!sample.data.media.coarse){
      check(intersection(row.rects.toolbar,row.rects.title)<0.1,`[ASSERT:TOOLBAR-TITLE-NO-OVERLAP] ${sample.width}/${sample.state}/d${row.depth}`);
      check(intersection(row.rects.toolbar,row.rects.input)<0.1,`[ASSERT:TOOLBAR-ID-NO-OVERLAP] ${sample.width}/${sample.state}/d${row.depth}`);
    }
  }
}
for(const width of [1200,1000,961]){
  const states=matrix.filter(x=>x.width===width&&['idle','hover-depth4','focus-id-depth4','focus-toolbar-depth4'].includes(x.state));
  for(const sample of states){
    const row=sample.data.rows[4];
    check(near(row.spaces.afterMain,152),`[ASSERT:TOOLBAR-RESERVATION] ${width}/${sample.state} ${row.spaces.afterMain}px != 152px`);
    check(row.spaces.titleToToolbar>=-0.2,`[ASSERT:CONTENT-BEFORE-TOOLBAR] ${width}/${sample.state} crosses by ${-row.spaces.titleToToolbar}px`);
  }
  const idle=matrix.find(x=>x.width===width&&x.state==='idle');
  check(idle.data.rows.every(row=>row.oneLine),`[ASSERT:DESKTOP-ONE-LINE] ${width}/idle depth row wrapped`);
  const heights=idle.data.rows.map(row=>row.rects.row.height);
  check(Math.max(...heights)-Math.min(...heights)<1,`[ASSERT:ROW-HEIGHT-STABLE] ${width}/idle depth changes row height`);
}
const idle1200=matrix.find(x=>x.width===1200&&x.state==='idle').data.rows[8];
const idle1000=matrix.find(x=>x.width===1000&&x.state==='idle').data.rows[8];
const idle961=matrix.find(x=>x.width===961&&x.state==='idle').data.rows[8];
const preferredId=Math.max(...pressure.map(r=>r.id));
const idFloor=Math.min(...pressure.map(r=>r.id));
const effectiveTitleFloor=Math.min(...pressure.filter(r=>near(r.id,preferredId)).map(r=>r.title));
const blankPhase=pressure.filter(r=>near(r.id,preferredId)&&r.title>r.titleNatural+1);
const titlePhase=pressure.filter(r=>near(r.id,preferredId)&&r.title<r.titleNatural-1&&r.title>effectiveTitleFloor+1);
const idPhase=pressure.filter(r=>r.id<preferredId-1);
const monotone=(values)=>values.every((v,i)=>i===0||v<=values[i-1]+0.25);
check(blankPhase.length>0,`[ASSERT:SHRINK-BLANK-PHASE] no measured excess title-track reservation before ellipsis`);
check(titlePhase.length>0&&monotone(titlePhase.map(r=>r.title)),`[ASSERT:SHRINK-TITLE-PHASE] Title did not decrease monotonically toward measured floor`);
check(idPhase.length>0,`[ASSERT:SHRINK-ID-PHASE] no measured ID shrink phase after Title reached its floor`);
check(idPhase.length===0||idPhase.every(r=>r.title<=effectiveTitleFloor+0.25),`[ASSERT:SHRINK-ORDER-ID-LAST] ID shrank before Title reached effective floor ${effectiveTitleFloor}px`);
check(monotone(idPhase.map(r=>r.id))&&idFloor>=96,`[ASSERT:SHRINK-ID-FLOOR] ID phase non-monotone or below 6rem (${idFloor}px)`);
check(pressure.every((r,i)=>i===0||r.id<=pressure[i-1].id+0.25),`[ASSERT:SHRINK-PIECEWISE-MONOTONE] ID grew under increasing depth pressure`);
check(idle1200.rects.input.width>=idle1000.rects.input.width&&idle1000.rects.input.width>=idle961.rects.input.width,`[ASSERT:SHRINK-DESKTOP-MONOTONE] desktop ID widths are non-monotone`);
check(idle1000.rects.title.width>=200,`[ASSERT:DESKTOP-TITLE-BUDGET] desktop deep Title retained only ${idle1000.rects.title.width}px`);
const medium417=matrix.find(x=>x.width===417&&x.state==='idle').data.rows[8];
check(medium417.rects.kind.width<100,`[ASSERT:MEDIUM-KIND-SHRINK] 417px Kind ${medium417.rects.kind.width}px`);
for(const width of [1200,1000,961,960,417,416,415,360]){
  const idle=matrix.find(x=>x.width===width&&x.state==='idle').data.rows[4];
  const focused=matrix.find(x=>x.width===width&&x.state==='focus-id-depth4').data;
  check(focused.suggestions?.position==='absolute',`[ASSERT:ROW-SUGGESTIONS-OVERLAY] ${width}/ID focus position ${focused.suggestions?.position}`);
  check(near(focused.rows[4].rects.row.height,idle.rects.row.height),`[ASSERT:SUGGESTIONS-ROW-HEIGHT-STABLE] ${width}/ID focus`);
  check(near(focused.rows[4].rects.title.top,idle.rects.title.top)&&near(focused.rows[4].rects.input.top,idle.rects.input.top),`[ASSERT:SUGGESTIONS-BASELINE-STABLE] ${width}/ID focus`);
}
check(hitTests.every(hit=>hit.exact),`[ASSERT:DISCLOSURE-HIT-TARGET] center hit tests failed`);
for(const width of [959,960,961])check(matrix.some(x=>x.width===width&&x.state==='idle'),`[ASSERT:NAMED-CONTAINER-BOUNDARY] missing ${width}px sample`);
for(const interaction of addInteractions){
  check(!interaction.error,`${interaction.error??'[ASSERT:ADD-ACTION-EXISTS]'} d${interaction.depth}/${interaction.method}`);
  check(interaction.formExists&&interaction.inputExists&&interaction.listExists,`[ASSERT:ADD-MENU-EXISTS] d${interaction.depth}/${interaction.method} form=${interaction.formExists} input=${interaction.inputExists} list=${interaction.listExists}`);
  if(!interaction.formExists||!interaction.inputExists||!interaction.listExists)continue;
  check(interaction.expanded==='true',`[ASSERT:ADD-SUGGESTIONS-OPEN] d${interaction.depth}/${interaction.method} aria-expanded=${interaction.expanded}`);
  check(interaction.formDepth===String(interaction.depth),`[ASSERT:ADD-MENU-ATTACHED-DEPTH] expected ${interaction.depth}, got ${interaction.formDepth}`);
  check((interaction.overflow??Infinity)<=1,`[ASSERT:ADD-MENU-CONTAINER-BOUNDED] d${interaction.depth}/${interaction.method} overflow ${interaction.overflow}px`);
  if(interaction.form&&interaction.container)check(interaction.form.left>=interaction.container.left-1&&interaction.form.right<=interaction.container.right+1,`[ASSERT:ADD-FORM-RECT-BOUNDED] d${interaction.depth} form ${interaction.form.left}..${interaction.form.right}, container ${interaction.container.left}..${interaction.container.right}`);
  if(interaction.input&&interaction.list)check(intersection(interaction.input,interaction.list)<0.1,`[ASSERT:ADD-SUGGESTIONS-NO-FIELD-OVERLAP] d${interaction.depth}`);
  const visual=interaction.idVisual;
  const rangeContained=visual?.rangeRects?.length>1&&visual.rangeRects.every(rect=>interaction.list&&rect.left>=interaction.list.left-1&&rect.right<=interaction.list.right+1);
  check(visual?.text===ids[0]&&visual.whiteSpace==='normal'&&visual.overflowWrap==='anywhere'&&visual.textOverflow==='clip'&&visual.overflow!=='hidden'&&visual.scrollWidth<=visual.clientWidth+1&&visual.scrollHeight<=visual.clientHeight+1&&rangeContained,`[ASSERT:ADD-ID-VISUALLY-REACHABLE] d${interaction.depth} ${JSON.stringify(visual)}`);
  check(visual?.pointerReachable===true,`[ASSERT:ADD-ID-POINTER-REACHABLE] d${interaction.depth}`);
  check(interaction.activeDescendant===visual?.optionId,`[ASSERT:ADD-ID-KEYBOARD-REACHABLE] d${interaction.depth}`);
  if(interaction.selectionMethod)check(interaction.selectedValue===ids[0],`[ASSERT:ADD-ID-${interaction.selectionMethod.toUpperCase()}-SELECTABLE] d${interaction.depth} selected ${interaction.selectedValue}`);
}
check(errors.length===0,`[ASSERT:BROWSER-CONSOLE-CLEAN] emitted ${errors.length} errors/warnings`);
writeFileSync(resolve(out,'depth-width-matrix.json'),JSON.stringify({head:process.env.GITHUB_SHA||null,mutation,artifactBuild,priorArtifacts,buildStartedAt,fixtureSummary:{acceptanceDepths:'0-8',syntheticPressureDepths:'0-32',ids,kind:fixture.graph.kinds[0].name,title:fixture.graph.entries[0].title},pressure,shrinkPhases:{preferredId,idFloor,effectiveTitleFloor,blank:blankPhase,title:titlePhase,id:idPhase},menuMeta,addInteractions,hitTests,errors,failures,matrix},null,2));
console.log(JSON.stringify({cases:matrix.length,widths,mutation:mutation||null,assertions:'named geometry/overflow/shrink/add-interaction/baseline/hit-test',failures,errors:errors.length,artifactBuild,out:explicitOut?out:'OS_TEMP_CLEANED'},null,2));
return { failures, mutation };}

async function closeServer(instance) {
  if (!instance) return;
  await new Promise((resolveClose, rejectClose) => instance.close(error => error ? rejectClose(error) : resolveClose()));
}
async function cleanupHarness() {
  const errors=[];
  for (const socket of [ps,bs]) { try { socket?.close(); } catch (error) { errors.push(error); } }
  for (const child of [chrome,xvfb]) { try { await terminateProcessTree(child); } catch (error) { errors.push(error); } }
  try { await closeServer(server); } catch (error) { errors.push(error); }
  try { if (profile) rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100}); } catch (error) { errors.push(error); }
  try { if (out && !process.env.SNL_LIBRARY_GEOMETRY_OUT) rmSync(out,{recursive:true,force:true,maxRetries:5,retryDelay:100}); } catch (error) { errors.push(error); }
  if (artifactSnapshot) {
    try {
      restoreFiles(artifactSnapshot);
      const after=fileCensus(artifactPaths);
      if (!sameFileCensus(artifactCensusBefore,after)) throw new Error(`artifact census changed: ${JSON.stringify({before:artifactCensusBefore,after})}`);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new Error(errors.map(error=>error?.stack||String(error)).join('\n'));
}
let terminalResult;
try {
  const run=await runHarness();
  if (!run.failures.length) terminalResult={kind:'pass'};
  else {
    const ids=[...new Set(run.failures.flatMap(message=>[...message.matchAll(/\[ASSERT:([A-Z0-9-]+)\]/g)].map(match=>match[1])))];
    terminalResult={kind:'assertion',ids:ids.length?ids:['UNKNOWN']};
  }
} catch (error) {
  terminalResult={kind:'infra',id:'HARNESS',message:error?.stack||String(error)};
} finally {
  try { await cleanupHarness(); }
  catch (error) { terminalResult={kind:'infra',id:'CLEANUP',message:error?.stack||String(error)}; }
}
console.log(JSON.stringify(terminalResult));
process.exitCode=terminalResult.kind==='pass'?0:1;
