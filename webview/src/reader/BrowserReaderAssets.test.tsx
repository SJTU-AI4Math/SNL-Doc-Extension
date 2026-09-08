import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { BrowserReader } from './BrowserReader';
import type { FrozenReaderSnapshot } from '../../../src/sharedReaderSnapshot';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('resolves Markdown images directly from frozen bytes and never emits a network asset URL',async()=>{
 const entry={id:'E',package:'P',kind:'entry',title:'Images',content:{markdown:'![known](assets/known.svg)\n\n![remote](https://example.invalid/tracker.png)\n\n![missing](missing.svg)'},pointer:null};
 const known='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E';
 const snapshot:FrozenReaderSnapshot={version:1,renderSnapshotId:'asset-test',library:{slug:'L',title:'L',warnings:[],outline:[{nodeId:'n',entry,kind:null,counterLabel:null,children:[]}]},entries:[entry],entryKinds:[],entryPackages:{E:'P'},macros:{},macroKinds:[],relationships:[],preferences:{language:'en',color_scheme:'light',motion:'reduced'},contentLanguage:'en',languages:[{id:'en',display_name:'English'}],resources:{'known.svg':{url:known,revision:'r'}}};
 const element=document.createElement('div');document.body.append(element);const root=createRoot(element);
 try{await act(async()=>root.render(<BrowserReader snapshot={snapshot}/>));const image=(alt:string)=>element.querySelector<HTMLImageElement>(`img[alt="${alt}"]`);expect(image('known')?.getAttribute('src')).toBe(known);expect(image('remote')?.getAttribute('src')).not.toMatch(/^https?:/);expect(image('missing')?.getAttribute('src')).not.toMatch(/^https?:/);}
 finally{await act(async()=>root.unmount());element.remove();}
});
