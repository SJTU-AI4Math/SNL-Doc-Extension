import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cacheFingerprint, cachePath, clearCache, readCache } from './derivedCache';
import { getLibraryGraphLayout } from './graphLayoutCache';
import { generateGraphLayout, graphLayoutInput, graphLayoutKey, GraphLayoutMemoryCache, isGraphLayout } from './graphLayoutCacheModel';
import { GRAPH_LAYOUT_VERSION, type Layout } from './graphLayout';
import * as geometry from './graphLayout';
const nodes = ['a','b','c'].map(id => ({ id, packageId: id === 'c' ? 'second' : 'p', title: id, kind: 'Theorem', kindId: 'theorem', color: '', background: '' }));
const edges = [['a','b'],['b','c'],['a','c'],['c','a']].map(([from,to]) => ({ id: from+to, from, to, label: 'related', isDependency: false, isAtomic: null }));
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'snl-layout-')); await fs.mkdir(path.join(root, '.SNL_Doc/libraries/one'), { recursive: true }); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
it('binds real spacing parameters, language, labels, graph edges, package and Library identity', async () => {
  const input = graphLayoutInput('one','en',nodes,edges);
  const original = await getLibraryGraphLayout(root,input);
  const generated = vi.spyOn(geometry,'layout');
  expect(await getLibraryGraphLayout(root,input)).toEqual(original);
  expect(generated).not.toHaveBeenCalled();
  const spaced = graphLayoutInput('one','en',nodes,edges,{nodeGapX: 120, layerGapY: 180});
  const changed = await getLibraryGraphLayout(root,spaced);
  expect(changed.layout.height).not.toBe(original.layout.height);
  expect(generated).toHaveBeenCalledTimes(1);
  expect(await readCache(root,{id:'graph-layout',version:GRAPH_LAYOUT_VERSION,scope:{library:'one'},input,
    validate:(v:unknown):v is Layout=>isGraphLayout(v,input)})).toBeUndefined();
  for (const other of [graphLayoutInput('one','zh-CN',nodes,edges), graphLayoutInput('two','en',nodes,edges),
    graphLayoutInput('one','en',nodes.map(n=>({...n,title:'Different'})),edges), graphLayoutInput('one','en',nodes,edges.slice(1)),
    graphLayoutInput('one','en',nodes.map(n=>({...n,packageId:'moved'})),edges)]) expect(graphLayoutKey(other)).not.toBe(original.key);
  await clearCache(root,'graph-layout',{library:'one'});
  expect(await getLibraryGraphLayout(root,input)).toEqual(original);
});
it.each(['json','version','owner','input','nonfinite','range','node','edge','waypoint','cluster','extra'])('rebuilds after %s corruption even when structural mutations have a recomputed envelope checksum', async mutation => {
  const input=graphLayoutInput('one','en',nodes,edges), original=await getLibraryGraphLayout(root,input);
  const file=cachePath(root,'graph-layout',{library:'one'});
  const envelope=JSON.parse(await fs.readFile(file,'utf8'));
  if(mutation==='version') envelope.version='old';
  if(mutation==='owner') envelope.library='other';
  if(mutation==='input') envelope.inputHash='0'.repeat(64);
  if(mutation==='nonfinite') envelope.value.nodes[0].x=null;
  if(mutation==='range') envelope.value.nodes[0].x=envelope.value.width+1;
  if(mutation==='node') envelope.value.nodes[0].id='foreign';
  if(mutation==='edge') envelope.value.edges[0].from='foreign';
  if(mutation==='waypoint') envelope.value.edges[0].waypoints=[{x:-1,y:1}];
  if(mutation==='cluster') envelope.value.clusters[0].nodeCount++;
  if(mutation==='extra') envelope.value.selectedId='a';
  envelope.valueHash=cacheFingerprint(envelope.value);
  await fs.writeFile(file,mutation==='json' ? '{' : JSON.stringify(envelope));
  expect(await getLibraryGraphLayout(root,input)).toEqual(original);
  expect(JSON.parse(await fs.readFile(file,'utf8')).value).toEqual(original.layout);
});
it('validates empty graphs, cycles, adversarial IDs and exact node/edge sets', () => {
  const input=graphLayoutInput('one','en',nodes.map(n=>({...n,id:n.id==='b'?'__dummy_0':n.id})),edges.map(e=>({...e,from:e.from==='b'?'__dummy_0':e.from,to:e.to==='b'?'__dummy_0':e.to})));
  const result=generateGraphLayout(input);
  expect(isGraphLayout(result,input)).toBe(true);
  expect(result.nodes.map(n=>n.id).sort()).toEqual(['__dummy_0','a','c']);
  expect(result.edges.some(e=>e.isBack)).toBe(true);
  const empty=graphLayoutInput(null,'en',[],[]); expect(isGraphLayout(generateGraphLayout(empty),empty)).toBe(true);
  for(const value of [undefined,{}, {...result,nodes:[result.nodes[0],result.nodes[0],result.nodes[2]]}, {...result,width:Infinity}]) expect(isGraphLayout(value,input)).toBe(false);
});
it('rejects unsafe path owners/symlinks without overwriting outside files', async () => {
  for(const owner of ['../escape','a/b','..']) await expect(getLibraryGraphLayout(root,graphLayoutInput(owner,'en',nodes,edges))).rejects.toThrow();
  const outside=path.join(root,'outside'); await fs.mkdir(outside);
  await fs.symlink(outside,path.join(root,'.SNL_Doc/libraries/one/.cache'));
  await expect(getLibraryGraphLayout(root,graphLayoutInput('one','en',nodes,edges))).rejects.toThrow();
  expect(await fs.readdir(outside)).toEqual([]);
  await expect(getLibraryGraphLayout(root,graphLayoutInput(null,'en',nodes,edges))).rejects.toThrow();
});
it('memory key is order independent, skips current colors, and invalidates changed parameters', () => {
  const input=graphLayoutInput(null,'en',nodes,edges), memory=new GraphLayoutMemoryCache();
  const first=memory.get(input);
  expect(memory.get(graphLayoutInput(null,'en',[...nodes].reverse().map(n=>({...n,color:'#fff'})),[...edges].reverse()))).toBe(first);
  const changed=memory.get(graphLayoutInput(null,'en',nodes,edges,{nodeGapX:2,layerGapY:300}));
  expect(changed.height).not.toBe(first.height);
  memory.clear(); expect(memory.get(input)).toEqual(first); expect(memory.get(input)).not.toBe(first);
});

it('clear retires in-flight layout generation rather than resurrecting cleared disk data', async () => {
  const input = graphLayoutInput('one','en',nodes,edges);
  const pending = getLibraryGraphLayout(root,input).then(() => 'unexpected success', error => error.name);
  await clearCache(root,'graph-layout',{library:'one'});
  expect(await pending).toBe('AbortError');
  await expect(fs.stat(cachePath(root,'graph-layout',{library:'one'}))).rejects.toThrow();
  const recovered = await getLibraryGraphLayout(root,input);
  expect(isGraphLayout(recovered.layout,input)).toBe(true);
});
