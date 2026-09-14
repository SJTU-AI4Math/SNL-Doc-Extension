// Production-browser regressions for compact radial geometry and screen-space labels.
// Run via test-graph-layout-browser.mjs --compact; --measure-baseline only records old metrics.
import assert from 'node:assert/strict';
export async function verifyCompactGraph({evaluate,wait,screenshot,page,evidence}) {
  const measureOnly=process.argv.includes('--measure-baseline');
  const select=async(label,value)=>{
    await evaluate(`(()=>{const s=document.querySelector('select[aria-label="${label}"]');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await new Promise(r=>setTimeout(r,120));
  };
  const measure=()=>evaluate(`(()=>{
    const ns=[...document.querySelectorAll('svg g[role="button"][data-package-id]')];
    const rects=ns.map(n=>n.querySelector(':scope > rect').getBoundingClientRect());
    const svg=document.getElementById('snl-graph-background').closest('svg').getBoundingClientRect();
    const labels=[...document.querySelectorAll('[data-package-label], g[role="group"][data-package-id] > text')];
    const bounds={left:Math.min(...rects.map(r=>r.left)),top:Math.min(...rects.map(r=>r.top)),right:Math.max(...rects.map(r=>r.right)),bottom:Math.max(...rects.map(r=>r.bottom))};
    const w=bounds.right-bounds.left,h=bounds.bottom-bounds.top;
    // Orbital routes can extend beyond the card rectangle: fit must contain
    // these real paths, not crop them to maximize the old node-only metric.
    const paths=[...document.querySelectorAll('[data-graph-viewport] path[marker-end]')].map(p=>p.getBoundingClientRect());
    const content=[...rects,...paths];
    const contentWidth=Math.max(...content.map(r=>r.right))-Math.min(...content.map(r=>r.left));
    const contentHeight=Math.max(...content.map(r=>r.bottom))-Math.min(...content.map(r=>r.top));
    let overlaps=0;for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>0.3&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>0.3)overlaps++;}
    return {nodes:ns.length,bounds,width:w,height:h,density:rects.reduce((s,r)=>s+r.width*r.height,0)/(w*h),extentFill:Math.max(w/svg.width,h/svg.height),contentExtentFill:Math.max(contentWidth/svg.width,contentHeight/svg.height),overlaps,
      routesOutside:paths.filter(r=>r.left<svg.left-0.5||r.top<svg.top-0.5||r.right>svg.right+0.5||r.bottom>svg.bottom+0.5).length,
      outside:rects.filter(r=>r.left<svg.left-0.5||r.top<svg.top-0.5||r.right>svg.right+0.5||r.bottom>svg.bottom+0.5).length,
      labels:labels.map(n=>{const r=n.getBoundingClientRect(),m=n.getScreenCTM();return {text:n.textContent,width:r.width,height:r.height,font:parseFloat(getComputedStyle(n).fontSize)*Math.hypot(m.a,m.b)};})};
  })()`);
  const packing = async(value) => {
    await evaluate(`[...document.querySelectorAll('button')].find(n=>/Filters/.test(n.textContent)).click()`);
    const info=await evaluate(`(()=>{const s=document.querySelector('select[aria-label="Layer packing"]');if(!s)return null;s.scrollIntoView({block:'center'});const r=s.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,index:[...s.options].findIndex(o=>o.value===${JSON.stringify(value)})};})()`);
    assert.ok(info,'missing Layer packing setting');assert.ok(info.index>=0,'missing packing choice');
    await page.call('Input.dispatchMouseEvent',{type:'mousePressed',x:info.x,y:info.y,button:'left',clickCount:1});
    await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:info.x,y:info.y,button:'left',clickCount:1});
    for(const key of ['Home',...Array(info.index).fill('ArrowDown'),'Enter']){await page.call('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:{Home:36,ArrowDown:40,Enter:13}[key]});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:{Home:36,ArrowDown:40,Enter:13}[key]});}
    await wait(`document.querySelector('select[aria-label="Layer packing"]').value===${JSON.stringify(value)}`);
    await evaluate(`[...document.querySelectorAll('button')].find(n=>/Filters/.test(n.textContent)).click()`);
    await new Promise(r=>setTimeout(r,160));
  };
  evidence.compact={};
  await select('Nodes','always-title');
  if(!measureOnly)await packing('bands');
  for(const [name,count,packages,tree] of [['chain',24,1,false],['sparse-packages',30,10,false],['branching',600,4,true]]) {
    await evaluate(`(()=>{const f=window.__fixture;const nodes=Array.from({length:${count}},(_,i)=>({...f.nodes[0],id:'N'+i,title:'Result '+i,packageId:'P'+(i%${packages})}));const edges=nodes.slice(1).map((n,i)=>({...f.edges[0],id:'E'+i,from:n.id,to:'N'+(${tree}?Math.floor(i/2):i)}));window.dispatchEvent(new MessageEvent('message',{data:{...f,nodes,edges}}));})()`);
    await wait(`document.querySelectorAll('svg g[role="button"][data-package-id]').length===${count}`);
    for(const mode of ['radial-outward','radial-inward']) {
      await select('Layout',mode);
      const result=await measure();evidence.compact[name+'-'+mode]=result;
      await screenshot('compact-'+name+'-'+mode);
      if(!measureOnly){assert.equal(result.nodes,count);assert.equal(result.overlaps,0,'ordinary title cards overlap');assert.equal(result.outside,0,'fit clips title cards');assert.equal(result.routesOutside,0,'fit clips orbital routes');assert.ok(result.contentExtentFill>=0.72,'actual content does not use available viewport');assert.ok(result.labels.length>=packages);assert.ok(result.labels.every(l=>Math.abs(l.font-12)<0.1),'package label must be 12 screen pixels');
        if(name==='branching'){
          await packing('rings');const rings=await measure();evidence.compact[name+'-'+mode+'-rings']=rings;await screenshot('compact-'+name+'-'+mode+'-rings');
          assert.equal(rings.overlaps,0);assert.equal(rings.outside,0);assert.equal(rings.nodes,count);
          assert.ok(result.density>rings.density*2,'compact bands must materially improve wide-layer density');
          await packing('bands');
        }
      }
    }
  }
  // A sparse fixture makes resize/sidebar failures visible without hiding them in tiny dots.
  await evaluate(`window.dispatchEvent(new MessageEvent('message',{data:window.__fixture}))`);
  await select('Layout','radial-outward');
  const before=await measure();
  const p=await evaluate(`(()=>{const r=document.getElementById('snl-graph-background').getBoundingClientRect();return {x:r.left+10,y:r.top+10}})()`);
  for(let i=0;i<5;i++)await page.call('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:0,deltaY:80});
  const after=await measure();evidence.compact.labelZoom={before:before.labels,after:after.labels};
  if(!measureOnly)assert.ok(after.labels.every(l=>Math.abs(l.font-12)<0.1),'labels shrink with zoom');
  await page.call('Emulation.setDeviceMetricsOverride',{width:820,height:650,deviceScaleFactor:1,mobile:false});
  await new Promise(r=>setTimeout(r,200));
  const resized=await measure();evidence.compact.resized=resized;
  if(!measureOnly)assert.equal(resized.outside,0,'resize fails to refit');
  await evaluate(`[...document.querySelectorAll('button')].find(n=>/Filters/.test(n.textContent)).click()`);
  await new Promise(r=>setTimeout(r,200));
  evidence.compact.sidebar=await measure();
  await screenshot('compact-sidebar');
  if(!measureOnly){
    const covered=await evaluate(`(()=>{const sidebar=document.querySelector('[data-testid="graph-filters"]').parentElement.getBoundingClientRect();return [...document.querySelectorAll('svg g[role="button"][data-package-id] > rect')].filter(n=>n.getBoundingClientRect().right>sidebar.left+0.5).length;})()`);
    assert.equal(covered,0,'open settings cover fitted cards');
    await select('Layer packing','rings');
    await evaluate(`window.dispatchEvent(new MessageEvent('message',{data:window.__fixture}))`);
    await wait(`document.querySelector('select[aria-label="Layer packing"]').value==='rings'`);
    await evaluate(`window.dispatchEvent(new MessageEvent('message',{data:{type:'snl.preferences/snapshot',generation:'compact-qa',revision:1,preferences:{language:'zh-CN',color_scheme:'light',motion:'none',popover_hover_enabled:false}}}))`);
    await wait(`document.querySelector('select[aria-label="同层铺排"]')!==null`);
    await page.call('Emulation.setDeviceMetricsOverride',{width:540,height:800,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,160));
    evidence.compact.chineseSettings=await evaluate(`({options:[...document.querySelector('select[aria-label="同层铺排"]').options].map(o=>o.text),value:document.querySelector('select[aria-label="同层铺排"]').value,scrollWidth:document.documentElement.scrollWidth,width:innerWidth})`);
    assert.equal(evidence.compact.chineseSettings.value,'rings');assert.ok(evidence.compact.chineseSettings.scrollWidth<=540);
    await screenshot('compact-chinese-settings');
    await evaluate(`(()=>{const f=window.__fixture;const n={...f.nodes[0],id:'Only',title:'Only',packageId:'LongPackageIdentifier'.repeat(12)};window.dispatchEvent(new MessageEvent('message',{data:{...f,nodes:[n],edges:[{...f.edges[0],id:'loop',from:n.id,to:n.id}]}}));})()`);
    evidence.compact.longLabel={};
    for(const mode of ['rectangle','radial-outward','radial-inward']){
      await evaluate(`(()=>{const s=[...document.querySelectorAll('select')].find(n=>[...n.options].some(o=>o.value==='rectangle'));s.value=${JSON.stringify(mode)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await new Promise(r=>setTimeout(r,140));const m=await measure();evidence.compact.longLabel[mode]=m;
      assert.equal(m.nodes,1);assert.equal(m.outside,0);assert.ok(m.width>50,'long fixed label must not collapse graph scale');assert.ok(m.labels.every(l=>Math.abs(l.font-12)<0.1));
    }
    await screenshot('compact-long-label');
    assert.deepEqual(await evaluate('window.__stateWrites'),[],'packing must not persist');
    await page.call('Page.reload');
    await wait(`document.querySelectorAll('svg g[role="button"][data-package-id]').length===8`);
    await evaluate(`[...document.querySelectorAll('button')].find(n=>/Filters/.test(n.textContent)).click()`);
    await wait(`document.querySelector('select[aria-label="Layer packing"]').value==='bands'`);
    evidence.compact.packingRefreshAndRemount=true;
  }
}
