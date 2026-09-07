/// <reference lib="dom" />
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController';
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding';
import 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard';
import { registerLean } from './leanLanguage';
import { isStructuralPointer, normalizePointerFile } from '../pointerSync/schema';
import type { SourceManifest, SourceFile, SourceChunk, SourcePointer, SourceRoute } from './types';
import type { PointerRange } from '../pointerSync/text';
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import './viewer.css';

declare const __SNL_EDITOR_WORKER__: string;
interface SourceGlobals {
  __snlSources?: unknown;
  __snlSourceChunks?: Map<string, SourceChunk>;
  __snlSourceViewerCleanup?: () => void;
  /** Optional router-owned passive apply hook: same route, no focus() call. */
  __snlExportSourceFollow?: () => void;
  __SNL_POPOVERS__?: Record<string, string>;
  MonacoEnvironment?: monaco.Environment;
}
const global = globalThis as typeof globalThis & SourceGlobals;
const positive = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) > 0;
const identifier = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && !x.includes('\0');
const digest = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const safeFileId = (x: unknown): x is string => typeof x === 'string' && /^[a-zA-Z0-9_-]+$/.test(x);
function validRange(r: PointerRange | undefined): r is PointerRange {
  return !!r && [r.startLine,r.startColumn,r.endLine,r.endColumn,r.coveredEndLine].every(positive) &&
    r.endLine >= r.startLine && (r.endLine !== r.startLine || r.endColumn >= r.startColumn) &&
    r.coveredEndLine >= r.startLine && r.coveredEndLine <= r.endLine &&
    (r.coveredEndLine === r.endLine || (r.endColumn === 1 && r.coveredEndLine === r.endLine - 1));
}

/** Fail closed before any path is loaded or any document route is used. */
export function validateManifest(value: unknown): SourceManifest {
  if (!value || typeof value !== 'object') throw Error('Invalid source manifest');
  const m = value as SourceManifest;
  if (m.schemaVersion !== 'snl.export.sources/v1') throw Error('Unsupported source manifest version');
  if (!identifier(m.exportId) || !identifier(m.renderSnapshotId) || !identifier(m.workspaceName) ||
      m.snapshot?.mode !== 'disk' || !Array.isArray(m.files) || !Array.isArray(m.pointers) ||
      !Array.isArray(m.entryRoutes) || !Array.isArray(m.directories)) throw Error('Invalid source manifest');
  const ids = new Map<string,SourceFile>(); const paths = new Set<string>();
  for (const f of m.files) {
    if (!f || !safeFileId(f.fileId) || ids.has(f.fileId) || !identifier(f.displayPath) ||
        normalizePointerFile(f.displayPath) !== f.displayPath || paths.has(f.displayPath) ||
        !digest(f.sha256) || !Number.isSafeInteger(f.byteLength) || f.byteLength < 0 ||
        !['text','binary','unsupported'].includes(f.kind) || typeof f.language !== 'string' ||
        !identifier(f.chunkId) || f.chunkId.includes('/') || f.chunkId.includes('\\') ||
        !['lf','crlf','mixed','none'].includes(f.eol) || typeof f.bom !== 'boolean') throw Error('Invalid/duplicate source file');
    ids.set(f.fileId,f); paths.add(f.displayPath);
  }
  const directories = new Set<string>();
  for (const d of m.directories) {
    if (!identifier(d) || normalizePointerFile(d) !== d || directories.has(d) || paths.has(d)) throw Error('Invalid source directory');
    directories.add(d);
  }
  const entries = new Set<string>();
  for (const p of m.pointers) {
    if (!p || !identifier(p.entryId) || entries.has(p.entryId) ||
        !['ok','excluded','unavailable','unsupported','unresolved'].includes(p.status) ||
        (p.fileId !== undefined && !ids.has(p.fileId))) throw Error('Invalid/duplicate source Pointer');
    entries.add(p.entryId);
    if (p.status === 'ok' && (!p.fileId || ids.get(p.fileId)?.kind !== 'text' ||
        !validRange(p.range) || p.sourceSha256 !== ids.get(p.fileId)?.sha256 || !isStructuralPointer(p.pointer))) {
      throw Error('Invalid source Pointer range/revision');
    }
  }
  const routes = new Set<string>();
  for (const r of m.entryRoutes) {
    if (!r || !identifier(r.entryId) || (r.nodeId !== undefined && !identifier(r.nodeId)) ||
        r.hash !== (r.nodeId === undefined ? '#/entry/' + encodeURIComponent(r.entryId) : '#/node/' + encodeURIComponent(r.nodeId)) ||
        routes.has(r.hash)) throw Error('Invalid/duplicate source route');
    routes.add(r.hash);
  }
  return m;
}

/** Same (distance, inclusive covered-line span) rank as pointerSync/index.ts rankBucket.
 * This browser boundary consumes resolved ranges only; authored regex is NEVER executed.
 * Parity tests compare against the real host function, not a second test oracle.
 */
export function rankSourcePointers(m: SourceManifest, fileId: string, line: number) {
  if (!positive(line)) return { candidates: [] as SourcePointer[], complete: false };
  const path = m.files.find(f => f.fileId === fileId)?.displayPath;
  let bestDistance = Infinity, bestSpan = Infinity, complete = true;
  let candidates: SourcePointer[] = [];
  for (const p of m.pointers) {
    // Preserve uncertainty when an unresolved pointer has no fileId, or a lexical alias.
    const rawFile = p.pointer && typeof p.pointer === 'object' && 'file' in p.pointer ? p.pointer.file : undefined;
    const same = p.fileId === fileId || (typeof rawFile === 'string' && normalizePointerFile(rawFile) === path);
    if (!same) continue;
    if (p.status !== 'ok' || !validRange(p.range) || !isStructuralPointer(p.pointer)) { complete = false; continue; }
    const r = p.range;
    const distance = Math.max(r.startLine - line, line - r.coveredEndLine, 0);
    const threshold = line < r.startLine ? p.pointer.beforeLines ?? 15 : p.pointer.afterLines ?? 15;
    if (distance > threshold) continue;
    const span = r.coveredEndLine - r.startLine + 1;
    if (distance > bestDistance || (distance === bestDistance && span > bestSpan)) continue;
    if (distance < bestDistance || span < bestSpan) candidates = [];
    bestDistance = distance; bestSpan = span; candidates.push(p);
  }
  return { candidates, complete };
}

/** SHA-256 fallback for non-secure HTTP hosts; crypto.subtle was also exercised on file://.
 * Operates on original bytes, before UTF-8/BOM/EOL decoding. */
export function sha256Bytes(bytes: Uint8Array): string {
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64); padded.set(bytes); padded[bytes.length] = 128;
  const v = new DataView(padded.buffer); const bits = bytes.length * 8;
  v.setUint32(padded.length-8,Math.floor(bits/0x100000000)); v.setUint32(padded.length-4,bits>>>0);
  const w = new Uint32Array(64); const rr = (x:number,n:number) => (x>>>n)|(x<<(32-n));
  for (let offset=0; offset<padded.length; offset+=64) {
    for(let i=0;i<16;i++) w[i]=v.getUint32(offset+4*i);
    for(let i=16;i<64;i++) { const a=w[i-15],b=w[i-2]; w[i]=(rr(a,7)^rr(a,18)^(a>>>3))+w[i-16]+(rr(b,17)^rr(b,19)^(b>>>10))+w[i-7]; }
    let [a,b,c,d,e,f,g,j]=h;
    for(let i=0;i<64;i++) {const t1=(j+(rr(e,6)^rr(e,11)^rr(e,25))+((e&f)^(~e&g))+k[i]+w[i])|0;const t2=((rr(a,2)^rr(a,13)^rr(a,22))+((a&b)^(a&c)^(b&c)))|0;j=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;}
    [a,b,c,d,e,f,g,j].forEach((x,i)=>h[i]=(h[i]+x)|0);
  }
  return h.map(x=>(x>>>0).toString(16).padStart(8,'0')).join('');
}
export async function verifyChunk(file: SourceFile, chunk: SourceChunk | undefined): Promise<Uint8Array> {
  if (!chunk || chunk.fileId !== file.fileId || chunk.sha256 !== file.sha256 || typeof chunk.base64 !== 'string' ||
      chunk.base64.length > Math.ceil(file.byteLength/3)*4+4) throw Error('Missing or invalid source chunk');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(chunk.base64), c => c.charCodeAt(0)); } catch { throw Error('Invalid source encoding'); }
  if (bytes.length !== file.byteLength) throw Error('Source byte length mismatch');
  const hash = globalThis.crypto?.subtle
    ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)),x=>x.toString(16).padStart(2,'0')).join('')
    : sha256Bytes(bytes);
  if (hash !== file.sha256) throw Error('Source SHA-256 mismatch');
  return bytes;
}
export function preferSourceRoutes(all: SourceRoute[], currentHash: string): SourceRoute[] {
  const currentRoute = all.find(route => route.hash === currentHash);
  if (currentRoute) return [currentRoute];
  // A standalone Entry fallback is not a second outline occurrence.
  const nodes = all.filter(route => route.nodeId !== undefined);
  return nodes.length ? nodes : all;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) {
  const element = document.createElement(tag); if (className) element.className = className; return element;
}
function button(text: string, action: () => void) {
  const b = node('button'); b.type = 'button'; b.textContent = text; b.addEventListener('click',action); return b;
}
function range(r: PointerRange) { return new monaco.Range(r.startLine,r.startColumn,r.endLine,r.endColumn); }
interface SavedView { exportId: string; open: boolean; width: number; fileId?: string; view?: monaco.editor.ICodeEditorViewState | null }

export function installSourceViewer(): (() => void) | undefined {
  if (global.__snlSources === undefined) return;
  global.__snlSourceViewerCleanup?.();
  let manifest: SourceManifest;
  try { manifest = validateManifest(global.__snlSources); }
  catch (e) { const diagnostic=node('p','snl-source-diagnostic'); diagnostic.setAttribute('role','status');diagnostic.textContent=`Source: ${String(e)}`;document.body.append(diagnostic); return ()=>diagnostic.remove(); }
  const main = document.querySelector<HTMLElement>('.snl-export');
  if (!main) return;
  // Route existence is checked against the actual router's DOM and popover registry.
  const routeAvailable = (r: SourceRoute) => r.nodeId !== undefined
    ? Array.from(main.querySelectorAll('[data-snl-route-id]')).some(el=>el.getAttribute('data-snl-route-id')===r.nodeId &&
        [el,...Array.from(el.querySelectorAll('[data-entry-id]'))].some(entry=>entry.getAttribute('data-entry-id')===r.entryId))
    : !!global.__SNL_POPOVERS__ && Object.hasOwn(global.__SNL_POPOVERS__,r.entryId) && typeof global.__SNL_POPOVERS__[r.entryId] === 'string';
  const m = manifest;
  // Build immutable current-file buckets once; caret motion never scans the full Pointer set.
  const bucketed = new Map(m.files.map(file=>[file.fileId,{...m,files:[file],pointers:[] as SourcePointer[]}]));
  const pathIds = new Map(m.files.map(file=>[file.displayPath,file.fileId]));
  for(const p of m.pointers){
    const raw = p.pointer && typeof p.pointer==='object' && 'file' in p.pointer ? p.pointer.file : undefined;
    const logical = typeof raw==='string' ? normalizePointerFile(raw) : undefined;
    for(const id of new Set([p.fileId,logical?pathIds.get(logical):undefined]))if(id)bucketed.get(id)?.pointers.push(p);
  }
  let disposed=false, opened=false, width=50, current: string|undefined, generation=0, origin=0, follow=true;
  let editor: monaco.editor.IStandaloneCodeEditor|undefined, decorations: monaco.editor.IEditorDecorationsCollection|undefined;
  const models = new Map<string,monaco.editor.ITextModel>();
  const views = new Map<string,monaco.editor.ICodeEditorViewState|null>();
  const invalid = new Set<string>(); const loading = new Map<string,Promise<Uint8Array>>();
  const workers = new Set<Worker>(); let workerURL: string|undefined;
  const pendingScripts = new Set<() => void>();
  const previousEnvironment = global.MonacoEnvironment;
  const environment: monaco.Environment = { getWorker: () => {
    workerURL ??= URL.createObjectURL(new Blob([__SNL_EDITOR_WORKER__],{type:'text/javascript'}));
    const w = new Worker(workerURL); workers.add(w); return w;
  }};
  const root = node('aside','snl-source-panel'); root.id='snl-source-panel';root.hidden=true;root.setAttribute('aria-label','Source code');
  const bar=node('div','snl-source-toolbar'), files=node('nav','snl-source-files'), host=node('div','snl-source-editor');
  const pathLabel=node('div','snl-source-path'), status=node('div','snl-source-status'), choices=node('div','snl-source-choices');
  status.setAttribute('role','status');files.setAttribute('aria-label','Source files');
  const split=node('div','snl-source-splitter');split.tabIndex=0;split.setAttribute('role','separator');split.setAttribute('aria-orientation','vertical');split.setAttribute('aria-label','Source / document width');split.setAttribute('aria-valuemin','25');split.setAttribute('aria-valuemax','75');split.hidden=true;
  const opener=button('Source code',()=>setOpen(!opened));opener.className='snl-source-open';opener.setAttribute('aria-controls',root.id);opener.setAttribute('aria-expanded','false');
  const treeToggle=button('Files',()=>{files.hidden=!files.hidden;treeToggle.setAttribute('aria-expanded',String(!files.hidden));layout();});treeToggle.setAttribute('aria-expanded','true');
  const nearest=button('Nearby entry (Ctrl+Alt+J)',()=>reverse(true));
  const followLabel=node('label');const checkbox=node('input');checkbox.type='checkbox';checkbox.checked=true;checkbox.addEventListener('change',()=>{follow=checkbox.checked;clearMark();choices.replaceChildren();});followLabel.append(checkbox,document.createTextNode('Follow cursor'));
  const copy=button('Copy',()=>{
    const model=editor?.getModel(), selection=editor?.getSelection();if(!model||!selection)return;
    const text=selection.isEmpty()?model.getLineContent(selection.startLineNumber):model.getValueInRange(selection);
    editor!.focus();
    if(navigator.clipboard?.writeText)void navigator.clipboard.writeText(text).catch(()=>{status.textContent='Clipboard permission denied — use Ctrl/Cmd+C in the editor';});
    else if(!document.execCommand('copy'))status.textContent='Use Ctrl/Cmd+C in the editor to copy';
  });
  const search=button('Search',()=>{editor?.focus();void editor?.getAction('actions.find')?.run();});
  const fold=button('Fold / unfold',()=>{if(editor){const id=fold.getAttribute('aria-pressed')==='true'?'editor.unfoldAll':'editor.foldAll';void editor.getAction(id)?.run();fold.setAttribute('aria-pressed',String(id==='editor.foldAll'));}});fold.setAttribute('aria-pressed','false');
  bar.append(treeToggle,nearest,followLabel,copy,search,fold,button('Hide',()=>setOpen(false,true)));
  const notice=node('small','snl-source-mobile-notice');notice.textContent='Monaco source reading is supported on desktop browsers. Hide to read the document.';
  const content=node('div','snl-source-content');content.append(files,host);
  root.append(bar,pathLabel,status,choices,notice,content);document.body.append(opener,root,split);
  function clearMark() { main!.querySelectorAll('[data-snl-source-current]').forEach(el=>el.removeAttribute('data-snl-source-current')); }
  function layout() { if(opened&&!disposed) editor?.layout(); }
  const resize=new ResizeObserver(layout);
  function setWidth(value:number) {width=Math.max(25,Math.min(75,value));document.documentElement.style.setProperty('--snl-source-width',width+'vw');split.setAttribute('aria-valuenow',String(Math.round(width)));layout();}
  setWidth(50);
  function saveView() {if(current&&editor?.getModel())views.set(current,editor.saveViewState());}
  function state(): SavedView {saveView();return {exportId:m.exportId,open:opened,width,fileId:current,view:current?views.get(current):undefined};}
  function persist() {if(!disposed)history.replaceState({...history.state,snlSourceView:state()},'');}
  function setOpen(value:boolean,returnFocus=false) {
    if(disposed)return;
    opened=value;root.hidden=!value;split.hidden=!value;opener.setAttribute('aria-expanded',String(value));document.documentElement.classList.toggle('snl-source-visible',value);
    if(value){resize.observe(host);if(!current&&m.files[0])void openFile(m.files[0].fileId);layout();}
    else {saveView();resize.disconnect();generation++;if(returnFocus)opener.focus();}
    persist();
  }
  function theme() {if(!editor)return;const style=getComputedStyle(document.documentElement);const dark=document.body.classList.contains('vscode-dark')||document.documentElement.classList.contains('vscode-dark')||document.documentElement.dataset.snlColorScheme==='dark'||style.colorScheme==='dark';monaco.editor.setTheme(dark?'vs-dark':'vs');}
  function ensureEditor() {
    if(editor)return editor;
    global.MonacoEnvironment=environment;
    if(!monaco.languages.getLanguages().some(l=>l.id==='lean4'))registerLean(monaco);
    editor=monaco.editor.create(host,{model:null,readOnly:true,domReadOnly:true,ariaLabel:'Read-only source code',automaticLayout:false,minimap:{enabled:false},scrollBeyondLastLine:false,fontSize:14,lineNumbers:'on',folding:true,showFoldingControls:'always',dragAndDrop:false,dropIntoEditor:{enabled:false},quickSuggestions:false,suggestOnTriggerCharacters:false,wordBasedSuggestions:'off',contextmenu:true,unicodeHighlight:{ambiguousCharacters:false,nonBasicASCII:false},padding:{top:10}});
    decorations=editor.createDecorationsCollection();theme();
    editor.onDidChangeCursorPosition(e=>{if(!origin&&opened&&editor?.hasTextFocus()&&e.reason===monaco.editor.CursorChangeReason.Explicit&&(e.source==='keyboard'||e.source==='mouse')){if(follow)reverse(false);persist();}});
    editor.onDidScrollChange(()=>{if(!origin&&opened)persist();});
    host.dataset.ready='true';return editor;
  }
  async function load(file:SourceFile):Promise<Uint8Array> {
    let pending=loading.get(file.fileId);if(pending)return pending;
    pending=(async()=>{
      if(!(global.__snlSourceChunks instanceof Map))throw Error('Source chunk registry is missing');
      if(!global.__snlSourceChunks.has(file.fileId))await new Promise<void>((resolve,reject)=>{
        const script=node('script');const timer=setTimeout(()=>done(Error('Source chunk load timed out')),10000);
        const cancel=()=>done(Error('Source viewer disposed'));
        const done=(error?:Error)=>{clearTimeout(timer);pendingScripts.delete(cancel);script.remove();error?reject(error):resolve();};
        pendingScripts.add(cancel);
        script.onload=()=>done();script.onerror=()=>done(Error('Source chunk is missing'));
        script.src=new URL('source-'+file.fileId+'.js',document.baseURI).href;document.head.append(script);
      });
      return verifyChunk(file,global.__snlSourceChunks.get(file.fileId));
    })();loading.set(file.fileId,pending);
    try{return await pending;}finally{loading.delete(file.fileId);}
  }
  async function openFile(id:string,pointer?:SourcePointer,restore?:SavedView) {
    const file=m.files.find(f=>f.fileId===id);if(!file)return;
    const ticket=++generation;saveView();status.textContent='Loading source…';choices.replaceChildren();clearMark();
    try {
      const bytes=await load(file);if(disposed||ticket!==generation||!opened)return;
      invalid.delete(id);origin++;
      try {
        const e=ensureEditor();decorations?.clear();current=id;pathLabel.textContent=file.displayPath;host.hidden=file.kind!=='text';
        for(const control of [copy,search,fold,nearest])control.disabled=file.kind!=='text';
        if(file.kind!=='text') {
          e.setModel(null);status.textContent='Binary / unsupported encoding. Download only; never executed.';
          const download=button('Download '+file.displayPath,()=>{const url=URL.createObjectURL(new Blob([bytes as BlobPart],{type:'application/octet-stream'}));const a=node('a');a.href=url;a.download=file.displayPath.split('/').pop()!;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});choices.append(download);
        } else {
          let model=models.get(id);
          if(!model) {const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);const language=file.language==='lean'||file.language==='lean4'||file.displayPath.endsWith('.lean')?'lean4':'plaintext';model=monaco.editor.createModel(text,language,monaco.Uri.from({scheme:'snl-source',path:'/'+m.exportId+'/'+id}));models.set(id,model);}
          models.delete(id);models.set(id,model);e.setModel(model);
          for(const p of m.pointers)if(p.fileId===id&&p.status==='ok'&&p.range&&!model.validateRange(range(p.range)).equalsRange(range(p.range)))throw Error('Pointer range exceeds source');
          const saved=restore?.view??views.get(id);if(saved)e.restoreViewState(saved);
          while(models.size>4){const oldest=models.keys().next().value!;models.get(oldest)?.dispose();models.delete(oldest);}
          root.dataset.modelCount=String(models.size);root.dataset.fileId=id;
          if(pointer?.range){const r=pointer.range;if(model.validateRange(range(r)).equalsRange(range(r))===false)throw Error('Pointer range exceeds source');e.setSelection(range(r),'snl-source');e.revealRangeInCenter(range(r));decorations?.set([{range:range(r),options:{className:'snl-source-range',isWholeLine:false,linesDecorationsClassName:'snl-source-range-gutter'}}]);}
          status.textContent='Read-only · '+file.byteLength+' bytes · SHA-256 verified';layout();
        }
      }finally{origin--;}
      persist();
    } catch(e) {if(disposed||ticket!==generation)return;invalid.add(id);status.textContent='Source unavailable: '+String(e);decorations?.clear();host.hidden=true;
      if(models.has(id)){editor?.setModel(null);models.get(id)?.dispose();models.delete(id);}
      for(const control of [copy,search,fold,nearest])control.disabled=true;current=undefined;}
  }
  function showPointer(id:string) {
    const p=m.pointers.find(p=>p.entryId===id);if(!p)return;
    setOpen(true);
    if(p.status!=='ok'||!p.fileId){generation++;status.textContent=p.reason||('Source '+p.status);choices.replaceChildren();return;}
    void openFile(p.fileId,p);
  }
  // Build the actual project hierarchy, retaining independent empty directory records.
  const folders=new Map<string,HTMLElement>([['',files]]);
  function folder(path:string):HTMLElement {const old=folders.get(path);if(old)return old;const parts=path.split('/');const title=parts.pop()!;const parent=folder(parts.join('/'));const details=node('details');details.open=true;const summary=node('summary');summary.textContent=title;details.append(summary);parent.append(details);folders.set(path,details);return details;}
  m.directories.forEach(folder);
  for(const f of m.files){const parts=f.displayPath.split('/');const title=parts.pop()!;const b=button(title,()=>{setOpen(true);void openFile(f.fileId);});b.dataset.snlSourceFile=f.fileId;b.title=f.displayPath;folder(parts.join('/')).append(b);}
  function routesFor(p:SourcePointer) {return preferSourceRoutes(m.entryRoutes.filter(r=>r.entryId===p.entryId&&routeAvailable(r)),location.hash);}
  function mark(p:SourcePointer): boolean {
    clearMark();
    const surfaces=Array.from(main!.querySelectorAll<HTMLElement>('[data-entry-id]')).filter(el=>el.dataset.entryId===p.entryId&&!el.closest('.snl-export-popover')&&el.getClientRects().length>0);
    if(surfaces.length!==1)return false;
    surfaces[0].setAttribute('data-snl-source-current','');surfaces[0].scrollIntoView({block:'nearest',inline:'nearest'});return true;
  }
  function navigate(p:SourcePointer,r:SourceRoute,explicit:boolean) {
    if(!routeAvailable(r)||!current||invalid.has(current))return;
    persist();
    const data={...history.state,snlSourceView:state()};
    if(r.hash!==location.hash) {
      if(explicit){history.pushState(data,'',r.hash);window.dispatchEvent(new HashChangeEvent('hashchange'));}
      else {
        // The legacy router focuses every route target. Never steal then restore focus:
        // only a router-owned passive apply hook may cross a hidden/standalone route.
        if(!global.__snlExportSourceFollow)return;
        history.replaceState(data,'',r.hash);global.__snlExportSourceFollow();
      }
    }
    mark(p);
  }
  function reverse(explicit:boolean) {
    if(!editor?.getModel()||!current||invalid.has(current)||!opened)return;
    clearMark();choices.replaceChildren();decorations?.clear();
    const result=rankSourcePointers(bucketed.get(current)!,current,editor.getPosition()?.lineNumber??1);
    status.textContent=!result.complete?'Incomplete source index — automatic following paused':result.candidates.length?'Nearby entries':'No nearby entry';
    for(const p of result.candidates) {
      const routes=routesFor(p);
      if(!routes.length){const missing=node('span');missing.textContent=p.entryId+': not included in this export';choices.append(missing);continue;}
      for(const route of routes)choices.append(button(p.entryId+(route.nodeId?' · '+route.nodeId:''),()=>navigate(p,route,true)));
    }
    if(result.complete&&result.candidates.length===1) {
      const p=result.candidates[0],routes=routesFor(p);
      if(p.range)decorations?.set([{range:range(p.range),options:{className:'snl-source-range'}}]);
      if(routes.length===1){if(explicit)navigate(p,routes[0],true);else if(!mark(p)){
        if(global.__snlExportSourceFollow)navigate(p,routes[0],false);
        else status.textContent='Nearby entry is outside the visible document — choose it to open';
      }}
    }
  }
  function attachActions(scope:ParentNode) {
    for(const surface of scope.querySelectorAll<HTMLElement>('.snl-entry[data-entry-id], .snl-entry-surface[data-entry-id], [data-snl-route-surface][data-entry-id]')) {
      const id=surface.dataset.entryId;if(!id||!m.pointers.some(p=>p.entryId===id))continue;
      if(Array.from(surface.querySelectorAll('[data-snl-source-entry]')).some(el=>el.getAttribute('data-snl-source-entry')===id))continue;
      // Route wrappers may contain the actual Basics Entry surface. Its own
      // header owns the action; do not add another button to the wrapper.
      if(Array.from(surface.querySelectorAll<HTMLElement>('.snl-entry[data-entry-id], .snl-entry-surface[data-entry-id]')).some(child=>child.dataset.entryId===id))continue;
      const action=button('↗ source',()=>{});
      action.dataset.snlSourceEntry=id;action.dataset.snlSourceViewerAction='';
      action.className='snl-entry-source-action';action.setAttribute('aria-label','Open source');action.style.flexShrink='0';
      // Restore the Extension's header slot after export stripped its live
      // button. Headerless legacy surfaces retain their existing fallback.
      (surface.querySelector(':scope > .snl-entry-header') ?? surface).append(action);
    }
  }
  const mutations=new MutationObserver(records=>{if(records.some(r=>r.type==='childList'&&Array.from(r.addedNodes).some(n=>n instanceof Element&&!n.closest('.snl-source-panel'))))attachActions(document);});
  mutations.observe(document.body,{childList:true,subtree:true});attachActions(document);
  function click(e:MouseEvent) {const action=(e.target as Element)?.closest<HTMLElement>('[data-snl-source-entry]');if(action){e.preventDefault();e.stopPropagation();showPointer(action.dataset.snlSourceEntry!);}}
  document.addEventListener('click',click,true);
  function key(e:KeyboardEvent) {
    if(!opened)return;
    if((e.ctrlKey||e.metaKey)&&e.altKey&&e.key.toLowerCase()==='j'&&root.contains(document.activeElement)){e.preventDefault();reverse(true);}
    else if(e.key==='Escape'&&root.contains(document.activeElement)&&!host.querySelector('.find-widget.visible')){e.preventDefault();setOpen(false,true);}
  }
  document.addEventListener('keydown',key,true);
  split.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setWidth(width+(e.key==='ArrowRight'?2:-2));persist();}else if(e.key==='Home'){setWidth(50);persist();}});
  split.addEventListener('pointerdown',e=>{split.setPointerCapture(e.pointerId);});
  split.addEventListener('pointermove',e=>{if(split.hasPointerCapture(e.pointerId))setWidth(e.clientX/innerWidth*100);});
  split.addEventListener('pointerup',e=>{if(split.hasPointerCapture(e.pointerId))split.releasePointerCapture(e.pointerId);persist();});
  const themeObserver=new MutationObserver(theme);themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['class','style','data-snl-color-scheme','lang']});themeObserver.observe(document.body,{attributes:true,attributeFilter:['class','style']});
  function restore() {const s=history.state?.snlSourceView as SavedView|undefined;if(s?.exportId!==m.exportId)return;origin++;try {if(typeof s.width==='number'&&Number.isFinite(s.width))setWidth(s.width);setOpen(!!s.open);if(s.open&&s.fileId&&m.files.some(f=>f.fileId===s.fileId))void openFile(s.fileId,undefined,s);}finally{origin--;}}
  window.addEventListener('popstate',restore);restore();
  const cleanup=()=>{if(disposed)return;disposed=true;generation++;pendingScripts.forEach(cancel=>cancel());resize.disconnect();mutations.disconnect();themeObserver.disconnect();document.removeEventListener('click',click,true);document.removeEventListener('keydown',key,true);window.removeEventListener('popstate',restore);clearMark();decorations?.clear();editor?.dispose();models.forEach(model=>model.dispose());workers.forEach(w=>w.terminate());if(workerURL)URL.revokeObjectURL(workerURL);if(global.MonacoEnvironment===environment)global.MonacoEnvironment=previousEnvironment;root.remove();opener.remove();split.remove();document.documentElement.classList.remove('snl-source-visible');document.querySelectorAll('[data-snl-source-viewer-action]').forEach(el=>el.remove());};
  global.__snlSourceViewerCleanup=cleanup;return cleanup;
}
if(typeof document!=='undefined') {
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>installSourceViewer(),{once:true});
  else installSourceViewer();
}
