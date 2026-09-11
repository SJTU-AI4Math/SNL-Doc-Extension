import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserReader } from './BrowserReader';
import type { FrozenReaderSnapshot } from '../../../src/sharedReaderSnapshot';
import * as metrics from '../components/EntryMetrics';
function snapshot(): FrozenReaderSnapshot {
  const entry = {id:'a',package:'p',kind:'entry',title:'Alpha',content:{markdown:'Authored body'},pointer:null};
  return {version:1,renderSnapshotId:'global-metric-fixture',
    library:{slug:'one',title:'One',warnings:[],outline:[{nodeId:'a-node',entry,kind:null,counterLabel:null,children:[]}]},
    entries:[entry],entryKinds:[],entryPackages:{a:'p'},macros:{},macroKinds:[],relationships:[],
    preferences:{language:'en',color_scheme:'light',motion:'reduced'},contentLanguage:'en',languages:[{id:'en',display_name:'English'}],resources:{},
    // Deliberately frozen fixture values: a local empty/SNL-less context cannot
    // reconstruct these. The reader must display them, never recompute a subgraph.
    cachedEntryMetrics:{scope:'workspace',status:'ready',entries:{a:{kind:'ok',metrics:{structuralIndex:0.625,
      weakSemanticFreedom:3,strongSemanticFreedom:1,weightedTotal:4,weightedWeakSemanticFreedom:3,weightedStrongSemanticFreedom:1}}}},
    globalPageRank:{scope:'workspace',scores:{a:0.125},converged:true,iterations:8}};
}
beforeEach(()=> {history.replaceState(null,'','#/library');localStorage.clear();});
afterEach(()=> {cleanup();vi.restoreAllMocks();});
it('reuses identical frozen global values in Library and Entry routes without recalculation or writes',async()=>{
  const source = snapshot(), before=JSON.stringify(source);
  const compute=vi.spyOn(metrics,'computeEntryMetricsForIds');
  const write=vi.spyOn(Storage.prototype,'setItem');
  const view=render(<BrowserReader snapshot={source}/>);
  const check=(scope:Element)=> {
    expect(scope.querySelector('[data-snl-cached-entry-metrics="a"]')?.textContent).toBe('SSI '+(0.625).toFixed(2));
    const rank=scope.querySelector('.entry-page-rank');
    expect(rank?.getAttribute('data-state')).toBe('ready');
    expect(rank?.textContent).toContain((0.125).toPrecision(6));
  };
  check(view.container);
  await act(async()=> {history.replaceState(null,'','#/entry/a');window.dispatchEvent(new PopStateEvent('popstate'));});
  const visible = [...view.container.querySelectorAll('[data-snl-entry-metric-region="a"]')].filter(node => !node.closest('[hidden]'));
  expect(visible).toHaveLength(1);
  check(visible[0]);
  expect(compute).not.toHaveBeenCalled();
  expect(write.mock.calls.every(([key])=>key==='snl-reader-preferences')).toBe(true);
  expect(JSON.stringify(source)).toBe(before);
});
it.each(['missing','corrupt'])('keeps authored body readable and marks %s metrics unavailable',async(mode)=>{
  const source=snapshot();
  delete source.cachedEntryMetrics; delete source.globalPageRank;
  if(mode==='corrupt') Object.assign(source,{cachedEntryMetrics:{scope:'workspace',status:'ready',entries:{a:null}},
    globalPageRank:{scope:'library',scores:{a:1},converged:true,iterations:1}});
  const view=render(<BrowserReader snapshot={source}/>);
  expect(view.container.textContent).toContain('Authored body');
  expect(view.container.querySelector('[data-snl-cached-entry-metrics="a"]')?.textContent).toBe('Global SSI unavailable');
  expect(view.container.querySelector('.entry-page-rank')?.getAttribute('data-state')).toBe('unavailable');
});
