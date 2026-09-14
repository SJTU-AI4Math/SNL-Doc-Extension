import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

let state: unknown;
const requests: any[] = [];
let host: any;
let pending: Promise<void> = Promise.resolve();
const api = { getState: () => state, setState: (v: unknown) => { state = v; },
  postMessage: (m: unknown) => { requests.push(m); pending = host.handle(m); } };
vi.mock('./vscodeApi', async () => ({ ...await vi.importActual('./vscodeApi'),
  getVsCodeApi: () => api, useVsCodeApiRef: () => ({ current: api }) }));
const { CreateMacroApp } = await import('./CreateMacroApp');
const { macroPanelHost } = await import(pathToFileURL(resolve('scripts/macro-panel-browser-host.mjs')).href);
function send(data: unknown): void { act(() => window.dispatchEvent(new MessageEvent('message', { data }))); }
function description(value: string): void {
  fireEvent.change(screen.getByPlaceholderText('Short human-readable description'), { target: { value } });
}
afterEach(cleanup);

describe('compiled Host → retained React draft → next real writer CAS', () => {
  it.each(['edit', 'create'].flatMap(mode => ['external', 'watcher', 'read-failure'].map(schedule => [mode, schedule])))('%s / %s', async (mode, schedule) => {
    state = undefined; requests.length = 0;
    const root = mkdtempSync(join(tmpdir(), 'macro-committed-'));
    const cli = (args: string[], value?: unknown): any => {
      const run = spawnSync(process.env.SNL_CLI ?? 'snl', [...args, '--root', root, '--json', ...(value ? ['--input', '-'] : [])], { encoding: 'utf8', input: value ? JSON.stringify(value) : undefined });
      const result = JSON.parse(run.stdout); expect(result.ok, run.stdout + run.stderr).toBe(true); return result.data;
    };
    let held: any, terminal: any, capture = false;
    const messages: any[] = [];
    host = macroPanelHost(resolve('.'), root, (m: any) => {
      messages.push(m);
      if (capture && ['created', 'updated'].includes(m.type)) {
        capture = false; terminal = m; held = host.holdRead(schedule === 'read-failure');
      } else send(m);
    });
    let view: ReturnType<typeof render> | undefined;
    try {
      cli(['init']);
      const packageId = cli(['macro-package', 'list']).entities.find((p: any) => p.id !== '_unpackaged').id;
      const name = `Receipt.${mode}.${schedule}`;
      const initial = { package: packageId, name, description: 'R0 initial', kind: 'const', source: { entries: [], urls: [] }, dynamic_arity: false, tags: ['preserve'], styles: [{ style_name: 'default', tags: ['style'], template: { mode: 'formula_inline', body: '#1 #0' } }] };
      const r0 = mode === 'edit' ? cli(['macro', 'create'], initial).entity : undefined;
      host.configure(mode, packageId, mode === 'edit' ? name : '', null);
      view = render(<CreateMacroApp />);
      await act(async () => { await pending; });
      if (mode === 'create') {
        fireEvent.change(document.getElementById('m-name')!, { target: { value: name } });
        fireEvent.change(screen.getByPlaceholderText(/\\frac/), { target: { value: 'x' } });
      }
      description('R1 submitted');
      capture = true;
      fireEvent.click(screen.getByRole('button', { name: mode === 'edit' ? 'Update Macro' : 'Create Macro' }));
      const writing = pending;
      await waitFor(() => expect(terminal).toBeTruthy()); await held.entered;
      const id = r0?.id ?? cli(['macro', 'list']).entities.find((m: any) => m.value.name === name).id;
      const r1 = cli(['macro', 'get', id]).entity;
      expect(r1.value.description).toBe('R1 submitted');
      if (r0) expect(r1.revision).not.toBe(r0.revision);
      description('New retained description');
      send(terminal);
      const normalizedR1 = host.doc.entityRevision((await host.doc.readMacroPackage(host.root, packageId)).macros.find((m: any) => m.name === name));
      let r2: any;
      if (schedule === 'external') {
        r2 = cli(['macro', 'update', id, '--if-match', r1.revision], { ...r1.value, description: 'R2 external' }).entity;
        expect(r2.revision).not.toBe(r1.revision);
      } else if (schedule === 'watcher') {
        host.watcher();
        await waitFor(() => expect(messages.some(m => m.type === 'context' && !m.savedRequestId && m.existing?.description === 'R1 submitted')).toBe(true));
      }
      await act(async () => { held.release(); await writing; });
      expect(terminal.committedRevision).toBe(normalizedR1);
      expect(Object.values(state as any).find((d: any) => d.name === name)).toMatchObject({ originalRevision: normalizedR1, description: 'New retained description' });
      view.unmount(); view = render(<CreateMacroApp />);
      await act(async () => { await pending; });
      expect((screen.getByPlaceholderText('Short human-readable description') as HTMLInputElement).value).toBe('New retained description');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update Macro' })); await pending; });
      expect(requests.filter(m => m.type === 'update').at(-1).expectedRevision).toBe(normalizedR1);
      const final = cli(['macro', 'get', id]).entity;
      if (r2) {
        expect(final.revision).toBe(r2.revision);
        expect(messages.some(m => m.type === 'error' && m.message.includes('changed after'))).toBe(true);
      } else {
        expect(final.value.description).toBe('New retained description');
        expect(final.revision).not.toBe(r1.revision);
      }
    } finally {
      held?.release(); await pending.catch(() => {}); view?.unmount(); host.close(); rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});
