// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CreateLibraryApp } from './CreateLibraryApp';
const postMessage=vi.fn();
beforeEach(()=>{postMessage.mockClear();(globalThis as any).__snlApi={postMessage,getState:()=>undefined,setState:()=>{}};});
afterEach(()=>{cleanup();delete (globalThis as any).__snlApi;});
const send=async(data:unknown)=>act(async()=>{window.dispatchEvent(new MessageEvent('message',{data}));});
async function open(){render(<CreateLibraryApp/>);await send({type:'context',mode:'edit',targetState:'found',slug:'notes',libraryRevision:'m1',existing:{slug:'notes',title:'Notes'}});await send({type:'graph',nodes:[],relationships:[],entries:[],kinds:[],warnings:[],graphRevision:'g1'});await send({type:'countersLoaded',counters:[],countersRevision:'c1'});fireEvent.click(await screen.findByRole('button',{name:'+ Add root entry'}));return screen.getByPlaceholderText('Search existing entry, or type a new id and click Create');}
async function query(input:HTMLElement,id:string){fireEvent.change(input,{target:{value:id}});await waitFor(()=>expect(postMessage.mock.calls.some(([m])=>m.type==='lookupEntry'&&m.entryId===id)).toBe(true));return postMessage.mock.calls.filter(([m])=>m.type==='lookupEntry').at(-1)![0];}
it('off-graph hit stages one reference, pending cannot create, complete save retains CAS',async()=>{
 const input=await open();const request=await query(input,'Off.graph');
 fireEvent.click(screen.getByRole('button',{name:'Create'}));expect(postMessage.mock.calls.some(([m])=>m.type==='openCreateEntry')).toBe(false);
 await send({...request,type:'entryLookup',entry:{id:'Off.graph',title:'Off graph',kind:'theorem',content:{}}});
 fireEvent.click(await screen.findByRole('button',{name:'Reference'}));
 fireEvent.click(screen.getByRole('button',{name:'Save Changes'}));
 await waitFor(()=>expect(postMessage.mock.calls.some(([m])=>m.type==='saveLibraryDraft')).toBe(true));
 const saved=postMessage.mock.calls.find(([m])=>m.type==='saveLibraryDraft')![0];
 expect(saved.graph.nodes).toEqual([expect.objectContaining({props:{entryId:'Off.graph'}})]);
 expect(saved.expectedRevisions).toEqual({meta:'m1',graph:'g1',counters:'c1'});
 expect(postMessage.mock.calls.some(([m])=>['graphOp','openCreateEntry'].includes(m.type))).toBe(false);
});
it('lookup error is not a create invitation and malformed hit cannot resolve',async()=>{
 const request=await query(await open(),'Denied');await send({...request,type:'entryLookupError',message:'denied'});
 fireEvent.click(screen.getByRole('button',{name:'Create'}));expect(postMessage.mock.calls.some(([m])=>m.type==='openCreateEntry')).toBe(false);
 await send({...request,type:'entryLookup',entry:{id:'Other',title:'Wrong'}});expect(screen.queryByRole('button',{name:'Reference'})).toBeNull();
});
it('cancel and newer same-ID queries retire previous responses',async()=>{
 const input=await open();const first=await query(input,'Repeat');await query(input,'Other');const second=await query(input,'Repeat');
 expect(second.requestId).not.toBe(first.requestId);
 await send({...first,type:'entryLookup',entry:{id:'Repeat',title:'Stale',kind:'theorem'}});expect(screen.queryByRole('button',{name:'Reference'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));await send({...second,type:'entryLookup',entry:{id:'Repeat',title:'Cancelled',kind:'theorem'}});
 fireEvent.click(screen.getByRole('button',{name:'+ Add root entry'}));expect(screen.queryByText(/Cancelled/)).toBeNull();
});
