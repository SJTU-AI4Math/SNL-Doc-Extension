import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { CURRENT_DATA_VERSION } from './dataMigrationCore';
import { makeEntryEnvelope, makeMacroEnvelope, makePackageManifest, entryEntityPath, macroEntityPath, packageManifestPath } from './entityStorage';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
export const entry = (id: string, snl = '', owner = 'alpha') => ({ id, package: owner, kind: 'definition', title: id, content: { snl }, pointer: null });
export const macro = (name: string, entries: string[] = []) => ({ name, description: '', source: { entries, urls: [] }, kind: 'const', dynamic_arity: false,
  styles: [{ style_name: 'default', template: { mode: 'formula_inline' as const, body: name }, tags: [] }], tags: [] });
export async function fixture(active: string[] = ['alpha']) {
  const root = await mkdtemp(join(tmpdir(), 'snl-point-')); roots.push(root);
  const calls: Array<{ op: string; path: string }> = [];
  const put = async (path: string, value: unknown) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), JSON.stringify(value)); };
  const provider = {
    async readFile(path: string) { calls.push({ op: 'readFile', path }); return readFile(join(root, path)); },
    async readDirectory(path: string): Promise<Array<[string, number]>> {
      calls.push({ op: 'readDirectory', path });
      if (path !== 'packages') throw new Error('Full Entry/Macro enumeration forbidden');
      return (await readdir(join(root, path), { withFileTypes: true })).map(e => [e.name, e.isFile() ? 1 : 2]);
    },
    readEntries() { throw new Error('Full Entry fallback forbidden'); },
    readAllMacros() { throw new Error('Full Macro fallback forbidden'); }
  };
  const config = { version: CURRENT_DATA_VERSION, active_macro_packages: active, entity_storage: { version: 1, legacy_backup_version: '0.0.5', entry_default_package: '_unpackaged',
    receipt: { legacy_backup_present: false, legacy_entries_present: false, entry_count: 0, macro_package_count: 0, macro_count: 0, entries_digest: '', macro_packages_digest: '' } } };
  await put('config.json', config);
  await mkdir(join(root, 'packages'), { recursive: true });
  return { root, calls, provider, put, config,
    async pkg(id: string, ids: string[] = []) { await put(packageManifestPath(id), makePackageManifest(id, id, '', ids)); },
    async ent(id: string, snl = '', owner = 'alpha') { await put(entryEntityPath(owner, id), makeEntryEnvelope(owner, entry(id, snl, owner))); },
    async mac(name: string, sources: string[] = [], owner = 'alpha') { await put(macroEntityPath(owner, name), makeMacroEnvelope(owner, macro(name, sources))); },
    async remove(path: string) { await rm(join(root, path)); }
  };
}
