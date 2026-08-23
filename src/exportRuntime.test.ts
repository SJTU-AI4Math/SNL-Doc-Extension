import { describe, it, expect } from 'vitest';
import { EXPORT_RUNTIME_CSS, EXPORT_RUNTIME_WIRING_JS } from './exportRuntime';
import { buildExportDocument } from './exportHtmlDocument';

describe('EXPORT_RUNTIME_WIRING_JS', () => {
  it('is self-contained: no imports, no bundler globals, no host bridge', () => {
    expect(EXPORT_RUNTIME_WIRING_JS).not.toMatch(/\bimport\b/);
    expect(EXPORT_RUNTIME_WIRING_JS).not.toMatch(/\brequire\(/);
    expect(EXPORT_RUNTIME_WIRING_JS).not.toContain('acquireVsCodeApi');
    expect(EXPORT_RUNTIME_WIRING_JS).not.toContain('postMessage');
  });

  it('delegates hover to SNL-Basics instead of reimplementing it', () => {
    // The wiring must NOT know the highlight class names or the scope-walking
    // rules: that policy lives in SNL-Basics and is bundled in beside this
    // (see scripts/build-export-runtime.mjs). A hand-rolled copy is exactly
    // what drifted and broke nested-subtree colouring (猫猫 2026-07-29).
    for (const owned of [
      'snl-single-hover',
      'snl-bvar-scope',
      'snl-binder-decl',
      'data-scope="binder"',
      'data-bindref'
    ]) {
      expect(EXPORT_RUNTIME_WIRING_JS).not.toContain(owned);
    }
    // It only attaches listeners and hands the target to SNL-Basics.
    expect(EXPORT_RUNTIME_WIRING_JS).toContain('__snlHover');
    expect(EXPORT_RUNTIME_WIRING_JS).toContain('data-entry-body');
    expect(EXPORT_RUNTIME_WIRING_JS).toContain('resolveRoot');
  });

  it('rebuilds collapse from the exporter markers', () => {
    expect(EXPORT_RUNTIME_WIRING_JS).toContain('data-snl-collapsible');
    expect(EXPORT_RUNTIME_WIRING_JS).toContain('data-snl-subtree');
  });

  it('uses file-safe hash routes instead of server-dependent history routes', () => {
    expect(EXPORT_RUNTIME_WIRING_JS).toContain("#/node/");
    expect(EXPORT_RUNTIME_WIRING_JS).toContain('hashchange');
    expect(EXPORT_RUNTIME_WIRING_JS).toContain('data-snl-route-id');
    expect(EXPORT_RUNTIME_WIRING_JS).not.toContain('pushState(');
  });

  it('stays bounded without bundling a renderer', () => {
    // Includes collapse, recursive pin-capable popovers, hash-route extraction,
    // and locale/theme variant controls. The cap still catches accidentally
    // dragging React or the Entry renderer into this dependency-free runtime.
    expect(EXPORT_RUNTIME_WIRING_JS.length).toBeLessThan(36000);
  });
});

describe('buildExportDocument with a runtime', () => {
  it('omits every script tag when no runtime is requested', () => {
    const doc = buildExportDocument({ title: 'T', css: '', body: '<p>x</p>' });
    expect(doc).not.toContain('<script');
  });

  it('inlines the runtime at the end of body when requested', () => {
    const doc = buildExportDocument({
      title: 'T',
      css: EXPORT_RUNTIME_CSS,
      body: '<p>x</p>',
      script: EXPORT_RUNTIME_WIRING_JS
    });
    expect(doc).toContain('<script>');
    expect(doc).toContain('__snlHover');
    expect(doc.indexOf('<script>')).toBeGreaterThan(doc.indexOf('<p>x</p>'));
    expect(doc).not.toContain('<script src=');
  });

  it('neutralises a closing script tag hidden in the payload', () => {
    const doc = buildExportDocument({
      title: 'T',
      css: '',
      body: '',
      script: 'var a = "</script><img onerror=alert(1)>";'
    });
    expect(doc).toContain('<\\/script>');
    expect(doc.match(/<\/script>/g)).toHaveLength(1);
  });
});
