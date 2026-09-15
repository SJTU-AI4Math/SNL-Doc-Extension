import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdir, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entry, macro, fixture } from './libraryPointRead.testSupport';
import { makeEntryEnvelope, makeMacroEnvelope, makePackageManifest, packageManifestPath, entryEntityPath, macroEntityPath } from './entityStorage';
const state = vi.hoisted(() => ({ root: null as any, panels: [] as any[], calls: [] as string[], watchers: [] as any[], fail: '', hold: null as null | (() => Promise<void>), folders: [] as any[], exports: [] as any[], gate: null as null | ((op: string, uri: any) => Promise<void>) }));
vi.mock('vscode', async () => {
 const fs = await import('node:fs/promises'); const path = await import('node:path');
 const uri = (p: string, scheme = 'test', authority = 'authority'): any => ({ scheme, authority, path: p, fsPath: p, toString: () => scheme+'://'+authority+p, with: (c: any) => uri(c.path ?? p, c.scheme ?? scheme, c.authority ?? authority) });
 const transport = async (op: string, u: any, run: () => Promise<any>) => {
  state.calls.push(op+':'+u.path.split('/.SNL_Doc/')[1]);
  await state.gate?.(op,u);
  if (u.path.endsWith(state.fail) && state.fail) throw Object.assign(new Error('denied'),{code:'NoPermissions'});
  if (op === 'read' && u.path.includes('/entries/')) await state.hold?.();
  try { return await run(); } catch(e: any) { if(e.code==='ENOENT') e.code='FileNotFound'; throw e; }
 };
 return { Uri: { file: uri, joinPath:(b:any,...ps:string[])=>uri(path.join(b.path,...ps),b.scheme,b.authority) }, FileType:{File:1,Directory:2,SymbolicLink:64},
  FileSystemError:{FileNotFound:()=>Object.assign(new Error('missing'),{code:'FileNotFound'})}, RelativePattern:class{constructor(public baseUri:any,public pattern:string){}}, ViewColumn:{Active:-1},
  commands:{executeCommand:vi.fn()}, env:{language:'en'}, ColorThemeKind:{Dark:2},
  window:{activeColorTheme:{kind:2}, showErrorMessage:vi.fn(), createOutputChannel:()=>({appendLine(){},dispose(){}}), createWebviewPanel:()=>{
   const p:any={posts:[], receive:null, active:false, webview:{html:'',postMessage:async(m:any)=>{p.posts.push(m);return true;},onDidReceiveMessage:(f:any)=>{p.receive=f;return {dispose(){}};}},reveal(){},onDidChangeViewState(){},onDidDispose(){},dispose(){}}; state.panels.push(p); return p;
  }},
  workspace:{get workspaceFolders(){return state.root ? [{uri:state.root}] : [];},getConfiguration:()=>({get:()=>undefined,inspect:()=>undefined}),onDidChangeConfiguration:()=>({dispose(){}}),
   onDidChangeWorkspaceFolders:(fire:any)=>{const d={fire,dispose:vi.fn()};state.folders.push(d);return d;},
   createFileSystemWatcher:(pattern:any)=>{const handles:any[]=[];const listen=(f:any,_?:any,ds?:any[])=>{w.fire=f;const h={dispose:vi.fn()};handles.push(h);ds?.push(h);return h;};const w:any={pattern,handles,onDidCreate:listen,onDidChange:listen,onDidDelete:listen,dispose:vi.fn()};state.watchers.push(w);return w;},
   fs:{writeFile:(u:any,bytes:any)=>transport('write',u,()=>fs.writeFile(u.path,bytes)),delete:(u:any)=>transport('delete',u,()=>fs.unlink(u.path)),stat:(u:any)=>transport('stat',u,async()=>{const s=await fs.stat(u.path);return {type:s.isDirectory()?2:1};}),readFile:(u:any)=>transport('read',u,()=>fs.readFile(u.path)),readDirectory:(u:any)=>transport('dir',u,async()=>(await fs.readdir(u.path,{withFileTypes:true})).map(d=>[d.name,d.isDirectory()?2:1]))}
  }
 };
});
vi.mock('./panelUtil',async original=>({...await original<any>(), buildPanelHtml:()=>'',handlePanelNavMessage:async()=>false,webviewLocalResourceRoots:()=>[]}));
vi.mock('./preferencesHost',()=>({bind_preferences_panel_title(){},get_preferences_asset_cache_root(){},register_preferences_webview(){}}));
vi.mock('./exportOptionsPanel',()=>({ExportOptionsPanel:{show:(...args:any[])=>state.exports.push(args)}}));
import * as vscode from 'vscode';
import { CreateLibraryPanel } from './createLibraryPanel';
import { InfoviewPanel } from './infoviewPanel';
import { readLibraryGraph, updateLibraryDraft, entityRevision } from './snlDoc';
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async()=>{
 state.calls=[];state.panels=[];state.watchers=[];state.folders=[];state.exports=[];state.fail='';state.hold=null;state.gate=null;
 f=await fixture(); await f.pkg('alpha',['Seed','Context','Off.graph']); await f.ent('Seed','x@Context');await f.ent('Context');await f.ent('Off.graph');
 await f.put('config.json',{...f.config,entry_kinds:[],macro_kinds:[]});
 await mkdir(join(f.root,'.SNL_Doc')); for(const p of ['config.json','packages','entries']) await rename(join(f.root,p),join(f.root,'.SNL_Doc',p));
 await f.put('.SNL_Doc/libraries/notes/meta.json',{title:'Notes'});await f.put('.SNL_Doc/libraries/notes/graph.json',{nodes:[{id:'n',label:'Entry',props:{entryId:'Seed'}}],relationships:[]});
 await f.put('.SNL_Doc/libraries/notes/counters.json',{counters:[]});
 await mkdir(join(f.root,'.SNL_Doc/macros'),{recursive:true});
 state.root=vscode.Uri.file(f.root);
});
afterEach(()=>{(InfoviewPanel as any).browserPanel?.dispose();for(const p of (CreateLibraryPanel as any).instances.values()) p.dispose();});
it('editor ready is dependency scoped with real provider bodies and transitive context',async()=>{
 await f.put('.SNL_Doc/'+entryEntityPath('alpha','Unrelated'),{});
 await f.put('.SNL_Doc/'+macroEntityPath('alpha','Unrelated'),{});
 CreateLibraryPanel.editOrShow(state.root,'notes'); await state.panels[0].receive({type:'ready'});
 const graph=state.panels[0].posts.find((m:any)=>m.type==='graph');
 expect(graph,JSON.stringify(state.panels[0].posts)).toBeDefined();
 expect(graph.entries.map((e:any)=>e.id)).toEqual(['Seed','Context']);
 expect(state.calls.filter(p=>/^dir:(entries|macros)/.test(p))).toEqual([]);
 expect(state.calls.filter(p=>p.startsWith('read:entries/'))).toHaveLength(2);
});
it('graph resolution errors are fatal instead of unchecked successful graph',async()=>{
 state.fail=entryEntityPath('alpha','Seed');
 expect(await readLibraryGraph(state.root,'notes')).toMatchObject({status:'error',message:expect.stringContaining('denied')});
});
it('empty known pool still warns about dangling references',async()=>{
 const r=await readLibraryGraph(state.root,'notes',{entryPool:[]});
 expect(r.status==='ok'&&r.result.warnings.join(' ')).toContain('missing entry "Seed"');
});
it('off-graph exact lookup returns a hit without graph or pool publication',async()=>{
 CreateLibraryPanel.editOrShow(state.root,'notes');
 await state.panels[0].receive({type:'lookupEntry',entryId:'Off.graph',requestId:1});
 expect(state.panels[0].posts).toEqual([expect.objectContaining({type:'entryLookup',entryId:'Off.graph',requestId:1,entry:expect.objectContaining({id:'Off.graph'})})]);
 expect(state.calls.filter(p=>/^dir:(entries|macros)/.test(p))).toEqual([]);
});

it('installed watcher invalidates in-flight reads immediately, before debounce',async()=>{
 CreateLibraryPanel.editOrShow(state.root,'notes');
 let release!:()=>void; const blocked=new Promise<void>(r=>{release=r;}); let entered!:()=>void; const reached=new Promise<void>(r=>{entered=r;});
 state.hold=async()=>{entered();await blocked;};
 const load=state.panels[0].receive({type:'ready'});await reached;
 state.watchers[0].fire(vscode.Uri.joinPath(state.root,'.SNL_Doc','config.json'));
 release();await load;
 expect(state.panels[0].posts.filter((m:any)=>m.type==='graph')).toEqual([]);
});

it('Infoview publishes early interactive body before global scans and never exports a partial closure',async()=>{
 await f.put('.SNL_Doc/'+entryEntityPath('alpha','Unrelated'),{});
 InfoviewPanel.createOrShow(state.root,'notes');
 await state.panels[0].receive({type:'ready'});
 const body=state.panels[0].posts.find((m:any)=>m.type==='libraryEntries');
 expect(body,JSON.stringify(state.panels[0].posts)).toBeDefined();
 expect(body.outline[0].entry.id).toBe('Seed');
 expect(body.entries.map((e:any)=>e.id)).toEqual(['Seed','Context']);
 expect(body.renderSnapshotId).toBeUndefined();
 expect((InfoviewPanel as any).browserPanel.readerSnapshot).toBeUndefined();
});
it('Infoview fatal selected body error is not successful empty outline',async()=>{
 state.fail=entryEntityPath('alpha','Seed');
 InfoviewPanel.createOrShow(state.root,'notes');await state.panels[0].receive({type:'ready'});
 expect(state.panels[0].posts.filter((m:any)=>m.type==='libraryEntriesError')).toHaveLength(1);
 expect(state.panels[0].posts.filter((m:any)=>m.type==='libraryEntries')).toHaveLength(0);
});

async function draft(){
 const read=async(name:string)=>JSON.parse(await readFile(join(f.root,'.SNL_Doc/libraries/notes',name+'.json'),'utf8'));
 const [meta,graph,counters]=await Promise.all(['meta','graph','counters'].map(read));
 return {title:'Saved',graph,counters:counters.counters,expectedRevisions:{meta:entityRevision(meta),graph:entityRevision(graph),counters:entityRevision(counters)}};
}
it('whole Library draft validates metadata and CAS without reading unrelated bodies',async()=>{
 await f.put('.SNL_Doc/'+entryEntityPath('alpha','Unrelated'),{});
 const result=await updateLibraryDraft(state.root,'notes',await draft());
 expect(result).toMatchObject({status:'updated'});
 expect(state.calls.filter(p=>/^(read|dir):(entries|macros)\//.test(p))).toEqual([]);
 expect(state.calls.filter(p=>p.startsWith('write:'))).toHaveLength(3);
});
it('invalid current receipt rejects complete Library draft with zero writes',async()=>{
 await f.put('.SNL_Doc/config.json',{...f.config,entity_storage:{},entry_kinds:[],macro_kinds:[]});
 expect(await updateLibraryDraft(state.root,'notes',await draft())).toMatchObject({status:'error'});
 expect(state.calls.filter(p=>p.startsWith('write:'))).toEqual([]);
});

it('successful global region freezes bidirectional relation neighbors and their own contexts',async()=>{
 await f.put('.SNL_Doc/'+packageManifestPath('alpha'),makePackageManifest('alpha','Alpha','',['Seed','Context','Outside','Tail']));
 for(const [id,snl] of [['Outside','x@Tail'],['Tail','']]) await f.put('.SNL_Doc/'+entryEntityPath('alpha',id),makeEntryEnvelope('alpha',entry(id,snl)));
 await f.put('.SNL_Doc/relationships.json',{version:1,relationships:[{id:'backward',from:'Outside',to:'Seed',label:'depends',metadata:null}]});
 InfoviewPanel.createOrShow(state.root,'notes');await state.panels[0].receive({type:'ready'});
 const posts=state.panels[0].posts;
 expect(posts.map((m:any)=>m.type)).toEqual(['libraryEntries','libraryRegions']);
 const snapshot=(InfoviewPanel as any).browserPanel.readerSnapshot;
 expect(snapshot.entries.map((e:any)=>e.id).sort()).toEqual(['Context','Outside','Seed','Tail']);
 expect(snapshot.relationships.map((rel:any)=>rel.id)).toContain('backward');
 expect(posts[0].entries.map((e:any)=>e.id)).toEqual(['Seed','Context']);
 expect(posts[1].entries.map((e:any)=>e.id).sort()).toEqual(['Context','Off.graph','Outside','Seed','Tail']);
});
it('all active Macro candidates including misses are watched, inactive source Entries are read',async()=>{
 await f.put('.SNL_Doc/config.json',{...f.config,active_macro_packages:['alpha','beta'],entry_kinds:[],macro_kinds:[]});
 await f.put('.SNL_Doc/'+packageManifestPath('beta'),makePackageManifest('beta','Beta','',[]));
 await f.put('.SNL_Doc/'+packageManifestPath('inactive'),makePackageManifest('inactive','Inactive','',['Source']));
 await f.put('.SNL_Doc/'+entryEntityPath('alpha','Seed'),makeEntryEnvelope('alpha',entry('Seed','M()')));
 await f.put('.SNL_Doc/'+entryEntityPath('inactive','Source'),makeEntryEnvelope('inactive',entry('Source','','inactive')));
 await f.put('.SNL_Doc/'+macroEntityPath('alpha','M'),makeMacroEnvelope('alpha',macro('M',['Source'])));
 CreateLibraryPanel.editOrShow(state.root,'notes');await state.panels[0].receive({type:'ready'});
 expect(state.panels[0].posts.find((m:any)=>m.type==='graph').entries.map((e:any)=>e.id)).toEqual(['Seed','Source']);
 expect(state.calls).toContain('read:'+macroEntityPath('beta','M'));
 state.panels[0].posts.length=0;
 state.watchers[0].fire(vscode.Uri.joinPath(state.root,'.SNL_Doc',entryEntityPath('alpha','Unrelated')));
 await new Promise(r=>setTimeout(r,150));expect(state.panels[0].posts).toEqual([]);
 state.watchers[0].fire(vscode.Uri.joinPath(state.root,'.SNL_Doc',macroEntityPath('beta','M')));
 await new Promise(r=>setTimeout(r,180));expect(state.panels[0].posts.filter((m:any)=>m.type==='graph')).toHaveLength(1);
});
it('root switch rejects a pending producer despite the same Library slug',async()=>{
 CreateLibraryPanel.editOrShow(state.root,'notes');let release!:()=>void;const blocked=new Promise<void>(r=>{release=r;});let entered!:()=>void;const reached=new Promise<void>(r=>{entered=r;});
 state.hold=async()=>{entered();await blocked;};const task=state.panels[0].receive({type:'ready'});await reached;
 state.root=vscode.Uri.file(f.root+'-other');release();await task;
 expect(state.panels[0].posts.filter((m:any)=>m.type==='graph')).toEqual([]);
});

const tick = () => new Promise(r=>setTimeout(r,180));
function switchRoot(root: any) { state.root=root; for(const d of state.folders) if(!d.dispose.mock.calls.length) d.fire({added:root?[{uri:root}]:[],removed:[]}); }
function blockAt(match:(op:string,u:any)=>boolean) {
 let release!:()=>void, entered!:()=>void;
 const blocked=new Promise<void>(r=>{release=r;});const reached=new Promise<void>(r=>{entered=r;});
 state.gate=async(op,u)=>{if(match(op,u)){entered();await blocked;}};
 return {reached,release};
}
for(const panel of ['editor','reader'] as const) {
 const open=()=>panel==='editor'?CreateLibraryPanel.editOrShow(state.root,'notes'):InfoviewPanel.createOrShow(state.root,'notes');
 const bodyType=panel==='editor'?'graph':'libraryEntries';
 it(`${panel} rebinds real watcher handles on authority/scheme change with identical fsPath`,async()=>{
  open();await state.panels[0].receive({type:'ready'});const old=state.watchers[0], root=state.root;
  switchRoot(root.with({authority:'other'}));
  expect(state.watchers).toHaveLength(2);expect(old.dispose).toHaveBeenCalledTimes(1);
  expect(old.handles).toHaveLength(3);for(const h of old.handles) expect(h.dispose).toHaveBeenCalledTimes(1);
  expect(state.watchers[1].pattern.baseUri.toString()).toBe(state.root.toString());
  await vi.waitFor(()=>expect(state.panels[0].posts.filter((m:any)=>m.type===bodyType)).toHaveLength(2));await tick();
  state.panels[0].posts.length=0;state.calls=[];
  old.fire(vscode.Uri.joinPath(root,'.SNL_Doc/config.json'));
  state.watchers[1].fire(vscode.Uri.joinPath(root,'.SNL_Doc/config.json'));
  await tick();expect(state.panels[0].posts).toEqual([]);expect(state.calls).toEqual([]);
  state.watchers[1].fire(vscode.Uri.joinPath(state.root,'.SNL_Doc/config.json'));
  await vi.waitFor(()=>expect(state.panels[0].posts.some((m:any)=>m.type===bodyType)).toBe(true));await tick();
  switchRoot(state.root.with({scheme:'remote'}));expect(state.watchers).toHaveLength(3);
  expect(state.watchers[1].dispose).toHaveBeenCalledTimes(1);
  await tick();switchRoot(null);expect(state.watchers[2].dispose).toHaveBeenCalledTimes(1);
  switchRoot(root);expect(state.watchers).toHaveLength(4);await tick();
 });
 for(const phase of ['metadata','body']) it(`${panel} root ABA during ${phase} await retires old body and disposal silences queued callbacks`,async()=>{
  open();const root=state.root;const gate=blockAt((op,u)=>op==='read'&&(phase==='metadata'?u.path.endsWith('/meta.json'):u.path.includes('/entries/')));
  const pending=state.panels[0].receive({type:'ready'});await gate.reached;
  switchRoot(root.with({authority:'other'}));switchRoot(root);state.gate=null;gate.release();await pending;await tick();
  expect(state.panels[0].posts.filter((m:any)=>m.type===bodyType)).toHaveLength(1);
  const host=panel==='editor'?[...(CreateLibraryPanel as any).instances.values()][0]:(InfoviewPanel as any).browserPanel;
  state.watchers.at(-1).fire(vscode.Uri.joinPath(root,'.SNL_Doc/config.json'));host.dispose();state.panels[0].posts.length=0;
  for(const w of state.watchers) w.fire(vscode.Uri.joinPath(root,'.SNL_Doc/config.json'));
  await state.panels[0].receive({type:'ready'});await tick();expect(state.panels[0].posts).toEqual([]);
  for(const d of state.folders) expect(d.dispose).toHaveBeenCalledTimes(1);
 });
}
it('old-root same-ID lookup cannot answer after an ABA folder replacement',async()=>{
 CreateLibraryPanel.editOrShow(state.root,'notes');const root=state.root;
 const gate=blockAt((op,u)=>op==='read'&&u.path.endsWith(entryEntityPath('alpha','Off.graph')));
 const pending=state.panels[0].receive({type:'lookupEntry',entryId:'Off.graph',requestId:1});await gate.reached;
 switchRoot(root.with({authority:'other'}));switchRoot(root);state.gate=null;gate.release();await pending;await tick();
 expect(state.panels[0].posts.filter((m:any)=>m.type==='entryLookup'||m.type==='entryLookupError')).toEqual([]);
 await state.panels[0].receive({type:'lookupEntry',entryId:'Off.graph',requestId:2});
 expect(state.panels[0].posts.at(-1)).toMatchObject({type:'entryLookup',requestId:2,entry:{id:'Off.graph'}});
});

async function seedExportMacros() {
 await f.put('.SNL_Doc/config.json',{...f.config,active_macro_packages:['alpha'],entry_kinds:[],macro_kinds:[]});
 await f.put('.SNL_Doc/'+entryEntityPath('alpha','Seed'),makeEntryEnvelope('alpha',entry('Seed','M()')));
 for(const name of ['M','Spare']) await f.put('.SNL_Doc/'+macroEntityPath('alpha',name),makeMacroEnvelope('alpha',macro(name,['Context'])));
}
for(const initial of ['pending','error'] as const) it(`complete export after ${initial} global retry reads every Entry/Macro exactly once per revalidation`,async()=>{
 await seedExportMacros();InfoviewPanel.createOrShow(state.root,'notes');
 const gate=initial==='pending'?blockAt((op,u)=>op==='dir'&&u.path.endsWith('/entries')):null;
 if(initial==='error') state.fail=entryEntityPath('alpha','Off.graph');
 const first=state.panels[0].receive({type:'ready'});
 if(gate) await gate.reached;else await first;
 expect(state.panels[0].posts.some((m:any)=>m.type==='libraryEntries')).toBe(true);
 expect((InfoviewPanel as any).browserPanel.readerSnapshot).toBeUndefined();
 await state.panels[0].receive({type:'exportLibraryHtml',renderSnapshotId:'pending'});expect(state.exports).toEqual([]);
 state.fail='';state.gate=null;
 if(gate) {
  // Off-body events retain the body but retire the complete pending region.
  state.watchers[0].fire(vscode.Uri.joinPath(state.root,'.SNL_Doc',entryEntityPath('alpha','Off.graph')));
  gate.release();await first;
  expect(state.panels[0].posts.filter((m:any)=>m.type==='libraryRegions')).toEqual([]);
  await vi.waitFor(()=>expect(state.panels[0].posts.some((m:any)=>m.type==='libraryRegions')).toBe(true));
 } else {
  expect(state.panels[0].posts.some((m:any)=>m.type==='libraryRegionsError')).toBe(true);
  await state.panels[0].receive({type:'ready'});
 }
 const region=state.panels[0].posts.filter((m:any)=>m.type==='libraryRegions').at(-1);
 expect(region.entries.map((e:any)=>e.id).sort()).toEqual(['Context','Off.graph','Seed']);
 expect(Object.keys(region.macros).sort()).toEqual(['M','Spare']);
 for(let attempt=1;attempt<=2;attempt++) {
  state.calls=[];
  await state.panels[0].receive({type:'exportLibraryHtml',renderSnapshotId:region.renderSnapshotId});
  expect(state.exports).toHaveLength(attempt);
  const snapshot=state.exports.at(-1)[1].readerSnapshot;
  expect(snapshot.entries.map((e:any)=>e.id).sort()).toEqual(['Context','Seed']);
  expect(Object.keys(snapshot.macros)).toEqual(['M']);
  const counts=Object.fromEntries([...new Set(state.calls.filter(c=>/^read:(entries|macros)\//.test(c)))].map(c=>[c,state.calls.filter(x=>x===c).length]));
  expect(counts).toEqual(Object.fromEntries([
   ...['Seed','Context','Off.graph'].map(id=>['read:'+entryEntityPath('alpha',id),2]),
   ...['M','Spare'].map(name=>['read:'+macroEntityPath('alpha',name),2])
  ]));
 }
});
for(const finish of ['root','retarget','dispose'] as const) it(`pending global producer is silent after ${finish}`,async()=>{
 InfoviewPanel.createOrShow(state.root,'notes');const root=state.root;
 const gate=blockAt((op,u)=>op==='dir'&&u.path.endsWith('/entries'));
 const old=state.panels[0].receive({type:'ready'});await gate.reached;
 const generation=state.panels[0].posts.find((m:any)=>m.type==='libraryEntries').bodyGeneration;
 state.gate=null;
 if(finish==='root') switchRoot(root.with({authority:'replacement'}));
 if(finish==='retarget') await state.panels[0].receive({type:'selectLibrary',slug:'other'});
 if(finish==='dispose') (InfoviewPanel as any).browserPanel.dispose();
 state.panels[0].posts.length=0;gate.release();await old;await tick();
 expect(state.panels[0].posts.filter((m:any)=>m.bodyGeneration===generation)).toEqual([]);
 if(finish==='dispose') expect(state.panels[0].posts).toEqual([]);
});
