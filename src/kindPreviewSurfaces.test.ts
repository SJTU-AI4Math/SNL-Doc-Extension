import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { handleEditKindMessage } from './editKindMessage';

const root = path.resolve(__dirname, '..');
const source = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

const surfaces = [
  'webview/src/DashboardApp.tsx',
  'webview/src/CreateEntryApp.tsx',
  'webview/src/KindEditorApp.tsx',
  'webview/src/CreateMacroApp.tsx',
  'webview/src/CreateLibraryApp.tsx',
  'webview/src/EntryPackagePanelApp.tsx',
  'webview/src/PackagePanelApp.tsx'
];

const routedHosts = [
  ['src/dashboardPanel.ts', 'entry'],
  ['src/dashboardPanel.ts', 'macro'],
  ['src/createEntryPanel.ts', 'entry'],
  ['src/createMacroPanel.ts', 'macro'],
  ['src/createLibraryPanel.ts', 'entry'],
  ['src/entryPackagePanel.ts', 'entry'],
  ['src/packagePanel.ts', 'macro']
] as const;

describe('shared KindPreview surface architecture', () => {
  it.each(surfaces)('%s imports and renders the shared KindPreview', (file) => {
    const text = source(file);
    expect(text).toMatch(/import \{ KindPreview \} from ['"]\.\/components\/KindPreview['"]/);
    expect(text).toContain('<KindPreview');
  });

  it('leaves no catalog-coloring preview implementation outside the shared primitive', () => {
    const combined = surfaces.map(source).join('\n');
    expect(combined).not.toContain('resolveWebviewKindColoring');
    expect(combined).not.toMatch(/function (?:Themed)?KindPreview\s*\(/);
    expect(combined).not.toMatch(/function KindBadge\s*\(/);
  });

  it.each(routedHosts)('%s closes its %s Kind edit route through the validated helper', (file, domain) => {
    const text = source(file);
    expect(text).toContain('handleEditKindMessage');
    expect(text).toMatch(new RegExp(`handleEditKindMessage\\(\\s*(?:message|msg),\\s*'${domain}'`));
    expect(text).toContain('(command, id) => vscode.commands.executeCommand(command, id)');
  });
});

describe('validated edit-kind host message routing', () => {
  it.each([
    ['entry', 'editEntryKind', 'snlDoc.editEntryKind'],
    ['macro', 'editMacroKind', 'snlDoc.editMacroKind']
  ] as const)('routes one valid %s message and rejects malformed ids', async (domain, type, command) => {
    const execute = vi.fn(async () => undefined);
    await expect(handleEditKindMessage({ type, id: 'kind-id' }, domain, execute)).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(command, 'kind-id');

    for (const id of ['', '   ', null, 3, {}, []]) {
      execute.mockClear();
      await expect(handleEditKindMessage({ type, id }, domain, execute)).resolves.toBe(true);
      expect(execute).not.toHaveBeenCalled();
    }
    await expect(handleEditKindMessage({ type: 'other', id: 'kind-id' }, domain, execute)).resolves.toBe(false);
  });
});
