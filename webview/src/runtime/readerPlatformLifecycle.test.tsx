import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { BrowserReader } from '../reader/BrowserReader';
import { getReaderPlatformApi, setReaderPlatformApi } from './readerPlatform';
import type { FrozenReaderSnapshot } from '../../../src/sharedReaderSnapshot';
const snapshot: FrozenReaderSnapshot = {
 version:1, renderSnapshotId:'port-test', library:{slug:'L',title:'L',outline:[],warnings:[]}, entries:[],entryKinds:[],entryPackages:{},macros:{},macroKinds:[],relationships:[],
 preferences:{language:'en',color_scheme:'light',motion:'reduced'},contentLanguage:'en',languages:[{id:'en',display_name:'English'}],resources:{}
};
describe('reader platform lease lifecycle',()=>{
 it('restores the previous port after a browser reader unmounts',async()=>{
  const previous={postMessage:vi.fn()};setReaderPlatformApi(previous);const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  try{await act(async()=>root.render(<BrowserReader snapshot={snapshot}/>));expect(getReaderPlatformApi()).not.toBe(previous);await act(async()=>root.unmount());expect(getReaderPlatformApi()).toBe(previous);}
  finally{host.remove();setReaderPlatformApi(previous);}
 });
});
