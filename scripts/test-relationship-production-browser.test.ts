import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';

const host = vi.hoisted(() => ({ root: undefined as any, panels: [] as any[], commands: new Map<string, (...args: any[]) => any>() }));
// Filesystem and editor/command transport adapters only; storage, Dashboard routing,
// extension command registration, editor reads and all writers below are real.
vi.mock('vscode', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const uri = (p: string, scheme = 'file', authority = ''): any => ({ scheme, authority, fsPath: p, path: p, toString: () => `${scheme}://${authority}${p}` });
  return {
    ViewColumn: { Active: 1 },
    commands: { registerCommand: (name: string, fn: any) => { host.commands.set(name, fn); return { dispose() {} }; }, executeCommand: async (name: string, ...args: any[]) => host.commands.get(name)?.(...args) },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: { file: uri, parse: (s: string) => { const u = new URL(s); return uri(u.pathname, u.protocol.slice(0, -1), u.host); }, joinPath: (base: any, ...parts: string[]) => uri(path.join(base.fsPath, ...parts), base.scheme, base.authority) },
    workspace: { onDidChangeConfiguration: () => ({ dispose() {} }), fs: {
      stat: async (u: any) => { const s = await fs.lstat(u.fsPath); return { type: s.isSymbolicLink() ? 64 : s.isDirectory() ? 2 : 1, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }; },
      readFile: async (u: any) => fs.readFile(u.fsPath),
      readDirectory: async (u: any) => (await fs.readdir(u.fsPath, { withFileTypes: true })).map(d => [d.name, d.isDirectory() ? 2 : d.isSymbolicLink() ? 64 : 1]),
      createDirectory: (u: any) => fs.mkdir(u.fsPath, { recursive: true }),
      writeFile: (u: any, b: Uint8Array) => fs.writeFile(u.fsPath, b),
      rename: (a: any, b: any) => fs.rename(a.fsPath, b.fsPath),
      delete: (u: any) => fs.rm(u.fsPath, { recursive: true, force: true })
    } },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showInformationMessage: async (_text: string, ...args: any[]) => args.at(-1), showWarningMessage: async (_text: string, ...args: any[]) => args.at(-1), showErrorMessage() {},
      createWebviewPanel: (_type: string, title: string) => {
        const panel: any = { title, messages: [], reveal: vi.fn(), dispose() {}, onDidDispose: (cb: any) => { panel.close = cb; return { dispose() {} }; },
          webview: { html: '', onDidReceiveMessage: (cb: any) => { panel.receive = cb; return { dispose() {} }; }, postMessage: async (msg: any) => { panel.messages.push(msg); return true; } } };
        host.panels.push(panel); return panel;
      }
    }
  };
});
import {
  initSnlDoc, createEntryKind, createMacroPackage, addMacro, readAllMacros, updateMacro,
  addEntry, readEntries, updateEntry, entityRevision,
  readAuthoredRelationships, readRelationships, type MacroPackageEntry
} from '../src/snlDoc';
import { readDashboardRelationships } from '../src/dashboardStatistics';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'snl-dependency-host-')); roots.push(root);
  const uri = vscode.Uri.file(root);
  expect(await initSnlDoc(uri)).toEqual({ status: 'created' });
  expect(await createEntryKind(uri, { id: 'entry', name: 'Entry', description: '', coloring: { light: { stroke: '', background: '' }, dark: { stroke: '', background: '' } }, defaultCounterName: '', style: '' })).toMatchObject({ status: 'created' });
  for (const id of ['A', 'B', 'isolated']) {
    expect(await addEntry(uri, { id, kind: 'entry', title: id, content: { snl: '' }, pointer: null, contribution_info: null })).toMatchObject({ status: 'ok' });
  }
  const relationships = [
    { id: 'manual', from: 'A', to: 'B', label: 'depends', metadata: { opaque: ['author'], isAtomic: 'keep' } },
    { id: 'legacy', from: 'B', to: 'A', label: 'depends', metadata: { generator: 'macro-source-scan', macros: ['old'] } },
    { id: 'context', from: 'B', to: 'A', label: 'uses_context', metadata: { generator: 'macro-source-scan', nested: { keep: true } } }
  ];
  await fs.writeFile(join(root, '.SNL_Doc/relationships.json'), JSON.stringify({ version: 1, relationships }, null, 3) + '\n');
  return { root, uri, relationships };
}
async function authored(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string) {
    for (const d of await fs.readdir(join(root, dir), { withFileTypes: true })) {
      if (d.name === '.cache') continue;
      const p = join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      else result[p] = (await fs.readFile(join(root, p))).toString('base64');
    }
  }
  await walk('.SNL_Doc'); return result;
}
async function setSnl(f: Awaited<ReturnType<typeof fixture>>, id: string, snl: string) {
  const e = (await readEntries(f.uri)).find(e => e.id === id)!;
  expect(await updateEntry(f.uri, id, { ...e, content: { snl } }, entityRevision(e))).toMatchObject({ status: 'updated' });
}
async function withMacro() {
  const f = await fixture();
  expect(await createMacroPackage(f.uri, 'Test', 'Test')).toMatchObject({ status: 'ok' });
  const macro: MacroPackageEntry = { name: 'testMacro', kind: 'const', description: '', source: { entries: ['B', 'B', 'A', 'missing'], urls: [] }, dynamic_arity: false, styles: [{ style_name: 'default', template: { mode: 'formula_inline', body: 'x' }, tags: [] }], tags: [] };
  expect(await addMacro(f.uri, 'Test', macro)).toMatchObject({ status: 'ok' });
  await setSnl(f, 'A', 'testMacro testMacro');
  return f;
}


vi.mock('../src/infoviewPanel', () => ({ InfoviewPanel: {} }));
vi.mock('../src/createLibraryPanel', () => ({ CreateLibraryPanel: {} }));
vi.mock('../src/initEntryKindsPanel', () => ({ InitEntryKindsPanel: {} }));
vi.mock('../src/createEntryKindPanel', () => ({ CreateEntryKindPanel: {} }));
vi.mock('../src/initMacroKindsPanel', () => ({ InitMacroKindsPanel: {} }));
vi.mock('../src/createMacroKindPanel', () => ({ CreateMacroKindPanel: {} }));
vi.mock('../src/createEntryPanel', () => ({
  CreateEntryPanel: { createOrShow: vi.fn() }
}));
vi.mock('../src/createEntryPackagePanel', () => ({
  CreateEntryPackagePanel: { createOrShow: vi.fn() }
}));
vi.mock('../src/createMacroPackagePanel', () => ({ CreateMacroPackagePanel: {} }));
vi.mock('../src/packagePanel', () => ({ PackagePanel: {} }));
vi.mock('../src/createMacroPanel', () => ({ CreateMacroPanel: {} }));
vi.mock('../src/graphPanel', () => ({ GraphPanel: {} }));
vi.mock('../src/snooglPanel', () => ({ SnoogLPanel: {} }));

vi.mock('../src/trace', () => ({
  isTraceEnabled: vi.fn(() => false), refreshTraceEnabled: vi.fn(),
  setTraceEnabled: vi.fn((value: boolean) => value),
  startTrace: vi.fn(() => ({ mark: vi.fn() })), traceChannel: vi.fn(() => undefined)
}));
vi.mock('../src/webviewCostProbe', () => ({ registerWebviewCostProbe: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock('../src/preferencesHost', () => ({ initialize_preferences_host: vi.fn(), bind_preferences_panel_title: vi.fn() }));
vi.mock('../src/snlDocContext', () => ({ installSnlDocContextKey: vi.fn() }));
vi.mock('../src/pointerSyncHost', () => ({ installPointerSyncHost: vi.fn() }));
vi.mock('../src/pointerSyncDriver', () => ({ createPointerHostDriver: vi.fn() }));
vi.mock('../src/dataMigrationCommands', () => ({ checkDataVersion: vi.fn(), repairData: vi.fn() }));
vi.mock('../src/preferences', () => ({ read_extension_preferences: () => ({ language: 'en' }), extension_preferences_runtime: { query_environment: () => ({ language: 'en' }) } }));
vi.mock('../src/panelUtil', () => ({ firstWorkspaceFolder: () => host.root, buildPanelHtml: () => '', installSnlDocWatcher() {}, handlePanelNavMessage: async () => false }));
import { activate } from '../src/extension';
import { DashboardPanel } from '../src/dashboardPanel';
import { CreateRelationshipPanel } from '../src/createRelationshipPanel';

beforeEach(() => { host.commands.clear(); activate({ extensionUri: vscode.Uri.file('/extension'), subscriptions: [] } as any); });
afterEach(() => { for (const p of host.panels.splice(0)) p.close(); });
async function openSaved(id: string, extra: Record<string, unknown> = {}) {
  // Same message as the real Dashboard component's DOM-tested row action.
  await (DashboardPanel.prototype as any).handleMessage.call({}, { type: 'editRelationship', id, source: 'saved', ...extra });
  const panel = host.panels.at(-1)!;
  await panel.receive({ type: 'ready' });
  return panel;
}
function context(panel: any) { return panel.messages.filter((m: any) => m.type === 'context').at(-1); }

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve, extname } from 'node:path';
const root = process.cwd();
const evidence = resolve(process.env.SNL_AUTHOR_EVIDENCE || root, 'relationship');
const digest = (value: any) => createHash('sha256').update(value).digest('hex');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SNL_PLAYWRIGHT_PATH || 'playwright-core');

it('production Dashboard DOM → real registered Host → production editor: three saved/current variants, EN/ZH, manual CRUD/CAS', async () => {
  await fs.mkdir(evidence, { recursive: true });
  const result: any = { scope: 'Production browser bundles + controlled VS Code adapters + actual Host registration/storage, not installed VS Code/Windows', cases: [], errors: [], assets: [], cleanup: {} };
  const bundle = resolve(root, 'media/webview');
  const server = createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://localhost');
    if (u.pathname === '/') {
      const entry = u.searchParams.get('entry') === 'createRelationship' ? 'createRelationship' : 'dashboard';
      const language = u.searchParams.get('language') === 'zh-CN' ? 'zh-CN' : 'en';
      res.setHeader('Content-Type','text/html');
      res.end(`<!doctype html><html lang="${language}" data-snl-color-scheme="light"><head><meta charset="utf-8"><script>window.__posted=[];window.__state={};window.acquireVsCodeApi=()=>({getState:()=>window.__state,setState:s=>window.__state=s,postMessage:m=>window.__posted.push(m)});</script><link rel="stylesheet" href="/${entry}.css"><style>body{margin:0;color:#222;background:#fff;--vscode-foreground:#222;--vscode-editor-background:#fff;--vscode-input-background:#fff;--vscode-input-foreground:#222;--vscode-input-border:#777;--vscode-button-background:#246;--vscode-button-foreground:#fff}</style></head><body><div id="root"></div><script src="/${entry}.js"></script></body></html>`);
      return;
    }
    try {
      const file = resolve(bundle, '.' + u.pathname);
      if (!file.startsWith(bundle + '/')) throw Error('path escape');
      const bytes = await fs.readFile(file);
      result.assets.push({ url: `http://127.0.0.1:${(server.address() as any).port}${req.url}`, file, sha256: digest(bytes) });
      res.setHeader('Content-Type', ({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf'} as any)[extname(file)] || 'application/octet-stream'); res.end(bytes);
    } catch { res.statusCode=404; res.end(); }
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  let browser: any;
  try {
    browser = await chromium.launch({executablePath:process.env.SNL_CHROMIUM_PATH,headless:true,args:['--no-sandbox','--num-raster-threads=1']});
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const send = async (page: any, data: any) => { await page.evaluate((data: any)=>window.dispatchEvent(new MessageEvent('message',{data})), data); await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))); };
    const open = async (entry: string, language: string) => {
      const page = await browser.newPage({viewport:{width:1280,height:960}});page.setDefaultTimeout(10000);
      page.on('pageerror',(error: any)=>result.errors.push(String(error)));
      page.on('requestfailed',(request: any)=>result.errors.push(request.url()+': '+request.failure()?.errorText));
      await page.goto(`${base}/?entry=${entry}&language=${language}`);
      await page.waitForFunction(()=>(window as any).__posted.some((m:any)=>m.type==='ready'));
      return page;
    };
    const dom = async (page: any) => page.evaluate(()=>({url:location.href,text:document.body.innerText,fields:Array.from(document.querySelectorAll('input,textarea')).map((e:any)=>({value:e.value,disabled:e.matches(':disabled'),readOnly:e.readOnly})),buttons:Array.from(document.querySelectorAll('button')).map((e:any)=>({name:e.getAttribute('aria-label')||e.innerText,disabled:e.matches(':disabled')}))}));
    for (const variant of ['retired','endpoint-collision','witness-change']) {
      const f = await withMacro(); host.root = f.uri;
      let saved: any = f.relationships[1];
      if (variant === 'endpoint-collision') {
        for (const id of ['a.b','c','a','b.c']) expect(await addEntry(f.uri,{id,kind:'entry',title:id,content:{snl:''},pointer:null,contribution_info:null})).toMatchObject({status:'ok'});
        const m = (await readAllMacros(f.uri)).testMacro;
        expect(await updateMacro(f.uri,'Test',{...m,source:{entries:['b.c'],urls:[]}},entityRevision(m))).toMatchObject({status:'updated'});
        await setSnl(f,'A',''); await setSnl(f,'a','testMacro');
        saved = {id:'dep.a.b.c',from:'a.b',to:'c',label:'depends',metadata:{generator:'macro-source-scan',macros:['old']}};
      } else if (variant === 'witness-change') saved = {id:'dep.A.B',from:'A',to:'B',label:'depends',metadata:{generator:'macro-source-scan',macros:['old'],isAtomic:false,oldWitness:{keep:true}}};
      await fs.writeFile(join(f.root,'.SNL_Doc/relationships.json'),JSON.stringify({version:1,relationships:[f.relationships[0],saved]}));
      const before = await authored(f.root);
      const table = await readDashboardRelationships(f.uri,new AbortController().signal);
      const row = table.relationships.find(r=>r.id===saved.id)!;
      const current = (await readRelationships(f.uri)).find(r=>r.id===row.id);
      if (variant==='retired') expect(current).toBeUndefined();
      else if (variant==='endpoint-collision') expect(current).toMatchObject({from:'a',to:'b.c'});
      else expect(current).toMatchObject({from:'A',to:'B',metadata:{macros:['testMacro'],isAtomic:true}});
      for (const language of ['en','zh-CN']) {
        const item: any = {variant,language,row,current:current??null,authorBeforeSha256:digest(JSON.stringify(before))};result.cases.push(item);
        const page = await open('dashboard',language);
        await send(page,{type:'overview',generation:1,overview:{hasSnlDoc:true}});
        await page.getByText(language==='en'?'Relationships':'关系',{exact:true}).click();
        await send(page,{type:'dashboardRelationships',generation:1,status:'ready',...table});
        const action=language==='en'?`View saved relationship ${row.id} (read-only)`:`查看已保存关系 ${row.id}（只读）`;
        await page.getByRole('button',{name:action,exact:true}).waitFor();
        expect(await page.getByRole('button',{name:language==='en'?`Edit relationship ${row.id}`:`编辑关系 ${row.id}`,exact:true}).count()).toBe(0);
        expect(await page.getByRole('button',{name:language==='en'?`Delete relationship ${row.id}`:`删除关系 ${row.id}`,exact:true}).count()).toBe(0);
        item.dashboard=await dom(page);
        await page.screenshot({path:resolve(evidence,`${variant}-${language}-dashboard.png`)});
        await page.getByRole('button',{name:action,exact:true}).click();
        const selection=await page.evaluate(()=>(window as any).__posted.filter((m:any)=>m.type==='editRelationship').at(-1));
        expect(selection).toEqual({type:'editRelationship',id:row.id,source:'saved'}); item.selection=selection;
        await (DashboardPanel.prototype as any).handleMessage.call({},selection);
        const panel=host.panels.at(-1)!;await panel.receive({type:'ready'});
        const message=context(panel);expect(message.existing).toEqual(row);expect(message).toMatchObject({source:'saved',readOnly:true,targetState:'found'});expect(message.relationshipRevision).toBeUndefined();item.savedContext=message;
        const editor=await open('createRelationship',language);await send(editor,message);
        await editor.getByText(language==='en'?'Saved relationship record — may differ from the current graph.':'已保存的关系记录，可能不同于当前关系图。',{exact:true}).waitFor();
        expect(await editor.locator('fieldset[disabled]').count()).toBe(1);
        const save=editor.getByRole('button',{name:language==='en'?'Save Changes':'保存更改',exact:true});expect(await save.isDisabled()).toBe(true);
        expect(JSON.parse(await editor.locator('textarea').inputValue())).toEqual(row.metadata);
        const fields=await editor.locator('fieldset input').evaluateAll((els:any[])=>els.map(e=>e.value));expect(fields).toContain(row.from);expect(fields).toContain(row.to);
        item.editor=await dom(editor);await editor.screenshot({path:resolve(evidence,`${variant}-${language}-saved.png`)});
        await panel.receive({type:'update',readOnly:false,relationship:{...row,metadata:null,label:'custom'},expectedRevision:entityRevision(row)});
        expect(panel.messages.at(-1)).toMatchObject({type:'invalid'});item.forgedUpdate=panel.messages.at(-1);
        await send(editor,item.forgedUpdate);expect(await editor.getByText(new RegExp(language==='en'?'Invalid:':'无效：')).count()).toBeGreaterThan(0);
        await vscode.commands.executeCommand('snlDoc.editRelationship',row.id);
        const currentPanel=host.panels.at(-1)!;expect(currentPanel).not.toBe(panel);await currentPanel.receive({type:'ready'});
        item.currentContext=context(currentPanel);expect(item.currentContext.source).toBe('current');expect(item.currentContext.existing).toEqual(current??null);
        const currentPage=await open('createRelationship',language);await send(currentPage,item.currentContext);
        if(current){expect(JSON.parse(await currentPage.locator('textarea').inputValue())).toEqual(current.metadata);const values=await currentPage.locator('fieldset input').evaluateAll((els:any[])=>els.map(e=>e.value));expect(values).toContain(current.from);expect(values).toContain(current.to);}
        else expect(await currentPage.locator('fieldset').count()).toBe(0);
        item.currentEditor=await dom(currentPage);await currentPage.screenshot({path:resolve(evidence,`${variant}-${language}-current.png`)});
        expect(await authored(f.root)).toEqual(before);item.authorAfterSha256=digest(JSON.stringify(await authored(f.root)));item.ok=true;
        await page.close();await editor.close();await currentPage.close();for(const p of host.panels.splice(0))p.close();
      }
    }
    // Positive editable control, with browser-captured update and actual Host writer/CAS.
    const f=await withMacro();host.root=f.uri;
    const panel=await openSaved('manual',{readOnly:true});expect(context(panel).readOnly).toBe(false);
    const page=await open('createRelationship','en');await send(page,context(panel));
    expect(await page.locator('fieldset[disabled]').count()).toBe(0);
    await page.getByLabel('Label (required)',{exact:true}).fill('browser manual update');
    await page.getByRole('button',{name:'Save Changes',exact:true}).click();
    const update=await page.evaluate(()=>(window as any).__posted.filter((m:any)=>m.type==='update').at(-1));
    expect(update.relationship.metadata).toEqual(f.relationships[0].metadata);
    await panel.receive({...update,expectedRevision:'stale'});expect(panel.messages.at(-1)).toMatchObject({type:'conflict'});
    await send(page,panel.messages.at(-1));
    const conflictDOM=await dom(page);
    const start=panel.messages.length;await panel.receive(update);expect(context(panel).existing.label).toBe('browser manual update');for(const message of panel.messages.slice(start))await send(page,message);
    expect(await page.getByText('Updated relationship "manual".',{exact:true}).count()).toBe(1);
    const manual:any={variant:'manual',update,conflictDOM,editor:await dom(page)};
    await page.screenshot({path:resolve(evidence,'manual-updated.png')});
    await vscode.commands.executeCommand('snlDoc.createRelationship');const createPanel=host.panels.at(-1)!;
    await createPanel.receive({type:'create',relationship:{id:'new',from:'B',to:'A',label:'custom',metadata:{opaque:['preserve']}}});expect(createPanel.messages.at(-1)).toMatchObject({type:'created',id:'new'});
    await (DashboardPanel.prototype as any).handleMessage.call({},{type:'deleteRelationship',id:'new'});
    const after=await readAuthoredRelationships(f.uri);expect(after.map(r=>r.id)).not.toContain('new');expect(after.find(r=>r.id==='legacy')).toEqual(f.relationships[1]);expect(after.find(r=>r.id==='manual')?.metadata).toEqual(f.relationships[0].metadata);
    manual.ok=true;manual.after=after;result.cases.push(manual);await page.close();
    expect(result.errors).toEqual([]);result.ok=true;
  } catch(error) {result.ok=false;result.failure=String(error);throw error;}
  finally {
    if(browser){await browser.close();result.cleanup.browserClosed=true;}
    await new Promise<void>(r=>server.close(()=>r()));result.cleanup.serverClosed=true;result.cleanup.serverListening=server.listening;
    await fs.writeFile(resolve(evidence,'results.json'),JSON.stringify(result,null,2));
  }
});
