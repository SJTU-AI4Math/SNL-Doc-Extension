import { describe, it, expect } from 'vitest';
import { buildExportDocument, EXPORT_BASE_CSS } from './exportHtmlDocument';

describe('buildExportDocument', () => {
  it('produces a script-free self-sufficient document', () => {
    const doc = buildExportDocument({
      title: 'Extension UI Tour',
      subtitle: '3 entries · extension-ui-tour',
      css: EXPORT_BASE_CSS,
      body: '<section>hi</section>'
    });
    expect(doc).toMatch(/^<!DOCTYPE html>/);
    expect(doc).toContain('<title>Extension UI Tour</title>');
    expect(doc).toContain('3 entries');
    expect(doc).toContain('<section>hi</section>');
    expect(doc).not.toContain('<script');
  });

  it('omits the subtitle line when there is none', () => {
    const doc = buildExportDocument({ title: 'T', css: '', body: '' });
    expect(doc).not.toContain('snl-export-subtitle');
  });

  it('escapes a title containing markup', () => {
    const doc = buildExportDocument({
      title: '<img src=x onerror=alert(1)>',
      css: '',
      body: ''
    });
    expect(doc).not.toContain('<img src=x');
    expect(doc).toContain('&lt;img src=x');
  });

  it('escapes the subtitle too', () => {
    const doc = buildExportDocument({
      title: 'T',
      subtitle: '<script>alert(1)</script>',
      css: '',
      body: ''
    });
    expect(doc).not.toContain('<script');
  });

  it('emits the selected Chinese locale and localized watermark accessibility copy', () => {
    const doc = buildExportDocument({ title: 'T', locale: 'zh-CN', css: '', body: '' });
    expect(doc).toContain('<html lang="zh-CN">');
    expect(doc).toContain('aria-label="GitHub 上的 SNL-Basics"');
    expect(doc).toContain('由上海交通大学 AI4Math 团队 Fulcrum 的 SNL 提供交互式公式支持');
  });
});
