import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
vi.mock('monaco-editor/esm/vs/editor/editor.api', () => ({}));
vi.mock('monaco-editor/esm/vs/editor/contrib/find/browser/findController', () => ({}));
vi.mock('monaco-editor/esm/vs/editor/contrib/folding/browser/folding', () => ({}));
vi.mock('monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard', () => ({}));
import { rankSourcePointers, validateManifest, sha256Bytes, verifyChunk, preferSourceRoutes } from './viewer';
import { findNearestEntries, type PointerIndex } from '../pointerSync/index';
import type { SourceManifest, SourcePointer } from './types';
const sha = createHash('sha256').update('abc').digest('hex');
const base: SourceManifest = { schemaVersion:'snl.export.sources/v1',exportId:'e',renderSnapshotId:'r',workspaceName:'w',snapshot:{mode:'disk'},options:{scope:'project',keep:[],exclude:[],companionFiles:[]},files:[{fileId:'f',displayPath:'x',kind:'text',language:'lean4',byteLength:3,sha256:sha,bom:false,eol:'none',chunkId:'source-f.js'}],directories:[],pointers:[],entryRoutes:[] };
function pointer(id:string,line:number,endLine=line,beforeLines?:number,afterLines?:number):SourcePointer {return {entryId:id,fileId:'f',sourceSha256:sha,status:'ok',pointer:{mode:'lines',file:'x',line,endLine,beforeLines,afterLines},range:{startLine:line,startColumn:1,endLine,endColumn:2,coveredEndLine:endLine}};}
describe('browser/host ranking contract',()=>{
  it('does not mistake the standalone fallback for a second outline occurrence',()=>{
    const a={entryId:'e',nodeId:'a',hash:'#/node/a'},b={entryId:'e',nodeId:'b',hash:'#/node/b'},fallback={entryId:'e',hash:'#/entry/e'};
    expect(preferSourceRoutes([a,fallback],'')).toEqual([a]);
    expect(preferSourceRoutes([a,b,fallback],'')).toEqual([a,b]);
    expect(preferSourceRoutes([a,b,fallback],fallback.hash)).toEqual([fallback]);
    expect(preferSourceRoutes([fallback],'')).toEqual([fallback]);
  });
  it('matches real host for every line across asymmetric thresholds, span and ties',()=>{
    const pointers=[pointer('wide',20,35,0,2),pointer('inner',24,25,15,0),pointer('tie',24,25,15,0),pointer('default',60)];
    const manifest={...base,pointers};
    const index:PointerIndex={version:1,unfiled:[],files:{x:{fingerprint:sha,entries:pointers.map(p=>({entryId:p.entryId,pointer:p.pointer,resolution:{status:'ok',range:p.range!}}))}}};
    for(let line=1;line<100;line++){const b=rankSourcePointers(manifest,'f',line),h=findNearestEntries(index,'x',line);expect(b.candidates.map(c=>c.entryId)).toEqual(h.candidates.map(c=>c.entryId));expect(b.complete).toBe(h.complete);}
  });
  it('does not run regex and preserves unresolved same-file completeness',()=>{
    const known=pointer('known',1);const unresolved:SourcePointer={entryId:'unknown',pointer:{mode:'regex',file:'x',pattern:'(a+)+$'},status:'unresolved'};
    expect(rankSourcePointers({...base,pointers:[known,unresolved]},'f',1)).toEqual({candidates:[known],complete:false});
    expect(rankSourcePointers({...base,pointers:[known,{...unresolved,pointer:{mode:'regex',file:'elsewhere',pattern:'['}}]},'f',1).complete).toBe(true);
  });
  it('covers 0/15/16 boundaries, long interior and half-open coveredEndLine',()=>{
    const p=pointer('one',20);expect(rankSourcePointers({...base,pointers:[p]},'f',5).candidates).toHaveLength(1);expect(rankSourcePointers({...base,pointers:[p]},'f',4).candidates).toHaveLength(0);
    expect(rankSourcePointers({...base,pointers:[p]},'f',35).candidates).toHaveLength(1);expect(rankSourcePointers({...base,pointers:[p]},'f',36).candidates).toHaveLength(0);
    const half={...pointer('half',1,10,0,0),range:{startLine:1,startColumn:1,endLine:11,endColumn:1,coveredEndLine:10}};expect(rankSourcePointers({...base,pointers:[half]},'f',10).candidates).toHaveLength(1);expect(rankSourcePointers({...base,pointers:[half]},'f',11).candidates).toHaveLength(0);
  });
});
describe('offline integrity admission',()=>{
  it('accepts prototype-shaped ordinary display paths and Entry IDs',()=>{expect(validateManifest({...base,files:[{...base.files[0],displayPath:'__proto__'}],entryRoutes:[{entryId:'constructor',hash:'#/entry/constructor'}]})).toBeTruthy();});
  it.each([
    {...base,schemaVersion:'v99'}, {...base,files:[...base.files,...base.files]},
    {...base,files:[{...base.files[0],fileId:'../bad'}]}, {...base,files:[{...base.files[0],displayPath:'../secret'}]},
    {...base,entryRoutes:[{entryId:'x',hash:'javascript:alert(1)'}]},
    {...base,pointers:[{...pointer('x',1),sourceSha256:'bad'}]}
  ])('rejects malformed manifest before loading/navigation',m=>expect(()=>validateManifest(m)).toThrow());
  it('matches Node SHA-256 across padding boundaries and non-ASCII bytes',()=>{for(const n of [0,1,3,55,56,63,64,65,1000,65536]){const b=Uint8Array.from({length:n},(_,i)=>i%256);expect(sha256Bytes(b)).toBe(createHash('sha256').update(b).digest('hex'));}});
  it('rejects chunk corruption, ID mismatches and missing chunks',async()=>{const c={fileId:'f',sha256:sha,base64:'YWJj'};await expect(verifyChunk(base.files[0],c)).resolves.toEqual(new Uint8Array([97,98,99]));for(const bad of [undefined,{...c,fileId:'g'},{...c,base64:'YWJk'},{...c,base64:'!!!'}])await expect(verifyChunk(base.files[0],bad)).rejects.toThrow();});
});
