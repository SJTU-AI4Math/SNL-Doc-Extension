import * as vscode from 'vscode';
import { compareDataVersions, CURRENT_DATA_VERSION } from './dataMigrationCore';
import {
  assertCurrentEntityStorageMetadata,
  readEntryEntityRecordWithOwner,
  type EntityReadStorage
} from './entityStorageIo';
import { readEntries, type EntryData } from './snlDoc';

/**
 * Resolve one popover Entry according to the workspace's storage topology.
 * Current storage is fail-closed and uses exact Entry + owner-Package point
 * reads. Legacy aggregate storage has no package-addressable equivalent, so it
 * retains the historical id scan.
 */
export async function readPopoverEntry(
  root: vscode.Uri,
  entryPackage: string | undefined,
  id: string
): Promise<EntryData | undefined> {
  const configUri = vscode.Uri.joinPath(root, '.SNL_Doc', 'config.json');
  const configBytes = await vscode.workspace.fs.readFile(configUri);
  const config = JSON.parse(new TextDecoder('utf-8').decode(configBytes)) as unknown;
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      typeof (config as Record<string, unknown>).version !== 'string') {
    throw new Error('config.json must contain a string version.');
  }
  const version = (config as Record<string, unknown>).version as string;
  const relation = compareDataVersions(version, CURRENT_DATA_VERSION);
  if (relation > 0) {
    throw new Error(`Workspace data ${version} is newer than this Extension supports.`);
  }
  if (relation < 0) {
    return readEntries(root).then((entries) => entries.find((candidate) => candidate.id === id));
  }

  assertCurrentEntityStorageMetadata(config);
  if (!entryPackage) {
    throw new Error(`Current Entry ${JSON.stringify(id)} request is missing its package identity.`);
  }
  const snlRoot = vscode.Uri.joinPath(root, '.SNL_Doc');
  const storage: EntityReadStorage = {
    listJsonFiles: async () => {
      throw new Error('Popover point reads must not list entity directories.');
    },
    readJson: async (path) => {
      const uri = vscode.Uri.joinPath(snlRoot, ...path.split('/'));
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return JSON.parse(new TextDecoder('utf-8').decode(bytes)) as unknown;
      } catch (error) {
        if (error && typeof error === 'object' &&
            (error as { code?: unknown }).code === 'FileNotFound') return null;
        throw error;
      }
    }
  };
  const record = await readEntryEntityRecordWithOwner(storage, entryPackage, id);
  return record?.entry as unknown as EntryData | undefined;
}

/** Operation-local stable identity for exact current-storage popover reads. */
export function entryPackageIdentities(entries: EntryData[]): Record<string, string> {
  const identities = Object.create(null) as Record<string, string>;
  for (const entry of entries) {
    if (typeof entry.package === 'string' && entry.package) {
      identities[entry.id] = entry.package;
    }
  }
  return identities;
}
