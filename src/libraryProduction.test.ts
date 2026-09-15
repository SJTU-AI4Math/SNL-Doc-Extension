import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdir, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entry, macro, fixture } from './libraryPointRead.testSupport';
import { makeEntryEnvelope, makeMacroEnvelope, makePackageManifest, packageManifestPath, entryEntityPath, macroEntityPath } from './entityStorage';
const state = vi.hoisted(() => ({ root: null as any, panels: [] as any[], calls: [] as string[], watchers: [] as any[], fail: '', hold: null as null | (() => Promise<void>) }));
vi.mock('vscode', async () => {
 const fs = await import('node:fs/promises'); const path = await import('node:path');
 const uri = (p: string): any => ({ scheme: 'test', path: p, fsPath: p, toString: () => 'test://authority'+p });
 const transport = async (op: string, u: any, run: () => Promise<any>) => {
  state.calls.push(op+':'+u.path.slice(state.root.path.length+10));
  if (u.path.endsWith(state.fail) && state.fail) throw Object.assign(new Error('denied'),{code:'NoPermissions'});
  if (op === 'read' && u.path.includes('/entries/')) await state.hold?.();
  try { return await run(); } catch(e: any) { if(e.code==='ENOENT') e.code='FileNotFound'; throw e; }
 };
 return { Uri: { file: uri, joinPath:(b:any,...ps:string[])=>uri(path.join(b.path,...ps)) }, FileType:{File:1,Directory:2,SymbolicLink:64},
  FileSystemError:{FileNotFound:()=>Object.assign(new Error('missing'),{code:'FileNotFound'})}, RelativePattern:class{}, ViewColumn:{Active:-1},
  commands:{executeCommand:vi.fn()}, env:{language:'en'}, ColorThemeKind:{Dark:2},
  window:{activeColorTheme:{kind:2}, showErrorMessage:vi.fn(), createOutputChannel:()=>({appendLine(){},dispose(){}}), createWebviewPanel:()=>{
   const p:any={posts:[], receive:null, active:false, webview:{html:'',postMessage:async(m:any)=>{p.posts.push(m);return true;},onDidReceiveMessage:(f:any)=>{p.receive=f;return {dispose(){}};}},reveal(){},onDidChangeViewState(){},onDidDispose(){},dispose(){}}; state.panels.push(p); return p;
  }},
  workspace:{get workspaceFolders(){return [{uri:state.root}];},getConfiguration:()=>({get:()=>undefined,inspect:()=>undefined}),onDidChangeConfiguration:()=>({dispose(){}}),
   createFileSystemWatcher:()=>{const w:any={onDidCreate(f:any){w.fire=f;},onDidChange(f:any){w.fire=f;},onDidDelete(f:any){w.fire=f;},dispose(){}};state.watchers.push(w);return w;},
   fs:{writeFile:(u:any,bytes:any)=>transport('write',u,()=>fs.writeFile(u.path,bytes)),delete:(u:any)=>transport('delete',u,()=>fs.unlink(u.path)),stat:(u:any)=>transport('stat',u,async()=>{const s=await fs.stat(u.path);return {type:s.isDirectory()?2:1};}),readFile:(u:any)=>transport('read',u,()=>fs.readFile(u.path)),readDirectory:(u:any)=>transport('dir',u,async()=>(await fs.readdir(u.path,{withFileTypes:true})).map(d=>[d.name,d.isDirectory()?2:1]))}
  }
 };
});
vi.mock('./panelUtil',async original=>({...await original<any>(), buildPanelHtml:()=>'',handlePanelNavMessage:async()=>false,webviewLocalResourceRoots:()=>[]}));
vi.mock('./preferencesHost',()=>({bind_preferences_panel_title(){},get_preferences_asset_cache_root(){},register_preferences_webview(){}}));
import * as vscode from 'vscode';
import { CreateLibraryPanel } from './createLibraryPanel';
import { InfoviewPanel } from './infoviewPanel';
import { readLibraryGraph, updateLibraryDraft, entityRevision } from './snlDoc';
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async()=>{
 state.calls=[];state.panels=[];state.watchers=[];state.fail='';state.hold=null;
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
