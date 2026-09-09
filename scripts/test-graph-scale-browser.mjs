import assert from 'node:assert/strict';
export async function verifyGraphScale({ evaluate, wait, screenshot, page, evidence }) {
  const pause=()=>new Promise(r=>setTimeout(r,35));
  const select=async(label,value)=>{await evaluate(`(()=>{const s=document.querySelector('select[aria-label="${label}"]');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await pause();};
  const read=()=>evaluate(`(()=>{
    const nodes=[...document.querySelectorAll('[data-node-id]')].map(n=>{
      const s=n.querySelector(':scope > circle,:scope > rect'),r=s.getBoundingClientRect(),m=n.transform.baseVal.consolidate().matrix,circle=s.tagName==='circle';
      const x=circle?+s.getAttribute('cx'):+s.getAttribute('x')+(+s.getAttribute('width'))/2,y=circle?+s.getAttribute('cy'):+s.getAttribute('y')+(+s.getAttribute('height'))/2;
      const text=n.querySelector('foreignObject');let glyphH=null;if(text){const range=document.createRange();range.selectNodeContents(text);glyphH=range.getBoundingClientRect().height;}
      return {glyphH,id:n.dataset.nodeId,shape:circle?'dot':'title',r:circle?+s.getAttribute('r'):null,stroke:+s.getAttribute('stroke-width'),world:[m.e+m.a*x,m.f+m.d*y],x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};
    }).sort((a,b)=>a.id.localeCompare(b.id));
    const viewport=document.getElementById('snl-graph-background').closest('svg').querySelector(':scope > g[transform]');
    return {nodes,scale:viewport.transform.baseVal.consolidate().matrix.a,viewport:viewport.getAttribute('transform'),labels:[...document.querySelectorAll('[data-package-label]')].map(n=>({text:n.textContent,font:getComputedStyle(n).fontSize,w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height}))};
  })()`);
  const point=()=>evaluate(`(()=>{const r=document.getElementById('snl-graph-background').closest('svg').getBoundingClientRect();return{x:r.left+20,y:r.top+20};})()`);
  const zoom=async(target)=>{
    const p=await point();let s=await read();
    for(let i=0;i<50 && (s.scale>target*1.08||s.scale<target/1.08);i++) {
      const sign=s.scale>target?80:-80,old=s.scale;
      await page.call('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:0,deltaY:sign});await pause();s=await read();
      if(s.scale===old)break;
      if((old-target)*(s.scale-target)<=0)break;
    }
    return s;
  };
  const centers=s=>s.nodes.map(n=>[n.id,...n.world]);
  // SVG screen rects are float-quantized; allow one thousandth CSS px.
  const close=(a,b,msg)=>assert.ok(Math.abs(a-b)<1e-3,`${msg}: ${a} != ${b}`);
  evidence.scaling=[];
  for(const mode of ['rectangle','radial-outward','radial-inward']) for(const packing of (mode==='rectangle'?['bands']:['bands','rings'])) {
    await select('Layout',mode);
    await evaluate(`(()=>{const b=document.querySelector('button[title="Expand filters"]');b?.click();})()`);await pause();
    await select('Layer packing',packing);
    await evaluate(`document.querySelector('button[title="Collapse filters"]')?.click()`);await pause();
    await select('Nodes','auto');
    await evaluate(`(()=>{const s=document.querySelector('input[aria-label="Title threshold"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,'300');s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));document.activeElement?.blur();})()`);
    await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:5});
    const record={mode,packing,samples:[]};evidence.scaling.push(record);
    for(const target of [.15,.3,.8,2]) {
      const s=await zoom(target);record.samples.push(s);
      assert.equal(s.nodes.length,8);assert.ok(s.nodes.every(n=>n.shape==='dot'));
      for(const n of s.nodes){close(n.r,6,'world dot radius');close(n.stroke,2,'world outline');close(n.w,12*s.scale,'screen diameter');}
      const first=record.samples[0];assert.deepEqual(centers(s),centers(first));
      const distance=q=>Math.hypot(q.nodes[0].x-q.nodes[1].x,q.nodes[0].y-q.nodes[1].y);
      const painted=q=>(2*q.nodes[0].r+q.nodes[0].stroke)*q.scale;
      close(painted(s)/distance(s),painted(first)/distance(first),'painted diameter / center distance');
      s.labels.forEach((l,i)=>{assert.equal(l.font,'12px');close(l.w,first.labels[i].w,'fixed Package label width');});
      if(target===.3||target===2)await screenshot(`scale-${mode}-${packing}-${target}`);
    }
    await zoom(.3);await select('Nodes','always-title');
    const ordinary=await read();
    // A real pointer enters the painted card, not a synthetic pointerenter.
    const n=ordinary.nodes.find(n=>n.id==='Goal');await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:n.x,y:n.y});
    await pause();const hovered=await read();
    assert.equal(n.stroke,2);assert.equal(hovered.nodes.find(n=>n.id==='Goal').stroke,3.5,'native hover really activated');
    assert.equal(hovered.viewport,ordinary.viewport);assert.deepEqual(centers(hovered),centers(ordinary));
    close(hovered.nodes.find(n=>n.id==='Goal').w,n.w,'hover must not counter-scale title');
    await evaluate(`document.querySelector('[data-node-id="Goal"]').focus()`);await pause();
    assert.equal(await evaluate('document.activeElement?.dataset.nodeId'),'Goal');
    await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:5});await pause();
    const active=await read();assert.equal(active.nodes.find(n=>n.id==='Goal').stroke,3.5,'focus remains active without hover');close(active.nodes.find(n=>n.id==='Goal').w,n.w,'focus must not counter-scale title');
    const larger=await zoom(.8);const ratio=larger.scale/active.scale;
    larger.nodes.forEach((n,i)=>{close(n.w,active.nodes[i].w*ratio,'card width follows zoom');close(n.h,active.nodes[i].h*ratio,'card height follows zoom');assert.ok(n.glyphH>0);close(n.glyphH,active.nodes[i].glyphH*ratio,'title text follows zoom');});
    assert.deepEqual(centers(larger),centers(active));
    record.titles={ordinary,active,larger};
    await evaluate('document.activeElement?.blur()');
    await screenshot(`scale-${mode}-${packing}-titles`);
  }
}
