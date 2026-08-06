import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let webviewState: unknown;
const posted: unknown[] = [];
const api = {
  postMessage: (message: unknown) => { posted.push(message); },
  getState: () => webviewState,
  setState: (next: unknown) => { webviewState = next; }
};

vi.mock('./vscodeApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./vscodeApi');
  return {
    ...actual,
    getVsCodeApi: () => api,
    useVsCodeApiRef: () => ({ current: api })
  };
});

const { CreateMacroPackageApp } = await import('./CreateMacroPackageApp');

function send(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data })));
}

function lastMutation(): Record<string, unknown> | undefined {
  return [...posted].reverse().find((message): message is Record<string, unknown> => {
    if (typeof message !== 'object' || message === null) return false;
    const type = (message as { type?: unknown }).type;
    return type === 'create' || type === 'update';
  });
}

afterEach(cleanup);
beforeEach(() => {
  webviewState = undefined;
  posted.length = 0;
});

describe('Macro Package persisted drafts', () => {
  it('restores every create field after a full unmount/remount', () => {
    const first = render(<CreateMacroPackageApp />);
    send({ type: 'context', mode: 'create' });
    fireEvent.change(document.getElementById('pkg-file')!, { target: { value: 'draft-package' } });
    fireEvent.change(document.getElementById('pkg-name')!, { target: { value: 'Draft Package' } });
    fireEvent.change(document.getElementById('pkg-desc')!, { target: { value: 'draft description' } });
    first.unmount();

    render(<CreateMacroPackageApp />);
    send({ type: 'context', mode: 'create' });

    expect((document.getElementById('pkg-file') as HTMLInputElement).value).toBe('draft-package');
    expect((document.getElementById('pkg-name') as HTMLInputElement).value).toBe('Draft Package');
    expect((document.getElementById('pkg-desc') as HTMLTextAreaElement).value).toBe('draft description');
  });

  it('keeps a restored edit draft through host refresh and submits its original revision', () => {
    const first = render(<CreateMacroPackageApp />);
    send({
      type: 'context', mode: 'edit', file: 'core', packageRevision: 'revision-original',
      existing: { file: 'core', name: 'Core', description: 'original' }
    });
    fireEvent.change(document.getElementById('pkg-name')!, { target: { value: 'Draft Core' } });
    fireEvent.change(document.getElementById('pkg-desc')!, { target: { value: 'restored draft' } });
    first.unmount();

    render(<CreateMacroPackageApp />);
    send({
      type: 'context', mode: 'edit', file: 'core', packageRevision: 'revision-new',
      existing: { file: 'core', name: 'New Core', description: 'new host value' }
    });
    send({
      type: 'context', mode: 'edit', file: 'core', packageRevision: 'revision-newer',
      existing: { file: 'core', name: 'Newest Core', description: 'newer host refresh' }
    });

    expect((document.getElementById('pkg-name') as HTMLInputElement).value).toBe('Draft Core');
    expect((document.getElementById('pkg-desc') as HTMLTextAreaElement).value).toBe('restored draft');
    fireEvent.click(screen.getByRole('button', { name: 'Update Package' }));

    expect(lastMutation()).toMatchObject({
      type: 'update',
      file: 'core',
      name: 'Draft Core',
      description: 'restored draft',
      expectedRevision: 'revision-original'
    });
  });
});
