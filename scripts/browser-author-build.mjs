import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
export function requireOverlay(){
 const identity=JSON.parse(readFileSync(resolve(root,'.browser-author-overlay.json'),'utf8'));
 if(identity.source!==root || existsSync(resolve(root,'.git'))) throw Error('Exclusive non-Git source overlay required');
 return identity;
}
requireOverlay();
const {build}=await import('esbuild');
await build({entryPoints:[resolve(root,'webview/vite.config.ts')],outfile:resolve(root,'.author-vite.mjs'),bundle:true,packages:'external',platform:'node',format:'esm',define:{__dirname:JSON.stringify(resolve(root,'webview'))}});
for(const name of (process.env.SNL_AUTHOR_ENTRIES||'main,createEntry').split(',')){
 const p=spawnSync(process.execPath,[resolve(root,'node_modules/vite/bin/vite.js'),'build','--config',resolve(root,'.author-vite.mjs'),'--configLoader','native'],{cwd:root,env:{...process.env,SNL_WEBVIEW_ENTRY:name},stdio:'inherit'});
 if(p.status!==0) process.exit(p.status??1);
}
