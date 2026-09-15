import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFileSync,mkdtempSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url).pathname;
const evidence=process.env.SNL_BROWSER_EVIDENCE;assert(evidence, 'Set SNL_BROWSER_EVIDENCE to an owned evidence directory');
const hash=()=>createHash('sha256').update(readFileSync(root+'media/webview/createEntry.js')).digest('hex');
const before=hash();
const styles=Object.fromEntries(['createEntry.css','createEntry2.css'].map(f=>[f,createHash('sha256').update(readFileSync(root+'media/webview/'+f)).digest('hex')]));
const ctx={type:'context',mode:'create',targetGeneration:1,seedId:'seed-entry',kinds:[{id:'definition',name:'Definition',description:'',coloring:{light:{stroke:'#555',background:'#eee'},dark:{stroke:'#888',background:'#222'}},numbering:'1',style:'default'}],macros:{},macroKinds:[],macroOrigin:{},existing:null,selectedPackage:'_unpackaged',entryPackages:['_unpackaged'],existingIds:[],relationships:[]};
const server=createServer((req,res)=>{if(req.url==='/' ){res.setHeader('Content-Type','text/html');res.end(`<html><head><link rel="stylesheet" href="/createEntry.css"><link rel="stylesheet" href="/createEntry2.css"></head><body><div id="root"></div><script>window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted.push(m),getState:()=>undefined,setState:()=>{}});window.__SNL_UI_LANGUAGE__='en';window.__SNL_LANGUAGE__='en';</script><script type="module" src="/createEntry.js"></script></body></html>`);}else if(/^\/(createEntry[^/]*\.(js|css|woff2?|ttf))$/.test(req.url)){res.setHeader('Content-Type',req.url.endsWith('js')?'text/javascript':'text/css');res.end(readFileSync(root+'media/webview'+req.url));}else {res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const chrome=['/home/argustest/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome','/usr/bin/chromium','/usr/bin/google-chrome'].find(existsSync);assert(chrome);
const profile=mkdtempSync('/tmp/snl-pkg.'); const proc=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
let wsurl='',err='';proc.stderr.on('data',b=>{err+=b;wsurl=err.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]||'';});
const delay=()=>new Promise(r=>setTimeout(r,30)); let socket;
try {
 for(let i=0;i<200&&!wsurl;i++)await delay();assert(wsurl,err);
 const targets=await fetch('http://127.0.0.1:'+new URL(wsurl).port+'/json/list').then(r=>r.json());
 socket=new WebSocket(targets[0].webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 let id=0;const pending=new Map();socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const [r,j]=pending.get(m.id);pending.delete(m.id);m.error?j(Error(JSON.stringify(m.error))):r(m.result);}};
 const call=(method,params={})=>new Promise((r,j)=>{const n=++id;pending.set(n,[r,j]);socket.send(JSON.stringify({id:n,method,params}));});
 const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value;};
 const wait=async expression=>{for(let i=0;i<200;i++){if(await ev(expression))return;await delay();}throw Error('Timeout '+expression+' '+await ev('document.body.innerText'));};
 const send=async data=>ev('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify(data)+'}))');
 const paint=()=>ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const click=async expression=>{
   const rect=await ev(`(async()=>{const b=${expression};if(!b||b.disabled)throw Error('Missing/disabled control');b.scrollIntoView({behavior:'instant',block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const r=b.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(hit!==b&&!b.contains(hit))throw Error('Control center occluded');return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
   for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,...rect,button:'left',clickCount:1});
 };
 const button=name=>`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(name)})`;
 const input=async (expression,text)=>{await click(expression);await call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await call('Input.insertText',{text});};
 const results=[];
 for(const order of ['context-first','retarget-first']) {
   await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});
   await wait('window.__posted?.some(x=>x.type==="ready")');
   await send(ctx);await wait('!!document.querySelector("#snl-entry-package")');
   await send({type:'openPackageCreator',targetGeneration:1});
   await wait('[...document.querySelectorAll("label")].some(x=>x.textContent.includes("New Entry Package ID"))');
   await input(`(()=>{const l=[...document.querySelectorAll('label')].find(x=>x.textContent.includes('New Entry Package ID'));return document.getElementById(l.htmlFor)||l.querySelector('input');})()`,'Algebra');
   await click(button('Add Entry Package'));
   await wait('window.__posted.some(x=>x.type==="createPackage")');
   const req=await ev('window.__posted.findLast(x=>x.type==="createPackage")');
   await send({type:'packageCreated',packageId:'Algebra',requestId:'stale',targetGeneration:1});await paint();
   assert.equal(await ev('document.querySelector("#snl-entry-package").value'),'Unpackaged (_unpackaged)');
   await send({type:'packageCreated',packageId:'Algebra',requestId:req.requestId,targetGeneration:1});
   await wait('document.querySelector("#snl-entry-package").value==="Algebra"');
   for(let i=0;i<2;i++) {await send({...ctx,entryPackages:['_unpackaged','Algebra','Logic']});await paint();assert.equal(await ev('document.querySelector("#snl-entry-package").value'),'Algebra');}
   const context={...ctx,targetGeneration:2,selectedPackage:'Logic',seedId:'new-target',entryPackages:['_unpackaged','Algebra','Logic']};
   const retarget={type:'retarget',mode:'create',targetGeneration:2};
   for(const msg of order==='context-first'?[context,retarget]:[retarget,context]) {await send(msg);await paint();}
   for(let i=0;i<2;i++) {await send(context);await paint();}
   await send({type:'packageCreated',packageId:'Algebra',requestId:req.requestId,targetGeneration:1});await paint();
   await input(`document.querySelector('#snl-entry-title')`,'New target');
   await input(`document.querySelector('#snl-entry-id')`,'new-target');
   await click(button('Create Entry'));
   await wait('window.__posted.some(x=>x.type==="create")');
   const creates=await ev('window.__posted.filter(x=>x.type==="create")');
   assert.equal(creates.length,1);assert.equal(creates[0].entry.id,'new-target');assert.equal(creates[0].entry.package,'Logic');
   assert.equal(await ev('document.querySelector("#snl-entry-package").value'),'Logic');
   const screenshot=await call('Page.captureScreenshot',{format:'png'});
   writeFileSync(evidence+'/'+order+'.png',Buffer.from(screenshot.data,'base64'));
   results.push({order,create:creates[0],same_generation_refreshes:2,new_generation_refreshes:2,real_clicks:true});
 }
 assert.equal(hash(),before);
 for(const [file,digest] of Object.entries(styles))assert.equal(createHash('sha256').update(readFileSync(root+'media/webview/'+file)).digest('hex'),digest);
 const receipt={status:'PASS',bundle_sha256:before,styles,results,boundary:'Linux Chromium, fresh production module JS/CSS, controlled Host messages; not installed VSIX'};
 writeFileSync(evidence+'/browser-result.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
} finally {socket?.close();proc.kill();await new Promise(r=>proc.once('exit',r));server.close();rmSync(profile,{recursive:true,force:true});}
