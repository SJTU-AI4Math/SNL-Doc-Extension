import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportOptionsApp } from '../ExportOptionsApp';
const postMessage = vi.fn();
beforeEach(() => { postMessage.mockClear(); document.documentElement.lang = 'en'; (globalThis as any).__snlApi = { postMessage }; });
afterEach(() => cleanup());
function send(data: unknown) { act(() => { window.dispatchEvent(new MessageEvent('message', { data })); }); }
function setup() {
  render(<ExportOptionsApp />);
  send({ type: 'exportContext', context: { slug: 'L', title: 'L', entryCount: 1, assetCount: 0, defaultDestination: '/tmp/export', sourceAvailable: true, sourceRoot: '/tmp/project' } });
}
const preview = { confirmationId: 'frozen', files: [{ displayPath: 'Main.lean', kind: 'text', byteLength: 8 }], directories: [], totalBytes: 8, estimatedBytes: 12, exclusions: [], warnings: [], externalRoots: [], unresolved: [], dirtyFiles: [] };
function lastPreviewId() { return postMessage.mock.calls.map(c => c[0]).filter(c => c.type === 'previewSources').at(-1).requestId; }
describe('source export confirmation UI', () => {
  it('defaults off and forces interaction on when sources are selected', () => {
    setup();
    expect((screen.getByLabelText(/Include source code/) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText(/Keep interaction/));
    fireEvent.click(screen.getByLabelText(/Include source code/));
    expect((screen.getByLabelText(/Keep interaction/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Keep interaction/));
    expect((screen.getByLabelText(/Include source code/) as HTMLInputElement).checked).toBe(false);
  });
  it('defaults to warnings for unavailable Pointers and requires a new preview when strict mode is selected', () => {
    setup(); fireEvent.click(screen.getByLabelText(/Include source code/));
    const allow = screen.getByLabelText(/Allow unavailable Pointer targets/) as HTMLInputElement;
    expect(allow.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Preview selected sources' }));
    send({ type: 'sourcePreview', requestId: lastPreviewId(), preview: { ...preview, blocked: false, unresolved: [{ entryId: 'Algebra.def.semigroup', status: 'excluded', reason: 'default build/cache exclusion' }] } });
    expect(screen.getByText(/Algebra.def.semigroup/).textContent).toContain('default build/cache exclusion');
    fireEvent.click(screen.getByLabelText(/I reviewed this exact file list/));
    const button = screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(allow);
    expect(allow.checked).toBe(false); expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Preview selected sources' }));
    expect(postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'previewSources', sources: { allowMissing: false } });
    send({ type: 'sourcePreview', requestId: lastPreviewId(), preview: { ...preview, blocked: true } });
    expect(button.disabled).toBe(true);
  });
  it('requires explicit file-list consent and invalidates it on every destination or filter edit', () => {
    setup(); fireEvent.click(screen.getByLabelText(/Include source code/));
    fireEvent.click(screen.getByRole('button', { name: 'Preview selected sources' }));
    const id = lastPreviewId(); send({ type: 'sourcePreview', requestId: id, preview });
    const button = screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I reviewed this exact file list/)); expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'runExport', confirmationId: 'frozen', sources: { enabled: true } });
    send({ type: 'exportDone', message: 'done', warnings: [] });
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: '/tmp/other' } });
    expect(button.disabled).toBe(true);
    send({ type: 'sourcePreview', requestId: id, preview });
    expect(screen.queryByLabelText(/I reviewed this exact file list/)).toBeNull();
  });
  it('requires an explicit disk decision for dirty files and offers an actual save intent', () => {
    setup(); fireEvent.click(screen.getByLabelText(/Include source code/));
    fireEvent.click(screen.getByRole('button', { name: 'Preview selected sources' }));
    send({ type: 'sourcePreview', requestId: lastPreviewId(), preview: { ...preview, dirtyFiles: ['/tmp/project/Main.lean'] } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact file list/));
    const button = screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Explicitly use disk versions/)); expect(button.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Save listed buffers/ }));
    expect(postMessage.mock.calls.at(-1)?.[0]).toEqual({ type: 'saveSourceBuffers' });
  });
});
