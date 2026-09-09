import assert from 'node:assert/strict';
export async function verifyGraphRoutes({evaluate,wait,screenshot,page,evidence}){
 const settle=()=>new Promise(r=>setTimeout(r,100));
 const select=async(label,value)=>{await evaluate(`(()=>{const s=document.querySelector('select[aria-label="${label}"]');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await settle();};
 const geometry=()=>evaluate(`(()=>{const vp=document.querySelector('[data-graph-viewport]');const nodes={};for(const n of document.querySelectorAll('[data-node-id]')){const s=n.querySelector(':scope>rect,:scope>circle');const b=s.getBBox(),m=vp.getCTM().inverse().multiply(s.getCTM());const p=new DOMPoint(b.x+b.width/2,b.y+b.height/2).matrixTransform(m);nodes[n.dataset.nodeId]={x:p.x,y:p.y};}const c=vp.closest('svg').getAttribute('data-radial-center');const center=c?c.match(/-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?/gi).map(Number):null;const edges=[...vp.querySelectorAll('path[marker-end]')].map(p=>{const g=p.parentElement;const e=window.__fixture.edges.find(e=>e.id===g.dataset.edgeId||g.getAttribute('aria-label')==='Relationship '+e.label+': '+e.from+' to '+e.to);return {id:e?.id,from:e?.from,to:e?.to,d:p.getAttribute('d'),arrow:p.getAttribute('marker-end'),opacity:getComputedStyle(g).opacity,stroke:p.getAttribute('stroke-opacity'),pointer:getComputedStyle(g).pointerEvents};});return {nodes,center,edges};})()`);
 const parse=d=>{const v=d.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi).map(Number);assert.ok(v.every(Number.isFinite));assert.equal((v.length-2)%6,0);let start={x:v[0],y:v[1]};const segments=[];for(let i=2;i<v.length;i+=6){const p=[start,{x:v[i],y:v[i+1]},{x:v[i+2],y:v[i+3]},{x:v[i+4],y:v[i+5]}];segments.push(p);start=p[3];}return segments;};
 const vector=(a,b)=>({x:b.x-a.x,y:b.y-a.y});
 const cross=(a,b)=>a.x*b.y-a.y*b.x;
 const length=a=>Math.hypot(a.x,a.y);
 const sample=(p,t)=>({x:(1-t)**3*p[0].x+3*(1-t)**2*t*p[1].x+3*(1-t)*t*t*p[2].x+t**3*p[3].x,y:(1-t)**3*p[0].y+3*(1-t)**2*t*p[1].y+3*(1-t)*t*t*p[2].y+t**3*p[3].y});
 evidence.routes={};const expectedEdgeCount=await evaluate('window.__fixture.edges.length');await select('Nodes','always-title');
 for(const [mode,packing] of [['rectangle','bands'],['radial-outward','bands'],['radial-inward','bands'],['radial-outward','rings'],['radial-inward','rings']]){
  if(packing==='rings'){await evaluate(`document.querySelector('button[title="Expand filters"]')?.click()`);await settle();await select('Layer packing',packing);}
  await select('Layout',mode);const g=await geometry();assert.equal(g.edges.length,expectedEdgeCount);
  for(const e of g.edges){assert.ok(e.id);const ss=parse(e.d),first=ss[0],last=ss.at(-1),u=vector(first[0],first[1]),v=vector(last[2],last[3]);assert.ok(length(u)>0&&length(v)>0);assert.equal(e.arrow,'url(#snl-graph-arrow)');if(e.from===e.to){assert.ok(ss.length>=2,'self loop stays visible');continue;}
   if(mode==='rectangle'){assert.equal(ss.length,1,'rectangle must have one cubic, no dummy anchors');assert.ok(Math.abs(u.x)<1e-7&&Math.abs(v.x)<1e-7,'rectangle endpoint tangents must be vertical');}
   else {assert.ok(g.center?.length===2,'radial center not exposed');const c={x:g.center[0],y:g.center[1]},a=vector(c,g.nodes[e.from]),b=vector(c,g.nodes[e.to]);assert.ok(Math.abs(cross(a,u))<=1e-5*length(a)*length(u),'departure is not radial');assert.ok(Math.abs(cross(b,v))<=1e-5*length(b)*length(v),'arrival is not radial');
    let prev=Math.atan2(first[0].y-c.y,first[0].x-c.x),turn=0;const radii=[],turns=[];for(const s of ss)for(let i=1;i<=32;i++){const p=sample(s,i/32),angle=Math.atan2(p.y-c.y,p.x-c.x);let delta=Math.atan2(Math.sin(angle-prev),Math.cos(angle-prev));turn+=delta;turns.push(delta);prev=angle;radii.push(Math.hypot(p.x-c.x,p.y-c.y));}assert.ok(Math.abs(turn)<=Math.PI+0.02,'route takes long angular side');assert.ok(Math.min(...radii)>0.01,'route crosses center');assert.ok(turns.every(d=>d*Math.sign(turn)>=-1e-7),'angular backtracking');assert.ok(turns.reduce((s,d)=>s+Math.abs(d),0)<=Math.PI+0.02,'total angular travel exceeds short side');
   }
  }
  const key=mode+(packing==='rings'?'-rings':'');evidence.routes[key]=g;await screenshot('routes-'+key);
 }
 // Real pointer hit for node selection; hidden paths must neither paint nor hit.
 const click=async(x,y)=>{await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});await settle();};
 const nodeCenter=await evaluate(`(()=>{const r=document.querySelector('[data-node-id="Goal"] > rect').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await click(nodeCenter.x,nodeCenter.y);
 let g=await geometry();assert.ok(g.edges.some(e=>e.from!=='Goal'&&e.to!=='Goal'));for(const e of g.edges)if(e.from!=='Goal'&&e.to!=='Goal'){assert.equal(e.opacity,'0');assert.equal(e.pointer,'none');}
 evidence.routes.nodeSelected=g;await screenshot('routes-selected-node');
 await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await settle();
 assert.ok((await geometry()).edges.every(e=>e.opacity!=='0'));
 const hit=await evaluate(`(()=>{const p=document.querySelector('[data-graph-viewport] path[marker-end]');const local=p.getPointAtLength(p.getTotalLength()/2),m=p.getScreenCTM(),v=new DOMPoint(local.x,local.y).matrixTransform(m);return {x:v.x,y:v.y}})()`);await click(hit.x,hit.y);
 g=await geometry();assert.equal(g.edges.filter(e=>e.opacity!=='0').length,1,'edge selection retains exactly that edge');assert.ok(await evaluate(`window.__posted.some(m=>m.type==='editRelationship')`));evidence.routes.edgeSelected=g;await screenshot('routes-selected-edge');
 const blank=await evaluate(`(()=>{const r=document.getElementById('snl-graph-background').getBoundingClientRect();return {x:r.x+3,y:r.y+3}})()`);await click(blank.x,blank.y);assert.ok((await geometry()).edges.every(e=>e.opacity!=='0'));assert.deepEqual(await evaluate('window.__stateWrites'),[]);
}
