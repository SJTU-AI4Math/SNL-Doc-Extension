import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SvgMacroEditor } from './SvgMacroEditor';

afterEach(cleanup);

const RAW = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><path id="label" d="M10 10h20v10H10z" fill="#000000"/><circle cx="70" cy="30" r="8" fill="#ffffff"/></svg>';

describe('SvgMacroEditor', () => {
  it('localizes the editor controls in Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    render(<SvgMacroEditor onTemplateChange={() => {}} />);
    expect(screen.getByRole('region', { name: 'SVG 宏编辑器' })).toBeTruthy();
    expect(screen.getByLabelText('导入 SVG 文件')).toBeTruthy();
    expect(screen.getByRole('button', { name: '载入 SVG 预览' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('SVG 源码'), { target: { value: '<svg><script/></svg>' } });
    fireEvent.click(screen.getByRole('button', { name: '载入 SVG 预览' }));
    expect(screen.getByRole('alert').textContent).toBe('SVG 源码无效或不安全。');
    document.documentElement.lang = 'en';
  });

  it('imports safe SVG, selects a painted occurrence, and replaces it with a slot', () => {
    const onTemplateChange = vi.fn();
    render(<SvgMacroEditor onTemplateChange={onTemplateChange} />);

    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: RAW } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));

    const path = screen.getByTestId('svg-macro-preview').querySelector('#label') as SVGGraphicsElement;
    Object.defineProperty(path, 'getBBox', {
      configurable: true,
      value: () => ({ x: 10, y: 10, width: 20, height: 10 })
    });
    Object.defineProperty(path, 'getCTM', {
      configurable: true,
      value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
    });
    fireEvent.click(path);
    expect(path.getAttribute('data-snl-editor-selected')).toBe('true');
    expect(screen.getByText('1 painted occurrence selected')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Slot index'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection with slot' }));

    expect(screen.queryByRole('alert')?.textContent ?? '').toBe('');
    const template = onTemplateChange.mock.calls.at(-1)?.[0] as string;
    expect(template).toContain('data-snl-slot="2"');
    expect(template).toContain('translate(20 15)');
    expect(template).not.toContain('id="label"');
    expect(template).not.toContain('data-snl-editor-selected');
  });


  it('stores a root-level slot anchor in SVG user coordinates under CSS viewport scaling', () => {
    const onTemplateChange = vi.fn();
    render(<SvgMacroEditor onTemplateChange={onTemplateChange} />);
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: RAW } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    const preview = screen.getByTestId('svg-macro-preview');
    const svg = preview.querySelector('svg') as SVGSVGElement;
    const path = preview.querySelector('#label') as SVGGraphicsElement;
    const scaled = { a: 4, b: 0, c: 0, d: 4, e: 10, f: 20 };
    Object.defineProperty(svg, 'getCTM', { configurable: true, value: () => scaled });
    Object.defineProperty(path, 'getBBox', { configurable: true, value: () => ({ x: 10, y: 10, width: 20, height: 10 }) });
    Object.defineProperty(path, 'getCTM', { configurable: true, value: () => scaled });
    fireEvent.click(path);
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection with slot' }));
    const template = onTemplateChange.mock.calls.at(-1)?.[0] as string;
    expect(template).toContain('translate(20 15)');
  });

  it('places a multi-selection slot at the earliest selected painter position, not click order', () => {
    const onTemplateChange = vi.fn();
    render(<SvgMacroEditor onTemplateChange={onTemplateChange} />);
    const raw = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 10"><path id="first" d="M0 0h10v10z"/><path id="middle" d="M20 0h10v10z"/><path id="last" d="M40 0h10v10z"/></svg>';
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: raw } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    const preview = screen.getByTestId('svg-macro-preview');
    const first = preview.querySelector('#first') as SVGGraphicsElement;
    const last = preview.querySelector('#last') as SVGGraphicsElement;
    for (const [element, x] of [[first, 0], [last, 40]] as const) {
      Object.defineProperty(element, 'getBBox', { configurable: true, value: () => ({ x, y: 0, width: 10, height: 10 }) });
      Object.defineProperty(element, 'getCTM', { configurable: true, value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
    }
    fireEvent.click(last);
    fireEvent.click(first, { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection with slot' }));
    const template = onTemplateChange.mock.calls.at(-1)?.[0] as string;
    expect(template.indexOf('data-snl-slot="0"')).toBeLessThan(template.indexOf('id="middle"'));
  });

  it('fails closed when a multi-selection spans different painter parents', () => {
    const onTemplateChange = vi.fn();
    render(<SvgMacroEditor onTemplateChange={onTemplateChange} />);
    const raw = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 10"><g><path id="left" d="M0 0h5v5z"/></g><path id="middle" d="M10 0h5v5z"/><g><path id="right" d="M20 0h5v5z"/></g></svg>';
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: raw } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    const preview = screen.getByTestId('svg-macro-preview');
    expect(screen.queryByRole('alert')?.textContent ?? '').toBe('');
    const paths = preview.querySelectorAll('path');
    expect(paths).toHaveLength(3);
    const left = paths[0] as SVGGraphicsElement;
    const right = paths[2] as SVGGraphicsElement;
    for (const [element, x] of [[left, 0], [right, 20]] as const) {
      Object.defineProperty(element, 'getBBox', { configurable: true, value: () => ({ x, y: 0, width: 5, height: 5 }) });
      Object.defineProperty(element, 'getCTM', { configurable: true, value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
    }
    fireEvent.click(left);
    fireEvent.click(right, { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection with slot' }));
    expect(screen.getByRole('alert').textContent).toMatch(/same painter group/i);
    expect(onTemplateChange).not.toHaveBeenCalled();
    expect(preview.querySelectorAll('[data-snl-slot]')).toHaveLength(0);
    expect(preview.querySelector('#left')).toBeTruthy();
    expect(preview.querySelector('#right')).toBeTruthy();
  });

  it('replaces one painted use occurrence without deleting its shared definition or sibling use', () => {
    const onTemplateChange = vi.fn();
    render(<SvgMacroEditor onTemplateChange={onTemplateChange} />);
    const raw = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><defs><path id="glyph" d="M0 0h5v5z"/></defs><use id="first-use" href="#glyph" x="2"/><use id="second-use" href="#glyph" x="10"/></svg>';
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: raw } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    const occurrence = screen.getByTestId('svg-macro-preview').querySelector('#first-use') as SVGGraphicsElement;
    Object.defineProperty(occurrence, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 5, height: 5 }) });
    Object.defineProperty(occurrence, 'getCTM', { configurable: true, value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 2, f: 0 }) });
    fireEvent.click(occurrence);
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection with slot' }));
    const template = onTemplateChange.mock.calls.at(-1)?.[0] as string;
    expect(template).toContain('id="glyph"');
    expect(template).toContain('id="second-use"');
    expect(template).not.toContain('id="first-use"');
  });

  it('imports a raw SVG file into the safe source staging area', async () => {
    render(<SvgMacroEditor onTemplateChange={() => {}} />);
    const file = new File([RAW], 'diagram.svg', { type: 'image/svg+xml' });
    fireEvent.change(screen.getByLabelText('Import SVG file'), { target: { files: [file] } });
    await waitFor(() => expect((screen.getByLabelText('SVG source') as HTMLTextAreaElement).value).toBe(RAW));
    expect(screen.getByText('diagram.svg')).toBeTruthy();
  });


  it('cannot save a template compiled from a stale preview after source edits', () => {
    render(<SvgMacroEditor api={{ postMessage: vi.fn() }} onTemplateChange={() => {}} />);
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: RAW } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    expect(screen.getByRole('button', { name: 'Save SVG Macro Asset' })).toHaveProperty('disabled', false);
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: RAW.replace('#000000', '#ff0000') } });
    expect(screen.getByRole('button', { name: 'Save SVG Macro Asset' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Reload the SVG preview before saving this edited source.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    expect(screen.getByRole('button', { name: 'Save SVG Macro Asset' })).toHaveProperty('disabled', false);
  });

  it('saves source, compiled template, and operations through the host then returns the projection', () => {
    const posted: Record<string, unknown>[] = [];
    const onProjectionChange = vi.fn();
    render(<SvgMacroEditor
      api={{ postMessage: (message) => posted.push(message as Record<string, unknown>) }}
      onTemplateChange={() => {}}
      onProjectionChange={onProjectionChange} />);
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: RAW } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    fireEvent.change(screen.getByLabelText('Asset name'), { target: { value: 'diagram' } });
    fireEvent.change(screen.getByLabelText('Accessibility label'), { target: { value: 'Diagram' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save SVG Macro Asset' }));
    expect(posted.at(-1)).toMatchObject({
      type: 'svgMacro.writeAssets', slug: 'diagram', sourceSvg: RAW,
      accessibilityLabel: 'Diagram', operations: []
    });
    const requestId = posted.at(-1)?.requestId;
    const projection = {
      asset: { source: `svg/diagram.template.${'a'.repeat(64)}.svg`, base_identity: 'workspace:.SNL_Doc/assets', revision: `sha256:${'a'.repeat(64)}`, request_epoch: 0 },
      generation: 1, producer_revision: 'snl-doc-extension-svg-editor:v1', accessibility: { label: 'Diagram' },
      editor: { source: `svg/diagram.source.${'b'.repeat(64)}.svg`, source_revision: `sha256:${'b'.repeat(64)}`, manifest: `svg/diagram.manifest.${'c'.repeat(64)}.json` }
    };
    fireEvent(window, new MessageEvent('message', { data: {
      type: 'svgMacro.assetsWritten', requestId, projection,
      sourcePath: 'svg/diagram.source.def.svg', manifestPath: 'svg/diagram.manifest.ghi.json'
    } }));
    expect(onProjectionChange).toHaveBeenCalledWith(projection, 0);
    expect(screen.getByText('SVG Macro Asset saved.')).toBeTruthy();
  });

  it('rejects malformed or stale save replies without patching the Macro draft', () => {
    const posted: Record<string, unknown>[] = [];
    const onProjectionChange = vi.fn();
    render(<SvgMacroEditor api={{ postMessage: (message) => posted.push(message as Record<string, unknown>) }} onTemplateChange={() => {}} onProjectionChange={onProjectionChange} />);
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: RAW } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    fireEvent.change(screen.getByLabelText('Asset name'), { target: { value: 'diagram' } });
    fireEvent.change(screen.getByLabelText('Accessibility label'), { target: { value: 'Diagram' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save SVG Macro Asset' }));
    const requestId = posted.at(-1)?.requestId;
    fireEvent(window, new MessageEvent('message', { data: { type: 'svgMacro.assetsWritten', requestId, projection: { generation: 1 } } }));
    expect(onProjectionChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/invalid|malformed/i);

    fireEvent.click(screen.getByRole('button', { name: 'Save SVG Macro Asset' }));
    const secondRequestId = posted.at(-1)?.requestId;
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: RAW.replace('#000000', '#ff0000') } });
    const validProjection = {
      asset: { source: `svg/diagram.template.${'a'.repeat(64)}.svg`, base_identity: 'workspace:.SNL_Doc/assets', revision: `sha256:${'a'.repeat(64)}`, request_epoch: 0 },
      generation: 1, producer_revision: 'snl-doc-extension-svg-editor:v1', accessibility: { label: 'Diagram' },
      editor: { source: `svg/diagram.source.${'b'.repeat(64)}.svg`, source_revision: `sha256:${'b'.repeat(64)}`, manifest: `svg/diagram.manifest.${'c'.repeat(64)}.json` }
    };
    fireEvent(window, new MessageEvent('message', { data: { type: 'svgMacro.assetsWritten', requestId: secondRequestId, projection: validProjection } }));
    expect(onProjectionChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/changed|again/i);
  });

  it('does not adopt a pending save reply into a different style identity', () => {
    const posted: Record<string, unknown>[] = [];
    const onStyleA = vi.fn();
    const onStyleB = vi.fn();
    const view = render(<SvgMacroEditor editorIdentity="style-a" api={{ postMessage: (message) => posted.push(message as Record<string, unknown>) }} onTemplateChange={() => {}} onProjectionChange={onStyleA} />);
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: RAW } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    fireEvent.change(screen.getByLabelText('Asset name'), { target: { value: 'diagram' } });
    fireEvent.change(screen.getByLabelText('Accessibility label'), { target: { value: 'Diagram' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save SVG Macro Asset' }));
    const requestId = posted.at(-1)?.requestId;
    view.rerender(<SvgMacroEditor editorIdentity="style-b" api={{ postMessage: (message) => posted.push(message as Record<string, unknown>) }} onTemplateChange={() => {}} onProjectionChange={onStyleB} />);
    const projection = {
      asset: { source: `svg/diagram.template.${'a'.repeat(64)}.svg`, base_identity: 'workspace:.SNL_Doc/assets', revision: `sha256:${'a'.repeat(64)}`, request_epoch: 0 },
      generation: 1, producer_revision: 'snl-doc-extension-svg-editor:v1', accessibility: { label: 'Diagram' },
      editor: { source: `svg/diagram.source.${'b'.repeat(64)}.svg`, source_revision: `sha256:${'b'.repeat(64)}`, manifest: `svg/diagram.manifest.${'c'.repeat(64)}.json` }
    };
    fireEvent(window, new MessageEvent('message', { data: { type: 'svgMacro.assetsWritten', requestId, projection } }));
    expect(onStyleA).not.toHaveBeenCalled();
    expect(onStyleB).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/style|changed|again/i);
  });

  it('hydrates existing raw source and runtime template through immutable asset identities', async () => {
    const postMessage = vi.fn();
    render(<SvgMacroEditor api={{ postMessage }} onTemplateChange={() => {}} initialProjection={{
      asset: { source: 'svg/existing.template.svg', base_identity: 'workspace:.SNL_Doc/assets', revision: `sha256:${'b'.repeat(64)}` },
      editor: { source: `svg/existing.source.${'a'.repeat(64)}.svg`, source_revision: `sha256:${'a'.repeat(64)}` },
      accessibility: { label: 'Existing diagram' }
    }} />);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    for (const call of postMessage.mock.calls) {
      const request = call[0] as Record<string, string>;
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'snl.assets/svg-source-result', request_id: request.request_id,
        source: request.source, base_identity: request.base_identity, revision: request.revision,
        svg_source: request.source.includes('.source.') ? RAW : RAW.replace('<circle', '<rect x="60" y="20" width="10" height="10"/><circle')
      } }));
    }
    await waitFor(() => expect((screen.getByLabelText('SVG source') as HTMLTextAreaElement).value).toBe(RAW));
    expect(screen.getByTestId('svg-macro-preview').querySelector('rect')).toBeTruthy();
    expect((screen.getByLabelText('Asset name') as HTMLInputElement).value).toBe('existing');
    expect((screen.getByLabelText('Accessibility label') as HTMLInputElement).value).toBe('Existing diagram');
    expect(screen.getByText('SVG Macro Asset saved.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: `${RAW} ` } });
    expect(screen.queryByText('SVG Macro Asset saved.')).toBeNull();
  });

  it('keeps controls and the visual canvas in stable grid columns', () => {
    render(<SvgMacroEditor onTemplateChange={() => {}} />);
    const controls = screen.getByTestId('svg-macro-controls');
    const preview = screen.getByTestId('svg-macro-preview');
    expect(controls.contains(screen.getByLabelText('SVG source'))).toBe(true);
    expect(controls.contains(preview)).toBe(false);
    expect(preview.parentElement?.classList.contains('snl-svg-editor-preview-column')).toBe(true);
  });

  it('rejects unsafe raw SVG before mounting a preview', () => {
    render(<SvgMacroEditor onTemplateChange={() => {}} />);
    fireEvent.change(screen.getByLabelText('SVG source'), {
      target: { value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    expect(screen.getByRole('alert').textContent).toMatch(/script|not allowed|unsafe/i);
    expect(screen.getByTestId('svg-macro-preview').querySelector('svg')).toBeNull();
  });

  it('rolls back the whole paper-key compilation when a later target is unsupported', () => {
    const onTemplateChange = vi.fn();
    render(<SvgMacroEditor onTemplateChange={onTemplateChange} />);
    const raw = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path id="ink" fill="#000" d="M0 0h1"/><rect id="paper-a" fill="#fff" x="1" y="1" width="1" height="1"/><g opacity="0.5"><rect id="paper-b" fill="#fff" x="2" y="2" width="1" height="1"/></g></svg>';
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: raw } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    fireEvent.change(screen.getByLabelText('Exact color key'), { target: { value: '#fff' } });
    fireEvent.click(screen.getByRole('button', { name: 'Map exact color to paper knockout' }));
    expect(screen.getByRole('alert').textContent).toMatch(/paper|safely/i);
    const preview = screen.getByTestId('svg-macro-preview');
    expect(preview.querySelectorAll('mask')).toHaveLength(0);
    expect(preview.querySelector('#paper-a')?.getAttribute('fill')).toBe('#fff');
    expect(preview.querySelector('#paper-b')?.getAttribute('fill')).toBe('#fff');
    expect(onTemplateChange).not.toHaveBeenCalled();
  });

  it('ascends from a painted occurrence to replace its authored group', () => {
    const onTemplateChange = vi.fn();
    render(<SvgMacroEditor onTemplateChange={onTemplateChange} />);
    const raw = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g id="formula"><path id="glyph-a" d="M0 0h1"/><path id="glyph-b" d="M2 0h1"/></g></svg>';
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: raw } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    const preview = screen.getByTestId('svg-macro-preview');
    const glyph = preview.querySelector('#glyph-a')!;
    const group = preview.querySelector('#formula') as SVGGraphicsElement;
    Object.defineProperty(group, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 3, height: 1 }) });
    Object.defineProperty(group, 'getCTM', { configurable: true, value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
    fireEvent.click(glyph);
    fireEvent.click(screen.getByRole('button', { name: 'Select parent group' }));
    expect(group.getAttribute('data-snl-editor-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection with slot' }));
    const template = onTemplateChange.mock.calls.at(-1)?.[0] as string;
    expect(template).not.toContain('id="formula"');
    expect(template).toContain('data-snl-slot="0"');
  });

  it('maps an exact authored color key across painted occurrences', () => {
    const onTemplateChange = vi.fn();
    render(<SvgMacroEditor onTemplateChange={onTemplateChange} />);
    const raw = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#123456" d="M0 0h1"/><circle fill="#123456" stroke="#abcdef" cx="5" cy="5" r="1"/></svg>';
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: raw } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    fireEvent.change(screen.getByLabelText('Exact color key'), { target: { value: '#123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Map exact color to foreground' }));
    const template = onTemplateChange.mock.calls.at(-1)?.[0] as string;
    expect(template.match(/fill="currentColor"/g)).toHaveLength(2);
    expect(template).toContain('stroke="#abcdef"');
    expect(template).not.toContain('#123456');
  });

  it('does not rewrite a shared definition as though it were a painted paper occurrence', () => {
    const onTemplateChange = vi.fn();
    render(<SvgMacroEditor onTemplateChange={onTemplateChange} />);
    const raw = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><defs><path id="glyph" fill="#ffffff" d="M0 0h5v5z"/></defs><rect width="20" height="10" fill="#000000"/><use href="#glyph" x="2" y="2"/><use href="#glyph" x="10" y="2"/></svg>';
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: raw } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    fireEvent.change(screen.getByLabelText('Exact color key'), { target: { value: '#ffffff' } });
    fireEvent.click(screen.getByRole('button', { name: 'Map exact color to paper knockout' }));
    expect(screen.getByRole('alert').textContent).toMatch(/paper|safely/i);
    expect(onTemplateChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('svg-macro-preview').querySelector('#glyph')?.getAttribute('fill')).toBe('#ffffff');
  });

  it('compiles an exact paper color into an ordered full-viewBox knockout', () => {
    const onTemplateChange = vi.fn();
    render(<SvgMacroEditor onTemplateChange={onTemplateChange} />);
    const raw = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -3 20 30"><path id="snl-editor-paper-0" fill="#000" d="M0 0h10v10H0z"/><g transform="translate(2 3)"><rect id="paper" fill="#fff" x="1" y="1" width="2" height="2"/><path id="later" fill="#000" d="M0 0h1"/></g></svg>';
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: raw } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    fireEvent.change(screen.getByLabelText('Exact color key'), { target: { value: '#fff' } });
    fireEvent.click(screen.getByRole('button', { name: 'Map exact color to paper knockout' }));
    const template = onTemplateChange.mock.calls.at(-1)?.[0] as string;
    expect(template).toMatch(/<mask[^>]*maskUnits="userSpaceOnUse"[^>]*x="-2"[^>]*y="-3"[^>]*width="20"[^>]*height="30"/);
    expect(template).toMatch(/<g[^>]*mask="url\(#snl-editor-paper-1\)"[^>]*>[\s\S]*id="snl-editor-paper-0"[\s\S]*<\/g>/);
    expect(template).toMatch(/id="paper"[^>]*fill="none"/);
    expect(template.indexOf('id="later"')).toBeGreaterThan(template.indexOf('id="paper"'));
  });

  it('maps the selected painted channels to inherited foreground', () => {
    const onTemplateChange = vi.fn();
    render(<SvgMacroEditor onTemplateChange={onTemplateChange} />);
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: RAW } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    const path = screen.getByTestId('svg-macro-preview').querySelector('#label')!;
    fireEvent.click(path);
    fireEvent.click(screen.getByRole('button', { name: 'Map selected paint to foreground' }));
    const template = onTemplateChange.mock.calls.at(-1)?.[0] as string;
    expect(template).toContain('fill="currentColor"');
    expect(template).toContain('id="label"');
  });

});
