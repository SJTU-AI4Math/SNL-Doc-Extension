// Production browser Tag-color checks; CLI/Entry editor/Host wiring is exercised separately.
import assert from 'node:assert/strict';
export async function verifyGraphColors({ evaluate, wait, screenshot, page, evidence, url }) {
  const row = i => `document.querySelectorAll('[data-testid="graph-tag-color-rule"]')[${i}]`;
  const button = name => `[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(name)} || n.getAttribute('aria-label')===${JSON.stringify(name)})`;
  const click = async expr => {
    const point = await evaluate(`(()=>{const n=${expr};if(!n)throw Error('missing clickable control');n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed','mouseReleased']) await page.call('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
  };
  const select = async (label,value) => {
    await evaluate(`(()=>{const s=document.querySelector('select[aria-label="${label}"]');if(!s)throw Error('missing select ${label}');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(`document.querySelector('select[aria-label="${label}"]').value===${JSON.stringify(value)}`);
  };
  const fillExpr = id => `document.querySelector('[data-node-id="${id}"] > rect, [data-node-id="${id}"] > circle')?.getAttribute('fill')`;
  const expectFill = async (id,color) => wait(`${fillExpr(id)}===${JSON.stringify(color)}`);
  const stable = () => evaluate(`(()=>{const vp=document.querySelector('[data-graph-viewport]');return {viewport:vp.getAttribute('transform'),nodes:[...document.querySelectorAll('[data-node-id]')].map(n=>{const s=n.querySelector(':scope > rect, :scope > circle'),b=s.getBBox(),m=vp.getCTM().inverse().multiply(s.getCTM());const p=new DOMPoint(b.x+b.width/2,b.y+b.height/2).matrixTransform(m);return [n.dataset.nodeId,p.x,p.y];})};})()`);
  const rowButton = (i,name) => `[...${row(i)}.querySelectorAll('button')].find(n=>n.getAttribute('aria-label')===${JSON.stringify(name)} || n.textContent.trim()===${JSON.stringify(name)})`;
  const setColor = async (i,color) => evaluate(`(()=>{const n=${row(i)}.querySelector('input[type="color"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(color)});n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const add = async (tag,color) => {
    await click(button('Add color mapping'));
    const i = await evaluate(`document.querySelectorAll('[data-testid="graph-tag-color-rule"]').length-1`);
    await evaluate(`(()=>{const s=${row(i)}.querySelector('select');const o=[...s.options].find(o=>o.textContent===${JSON.stringify(tag===''?'(empty tag)':tag)});if(!o)throw Error('missing exact tag');s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await setColor(i,color);
  };
  await evaluate(`(()=>{const tags={Goal:['中文','__proto__'],Middle:['__proto__','中文'],Base:['a,b'],Base2:['']};window.__tagFixture={...window.__fixture,nodes:window.__fixture.nodes.map(n=>({...n,tags:tags[n.id]||[]}))};window.dispatchEvent(new MessageEvent('message',{data:window.__tagFixture}));})()`);
  await click(`[...document.querySelectorAll('button')].find(n=>n.title==='Expand filters')`);
  assert.ok(await evaluate(`Boolean(document.querySelector('select[aria-label="Coloring mode"]'))`),'missing Tag-color Settings: predecessor must fail');
  assert.equal(await evaluate(`document.querySelector('select[aria-label="Coloring mode"]').value`),'kind');
  await select('Nodes','always-title');
  const fallback = await evaluate(fillExpr('Goal'));
  const initial = await stable();
  await add('__proto__','#c05050'); await add('中文','#55aa77');
  await expectFill('Goal',fallback);
  assert.deepEqual(await stable(),initial,'adding mappings in Kind mode must not refit');
  evidence.colors={};
  for (const mode of ['rectangle','radial-outward','radial-inward']) {
    await select('Layout',mode);
    await wait(`document.querySelector('svg[data-layout-mode]')?.getAttribute('data-layout-mode')===${JSON.stringify(mode)} || document.querySelector('select[aria-label="Layout"]').value===${JSON.stringify(mode)}`);
    await evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    const before=await stable();
    await select('Coloring mode','tag'); await expectFill('Goal','#c05050'); await expectFill('Middle','#c05050'); await expectFill('Base3',fallback);
    await click(rowButton(0,'Move down')); await expectFill('Goal','#55aa77'); await expectFill('Middle','#55aa77');
    await click(rowButton(1,'Move up')); await expectFill('Goal','#c05050');
    await setColor(0,'#8844aa'); await expectFill('Goal','#8844aa');
    await setColor(0,'#c05050'); await expectFill('Goal','#c05050');
    assert.deepEqual(await stable(),before,'paint edits must preserve centres and viewport');
    await screenshot('colors-'+mode); evidence.colors[mode]=await stable();
    await select('Coloring mode','kind'); await expectFill('Goal',fallback);
  }
  await select('Coloring mode','tag');
  await add('a,b','#4466cc'); await add('','#cc8844');
  await expectFill('Base','#4466cc'); await expectFill('Base2','#cc8844');
  await select('Nodes','auto');
  const zoomPoint=await evaluate(`(()=>{const r=document.getElementById('snl-graph-background').closest('svg').getBoundingClientRect();return {x:r.left+20,y:r.bottom-20};})()`);
  for(let i=0;i<35 && !await evaluate(`Boolean(document.querySelector('[data-node-id="Goal"] > circle'))`);i++) {
    await page.call('Input.dispatchMouseEvent',{type:'mouseWheel',...zoomPoint,deltaX:0,deltaY:100});
    await evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  }
  await expectFill('Goal','#c05050');
  assert.equal(await evaluate(`document.querySelector('[data-node-id="Goal"] > circle')!==null`),true);
  await select('Nodes','always-title'); await expectFill('Goal','#c05050');
  await evaluate(`window.dispatchEvent(new MessageEvent('message',{data:window.__tagFixture}))`);
  await expectFill('Goal','#c05050');
  await click(rowButton(0,'Remove color mapping')); await expectFill('Goal','#55aa77');
  await evaluate(`window.dispatchEvent(new MessageEvent('message',{data:{...window.__tagFixture,nodes:window.__tagFixture.nodes.map(n=>({...n,tags:[]}))}}))`);
  await expectFill('Goal',fallback);
  assert.ok(await evaluate(`${row(0)}.textContent.includes('unavailable')`),'unavailable selected tag must remain visible');
  await evaluate(`window.dispatchEvent(new MessageEvent('message',{data:window.__tagFixture}))`);
  await expectFill('Goal','#55aa77');
  await page.call('Emulation.setDeviceMetricsOverride',{width:430,height:850,deviceScaleFactor:1,mobile:false});
  await evaluate(`window.dispatchEvent(new MessageEvent('message',{data:{type:'snl.preferences/snapshot',generation:'color-qa',revision:1,preferences:{language:'zh-CN',color_scheme:'light',motion:'none',popover_hover_enabled:false}}}))`);
  await expectFill('Goal','#55aa77');
  await expectFill('Base3','#e9f2fc');
  await screenshot('colors-narrow-chinese-light');
  assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'color settings must not cause page overflow');
  evidence.colors.persistence=await evaluate(`({stateWrites:window.__stateWrites,keys:Object.keys(localStorage),messages:window.__posted.map(m=>m.type)})`);
  assert.deepEqual(evidence.colors.persistence.stateWrites,[]);assert.deepEqual(evidence.colors.persistence.keys,[]);
  assert.ok(evidence.colors.persistence.messages.every(t=>['ready','snl.preferences/ready','popoverEntryDetails','cancelPopoverEntryDetails','getPopoverEntryDetails'].includes(t)));
  await page.call('Page.navigate',{url});await wait(`document.querySelectorAll('[data-node-id]').length===8`);
  await click(`[...document.querySelectorAll('button')].find(n=>n.title==='Expand filters')`);
  assert.equal(await evaluate(`document.querySelector('select[aria-label="Coloring mode"]').value`),'kind');
  assert.equal(await evaluate(`document.querySelectorAll('[data-testid="graph-tag-color-rule"]').length`),0);
  evidence.colors.remountReset=true;
}
