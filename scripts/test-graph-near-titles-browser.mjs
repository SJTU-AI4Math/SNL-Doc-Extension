import assert from 'node:assert/strict';

/** Real production large-graph wheel/pan/resize probe; no DOM visibility mocks. */
export async function verifyGraphNearTitles({ evaluate, wait, screenshot, page, evidence }) {
  const count = 2400;
  const pause = () => new Promise(r => setTimeout(r, 35));
  const choose = async (label, value) => {
    await evaluate(`(()=>{const e=document.querySelector('select[aria-label="${label}"]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await pause();
  };
  const scale = () => evaluate(`document.getElementById('snl-graph-background').closest('svg').querySelector(':scope > g[transform]').transform.baseVal.consolidate().matrix.a`);
  const read = () => evaluate(`(()=>{
    const svg=document.getElementById('snl-graph-background').closest('svg'),r=svg.getBoundingClientRect();
    const sidebar=svg.parentElement.querySelector('[data-graph-sidebar]')?.getBoundingClientRect();
    const width=sidebar?.width>0?Math.max(1,Math.min(r.width,sidebar.left-r.left)):r.width;
    const v=svg.querySelector(':scope > g[transform]').transform.baseVal.consolidate().matrix;
    const nodes=[...svg.querySelectorAll('[data-node-id]')].map(n=>{
      const dot=n.querySelector(':scope > circle'),card=n.querySelector(':scope > rect'),m=n.transform.baseVal.consolidate().matrix;
      const w=card?+card.getAttribute('width'):2*dot.cx.baseVal.value,h=card?+card.getAttribute('height'):2*dot.cy.baseVal.value;
      const x=m.e*v.a+v.e,y=m.f*v.d+v.f;
      const near=x+w*v.a>=-256&&x<=width+256&&y+h*v.d>=-256&&y<=r.height+256;
      return {id:n.dataset.nodeId,world:[m.e,m.f,w,h],near,title:!!card,foreign:!!n.querySelector('foreignObject'),katex:n.querySelectorAll('.katex').length,radius:dot?.r.baseVal.value};
    }).sort((a,b)=>a.id.localeCompare(b.id));
    return {scale:v.a,vp:[v.e,v.f,v.a],width,height:r.height,nodes,titles:nodes.filter(n=>n.title).length,near:nodes.filter(n=>n.near).length,total:nodes.length};
  })()`);
  const centers = s => s.nodes.map(n => [n.id,...n.world]);
  const wheelTo = async target => {
    const anchor = await evaluate(`(()=>{const n=document.querySelector('[data-node-id="Corpus0"]'),r=n.querySelector(':scope > circle,:scope > rect').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    let current = await scale(), maxMs=0;
    for(let i=0;i<100 && (current<target/1.1||current>target*1.1);i++) {
      const started=Date.now(), before=current;
      await page.call('Input.dispatchMouseEvent',{type:'mouseWheel',...anchor,deltaX:0,deltaY:current<target?-100:100});
      await wait(`Math.abs(document.getElementById('snl-graph-background').closest('svg').querySelector(':scope > g[transform]').transform.baseVal.consolidate().matrix.a-${before})>1e-12`);
      current=await scale();maxMs=Math.max(maxMs,Date.now()-started);
    }
    assert.ok(current>=target/1.1&&current<=target*1.1,'real wheel reached requested scale');
    await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:5});await pause();
    return maxMs;
  };
  const check = (s, label, above=true) => {
    assert.equal(s.total,count,`${label}: complete topology retained`);
    for(const n of s.nodes) {
      assert.equal(n.title,above&&n.near,`${label}: ${n.id} title must match viewport+buffer`);
      assert.equal(n.foreign,n.title,`${label}: no hidden title subtree`);
      assert.equal(n.katex>0,n.title,`${label}: no far KaTeX`);
    }
    if(above){assert.ok(s.titles>0,`${label}: exercise actual near titles`);assert.ok(s.titles<count/4,`${label}: don't mount the full graph`);}
  };
  evidence.nearTitles={count,configurations:[]};
  await evaluate(`document.querySelector('button[title="Expand filters"]')?.click()`);await pause();
  await choose('Nodes','auto');
  await evaluate(`(()=>{const r=document.querySelector('input[type="range"]');r.value='120';r.dispatchEvent(new Event('input',{bubbles:true}));r.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:5});
  const started=Date.now();
  await evaluate(`(()=>{const f=window.__fixture;const nodes=Array.from({length:${count}},(_,i)=>({...f.nodes[0],id:'Corpus'+i,title:'Corpus result '+i,packageId:'P'+(i%4)}));const edges=nodes.slice(1).map((n,i)=>({...f.edges[0],id:'CE'+i,from:n.id,to:'Corpus'+Math.floor(i/2)}));window.dispatchEvent(new MessageEvent('message',{data:{...f,nodes,edges}}));})()`);
  await wait(`document.querySelectorAll('[data-node-id]').length===${count}`);
  evidence.nearTitles.initialMs=Date.now()-started;
  for(const [mode,packing] of [['rectangle','bands'],['radial-outward','bands'],['radial-outward','rings'],['radial-inward','bands'],['radial-inward','rings']]) {
    await choose('Layout',mode);await choose('Layer packing',packing);
    const lowMs=await wheelTo(1.05),before=await read();check(before,'below threshold',false);
    const crossingMs=await wheelTo(1.35),high=await read();
    const record={mode,packing,lowMs,crossingMs,before,high};evidence.nearTitles.configurations.push(record);
    check(high,'above threshold');assert.deepEqual(centers(high),centers(before),'zoom never relayouts');
    assert.ok(high.nodes.filter(n=>!n.title).every(n=>n.radius===12),'larger dot world radius');
    assert.ok(high.nodes.filter(n=>n.title).every(n=>n.world[3]===66&&n.world[2]>=135),'larger title geometry');
    await evaluate('window.getSelection()?.removeAllRanges()');
    await screenshot(`near-titles-${mode}-${packing}`);
    // Drag blank canvas using the real pointer capture path.
    const anchor=await evaluate(`(()=>{const svg=document.getElementById('snl-graph-background').closest('svg'),r=svg.getBoundingClientRect();for(let y=25;y<Math.min(400,r.height-190);y+=37)for(let x=25;x<Math.min(650,r.width-30);x+=43){const e=document.elementFromPoint(r.left+x,r.top+y);if(e===svg||e?.id==='snl-graph-background')return{x:r.left+x,y:r.top+y};}throw Error('No real blank canvas hit point');})()`);
    const panStarted=Date.now();
    await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',...anchor});
    await page.call('Input.dispatchMouseEvent',{type:'mousePressed',...anchor,button:'left',clickCount:1});
    await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:anchor.x+420,y:anchor.y+180,button:'left',buttons:1});
    await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:anchor.x+420,y:anchor.y+180,button:'left',clickCount:1});
    await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:5});await pause();
    const panned=await read();record.panMs=Date.now()-panStarted;record.panned=panned;
    check(panned,'after pan');assert.deepEqual(centers(panned),centers(high));assert.equal(panned.scale,high.scale);
    assert.ok(Math.abs(panned.vp[0]-high.vp[0]-420)<0.01,'pan is not undone by refit');
    record.panChangedTitleSet=high.nodes.some((n,i)=>n.title!==panned.nodes[i].title);
    // Always-title must also obey near-field mounting.
    await choose('Nodes','always-title');const always=await read();check(always,'always-title');assert.deepEqual(always.vp,panned.vp);await choose('Nodes','auto');
  }
  assert.ok(evidence.nearTitles.configurations.some(r=>r.panChangedTitleSet),'pan crosses a title-buffer boundary');
  // Actual available area changes and refits, then high-scale culling resumes.
  await page.call('Emulation.setDeviceMetricsOverride',{width:680,height:760,deviceScaleFactor:1,mobile:false});await pause();
  await wheelTo(1.35);const narrow=await read();check(narrow,'narrow viewport');evidence.nearTitles.narrow=narrow;
  await evaluate('window.getSelection()?.removeAllRanges()');
  await screenshot('near-titles-narrow');
}
