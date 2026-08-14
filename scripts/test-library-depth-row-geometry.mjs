#!/usr/bin/env node
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=process.env.SNL_LIBRARY_GEOMETRY_OUT || resolve(root,'.hermes/library-depth-geometry');
const bundle=resolve(root,'media/webview');
mkdirSync(out,{recursive:true});
const viteBin=resolve(root,'node_modules/vite/bin/vite.js');
const buildStartedAt=Date.now();
const build=spawnSync(process.execPath,[viteBin,'build','--config',resolve(root,'webview/vite.config.ts')],{cwd:root,env:{...process.env,SNL_WEBVIEW_ENTRY:'createLibrary'},stdio:'inherit'});
if(build.status!==0)process.exit(build.status??1);
for(const f of ['createLibrary.js','createLibrary.css']) if(!existsSync(resolve(bundle,f))) throw new Error(`missing production artifact ${f}`);
for(const f of ['createLibrary.js','createLibrary.css']) if(statSync(resolve(bundle,f)).mtimeMs<buildStartedAt-1000) throw new Error(`stale production artifact ${f}`);
const localized=(v)=>({type:'localized',values:{en:v,'zh-CN':`超长本地化${v}`},default_language:'en'});
const ids=Array.from({length:9},(_,d)=>`entry-depth-${d}-identifier-with-a-deliberately-long-editable-suffix-ABCDEFGHIJKLMN`);
const nodes=ids.map((id,d)=>({id:`node-depth-${d}`,label:'Entry',props:{entryId:id,counterId:'counter-long'}}));
const fixture={
 context:{type:'context',mode:'edit',targetState:'found',slug:'deep-width-probe',libraryRevision:'probe',existing:{slug:'deep-width-probe',title:'Deep width probe'}},
 graph:{type:'graph',nodes,relationships:nodes.slice(1).map((n,i)=>({from:nodes[i].id,to:n.id,label:'branch'})),entries:ids.map((id,d)=>({id,kind:'localized-kind',title:localized(`An exceptionally long localized title at depth ${d} that must truncate before the editable identifier becomes unusable`),content:{snl:`Definition(Depth${d})`}})),kinds:[{id:'localized-kind',name:localized('Extraordinarily Long Localized Definition Kind Badge'),description:localized('Long kind description'),defaultCounterName:'section'}],metricMacroSources:{},metricThresholds:{structuralIndexRedBelow:60,structuralIndexGreenAtLeast:80},warnings:[]},
 counters:{type:'countersLoaded',counters:[{id:'counter-long',name:'a-very-long-localized-counter-name',numbering:'1',children:[]}]}
};
const mutation=process.env.SNL_LIBRARY_GEOMETRY_MUTATION||'';
const mutationCss={
  'reservation-11.3':'.snl-library-outline-row{--snl-library-toolbar-reservation:11.3rem!important}',
  'reveal-5.1':'.snl-library-outline-row.snl-library-outline-row:hover,.snl-library-outline-row.snl-library-outline-row:has(>.snl-outline-row-toolbar:focus-within){padding-right:5.1rem!important}',
  'depth-wrap':'.snl-library-outline-row:has([data-snl-library-row-main][style*="4.5rem"])>.snl-outline-row-content{flex:1 0 100%!important}',
  'title-8rem':'.snl-library-outline-row-main{grid-template-columns:calc(8rem + var(--snl-library-outline-depth-offset,0rem)) fit-content(10rem) minmax(7rem,11rem) minmax(8rem,1fr)!important}',
  'medium-max-content':'@container snl-outline (min-width:26.0625rem) and (max-width:60rem){.snl-library-outline-kind{width:max-content!important}}',
  'suggestions-in-flow':'.snl-library-outline-entry-id [role="listbox"]{position:static!important;margin-top:2px!important}'
}[mutation]||'';
const html=`<!doctype html><html lang="en" data-snl-color-scheme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/createLibrary.css"><style>html{font-size:16px}body{margin:0;color:#ddd;background:#1e1e1e;font-family:Arial,sans-serif}${mutationCss}</style><script>window.__posted=[];window.acquireVsCodeApi=()=>({postMessage(m){__posted.push(m);if(m?.type==='ready'){for(const p of ${JSON.stringify([fixture.context,fixture.graph,fixture.counters])})dispatchEvent(new MessageEvent('message',{data:p}))}},getState(){},setState(){}})</script></head><body><div id="root"></div><script src="/createLibrary.js"></script></body></html>`;
const mime={'.js':'text/javascript','.css':'text/css'};
const server=createServer((req,res)=>{const p=new URL(req.url,'http://x').pathname;if(p==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(html);return}if(p==='/favicon.ico'){res.writeHead(204);res.end();return}const f=resolve(bundle,p.slice(1));if(!f.startsWith(bundle)||!existsSync(f)){res.writeHead(404);res.end();return}res.writeHead(200,{'content-type':mime[extname(f)]||'application/octet-stream'});res.end(readFileSync(f))});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const chromeCandidates=[process.env.SNL_CHROMIUM_PATH,resolve(process.env.HOME||'','.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'),'/usr/bin/chromium','/usr/bin/google-chrome'].filter(Boolean);
const chromePath=chromeCandidates.find(existsSync);if(!chromePath)throw new Error('chromium missing');
const profile=mkdtempSync(resolve(tmpdir(),'snl-depth-width-'));const display=`:${300+process.pid%300}`;
const xvfb=spawn('/usr/bin/Xvfb',[display,'-screen','0','1600x2000x24','-nolisten','tcp','-ac'],{stdio:'ignore'});await new Promise(r=>setTimeout(r,150));
const chrome=spawn(chromePath,['--no-sandbox','--disable-gpu','--hide-scrollbars','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--window-size=1600,2000','about:blank'],{stdio:['ignore','ignore','pipe'],env:{...process.env,DISPLAY:display}});
let ws='',stderr='';chrome.stderr.setEncoding('utf8');chrome.stderr.on('data',c=>{stderr+=c;ws||=c.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]||''});for(let i=0;i<120&&!ws;i++)await new Promise(r=>setTimeout(r,25));if(!ws)throw new Error(stderr);
class Cdp{constructor(s){this.s=s;this.n=1;this.p=new Map;this.events=[];s.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=this.p.get(m.id);if(!p)return;this.p.delete(m.id);m.error?p.j(Error(JSON.stringify(m.error))):p.r(m.result)}else this.events.push(m)})}call(method,params={}){const id=this.n++;this.s.send(JSON.stringify({id,method,params}));return new Promise((r,j)=>this.p.set(id,{r,j}))}}
async function open(url){const bs=new WebSocket(ws);await new Promise((r,j)=>{bs.addEventListener('open',r,{once:true});bs.addEventListener('error',j,{once:true})});const b=new Cdp(bs);const {targetId}=await b.call('Target.createTarget',{url});let pws='';for(let i=0;i<100&&!pws;i++){const a=await fetch(`http://127.0.0.1:${new URL(ws).port}/json/list`).then(r=>r.json());pws=a.find(x=>x.id===targetId)?.webSocketDebuggerUrl||'';if(!pws)await new Promise(r=>setTimeout(r,25))}const ps=new WebSocket(pws);await new Promise((r,j)=>{ps.addEventListener('open',r,{once:true});ps.addEventListener('error',j,{once:true})});const p=new Cdp(ps);await p.call('Runtime.enable');await p.call('Page.enable');await p.call('Log.enable');return{b,p,bs,ps}}
const {p,bs,ps}=await open(`http://127.0.0.1:${port}/`);
async function evalv(expression){const q=await p.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(q.exceptionDetails)throw new Error(JSON.stringify(q.exceptionDetails));return q.result.value}
for(let i=0;i<200;i++){if(await evalv(`document.querySelectorAll('.snl-library-outline-row').length===9`))break;await new Promise(r=>setTimeout(r,25))}
async function setWidth(w,coarse=false){await p.call('Emulation.setDeviceMetricsOverride',{width:1400,height:1800,deviceScaleFactor:1,mobile:false});await p.call('Emulation.setTouchEmulationEnabled',{enabled:coarse,maxTouchPoints:coarse?5:1});await evalv(`(()=>{let c=document.querySelector('.snl-library-outline-row');while(c&&!getComputedStyle(c).containerName.split(/\\s+/).includes('snl-outline'))c=c.parentElement;if(!c)throw Error('named container missing');Object.assign(c.style,{boxSizing:'content-box',width:'${w}px',minWidth:'${w}px',maxWidth:'${w}px'});document.querySelectorAll('input[aria-expanded="true"]').forEach(e=>{e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))});document.activeElement?.blur();scrollTo(0,0)})()`);await p.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2});await new Promise(r=>setTimeout(r,160))}
const inspect=`(()=>{const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{left:+r.left.toFixed(2),right:+r.right.toFixed(2),top:+r.top.toFixed(2),bottom:+r.bottom.toFixed(2),width:+r.width.toFixed(2),height:+r.height.toFixed(2)}};const css=e=>{if(!e)return null;const s=getComputedStyle(e);return{display:s.display,boxSizing:s.boxSizing,width:s.width,minWidth:s.minWidth,maxWidth:s.maxWidth,paddingLeft:s.paddingLeft,paddingRight:s.paddingRight,gap:s.gap,marginLeft:s.marginLeft,flex:s.flex,gridTemplateColumns:s.gridTemplateColumns,overflow:s.overflow,whiteSpace:s.whiteSpace,opacity:s.opacity,pointerEvents:s.pointerEvents,transform:s.transform}};const rows=[...document.querySelectorAll('.snl-library-outline-row')];let container=rows[0];while(container&&!getComputedStyle(container).containerName.split(/\\s+/).includes('snl-outline'))container=container.parentElement;return{media:{hover:matchMedia('(hover:hover)').matches,fine:matchMedia('(pointer:fine)').matches,coarse:matchMedia('(pointer:coarse)').matches},viewport:{innerWidth,docClient:document.documentElement.clientWidth,docScroll:document.documentElement.scrollWidth},container:{rect:rect(container),clientWidth:container.clientWidth,scrollWidth:container.scrollWidth,css:css(container)},rows:rows.map((row,depth)=>{const q=s=>row.querySelector(s),main=q('[data-snl-library-row-main]'),content=q(':scope > .snl-outline-row-content'),disc=q(':scope > button[aria-expanded], :scope > .snl-outline-disclosure-spacer'),counter=q('.snl-library-outline-counter'),kind=q('.snl-library-outline-kind'),id=q('.snl-library-outline-entry-id'),input=id?.querySelector('input'),title=q('.snl-outline-row-title'),toolbar=q(':scope > .snl-outline-row-toolbar'),cluster=q('.snl-tree-operation-cluster'),dial=q('.snl-tree-operation-dial'),metric=q('.snl-library-outline-metric'),menu=q('.snl-tree-add-menu');const rr=rect(row),mr=rect(main),tr=rect(title),ir=rect(input),tb=rect(toolbar);const hit=disc?document.elementFromPoint((rect(disc).left+rect(disc).right)/2,(rect(disc).top+rect(disc).bottom)/2):null;return{depth,leaf:!disc?.matches('button'),rects:{row:rr,disclosure:rect(disc),content:rect(content),main:mr,counter:rect(counter),kind:rect(kind),idSlot:rect(id),input:ir,title:tr,toolbar:tb,cluster:rect(cluster),dial:rect(dial),metric:rect(metric),menu:rect(menu)},css:{row:css(row),content:css(content),main:css(main),counter:css(counter),kind:css(kind),idSlot:css(id),input:css(input),title:css(title),toolbar:css(toolbar)},intrinsic:{kindClient:kind?.clientWidth,kindScroll:kind?.scrollWidth,inputClient:input?.clientWidth,inputScroll:input?.scrollWidth,titleClient:title?.clientWidth,titleScroll:title?.scrollWidth},spaces:{beforeMain:mr&&rr?+(mr.left-rr.left).toFixed(2):null,afterMain:mr&&rr?+(rr.right-mr.right).toFixed(2):null,titleToToolbar:tr&&tb?+(tb.left-tr.right).toFixed(2):null,mainToToolbar:mr&&tb?+(tb.left-mr.right).toFixed(2):null},oneLine:ir&&tr?Math.abs(ir.top-tr.top)<1:false,overflow:{main:main.scrollWidth-main.clientWidth,row:row.scrollWidth-row.clientWidth},disclosureHit:hit?{tag:hit.tagName,cls:String(hit.className),label:hit.getAttribute('aria-label')}:null}}),buttons:[...document.querySelectorAll('.snl-library-outline-row button')].map(b=>({label:b.getAttribute('aria-label'),title:b.title,cls:b.className}))}})()`;
const widths=[1200,1100,1000,961,960,600,480,417,416,415,360];const matrix=[];
async function capture(name){const {data}=await p.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,fromSurface:true});writeFileSync(resolve(out,name),Buffer.from(data,'base64'))}
for(const w of widths){await setWidth(w,false);matrix.push({width:w,state:'idle',data:await evalv(inspect)});if(w===1000)await capture('depth-width-1000-idle.png');if([1200,1000,961,960,417,416,415,360].includes(w)){const r=await evalv(`(()=>{const x=document.querySelectorAll('.snl-library-outline-row')[4].getBoundingClientRect();return{x:(x.left+x.right)/2,y:(x.top+x.bottom)/2}})()`);await p.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:r.x,y:r.y});await new Promise(r=>setTimeout(r,140));matrix.push({width:w,state:'hover-depth4',data:await evalv(inspect)});if([1000,960,416,360].includes(w))await capture(`depth-width-${w}-hover.png`);await p.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2});await evalv(`(()=>{const i=document.querySelectorAll('.snl-library-outline-row')[4].querySelector('input');i.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'entry-depth');i.dispatchEvent(new Event('input',{bubbles:true}))})()`);await new Promise(r=>setTimeout(r,140));const focusData=await evalv(inspect);focusData.suggestions=await evalv(`(()=>{const e=document.querySelectorAll('.snl-library-outline-row')[4].querySelector('[role="listbox"]');if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return{position:s.position,top:+r.top.toFixed(2),bottom:+r.bottom.toFixed(2),height:+r.height.toFixed(2)}})()`);matrix.push({width:w,state:'focus-id-depth4',data:focusData});if(w===1000)await capture('depth-width-1000-focus-id.png');await evalv(`(()=>{const i=document.querySelectorAll('.snl-library-outline-row')[4].querySelector('input');i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.querySelectorAll('.snl-library-outline-row')[4].querySelector('.snl-tree-operation-dial button:not(:disabled)').focus()})()`);await new Promise(r=>setTimeout(r,140));matrix.push({width:w,state:'focus-toolbar-depth4',data:await evalv(inspect)})}}
for(const w of [1000,960,416,360]){await setWidth(w,true);matrix.push({width:w,state:'coarse',data:await evalv(inspect)})}
const hitTests=[];for(const w of [1000,417,416,360]){await setWidth(w,false);for(let depth=0;depth<9;depth++){hitTests.push({width:w,depth,...await evalv(`(()=>{const row=document.querySelectorAll('.snl-library-outline-row')[${depth}],d=row.querySelector(':scope > button[aria-expanded], :scope > .snl-outline-disclosure-spacer');d.scrollIntoView({block:'center'});const r=d.getBoundingClientRect(),e=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return{expected:d.matches('button')?'button':'spacer',hitTag:e?.tagName||null,hitLabel:e?.getAttribute('aria-label')||null,hitClass:String(e?.className||''),exact:e===d||d.contains(e)}})()`)});}}
await setWidth(1000,false);const menuMeta=await evalv(`(()=>{const row=document.querySelectorAll('.snl-library-outline-row')[4];return[...row.querySelectorAll('button')].map((b,i)=>({i,label:b.getAttribute('aria-label'),title:b.title,cls:b.className}))})()`);const addIndex=menuMeta.find(x=>/add sibling/i.test((x.label||'')+' '+(x.title||'')))?.i ?? menuMeta.find(x=>/add/i.test((x.label||'')+' '+(x.title||'')))?.i;if(addIndex!==undefined){await evalv(`document.querySelectorAll('.snl-library-outline-row')[4].querySelectorAll('button')[${addIndex}].click()`);await new Promise(r=>setTimeout(r,140));matrix.push({width:1000,state:'menu-depth4',data:await evalv(inspect)});await capture('depth-width-1000-menu.png')}
await setWidth(1000,false);
const errors=p.events.filter(e=>e.method==='Runtime.exceptionThrown'||e.method==='Log.entryAdded'&&['error','warning'].includes(e.params?.entry?.level));
const artifactBuild=Object.fromEntries(['createLibrary.js','createLibrary.css'].map(f=>[f,{sha256:createHash('sha256').update(readFileSync(resolve(bundle,f))).digest('hex')} ]));
const failures=[];
const check=(ok,message)=>{if(!ok)failures.push(message)};
const near=(a,b,tolerance=0.2)=>Math.abs(a-b)<=tolerance;
const intersection=(a,b)=>!a||!b?0:Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
for(const sample of matrix){
  if(sample.state!=='menu-depth4')check(sample.data.container.scrollWidth-sample.data.container.clientWidth<=1,`${sample.width}/${sample.state}: container overflow`);
  for(const row of sample.data.rows){
    check(row.overflow.row<=1&&row.overflow.main<=1,`${sample.width}/${sample.state}/d${row.depth}: row overflow`);
    check(intersection(row.rects.counter,row.rects.kind)<0.1,`${sample.width}/${sample.state}/d${row.depth}: counter intersects Kind`);
    check(intersection(row.rects.disclosure,row.rects.counter)<0.1,`${sample.width}/${sample.state}/d${row.depth}: disclosure intersects counter`);
    if(sample.width>=961&&!sample.data.media.coarse){
      check(intersection(row.rects.toolbar,row.rects.title)<0.1,`${sample.width}/${sample.state}/d${row.depth}: toolbar intersects Title`);
      check(intersection(row.rects.toolbar,row.rects.input)<0.1,`${sample.width}/${sample.state}/d${row.depth}: toolbar intersects ID`);
    }
  }
}
for(const width of [1200,1000,961]){
  const states=matrix.filter(x=>x.width===width&&['idle','hover-depth4','focus-id-depth4','focus-toolbar-depth4'].includes(x.state));
  for(const sample of states){
    const row=sample.data.rows[4];
    check(near(row.spaces.afterMain,152),`${width}/${sample.state}: reservation ${row.spaces.afterMain}px != 152px`);
    check(row.spaces.titleToToolbar>=-0.2,`${width}/${sample.state}: content crosses toolbar by ${-row.spaces.titleToToolbar}px`);
  }
  const idle=matrix.find(x=>x.width===width&&x.state==='idle');
  check(idle.data.rows.every(row=>row.oneLine),`${width}/idle: depth row wrapped`);
  const heights=idle.data.rows.map(row=>row.rects.row.height);
  check(Math.max(...heights)-Math.min(...heights)<1,`${width}/idle: depth changes row height`);
}
const idle1200=matrix.find(x=>x.width===1200&&x.state==='idle').data.rows[8];
const idle1000=matrix.find(x=>x.width===1000&&x.state==='idle').data.rows[8];
const idle961=matrix.find(x=>x.width===961&&x.state==='idle').data.rows[8];
check(near(idle1200.rects.title.width-idle1000.rects.title.width,200),`blank→Title priority failed from 1200→1000`);
check(near(idle1000.rects.title.width-idle961.rects.title.width,39),`Title priority failed from 1000→961`);
check(near(idle1200.rects.input.width,idle1000.rects.input.width)&&near(idle1000.rects.input.width,idle961.rects.input.width),`ID shrank before Title budget was exhausted`);
check(idle1000.rects.title.width>=200,`desktop deep Title retained only ${idle1000.rects.title.width}px`);
const medium417=matrix.find(x=>x.width===417&&x.state==='idle').data.rows[8];
check(medium417.rects.kind.width<100,`417px medium Kind did not shrink (${medium417.rects.kind.width}px)`);
for(const width of [1200,1000,961,960,417,416,415,360]){
  const idle=matrix.find(x=>x.width===width&&x.state==='idle').data.rows[4];
  const focused=matrix.find(x=>x.width===width&&x.state==='focus-id-depth4').data;
  check(focused.suggestions?.position==='absolute',`${width}/ID focus: suggestions are not an overlay`);
  check(near(focused.rows[4].rects.row.height,idle.rects.row.height),`${width}/ID focus: row height changed`);
  check(near(focused.rows[4].rects.title.top,idle.rects.title.top)&&near(focused.rows[4].rects.input.top,idle.rects.input.top),`${width}/ID focus: baseline moved`);
}
check(hitTests.every(hit=>hit.exact),`disclosure center hit tests failed`);
check(errors.length===0,`browser console emitted ${errors.length} errors/warnings`);
writeFileSync(resolve(out,'depth-width-matrix.json'),JSON.stringify({head:process.env.GITHUB_SHA||null,mutation,artifactBuild,fixtureSummary:{depths:'0-8',ids,kind:fixture.graph.kinds[0].name,title:fixture.graph.entries[0].title},menuMeta,addIndex,hitTests,errors,failures,matrix},null,2));
console.log(JSON.stringify({cases:matrix.length,widths,mutation:mutation||null,assertions:'geometry/overflow/baseline/hit-test',failures,errors:errors.length,artifactBuild,out},null,2));
ps.close();bs.close();server.close();chrome.kill('SIGTERM');await new Promise(r=>{if(chrome.exitCode!==null)r();else{chrome.once('exit',r);setTimeout(r,1000)}});xvfb.kill('SIGTERM');rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
if(failures.length)process.exit(1);
