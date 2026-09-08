import { afterEach, expect, it, vi } from 'vitest';
import { connect_preferences_platform } from './preferencesRuntime';
const base='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==#snl-workspace-asset';
afterEach(()=>{window.dispatchEvent(new Event('pagehide'));document.body.replaceChildren();delete document.documentElement.dataset.snlAssetBaseUri;});
it('initializes preferences and the image broker when host authority arrives after module evaluation',async()=>{
 document.documentElement.dataset.snlAssetBaseUri=base;
 const image=document.createElement('img');image.src=base+'/fixture.svg';document.body.append(image);
 const postMessage=vi.fn();const api={postMessage};connect_preferences_platform(api);connect_preferences_platform(api);
 await vi.waitFor(()=>expect(postMessage.mock.calls.some(([m])=>m.type==='snl.assets/resolve')).toBe(true));
 expect(postMessage.mock.calls.filter(([m])=>m.type==='snl.preferences/ready')).toHaveLength(1);
 const request=postMessage.mock.calls.find(([m])=>m.type==='snl.assets/resolve')![0];expect(request.path).toBe('fixture.svg');
 window.dispatchEvent(new MessageEvent('message',{data:{type:'snl.assets/resolved',request_id:request.request_id,path:request.path,url:'data:image/svg+xml,%3Csvg/%3E'}}));
 await vi.waitFor(()=>expect(image.src).toBe('data:image/svg+xml,%3Csvg/%3E'));
});
