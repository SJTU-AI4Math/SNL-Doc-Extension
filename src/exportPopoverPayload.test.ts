import { describe, it, expect } from 'vitest';
import {
  buildExportPayloadScript,
  buildPopoverScript,
  encodePopoverJson,
  POPOVER_GLOBAL,
  POPOVER_SCRIPT_PATH,
  VARIANTS_GLOBAL
} from './exportPopoverPayload';
import { buildExportDocument } from './exportHtmlDocument';
import { buildExportPlan, inlineScripts } from './exportDocument';

/**
 * Run a document's inline scripts the way a browser would, then report the
 * payload. Anything that breaks out of the <script> element, or is not valid
 * JS, shows up as a thrown error or a wrong value — which is the point: a
 * substring assertion on the escaping would pass even if the parser disagreed.
 */
function evalDocumentScripts(html: string): Record<string, string> | undefined {
  const scope: Record<string, unknown> = {};
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    // eslint-disable-next-line no-new-func
    new Function('window', match[1])(scope);
  }
  return scope[POPOVER_GLOBAL] as Record<string, string> | undefined;
}

describe('encodePopoverJson', () => {
  it('round-trips the markup it escapes', () => {
    const fragments = { a: '<b>x</b>', b: '<i data-src="c"></i>' };
    expect(JSON.parse(encodePopoverJson(fragments))).toEqual(fragments);
  });

  it('neutralises every sequence that can escape a <script> element', () => {
    const encoded = encodePopoverJson({
      a: '</script><img onerror=alert(1)>',
      b: '<!-- <script> -->',
      c: 'line\u2028sep\u2029par'
    });
    expect(encoded).not.toContain('</script>');
    expect(encoded).not.toContain('<!--');
    expect(encoded).not.toContain('\u2028');
    expect(encoded).not.toContain('\u2029');
  });
});

describe('the popover payload inside a real document', () => {
  const fragments = {
    evil: '</script><script>window.pwned=1</script>',
    comment: '<!-- <script> not a comment -->',
    seps: 'a\u2028b\u2029c',
    normal: '<b data-src="x">ok</b>'
  };

  it('parses back byte-identical after being embedded and executed', () => {
    const html = buildExportDocument({
      title: 'T',
      css: '',
      body: '<p>b</p>',
      script: 'void 0;',
      scriptSources: [POPOVER_SCRIPT_PATH]
    });
    const plan = buildExportPlan({
      html,
      binaries: [],
      inline: true,
      texts: [{ path: POPOVER_SCRIPT_PATH, source: buildPopoverScript(fragments) }]
    });
    expect(evalDocumentScripts(plan.html)).toEqual(fragments);
    // The hostile fragment stayed INSIDE a JS string: exactly two script
    // elements exist (payload + runtime), not the three a break-out yields.
    expect(plan.html.match(/<script/g)).toHaveLength(2);
  });

  it('emits the payload BEFORE the runtime that reads it', () => {
    const html = buildExportDocument({
      title: 'T',
      css: '',
      body: '',
      script: 'RUNTIME',
      scriptSources: [POPOVER_SCRIPT_PATH]
    });
    expect(html.indexOf(POPOVER_SCRIPT_PATH)).toBeLessThan(html.indexOf('RUNTIME'));
  });
});

describe('one pipeline, two shapes', () => {
  const texts = [{ path: POPOVER_SCRIPT_PATH, source: 'window.X=1;' }];
  const html = buildExportDocument({
    title: 'T',
    css: '',
    body: '',
    scriptSources: [POPOVER_SCRIPT_PATH]
  });

  it('directory shape keeps the payload as a referenced sidecar file', () => {
    const plan = buildExportPlan({ html, binaries: [], inline: false, texts });
    expect(plan.texts).toEqual(texts);
    expect(plan.html).toContain(`<script src="${POPOVER_SCRIPT_PATH}"></script>`);
    // A fetch() would be blocked under file://; the tag must survive.
    expect(plan.html).not.toContain('fetch(');
  });

  it('inline shape folds the SAME source into the document', () => {
    const plan = buildExportPlan({ html, binaries: [], inline: true, texts });
    expect(plan.texts).toEqual([]);
    expect(plan.html).not.toContain(`src="${POPOVER_SCRIPT_PATH}"`);
    expect(plan.html).toContain('window.X=1;');
  });
});

describe('inlineScripts', () => {
  it('escapes a closing tag hiding in the folded source', () => {
    const out = inlineScripts('<script src="p.js"></script>', [
      { path: 'p.js', source: 'var s="</script>";' }
    ]);
    expect(out).toBe('<script>\nvar s="<\\/script>";\n</script>');
  });
});

describe('buildPopoverScript', () => {
  it('assigns to the global the runtime reads', () => {
    expect(buildPopoverScript({ a: '<b/>' })).toContain(`window.${POPOVER_GLOBAL} =`);
  });

  it('round-trips hostile locale/theme variant markup without script breakout', () => {
    const variants = {
      initialLocale: 'en',
      initialColorScheme: 'light' as const,
      variants: [{
        locale: 'en', languageLabel: 'English', colorScheme: 'light' as const,
        title: 'T', body: '</script><script>window.pwned=1</script>',
        popovers: { x: '<!-- unsafe spelling -->' }
      }]
    };
    const source = buildExportPayloadScript({}, variants);
    expect(source).not.toContain('</script>');
    expect(source).not.toContain('<!--');
    const scope: Record<string, unknown> = {};
    // eslint-disable-next-line no-new-func
    new Function('window', source)(scope);
    expect(scope[VARIANTS_GLOBAL]).toEqual(variants);
    expect(scope).not.toHaveProperty('pwned');
  });
});
