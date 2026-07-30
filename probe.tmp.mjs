import { build } from 'esbuild';
const entry = `
import { applySnlHoverHighlight, clearSnlHoverHighlight, findMinimalHoverRoot } from '@sjtu-ai4math/snl-basics';
globalThis.__snlHover = { apply: applySnlHoverHighlight, clear: clearSnlHoverHighlight, resolveRoot: findMinimalHoverRoot };
`;
const r = await build({
  stdin:{contents:entry, resolveDir: process.cwd(), sourcefile:'e.js', loader:'js'},
  bundle:true, format:'iife', platform:'browser', target:'es2018', minify:true, write:false, legalComments:'none'
});
const js = r.outputFiles[0].text;
console.log('bundle bytes:', js.length);
console.log('pulled in React?', /react/i.test(js));
console.log('pulled in KaTeX?', /katex/i.test(js));
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<!doctype html><body><div id="c" class="katex-html" style="color: rgb(17,17,17)">
<span data-scope="binder" data-bindref="b1" data-kind="rule" data-name="forall">
 <span id="bd1" data-kind="binder" data-bindref="b1" data-name="x">x</span>
 <span id="bv1" data-kind="bvar" data-bindref="b1" data-name="x">x</span></span>
<span data-scope="binder" data-bindref="b2" data-kind="rule" data-name="forall">
 <span id="bd2" data-kind="binder" data-bindref="b2" data-name="x">x</span>
 <span id="bv2" data-kind="bvar" data-bindref="b2" data-name="x">x</span></span>
</div></body>`, { runScripts:'outside-only', pretendToBeVisual:true });
dom.window.eval(js);
const D=dom.window.document, C=D.getElementById('c'), H=dom.window.__snlHover;
console.log('__snlHover installed:', !!H, Object.keys(H||{}));
H.apply(D.getElementById('bv1'), C);
console.log('--snl-base-text-color =', JSON.stringify(C.style.getPropertyValue('--snl-base-text-color')));
console.log('bvarScope:', D.querySelectorAll('.snl-bvar-scope').length, '(expect 1)');
console.log('binderDecl:', D.querySelectorAll('.snl-binder-decl').length, '(expect 1)');
console.log('other scope untouched:', !D.getElementById('bv2').classList.contains('snl-bvar-scope'));
