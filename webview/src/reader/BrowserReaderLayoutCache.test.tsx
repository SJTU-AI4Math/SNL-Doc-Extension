import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserReader } from './BrowserReader';
import type { FrozenReaderSnapshot } from '../../../src/sharedReaderSnapshot';
import * as geometry from '../../../src/graphLayout';
function snapshot(slug = 'one'): FrozenReaderSnapshot {
  return { version: 1, renderSnapshotId: 'frozen-'+slug,
    library: { slug, title: slug, warnings: [], outline: [] },
    entries: ['a','b'].map(id=>({id,package:'p',kind:'theorem',title:id,content:{markdown:id},pointer:null})),
    entryKinds: [], entryPackages: {a:'p',b:'p'}, macros:{},macroKinds:[],
    relationships:[{id:'ab',from:'a',to:'b',label:'related',metadata:{}}],
    preferences:{language:'en',color_scheme:'light',motion:'reduced'},contentLanguage:'en',
    languages:[{id:'en',display_name:'English'}],resources:{} };
}
beforeEach(()=>{ history.replaceState(null,'','#/graph'); localStorage.clear(); });
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('reuses frozen geometry across real reader navigation, ignoring persistent layout data and never altering its source snapshot',async()=>{
  const source=snapshot(), bytes=JSON.stringify(source);
  localStorage.setItem('graph-layout',JSON.stringify({nodes:[{id:'evil',x:Infinity}]}));
  const read=vi.spyOn(Storage.prototype,'getItem'), write=vi.spyOn(Storage.prototype,'setItem');
  const compute=vi.spyOn(geometry,'layout');
  await act(async()=>{render(<BrowserReader snapshot={source}/>);});
  const node=screen.getByRole('button',{name:'Entry a (a)'});
  const initial=node.getAttribute('transform');
  expect(compute).toHaveBeenCalledTimes(1);
  await act(async()=>{fireEvent.click(node,{ctrlKey:true});});
  expect(location.hash).toContain('#/entry/a');
  await act(async()=>{history.replaceState(null,'','#/graph');window.dispatchEvent(new PopStateEvent('popstate'));});
  expect(screen.getByRole('button',{name:'Entry a (a)'}).getAttribute('transform')).toBe(initial);
  expect(compute).toHaveBeenCalledTimes(1);
  expect(read.mock.calls.every(([key])=>key==='snl-reader-preferences')).toBe(true);
  expect(write.mock.calls.every(([key])=>key==='snl-reader-preferences')).toBe(true);
  expect(JSON.stringify(source)).toBe(bytes);
});
it('uses a new memory owner and current graph when the frozen export is replaced',async()=>{
  const compute=vi.spyOn(geometry,'layout');
  const first=snapshot(); let view: ReturnType<typeof render>;
  await act(async()=>{view=render(<BrowserReader snapshot={first}/>);});
  const second=snapshot('two'); second.entries[0].title='Different title in another frozen export';
  await act(async()=>{view!.rerender(<BrowserReader snapshot={second}/>);});
  expect(screen.getByRole('button',{name:'Entry Different title in another frozen export (a)'})).toBeTruthy();
  expect(compute).toHaveBeenCalledTimes(2);
});
