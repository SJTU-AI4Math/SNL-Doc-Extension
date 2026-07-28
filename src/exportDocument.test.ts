import { describe, it, expect } from 'vitest';
import {
  buildExportPlan,
  exportFileStem,
  inlineBinaries,
  mimeForPath,
  rewriteBundledCss,
  toDataUrl
} from './exportDocument';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('mimeForPath', () => {
  it('maps the formats an SNL document can carry', () => {
    expect(mimeForPath('assets/a.png')).toBe('image/png');
    expect(mimeForPath('assets/a.SVG')).toBe('image/svg+xml');
    expect(mimeForPath('fonts/KaTeX_Main-Regular.woff2')).toBe('font/woff2');
  });

  it('falls back rather than guessing for unknown extensions', () => {
    expect(mimeForPath('assets/mystery.bin')).toBe('application/octet-stream');
    expect(mimeForPath('noextension')).toBe('application/octet-stream');
  });
});

describe('toDataUrl', () => {
  it('encodes bytes with the right media type', () => {
    expect(toDataUrl('a.png', PNG)).toBe('data:image/png;base64,iVBORw==');
  });
});

describe('rewriteBundledCss', () => {
  it('redirects bundle fonts into the export fonts directory', () => {
    const { css, fontFiles } = rewriteBundledCss(
      '@font-face{src:url(./main-KaTeX_Main-Regular-abc123.woff2) format("woff2")}'
    );
    expect(css).toContain('url(./fonts/KaTeX_Main-Regular-abc123.woff2)');
    expect(fontFiles).toEqual([
      {
        bundleName: 'main-KaTeX_Main-Regular-abc123.woff2',
        exportPath: 'fonts/KaTeX_Main-Regular-abc123.woff2'
      }
    ]);
  });

  it('collects each font once even when several formats appear', () => {
    const { fontFiles } = rewriteBundledCss(
      'url(./main-KaTeX_AMS-Regular-x.woff2) url(./main-KaTeX_AMS-Regular-x.woff2) url(./main-KaTeX_AMS-Regular-y.ttf)'
    );
    expect(fontFiles).toHaveLength(2);
  });

  it('drops the legacy woff/ttf fallbacks so the export is not tripled', () => {
    const { css, fontFiles } = rewriteBundledCss(
      '@font-face{font-family:KaTeX_AMS;src:url(./main-KaTeX_AMS-Regular-a.woff2)format("woff2"),url(./main-KaTeX_AMS-Regular-b.woff)format("woff"),url(./main-KaTeX_AMS-Regular-c.ttf)format("truetype")}'
    );
    expect(fontFiles).toEqual([
      {
        bundleName: 'main-KaTeX_AMS-Regular-a.woff2',
        exportPath: 'fonts/KaTeX_AMS-Regular-a.woff2'
      }
    ]);
    expect(css).toContain('fonts/KaTeX_AMS-Regular-a.woff2');
    expect(css).not.toContain('.woff)');
    expect(css).not.toContain('.ttf)');
    expect(css).toContain('font-family:KaTeX_AMS');
  });

  it('keeps a face that has no woff2 at all', () => {
    const { fontFiles } = rewriteBundledCss(
      '@font-face{src:url(./main-KaTeX_Odd-Regular-z.ttf)format("truetype")}'
    );
    expect(fontFiles).toEqual([
      {
        bundleName: 'main-KaTeX_Odd-Regular-z.ttf',
        exportPath: 'fonts/KaTeX_Odd-Regular-z.ttf'
      }
    ]);
  });

  it('leaves stylesheets without font references untouched', () => {
    const { css, fontFiles } = rewriteBundledCss('body{color:red}');
    expect(css).toBe('body{color:red}');
    expect(fontFiles).toEqual([]);
  });
});

describe('inlineBinaries', () => {
  it('inlines both markup images and stylesheet fonts', () => {
    const html = '<img src="assets/a.png"><style>url(./fonts/f.woff2)</style>';
    const out = inlineBinaries(html, [
      { path: 'assets/a.png', bytes: PNG },
      { path: 'fonts/f.woff2', bytes: new Uint8Array([1, 2, 3]) }
    ]);
    expect(out).toContain('src="data:image/png;base64,iVBORw=="');
    expect(out).toContain('url(data:font/woff2;base64,AQID)');
    expect(out).not.toContain('assets/a.png');
    expect(out).not.toContain('fonts/f.woff2');
  });

  it('inlines every occurrence of a shared asset', () => {
    const out = inlineBinaries('<img src="assets/a.png"><img src="assets/a.png">', [
      { path: 'assets/a.png', bytes: PNG }
    ]);
    expect(out).not.toContain('assets/a.png');
    expect(out.match(/data:image\/png/g)).toHaveLength(2);
  });
});

describe('buildExportPlan', () => {
  const input = {
    html: '<img src="assets/a.png">',
    binaries: [{ path: 'assets/a.png', bytes: PNG }]
  };

  it('directory shape keeps binaries as sibling files', () => {
    const plan = buildExportPlan({ ...input, inline: false });
    expect(plan.html).toContain('src="assets/a.png"');
    expect(plan.binaries).toHaveLength(1);
  });

  it('inline shape emits exactly one file with no outbound references', () => {
    const plan = buildExportPlan({ ...input, inline: true });
    expect(plan.binaries).toEqual([]);
    expect(plan.html).toContain('data:image/png');
    expect(plan.html).not.toContain('assets/a.png');
  });
});

describe('exportFileStem', () => {
  it('keeps ordinary slugs intact', () => {
    expect(exportFileStem('extension-ui-tour')).toBe('extension-ui-tour');
  });

  it('sanitises separators and never yields an empty name', () => {
    expect(exportFileStem('a/b c')).toBe('a-b-c');
    expect(exportFileStem('../../etc/passwd')).toBe('etc-passwd');
    expect(exportFileStem('///')).toBe('snl-document');
  });
});
