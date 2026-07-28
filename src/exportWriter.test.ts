import { describe, it, expect, vi, beforeEach } from 'vitest';

/** In-memory filesystem standing in for `vscode.workspace.fs`. */
const files = new Map<string, Uint8Array>();
const dirs = new Set<string>();

const key = (u: { path: string }): string => u.path;

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: { path: string }, ...parts: string[]) => ({
      path: [base.path.replace(/\/$/, ''), ...parts.filter(Boolean)].join('/')
    })
  },
  workspace: {
    fs: {
      readFile: async (u: { path: string }) => {
        const found = files.get(key(u));
        if (!found) throw new Error(`ENOENT ${u.path}`);
        return found;
      },
      writeFile: async (u: { path: string }, b: Uint8Array) => {
        files.set(key(u), b);
      },
      createDirectory: async (u: { path: string }) => {
        dirs.add(key(u));
      }
    }
  }
}));

import { writeExport, defaultExportName } from './exportWriter';
import { buildExportDocument, EXPORT_BASE_CSS } from './exportHtmlDocument';

const EXT = { path: '/ext' };
const WS = { path: '/ws' };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function seed(): void {
  files.clear();
  dirs.clear();
  files.set(
    '/ext/media/webview/main.css',
    new TextEncoder().encode(
      '@font-face{src:url(./main-KaTeX_Main-Regular-abc.woff2)}.katex{color:#111}'
    )
  );
  files.set('/ext/media/webview/main-KaTeX_Main-Regular-abc.woff2', new Uint8Array([9, 9]));
  files.set('/ws/.SNL_Doc/assets/Dashboard-Panel.png', PNG);
}

const request = {
  slug: 'extension-ui-tour',
  title: 'Extension UI Tour',
  subtitle: '2 entries · extension-ui-tour',
  body: '<section><img src="assets/Dashboard-Panel.png"></section>',
  assets: [
    {
      path: 'assets/Dashboard-Panel.png',
      sourceUrl: 'vscode-webview://x/ws/.SNL_Doc/assets/Dashboard-Panel.png'
    }
  ],
  inline: false
};

const deps = (destination: { path: string }) => ({
  extensionUri: EXT as never,
  workspaceRoot: WS as never,
  destination: destination as never,
  buildDocument: (input: {
    title: string;
    subtitle?: string;
    css: string;
    body: string;
  }) => buildExportDocument({ ...input, css: `${EXPORT_BASE_CSS}\n${input.css}` })
});

beforeEach(seed);

describe('writeExport — directory shape', () => {
  it('writes index.html plus the image and the fonts it references', async () => {
    const out = await writeExport(request, deps({ path: '/out/tour' }) as never);

    expect(out.target.path).toBe('/out/tour/index.html');
    expect(out.warnings).toEqual([]);
    expect(files.has('/out/tour/assets/Dashboard-Panel.png')).toBe(true);
    expect(files.has('/out/tour/fonts/KaTeX_Main-Regular-abc.woff2')).toBe(true);
    expect(out.fileCount).toBe(3);
  });

  it('inlines the stylesheet and points it at the exported fonts', async () => {
    await writeExport(request, deps({ path: '/out/tour' }) as never);
    const html = new TextDecoder().decode(files.get('/out/tour/index.html'));

    expect(html).toContain('url(./fonts/KaTeX_Main-Regular-abc.woff2)');
    expect(html).toContain('.katex{color:#111}');
    expect(html).toContain('src="assets/Dashboard-Panel.png"');
    expect(html).not.toContain('<script');
  });

  it('exports without the image rather than failing when an asset is missing', async () => {
    files.delete('/ws/.SNL_Doc/assets/Dashboard-Panel.png');
    const out = await writeExport(request, deps({ path: '/out/tour' }) as never);

    expect(out.warnings).toEqual([
      'Missing asset, exported without it: assets/Dashboard-Panel.png'
    ]);
    expect(files.has('/out/tour/index.html')).toBe(true);
  });

  it('refuses an asset path that would escape the export root', async () => {
    const out = await writeExport(
      {
        ...request,
        assets: [{ path: 'assets/../../etc/passwd', sourceUrl: 'x' }]
      },
      deps({ path: '/out/tour' }) as never
    );

    expect(out.warnings[0]).toContain('suspicious asset path');
    expect([...files.keys()].some((k) => k.includes('passwd'))).toBe(false);
  });
});

describe('writeExport — inline shape', () => {
  it('emits exactly one file with every binary folded in', async () => {
    const out = await writeExport(
      { ...request, inline: true },
      deps({ path: '/out/tour.html' }) as never
    );

    expect(out.fileCount).toBe(1);
    expect(out.target.path).toBe('/out/tour.html');

    const html = new TextDecoder().decode(files.get('/out/tour.html'));
    expect(html).toContain('data:image/png;base64,iVBORw==');
    expect(html).toContain('data:font/woff2;base64,CQk=');
    expect(html).not.toContain('assets/Dashboard-Panel.png');
    expect(html).not.toContain('fonts/KaTeX_Main-Regular-abc.woff2');

    const written = [...files.keys()].filter((k) => k.startsWith('/out/'));
    expect(written).toEqual(['/out/tour.html']);
  });
});

describe('defaultExportName', () => {
  it('names a single file with .html and a directory without', () => {
    expect(defaultExportName('extension-ui-tour', true)).toBe('extension-ui-tour.html');
    expect(defaultExportName('extension-ui-tour', false)).toBe('extension-ui-tour');
  });
});
