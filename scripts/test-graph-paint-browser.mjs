// Browser-side QA only: source geometry is not evidence of visible title paint.
export function installGraphPaintQA() {
  const require = (ok, message) => { if (!ok) throw Error('native paint contract: ' + message); };
  const nodes = () => [...document.querySelectorAll('svg g[role="button"][data-package-id][data-node-id]')];
  function read(n) {
    require(n?.matches('g[role="button"][data-node-id]'), 'stable interactive node missing');
    const source = n.querySelector('[data-node-paint]');
    const shapes = source?.querySelectorAll(':scope > rect, :scope > circle');
    require(shapes?.length === 1, n.dataset.nodeId + ': exactly one source shape');
    const shape = shapes[0], title = shape.tagName === 'rect';
    require(n.dataset.nodeShape === (title ? 'title' : 'dot'), 'semantic/source shape mismatch');
    const uses = document.querySelectorAll('[data-node-raised-paint] use[data-node-raise="' + CSS.escape(n.dataset.nodeId) + '"]');
    require(uses.length === (title ? 1 : 0), 'exactly one raised use per title, none per dot');
    const use = uses[0];
    require(getComputedStyle(source.parentElement).opacity === (title ? '0' : '1'), 'source opacity');
    if (title) {
      require(use.getAttribute('href') === '#' + source.id, 'raised use references this source');
      for (let e = use; e instanceof SVGElement; e = e.parentElement) {
        const style = getComputedStyle(e);
        require(style.display !== 'none' && style.visibility === 'visible' && +style.opacity > 0, 'raised use must really paint');
      }
    }
    const text = use?.parentElement.querySelector(':scope > foreignObject') || null;
    const sourceText = n.querySelector('foreignObject');
    require(!!text === title && !!sourceText === title, 'HTML only on near titles: hidden source plus direct raised copy');
    if (text) {
      require(text.innerHTML === sourceText.innerHTML, 'raised HTML matches compiled source');
      for (let e = text; e instanceof Element; e = e.parentElement) {
        const style = getComputedStyle(e);
        require(style.display !== 'none' && style.visibility === 'visible' && +style.opacity > 0, 'raised HTML must really paint');
      }
      require(text.getBoundingClientRect().width > 0 && text.getBoundingClientRect().height > 0, 'raised HTML has positive extent');
    }
    // use paints the referenced SVG shape; transform its bbox through the ACTUAL
    // instance CTM, not the opacity-zero source ancestor. Do not use use.getBBox()
    // (it also includes the kind text). HTML is measured on the direct raised FO.
    const b = shape.getBBox(), m = (use || source).getScreenCTM(), sm = source.getScreenCTM();
    for (const k of ['a','b','c','d','e','f']) require(Math.abs(m[k]-sm[k]) < 1e-7, 'source/instance world transform mismatch');
    const corners = [[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]].map(([x,y]) => new DOMPoint(x,y).matrixTransform(m));
    const left=Math.min(...corners.map(p=>p.x)),right=Math.max(...corners.map(p=>p.x)),top=Math.min(...corners.map(p=>p.y)),bottom=Math.max(...corners.map(p=>p.y));
    return {shape, text, sourceText, use, screenRect:{x:left,y:top,left,right,top,bottom,width:right-left,height:bottom-top}};
  }
  function audit() {
    const ns=nodes(); let titles=0;
    for(const n of ns) {
      const p=read(n); titles += !!p.use;
      require(n.getAttribute('tabindex') === '0' && !!n.getAttribute('aria-label'), 'interactive semantics');
      require(n.querySelectorAll(':scope > path[data-node-hit]').length === 1, 'one stable native hit path');
      require(n.querySelectorAll('[tabindex], [role="button"], a, button, input').length === 0, 'no nested interactive paint');
    }
    for(const layer of document.querySelectorAll('[data-node-raised-paint], [data-node-paint]')) {
      require(getComputedStyle(layer).pointerEvents === 'none', 'paint cannot intercept events');
      require(layer.querySelectorAll('[tabindex], [role="button"], [data-node-id], a, button, input').length === 0, 'paint has no focus or duplicate semantic node');
      for(const e of layer.querySelectorAll('*')) require(getComputedStyle(e).pointerEvents === 'none', 'paint descendant intercepts events');
    }
    for(const layer of document.querySelectorAll('[data-node-raised-paint]')) require(layer.getAttribute('aria-hidden') === 'true', 'raised paint is decorative');
    require(document.querySelectorAll('[data-node-raised-paint] use').length === titles, 'no orphan raised uses');
    require(document.querySelectorAll('[data-node-raised-paint] foreignObject').length === titles, 'no orphan raised HTML');
    return {nodes:ns.length,titles,dots:ns.length-titles};
  }
  function negativeControls() {
    const n=nodes().find(n=>n.dataset.nodeShape === 'title');
    require(n, 'negative controls require an actual title');
    const {use,text}=read(n), results=[];
    // Reversible browser-DOM mutations only; source/product bytes stay untouched.
    for(const [name,element,attribute,value] of [
      ['hidden raised SVG',use,'opacity','0'],
      ['wrong use source',use,'href','#missing-native-paint-source'],
      ['hidden raised HTML',text,'opacity','0'],
      ['focusable paint',use,'tabindex','0'],
      ['event-intercepting paint',use,'pointer-events','all']
    ]) {
      const before=element.getAttribute(attribute); let rejected=false;
      try { element.setAttribute(attribute,value); audit(); }
      catch(error) { rejected=String(error).includes('native paint contract:'); }
      finally { if(before===null)element.removeAttribute(attribute);else element.setAttribute(attribute,before); }
      require(rejected, 'negative control escaped: '+name);results.push(name);
      audit();
    }
    return results;
  }
  window.__graphQA = {read, audit, nodes, negativeControls};
}
