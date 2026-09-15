// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
afterEach(()=>{cleanup();delete (globalThis as any).__snlApi;});
const send=async(data:unknown)=>act(async()=>window.dispatchEvent(new MessageEvent('message',{data})));
it('early body is interactive and global region does not reset expanded descendants',async()=>{
 (globalThis as any).__snlApi={postMessage:vi.fn()};render(<App/>);
 const child={nodeId:'child',entry:null,kind:null,counterLabel:null,children:[]};
 const message={type:'libraryEntries',slug:'notes',title:'Notes',bodyGeneration:1,globalPending:true,entries:[],macros:{},outline:[{...child,nodeId:'root',children:[child]}],warnings:[]};
 await send(message);expect(screen.queryByRole('button',{name:'Export HTML'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Expand all'}));
 expect(document.querySelector('[data-snl-route-id=child]')).toBeTruthy();
 const before=document.querySelector('[data-snl-route-id=child]');
 await send({...message,type:'libraryRegions',globalPending:false,renderSnapshotId:'complete',outline:[]});
 expect(document.querySelector('[data-snl-route-id=child]')).toBe(before);
 expect(screen.getByRole('button',{name:'Export HTML'})).toBeTruthy();
 await send({type:'libraryInvalidated',slug:'notes'});
 expect(screen.queryByRole('button',{name:'Export HTML'})).toBeNull();
 expect(document.querySelector('[data-snl-route-id=child]')).toBe(before);
});
