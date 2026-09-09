import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnlGraphApp } from './SnlGraphApp';
const api=vi.hoisted(()=>({postMessage:vi.fn(),getState:vi.fn(),setState:vi.fn()}));
vi.mock('./vscodeApi',async(original)=>({...await original<typeof import('./vscodeApi')>(),useVsCodeApiRef:()=>({current:api}),getVsCodeApi:()=>api}));
const nodes=['a','b','c','d'].map(id=>({id,packageId:'logic',title:id,kind:'Theorem',kindId:'thm',coloring:null}));
const edge=(id:string,from:string,to:string)=>({id,from,to,label:id,isDependency:false,isAtomic:null});
const graph={type:'graph',scope:{mode:'pool'},title:'Selection',warnings:[],nodes,edges:[edge('AB','a','b'),edge('BC','b','c'),edge('DD','d','d')]};
const send=(data:unknown=graph)=>act(()=>window.dispatchEvent(new MessageEvent('message',{data})));
const group=(id:string)=>[...document.querySelectorAll<SVGGElement>('g[role="button"]')].find(n=>n.getAttribute('aria-label')?.startsWith(`Relationship ${id}:`))!;
const node=(id:string)=>document.querySelector(`[data-node-id="${id}"]`)!;
const hidden=(id:string)=>{expect(group(id)).toBeUndefined();expect(document.querySelector(`[data-edge-id="${id}"]`)).toBeNull();expect(screen.queryByRole('button',{name:new RegExp(`^Relationship ${id}:`)})).toBeNull();};
const visible=(id:string)=>expect(group(id).getAttribute('opacity')??group(id).style.opacity).not.toBe('0');
beforeEach(()=>{document.documentElement.lang='en';api.postMessage.mockReset();api.setState.mockReset();render(<SnlGraphApp/>);send();fireEvent.click(screen.getByTestId('graph-filter-toggle'));fireEvent.click(screen.getByRole('checkbox',{name:'Show relationships'}));});
afterEach(()=>{cleanup();vi.restoreAllMocks();document.documentElement.lang='';});
describe('graph selection isolates unrelated edges',()=>{
 it('keeps only directly incident edges and cannot reveal unrelated edges by hovering',()=>{
  const unrelated=group('DD');
  fireEvent.click(node('b'));visible('AB');visible('BC');hidden('DD');
  fireEvent.pointerEnter(unrelated);hidden('DD');
  fireEvent.click(node('b'));visible('AB');visible('BC');visible('DD');
 });
 it('selects only one edge, preserves its edit action and deselects on repeat click',()=>{
  fireEvent.click(group('AB'));visible('AB');hidden('BC');hidden('DD');
  expect(api.postMessage).toHaveBeenCalledWith({type:'editRelationship',id:'AB'});
  fireEvent.click(group('AB'));visible('BC');visible('DD');
 });
 it('switches edge/node selection mutually, restores on blank canvas and Escape without relayout',()=>{
  const transforms=nodes.map(n=>node(n.id).getAttribute('transform'));
  fireEvent.click(group('AB'));fireEvent.click(node('b'));visible('BC');hidden('DD');
  fireEvent.pointerDown(document.getElementById('snl-graph-background')!);visible('DD');
  fireEvent.click(node('a'));hidden('BC');fireEvent.keyDown(node('a'),{key:'Escape'});visible('BC');visible('DD');
  expect(nodes.map(n=>node(n.id).getAttribute('transform'))).toEqual(transforms);
  expect(api.setState).not.toHaveBeenCalled();
 });
 it('clears stale selections after refreshed objects disappear',()=>{
  fireEvent.click(group('AB'));hidden('DD');send({...graph,edges:graph.edges.slice(1)});visible('BC');visible('DD');
  fireEvent.click(node('b'));hidden('DD');send({...graph,nodes:[nodes[3]],edges:[graph.edges[2]]});visible('DD');
 });
 it('restores each edge original opacity after clearing selection',()=>{
  const before=graph.edges.map(e=>group(e.id).querySelector('path')!.getAttribute('stroke-opacity'));
  fireEvent.click(node('b'));hidden('DD');
  fireEvent.pointerDown(document.getElementById('snl-graph-background')!);
  expect(graph.edges.map(e=>group(e.id).querySelector('path')!.getAttribute('stroke-opacity'))).toEqual(before);
 });
 it('supports keyboard activation and keeps Ctrl node navigation',()=>{
  fireEvent.keyDown(group('AB'),{key:'Enter'});hidden('DD');
  fireEvent.keyDown(group('AB'),{key:'Escape'});visible('DD');
  fireEvent.keyDown(node('b'),{key:' '});hidden('DD');
  fireEvent.click(node('a'),{ctrlKey:true});
  expect(api.postMessage).toHaveBeenCalledWith({type:'openEntryInfoview',entryId:'a'});
 });
});
