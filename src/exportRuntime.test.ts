import { describe, it, expect } from 'vitest';
import { EXPORT_RUNTIME_CSS, EXPORT_RUNTIME_JS } from './exportRuntime';
import { buildExportDocument } from './exportHtmlDocument';

describe('EXPORT_RUNTIME_JS', () => {
  it('is self-contained: no imports, no bundler globals, no host bridge', () => {
    expect(EXPORT_RUNTIME_JS).not.toMatch(/\bimport\b/);
    expect(EXPORT_RUNTIME_JS).not.toMatch(/\brequire\(/);
    expect(EXPORT_RUNTIME_JS).not.toContain('acquireVsCodeApi');
    expect(EXPORT_RUNTIME_JS).not.toContain('postMessage');
  });

  it('drives interaction off the data-* attributes harvest preserves', () => {
    expect(EXPORT_RUNTIME_JS).toContain('data-kind');
    expect(EXPORT_RUNTIME_JS).toContain('data-bindref');
    expect(EXPORT_RUNTIME_JS).toContain('data-scope="binder"');
    expect(EXPORT_RUNTIME_JS).toContain('snl-single-hover');
    expect(EXPORT_RUNTIME_JS).toContain('snl-bvar-scope');
    expect(EXPORT_RUNTIME_JS).toContain('snl-binder-decl');
  });

  it('rebuilds collapse from the exporter markers', () => {
    expect(EXPORT_RUNTIME_JS).toContain('data-snl-collapsible');
    expect(EXPORT_RUNTIME_JS).toContain('data-snl-subtree');
  });

  it('stays small enough to inline without thought', () => {
    expect(EXPORT_RUNTIME_JS.length).toBeLessThan(8000);
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
      script: EXPORT_RUNTIME_JS
    });
    expect(doc).toContain('<script>');
    expect(doc).toContain('snl-single-hover');
    expect(doc.indexOf('<script>')).toBeGreaterThan(doc.indexOf('<p>x</p>'));
    expect(doc).not.toContain('src=');
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
