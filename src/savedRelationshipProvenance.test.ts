import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';

const host = vi.hoisted(() => ({ root: undefined as any, panels: [] as any[], commands: new Map<string, (...args: any[]) => any>() }));
// Filesystem and editor/command transport adapters only; storage, Dashboard routing,
// extension command registration, editor reads and all writers below are real.
vi.mock('vscode', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const uri = (p: string, scheme = 'file', authority = ''): any => ({ scheme, authority, fsPath: p, path: p, toString: () => `${scheme}://${authority}${p}` });
  return {
    ViewColumn: { Active: 1 },
    commands: { registerCommand: (name: string, fn: any) => { host.commands.set(name, fn); return { dispose() {} }; }, executeCommand: async (name: string, ...args: any[]) => host.commands.get(name)?.(...args) },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: { file: uri, parse: (s: string) => { const u = new URL(s); return uri(u.pathname, u.protocol.slice(0, -1), u.host); }, joinPath: (base: any, ...parts: string[]) => uri(path.join(base.fsPath, ...parts), base.scheme, base.authority) },
    workspace: { onDidChangeConfiguration: () => ({ dispose() {} }), fs: {
      stat: async (u: any) => { const s = await fs.lstat(u.fsPath); return { type: s.isSymbolicLink() ? 64 : s.isDirectory() ? 2 : 1, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }; },
      readFile: async (u: any) => fs.readFile(u.fsPath),
      readDirectory: async (u: any) => (await fs.readdir(u.fsPath, { withFileTypes: true })).map(d => [d.name, d.isDirectory() ? 2 : d.isSymbolicLink() ? 64 : 1]),
      createDirectory: (u: any) => fs.mkdir(u.fsPath, { recursive: true }),
      writeFile: (u: any, b: Uint8Array) => fs.writeFile(u.fsPath, b),
      rename: (a: any, b: any) => fs.rename(a.fsPath, b.fsPath),
      delete: (u: any) => fs.rm(u.fsPath, { recursive: true, force: true })
    } },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showInformationMessage: async (_text: string, ...args: any[]) => args.at(-1), showWarningMessage: async (_text: string, ...args: any[]) => args.at(-1), showErrorMessage() {},
      createWebviewPanel: (_type: string, title: string) => {
        const panel: any = { title, messages: [], reveal: vi.fn(), dispose() {}, onDidDispose: (cb: any) => { panel.close = cb; return { dispose() {} }; },
          webview: { html: '', onDidReceiveMessage: (cb: any) => { panel.receive = cb; return { dispose() {} }; }, postMessage: async (msg: any) => { panel.messages.push(msg); return true; } } };
        host.panels.push(panel); return panel;
      }
    }
  };
});
import {
  initSnlDoc, createEntryKind, createMacroPackage, addMacro, readAllMacros, updateMacro,
  addEntry, readEntries, updateEntry, entityRevision,
  readAuthoredRelationships, readRelationships, type MacroPackageEntry
} from './snlDoc';
import { readDashboardRelationships } from './dashboardStatistics';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'snl-dependency-host-')); roots.push(root);
  const uri = vscode.Uri.file(root);
  expect(await initSnlDoc(uri)).toEqual({ status: 'created' });
  expect(await createEntryKind(uri, { id: 'entry', name: 'Entry', description: '', coloring: { light: { stroke: '', background: '' }, dark: { stroke: '', background: '' } }, defaultCounterName: '', style: '' })).toMatchObject({ status: 'created' });
  for (const id of ['A', 'B', 'isolated']) {
    expect(await addEntry(uri, { id, kind: 'entry', title: id, content: { snl: '' }, pointer: null, contribution_info: null })).toMatchObject({ status: 'ok' });
  }
  const relationships = [
    { id: 'manual', from: 'A', to: 'B', label: 'depends', metadata: { opaque: ['author'], isAtomic: 'keep' } },
    { id: 'legacy', from: 'B', to: 'A', label: 'depends', metadata: { generator: 'macro-source-scan', macros: ['old'] } },
    { id: 'context', from: 'B', to: 'A', label: 'uses_context', metadata: { generator: 'macro-source-scan', nested: { keep: true } } }
  ];
  await fs.writeFile(join(root, '.SNL_Doc/relationships.json'), JSON.stringify({ version: 1, relationships }, null, 3) + '\n');
  return { root, uri, relationships };
}
async function authored(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string) {
    for (const d of await fs.readdir(join(root, dir), { withFileTypes: true })) {
      if (d.name === '.cache') continue;
      const p = join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      else result[p] = (await fs.readFile(join(root, p))).toString('base64');
    }
  }
  await walk('.SNL_Doc'); return result;
}
async function setSnl(f: Awaited<ReturnType<typeof fixture>>, id: string, snl: string) {
  const e = (await readEntries(f.uri)).find(e => e.id === id)!;
  expect(await updateEntry(f.uri, id, { ...e, content: { snl } }, entityRevision(e))).toMatchObject({ status: 'updated' });
}
async function withMacro() {
  const f = await fixture();
  expect(await createMacroPackage(f.uri, 'Test', 'Test')).toMatchObject({ status: 'ok' });
  const macro: MacroPackageEntry = { name: 'testMacro', kind: 'const', description: '', source: { entries: ['B', 'B', 'A', 'missing'], urls: [] }, dynamic_arity: false, styles: [{ style_name: 'default', template: { mode: 'formula_inline', body: 'x' }, tags: [] }], tags: [] };
  expect(await addMacro(f.uri, 'Test', macro)).toMatchObject({ status: 'ok' });
  await setSnl(f, 'A', 'testMacro testMacro');
  return f;
}


vi.mock('./infoviewPanel', () => ({ InfoviewPanel: {} }));
vi.mock('./createLibraryPanel', () => ({ CreateLibraryPanel: {} }));
vi.mock('./initEntryKindsPanel', () => ({ InitEntryKindsPanel: {} }));
vi.mock('./createEntryKindPanel', () => ({ CreateEntryKindPanel: {} }));
vi.mock('./initMacroKindsPanel', () => ({ InitMacroKindsPanel: {} }));
vi.mock('./createMacroKindPanel', () => ({ CreateMacroKindPanel: {} }));
vi.mock('./createEntryPanel', () => ({
  CreateEntryPanel: { createOrShow: vi.fn() }
}));
vi.mock('./createEntryPackagePanel', () => ({
  CreateEntryPackagePanel: { createOrShow: vi.fn() }
}));
vi.mock('./createMacroPackagePanel', () => ({ CreateMacroPackagePanel: {} }));
vi.mock('./packagePanel', () => ({ PackagePanel: {} }));
vi.mock('./createMacroPanel', () => ({ CreateMacroPanel: {} }));
vi.mock('./graphPanel', () => ({ GraphPanel: {} }));
vi.mock('./snooglPanel', () => ({ SnoogLPanel: {} }));

vi.mock('./trace', () => ({
  isTraceEnabled: vi.fn(() => false), refreshTraceEnabled: vi.fn(),
  setTraceEnabled: vi.fn((value: boolean) => value),
  startTrace: vi.fn(() => ({ mark: vi.fn() })), traceChannel: vi.fn(() => undefined)
}));
vi.mock('./webviewCostProbe', () => ({ registerWebviewCostProbe: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock('./preferencesHost', () => ({ initialize_preferences_host: vi.fn(), bind_preferences_panel_title: vi.fn() }));
vi.mock('./snlDocContext', () => ({ installSnlDocContextKey: vi.fn() }));
vi.mock('./pointerSyncHost', () => ({ installPointerSyncHost: vi.fn() }));
vi.mock('./pointerSyncDriver', () => ({ createPointerHostDriver: vi.fn() }));
vi.mock('./dataMigrationCommands', () => ({ checkDataVersion: vi.fn(), repairData: vi.fn() }));
vi.mock('./preferences', () => ({ read_extension_preferences: () => ({ language: 'en' }), extension_preferences_runtime: { query_environment: () => ({ language: 'en' }) } }));
vi.mock('./panelUtil', () => ({ firstWorkspaceFolder: () => host.root, buildPanelHtml: () => '', installSnlDocWatcher() {}, handlePanelNavMessage: async () => false }));
import { activate } from './extension';
import { DashboardPanel } from './dashboardPanel';
import { CreateRelationshipPanel } from './createRelationshipPanel';

beforeEach(() => { host.commands.clear(); activate({ extensionUri: vscode.Uri.file('/extension'), subscriptions: [] } as any); });
afterEach(() => { for (const p of host.panels.splice(0)) p.close(); });
async function openSaved(id: string, extra: Record<string, unknown> = {}) {
  // Same message as the real Dashboard component's DOM-tested row action.
  await (DashboardPanel.prototype as any).handleMessage.call({}, { type: 'editRelationship', id, source: 'saved', ...extra });
  const panel = host.panels.at(-1)!;
  await panel.receive({ type: 'ready' });
  return panel;
}
function context(panel: any) { return panel.messages.filter((m: any) => m.type === 'context').at(-1); }

describe('saved relationship provenance through Dashboard host → registered command → real editor/storage', () => {
  it.each(['retired', 'endpoint-collision', 'witness-change'])('opens the saved record, not current derivation: %s', async variant => {
    const f = await withMacro(); host.root = f.uri;
    let saved: any = f.relationships[1];
    if (variant === 'endpoint-collision') {
      for (const id of ['a.b', 'c', 'a', 'b.c']) {
        expect(await addEntry(f.uri, { id, kind: 'entry', title: id, content: { snl: '' }, pointer: null, contribution_info: null })).toMatchObject({ status: 'ok' });
      }
      const m = (await readAllMacros(f.uri)).testMacro;
      expect(await updateMacro(f.uri, 'Test', { ...m, source: { entries: ['b.c'], urls: [] } }, entityRevision(m))).toMatchObject({ status: 'updated' });
      await setSnl(f, 'A', ''); await setSnl(f, 'a', 'testMacro');
      saved = { id: 'dep.a.b.c', from: 'a.b', to: 'c', label: 'depends', metadata: { generator: 'macro-source-scan', macros: ['old'] } };
    } else if (variant === 'witness-change') {
      saved = { id: 'dep.A.B', from: 'A', to: 'B', label: 'depends', metadata: { generator: 'macro-source-scan', macros: ['old'], isAtomic: false, oldWitness: { keep: true } } };
    }
    await fs.writeFile(join(f.root, '.SNL_Doc/relationships.json'), JSON.stringify({ version: 1, relationships: [f.relationships[0], saved] }));
    const before = await authored(f.root);
    const table = await readDashboardRelationships(f.uri, new AbortController().signal);
    const row = table.relationships.find(r => r.id === saved.id)!;
    const current = (await readRelationships(f.uri)).find(r => r.id === row.id);
    if (variant === 'retired') expect(current).toBeUndefined();
    else if (variant === 'endpoint-collision') expect(current).toMatchObject({ from: 'a', to: 'b.c' });
    else expect(current).toMatchObject({ from: 'A', to: 'B', metadata: { macros: ['testMacro'], isAtomic: true } });
    const panel = await openSaved(row.id, { readOnly: false });
    expect(context(panel)).toMatchObject({ source: 'saved', targetState: 'found', existing: row, readOnly: true });
    expect(context(panel).existing).toEqual(row);
    expect(context(panel).relationshipRevision).toBeUndefined();
    // Client flags and metadata cannot unlock an automatic record.
    await panel.receive({ type: 'update', readOnly: false, relationship: { ...row, metadata: null, label: 'custom' }, expectedRevision: entityRevision(row) });
    expect(panel.messages.at(-1)).toMatchObject({ type: 'invalid' });
    // Old graph callers keep the current domain and get a separate singleton.
    await vscode.commands.executeCommand('snlDoc.editRelationship', row.id);
    const graphPanel = host.panels.at(-1)!;
    expect(graphPanel).not.toBe(panel);
    await graphPanel.receive({ type: 'ready' });
    expect(context(graphPanel).existing).toEqual(current ?? null);
    expect(context(graphPanel).source).toBe('current');
    await openSaved(row.id);
    expect(host.panels.at(-1)).toBe(graphPanel); // saved singleton was revealed, not overwritten
    expect(panel.reveal).toHaveBeenCalled();
    expect(await authored(f.root)).toEqual(before);
  });
  it('rejects invalid source at Dashboard, command and direct panel boundaries', async () => {
    for (const source of [null, true, {}, 'authored', 'SAVED']) {
      await (DashboardPanel.prototype as any).handleMessage.call({}, { type: 'editRelationship', id: 'manual', source });
      await vscode.commands.executeCommand('snlDoc.editRelationship', 'manual', source);
      (CreateRelationshipPanel.editOrShow as any)(vscode.Uri.file('/extension'), 'manual', source);
    }
    expect(host.panels).toHaveLength(0);
  });
  it('keeps old Dashboard rows saved, explicit current commands current, and sources isolated on refresh/dispose', async () => {
    const f = await withMacro(); host.root = f.uri;
    await (DashboardPanel.prototype as any).handleMessage.call({}, { type: 'editRelationship', id: 'legacy' });
    const saved = host.panels.at(-1)!; await saved.receive({ type: 'ready' });
    expect(context(saved)).toMatchObject({ source: 'saved', existing: f.relationships[1] });
    await vscode.commands.executeCommand('snlDoc.editRelationship', 'legacy', 'current');
    const current = host.panels.at(-1)!; await current.receive({ type: 'ready' });
    expect(context(current)).toMatchObject({ source: 'current', existing: null, targetState: 'notFound' });
    await saved.receive({ type: 'ready', source: 'current', readOnly: false });
    expect(context(saved)).toMatchObject({ source: 'saved', existing: f.relationships[1], readOnly: true });
    saved.close();
    await (DashboardPanel.prototype as any).handleMessage.call({}, { type: 'editRelationship', id: 'legacy' });
    const reopened = host.panels.at(-1)!; expect(reopened).not.toBe(saved);
    await reopened.receive({ type: 'ready' });
    expect(context(reopened).existing).toEqual(f.relationships[1]);
    await vscode.commands.executeCommand('snlDoc.editRelationship', 'legacy', 'current');
    expect(current.reveal).toHaveBeenCalled();
  });
  it('keeps saved manual create/update/CAS/delete on the real host writer', async () => {
    const f = await withMacro(); host.root = f.uri;
    const panel = await openSaved('manual', { readOnly: true });
    expect(context(panel)).toMatchObject({ readOnly: false, existing: f.relationships[0], relationshipRevision: entityRevision(f.relationships[0]) });
    await panel.receive({ type: 'update', relationship: { ...f.relationships[0], label: 'changed' }, expectedRevision: 'stale' });
    expect(panel.messages.at(-1)).toMatchObject({ type: 'conflict' });
    await panel.receive({ type: 'update', relationship: { ...f.relationships[0], label: 'changed' }, expectedRevision: context(panel).relationshipRevision });
    expect(context(panel).existing.label).toBe('changed');
    await vscode.commands.executeCommand('snlDoc.createRelationship');
    await host.panels.at(-1).receive({ type: 'create', relationship: { id: 'new', from: 'B', to: 'A', label: 'custom', metadata: null } });
    expect(host.panels.at(-1).messages.at(-1)).toMatchObject({ type: 'created', id: 'new' });
    await (DashboardPanel.prototype as any).handleMessage.call({}, { type: 'deleteRelationship', id: 'new' });
    expect((await readAuthoredRelationships(f.uri)).map(r => r.id)).not.toContain('new');
    expect((await readAuthoredRelationships(f.uri)).find(r => r.id === 'legacy')).toEqual(f.relationships[1]);
  });
});
