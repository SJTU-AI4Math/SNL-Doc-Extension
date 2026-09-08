#!/usr/bin/env node
// Production-artifact browser harness, not a full Extension/F5 acceptance claim.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, copyFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
let pw;
for (const p of [process.env.SNL_PLAYWRIGHT_PATH, 'playwright', 'playwright-core', '/tmp/snl-viewer-browser-tools/node_modules/playwright-core']) {
  if (!p) continue;
  try { pw = require(p); break; } catch {}
}
if (!pw) throw Error('Install playwright-core or set SNL_PLAYWRIGHT_PATH');
const executablePath = [process.env.SNL_CHROMIUM_PATH, resolve(process.env.HOME || '', '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'), '/usr/bin/chromium'].find(p => p && existsSync(p));
const dir = process.env.SNL_SOURCE_EVIDENCE || mkdtempSync(resolve(tmpdir(), 'snl-source-viewer-'));
mkdirSync(dir, { recursive: true });
const runtimeBuild=await build({absWorkingDir:root,entryPoints:['src/exportRuntime.ts'],bundle:true,format:'esm',platform:'node',write:false});
const runtime=await import('data:text/javascript;base64,'+Buffer.from(runtimeBuild.outputFiles[0].text).toString('base64'));
const scopeBuild=await build({absWorkingDir:root,entryPoints:['src/pointerSync/scope.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {compilePointerScope}=await import('data:text/javascript;base64,'+Buffer.from(scopeBuild.outputFiles[0].text).toString('base64'));
const text = 'theorem 中文 (α : Nat) : α = α := by\n  /- outer /- inner -/\n  theorem stays comment -/\n  let s := "theorem 中文\\n"\n  have n := 0x2a\n  rfl\n'+Array.from({length:140},(_,i)=>`-- line ${i+7}`).join('\n');
const sha = b => createHash('sha256').update(b).digest('hex');
const bytes = Buffer.from(text);
const safe = x => JSON.stringify(x).replaceAll('<', '\\u003c');
const files=[],chunks=[];
function file(id,displayPath,bytes,kind='text') {const hash=sha(bytes);files.push({fileId:id,displayPath,kind,language:displayPath.endsWith('.lean')?'lean4':'plaintext',byteLength:bytes.length,sha256:hash,bom:false,eol:'lf',chunkId:'source-'+id+'.js'});chunks.push({fileId:id,sha256:hash,base64:bytes.toString('base64')});}
file('f-one','Main.lean',bytes);
for(let i=2;i<=7;i++)file('f-'+i,'Library/File'+i+'.lean',Buffer.from('def value := '+i+'\n'));
file('binary','data/unsafe.html',Buffer.from('<script>globalThis.SOURCE_EXECUTED=true</script>\u0000'),'binary');
file('bad','broken.lean',Buffer.from('bad'));chunks.at(-1).base64=Buffer.from('BAD').toString('base64');
const p=(entryId,line,endLine=line)=>{const pointer={mode:'lines',file:'Main.lean',line,endLine};const range={startLine:line,startColumn:1,endLine,endColumn:2,coveredEndLine:endLine};return {entryId,pointer,fileId:'f-one',sourceSha256:sha(bytes),range,inverseScope:compilePointerScope(pointer,range,text),status:'ok'};};
const manifest = { schemaVersion: 'snl.export.sources/v2', exportId: 'export-1', renderSnapshotId: 'render-1', workspaceName: 'Offline Lean', snapshot: {mode:'disk'}, options:{scope:'project',keep:[],exclude:[],companionFiles:[]}, files,directories:['Library','empty'],pointers:[p('Demo',1,6),p('Tie',40),p('Other',40),p('Later',80)],entryRoutes:[{entryId:'Demo',nodeId:'node-demo',hash:'#/node/node-demo'},{entryId:'Tie',nodeId:'node-tie-a',hash:'#/node/node-tie-a'},{entryId:'Tie',nodeId:'node-tie-b',hash:'#/node/node-tie-b'},{entryId:'Other',hash:'#/entry/Other'},{entryId:'Later',nodeId:'node-later',hash:'#/node/node-later'}] };
const js = readFileSync(resolve(root,'media/sourceViewer.js'),'utf8');
const css = readFileSync(resolve(root,'media/sourceViewer.css'),'utf8');
assert(!/url\((?!["']?data:)[^)]+\)/.test(css),'CSS has an external asset dependency');
assert(css.includes('@font-face')&&css.includes('data:font/ttf;base64,'),'codicon font must be embedded');
const register=chunks.map(c=>`globalThis.__snlSourceChunks.set(${safe(c.fileId)},${safe(c)});`).join('\n');
for (const f of ['sourceViewer.js','sourceViewer.css']) copyFileSync(resolve(root,'media',f),resolve(dir,f));
for(const c of chunks)writeFileSync(resolve(dir,'source-'+c.fileId+'.js'),`globalThis.__snlSourceChunks.set(${safe(c.fileId)},${safe(c)});`);
const entryHeader = title => `<header class="snl-entry-header" style="display:flex;align-items:baseline;gap:0.5rem;min-width:0;padding:0.275rem 0.8rem"><strong class="snl-entry-title" style="flex:1 1 auto;min-width:0;font-size:1.25rem;overflow-wrap:anywhere">${title}</strong></header>`;
async function assertSourceHeaders(page, scope='') {
  const rows=await page.locator(scope+' .snl-entry-header').evaluateAll(headers=>headers.map(header=>{
    const action=header.querySelector('[data-snl-source-entry]');
    const title=header.querySelector('.snl-entry-title');
    const h=header.getBoundingClientRect(), a=action?.getBoundingClientRect(), t=title?.getBoundingClientRect();
    return {parent:action?.parentElement===header,text:action?.textContent,label:action?.getAttribute('aria-label'),nativeClass:action?.classList.contains('snl-entry-source-action'),noFooterClass:!action?.classList.contains('snl-source-entry-action'),shrink:action?getComputedStyle(action).flexShrink:null,right:a&&t&&a.left>=t.right-1,inside:a&&a.right<=h.right+1&&a.top>=h.top-1&&a.bottom<=h.bottom+1};
  }));
  assert(rows.length>0,'Expected rendered Entry headers');
  for(const row of rows) {
    assert.equal(row.parent,true,'Source must remain a direct child of the Extension Entry header');
    assert.equal(row.text,'↗ source');assert.equal(row.label,'Open source');
    assert(row.nativeClass&&row.noFooterClass);assert.equal(row.shrink,'0');
    assert(row.right&&row.inside,'Source must remain at the right of the title, inside the header');
  }
}
const body = locale => `<section data-snl-route-id="node-demo"><article class="snl-entry snl-entry-surface" data-entry-id="Demo">${entryHeader(locale==='en'?'Reflexivity':'自反性')}<p>Source and document share a frozen snapshot.</p><a data-src="Other" href="#/entry/Other">Other entry</a></article></section><section data-snl-route-id="node-tie-a"><article class="snl-entry" data-entry-id="Tie">${entryHeader("Tied occurrence A")}</article></section><section data-snl-route-id="node-tie-b"><article class="snl-entry" data-entry-id="Tie">${entryHeader("Tied occurrence B")}</article></section><section data-snl-route-id="node-later"><article class="snl-entry" data-entry-id="Later">${entryHeader("Later theorem")}</article></section>`;
const popovers={Other:`<article class="snl-entry snl-entry-surface" data-entry-id="Other">${entryHeader('Popover-only entry')}<p>Offline route.</p></article>`};
const variants={initialLocale:'en',initialColorScheme:'light',variants:['en','zh-CN'].flatMap(locale=>['light','dark'].map(colorScheme=>({locale,colorScheme,languageLabel:locale,body:body(locale),popovers})))};
function html(inline,withSources=true,override=manifest) {return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline' blob:; worker-src blob:; style-src 'self' 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'"><link rel="icon" href="data:,"><title>Offline source proof</title><style>body{margin:0;font:16px/1.6 system-ui;background:#fff}.snl-export{padding:24px;box-sizing:border-box}section{padding:20px;border-bottom:1px solid #8884}html[data-snl-color-scheme=dark]{color-scheme:dark;--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#ddd}html[data-snl-color-scheme=dark] body{background:#1e1e1e;color:#ddd}${runtime.EXPORT_RUNTIME_CSS}</style>${inline?`<style>${css}</style>`:'<link rel="stylesheet" href="sourceViewer.css">'}<body><main class="snl-export"><h1>Offline Lean</h1><div data-snl-export-body>${body('en')}</div></main><script>globalThis.MonacoEnvironment={globalAPI:true};globalThis.__SNL_POPOVERS__=${safe(popovers)};globalThis.__SNL_EXPORT_VARIANTS__=${safe(variants)};${withSources?`globalThis.__snlSources=${safe(override)};`:''}globalThis.__snlSourceChunks=new Map();${inline?register:''}history.replaceState({routerOwned:'preserve-me'},'');</script><script>${runtime.EXPORT_RUNTIME_WIRING_JS.replaceAll('</script','<\\/script')}</script>${inline?`<script>${js.replaceAll('</script','<\\/script')}</script>`:'<script src="sourceViewer.js"></script>'}</body></html>`;}
writeFileSync(resolve(dir,'directory.html'),html(false));writeFileSync(resolve(dir,'inline.html'),html(true));writeFileSync(resolve(dir,'none.html'),html(true,false));writeFileSync(resolve(dir,'invalid.html'),html(true,true,{...manifest,schemaVersion:'unknown'}));
const server = createServer((req,res) => { try { const p=resolve(dir, '.'+new URL(req.url,'http://localhost').pathname);res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html');res.end(readFileSync(p)); } catch {res.statusCode=404;res.end();} });
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const browser = await pw.chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
const results=[];
try {
for (const [mode,url] of [['http',`http://127.0.0.1:${server.address().port}/directory.html`],['directory-file',pathToFileURL(resolve(dir,'directory.html')).href],['inline-file',pathToFileURL(resolve(dir,'inline.html')).href]]) {
  const context=await browser.newContext({viewport:{width:1400,height:900},acceptDownloads:true});const page=await context.newPage();const errors=[],requests=[];
  page.on('pageerror',e=>{errors.push(String(e));console.error('PAGE ERROR',e);});page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')errors.push(m.text());});page.on('requestfailed',r=>errors.push('requestfailed '+r.url()));page.on('request',r=>requests.push(r.url()));
  await page.route('**/*',route=>{const u=route.request().url();if(u.startsWith('http')&&!u.startsWith('http://127.0.0.1:'))return route.abort();return route.continue();});
  if(mode!=='http')await context.setOffline(true);
  await page.goto(url);
  await page.waitForSelector('.snl-source-open');
  assert.equal(await page.locator('.monaco-editor').count(),0,'must not create editor before opening');
  assert.equal(await page.locator('.snl-source-panel').isVisible(),false);
  await assertSourceHeaders(page,'main');
  const start=Date.now();await page.locator('[data-snl-source-entry="Demo"]').click();await page.waitForSelector('.snl-source-editor[data-ready]');
  await page.waitForFunction(()=>window.monaco.editor.getEditors()[0]?.getValue().startsWith('theorem'));
  const firstOpenMs=Date.now()-start;
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  assert.equal(await page.evaluate(()=>window.monaco.editor.getEditors()[0].getValue()),text);
  assert.equal(await page.locator('.snl-source-panel').evaluate(el=>el.getBoundingClientRect().width),700);
  assert.equal(await page.locator('.monaco-editor textarea[readonly]').evaluate(el=>el.readOnly),true);
  await page.evaluate(()=>window.monaco.editor.getEditors()[0].focus());await page.keyboard.type('SHOULD NOT EDIT');
  assert.equal(await page.evaluate(()=>window.monaco.editor.getEditors()[0].getValue()),text);
  await page.keyboard.press('Control+f');await page.waitForSelector('.find-widget.visible');await page.keyboard.press('Escape');
  await page.evaluate(()=>window.monaco.editor.getEditors()[0].setSelection({startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:8}));
  await page.getByRole('button',{name:'Copy',exact:true}).click();
  await page.waitForFunction(async()=>await navigator.clipboard.readText()==='theorem');
  await page.waitForSelector('.codicon-folding-expanded');
  const beforeFold=await page.evaluate(()=>window.monaco.editor.getEditors()[0].getTopForLineNumber(7));
  await page.getByRole('button',{name:'Fold / unfold',exact:true}).click();
  await page.waitForFunction(top=>window.monaco.editor.getEditors()[0].getTopForLineNumber(7)<top,beforeFold);
  await page.getByRole('button',{name:'Fold / unfold',exact:true}).click();
  const tokens=await page.evaluate(text=>window.monaco.editor.tokenize(text,'lean4').map(line=>line.map(t=>t.type)),text);
  assert(tokens[0].includes('keyword.lean'));assert(tokens[1].every(t=>t==='comment.lean'||t==='white.lean'));assert(tokens[2].includes('comment.lean'));assert(tokens[3].includes('string.lean'));assert(tokens[4].includes('number.lean'));
  assert(tokens[0].includes('identifier.lean'));
  await page.locator('.snl-source-splitter').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('.snl-source-splitter').getAttribute('aria-valuenow'),'52');
  const splitter=await page.locator('.snl-source-splitter').boundingBox();await page.mouse.move(splitter.x+3,300);await page.mouse.down();await page.mouse.move(770,300);await page.mouse.up();assert.equal(await page.locator('.snl-source-splitter').getAttribute('aria-valuenow'),'55');
  await page.evaluate(()=>{const e=window.monaco.editor.getEditors()[0];e.setScrollTop(700);window.savedModel=e.getModel();window.savedScroll=e.getScrollTop();});
  await page.getByRole('button',{name:'Hide',exact:true}).click();await page.locator('.snl-source-open').click();
  assert(await page.evaluate(()=>window.monaco.editor.getEditors()[0].getModel()===window.savedModel));assert.equal(await page.evaluate(()=>window.monaco.editor.getEditors()[0].getScrollTop()),await page.evaluate(()=>window.savedScroll));
  await page.evaluate(()=>{const e=window.monaco.editor.getEditors()[0];e.setPosition({lineNumber:1,column:1},'test-program');e.revealLineInCenter(1);});
  await page.evaluate(()=>window.monaco.editor.getEditors()[0].focus());const historyBefore=await page.evaluate(()=>history.length);await page.keyboard.press('ArrowDown');
  await page.waitForSelector('[data-snl-source-current]');assert(await page.evaluate(()=>document.activeElement?.closest('.monaco-editor')!==null));assert.equal(await page.evaluate(()=>history.length),historyBefore);assert.equal(await page.evaluate(()=>location.hash),'');
  await page.evaluate(()=>window.monaco.editor.getEditors()[0].setPosition({lineNumber:40,column:1},'test-program'));await page.getByRole('button',{name:'Nearby entry (Ctrl+Alt+J)',exact:true}).click();
  assert.equal(await page.locator('.snl-source-choices button').count(),0);assert.equal(await page.evaluate(()=>location.hash),'#/entry/Other');await page.waitForSelector('[data-snl-route-outlet] [data-entry-id="Other"] [data-snl-source-entry="Other"]');
  await assertSourceHeaders(page,'[data-snl-route-outlet]');
  assert.equal(await page.evaluate(()=>history.state.routerOwned),'preserve-me');
  await page.goBack();await page.waitForFunction(()=>location.hash==='');await page.waitForFunction(()=>window.monaco.editor.getEditors()[0].getPosition().lineNumber===40);
  await page.goForward();await page.waitForFunction(()=>location.hash==='#/entry/Other');
  await page.goBack();await page.waitForFunction(()=>location.hash==='');
  await page.locator('a[data-src="Other"]').click();
  await page.waitForSelector('.snl-export-popover [data-snl-source-entry="Other"]');
  await assertSourceHeaders(page,'.snl-export-popover');
  await page.screenshot({path:resolve(dir,mode+'-source-popover.png')});
  await page.locator('.snl-export-popover [data-snl-source-entry="Other"]').click();
  await page.waitForFunction(()=>window.monaco.editor.getEditors()[0].getSelection().startLineNumber===40);
  await page.getByLabel('Follow cursor',{exact:true}).uncheck();
  await page.evaluate(()=>window.monaco.editor.getEditors()[0].focus());await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('[data-snl-source-current]').count(),0);
  await page.keyboard.press('Control+Alt+j');assert.equal(await page.locator('.snl-source-choices button').count(),0);assert.equal(await page.evaluate(()=>location.hash),'#/entry/Other');
  await page.getByLabel('Follow cursor',{exact:true}).check();
  await page.goBack();await page.waitForFunction(()=>location.hash==='');
  // The real export runtime swaps locale/theme body HTML, and source actions must be reattached.
  await page.locator('[data-snl-theme-toggle]').click();await page.waitForSelector('.monaco-editor.vs-dark');await page.locator('[data-snl-language-trigger]').click();await page.locator('[data-snl-language="zh-CN"]').click();await page.waitForSelector('[data-snl-source-entry="Demo"]');
  await assertSourceHeaders(page,'main');
  assert.equal(await page.evaluate(()=>window.monaco.editor.getModels().length),1);
  await page.evaluate(()=>window.monaco.editor.getEditors()[0].setScrollTop(0));await page.screenshot({path:resolve(dir,mode+'-dark.png')});
  await page.locator('[data-snl-theme-toggle]').click();await page.waitForSelector('.monaco-editor.vs');await page.screenshot({path:resolve(dir,mode+'-light.png')});
  for(let i=2;i<=7;i++){await page.locator(`[data-snl-source-file="f-${i}"]`).click();await page.waitForFunction(id=>document.querySelector('.snl-source-panel').dataset.fileId===id,'f-'+i);}
  assert.equal(await page.evaluate(()=>window.monaco.editor.getModels().length),4);
  await page.locator('[data-snl-source-file="binary"]').click();await page.waitForSelector('.snl-source-choices button');
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Download data/unsafe.html'}).click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'unsafe.html');assert.equal(await page.evaluate(()=>window.SOURCE_EXECUTED),undefined);
  await page.locator('[data-snl-source-file="bad"]').click();await page.waitForFunction(()=>document.querySelector('.snl-source-status').textContent.includes('SHA-256 mismatch'));
  await page.locator('[data-snl-source-file="f-one"]').click();await page.waitForFunction(()=>document.querySelector('.snl-source-panel').dataset.fileId==='f-one'&&!document.querySelector('.snl-source-editor').hidden);
  await context.setOffline(true);await page.locator('[data-snl-source-entry="Demo"]').first().click();await page.waitForFunction(()=>window.monaco.editor.getEditors()[0].getSelection().startLineNumber===1);
  await page.setViewportSize({width:720,height:900});await page.screenshot({path:resolve(dir,mode+'-narrow.png')});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.evaluate(()=>window.monaco.editor.getEditors()[0].focus());await page.keyboard.press('Escape');assert.equal(await page.locator('.snl-source-panel').isVisible(),false);assert(await page.locator('.snl-source-open').evaluate(el=>el===document.activeElement));
  assert.deepEqual(errors,[]);
  // Check wrapper ownership separately from the document's routing fixtures.
  // Adding a second Entry surface there changes reverse-navigation ambiguity.
  await page.evaluate(header=>{const wrapper=document.createElement('div');wrapper.id='source-wrapper-probe';wrapper.dataset.snlRouteSurface='';wrapper.dataset.entryId='Demo';wrapper.innerHTML=`<article class="snl-entry-surface" data-entry-id="Demo">${header}</article>`;document.body.append(wrapper);},entryHeader('Wrapped entry'));
  await page.waitForSelector('#source-wrapper-probe .snl-entry-header > [data-snl-source-entry]');
  assert.equal(await page.locator('#source-wrapper-probe [data-snl-source-entry]').count(),1,'Wrapper must not duplicate the Entry action');
  await assertSourceHeaders(page,'#source-wrapper-probe');
  await page.evaluate(()=>window.__snlSourceViewerCleanup());
  assert.equal(await page.locator('[data-snl-source-viewer-action]').count(),0,'Cleanup must remove restored Source actions');
  assert.equal(await page.evaluate(()=>window.monaco.editor.getModels().length),0);assert.equal(await page.locator('.monaco-editor').count(),0);
  results.push({mode,firstOpenMs,errors,requests,readOnly:true,domReadOnly:true,search:true,clipboardCopy:true,foldUnfold:true,tokenization:tokens.slice(0,6),splitter:true,hideRestore:true,followNoHistoryOrFocusChurn:true,deterministicTies:true,entryRouteBack:true,lazyPopover:true,followToggleAndShortcut:true,themeLocale:true,modelsBound:4,binaryInert:true,corruptionDiagnostic:true,narrow:true});await context.close();
}
for(const [file,selector] of [['none.html','.snl-source-open'],['invalid.html','.monaco-editor']]){const page=await browser.newPage();await page.goto(pathToFileURL(resolve(dir,file)).href);assert.equal(await page.locator(selector).count(),0);if(file==='invalid.html')assert((await page.locator('.snl-source-diagnostic').textContent()).includes('Unsupported'));await page.close();}
const report={browser:browser.version(),dir,jsBytes:Buffer.byteLength(js),cssBytes:Buffer.byteLength(css),results};writeFileSync(resolve(dir,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} catch(error) { for(const c of browser.contexts())for(const page of c.pages()){console.error('BROWSER FAILURE',await page.locator('body').innerText());await page.screenshot({path:resolve(dir,'failure.png')});} console.error('Evidence',dir);throw error;} finally {await browser.close();await new Promise(ok=>server.close(ok));}
