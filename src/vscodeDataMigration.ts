import * as vscode from 'vscode';
import { snlRootUri, canonicalizeMacroPackageData } from './snlDoc';
import {
  inspectStoredWorkspaceData,
  migrateStoredWorkspaceData,
  type CanonicalizeMacroPackage,
  type DataMigrationStorage
} from './workspaceDataMigration';
import type { WorkspaceDataInspection, WorkspaceMigrationContext } from './dataMigrations';
import type { DataMigrationReport } from './dataMigrationCore';
import { withWorkspaceDataLock } from './workspaceDataLock';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8');
let temporaryFileSequence = 0;
const activeWorkspaceMigrations = new Set<string>();

function relativeUri(root: vscode.Uri, relativePath: string): vscode.Uri {
  const parts = relativePath.split('/');
  if (
    relativePath.startsWith('/') ||
    parts.length === 0 ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe migration path: ${relativePath}`);
  }
  return vscode.Uri.joinPath(root, ...parts);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export function createVscodeDataMigrationStorage(
  workspaceRoot: vscode.Uri
): DataMigrationStorage {
  const root = snlRootUri(workspaceRoot);
  return {
    async directoryExists(directory): Promise<boolean> {
      return exists(relativeUri(root, directory));
    },

    async readJson(path): Promise<unknown | null> {
      const uri = relativeUri(root, path);
      if (!(await exists(uri))) return null;
      const bytes = await vscode.workspace.fs.readFile(uri);
      return JSON.parse(DECODER.decode(bytes)) as unknown;
    },

    async listJsonFiles(directory): Promise<string[]> {
      const uri = relativeUri(root, directory);
      if (!(await exists(uri))) return [];
      const entries = await vscode.workspace.fs.readDirectory(uri);
      const unsafeJsonEntry = entries.find(([name, type]) =>
        name.toLowerCase().endsWith('.json') && type !== vscode.FileType.File
      );
      if (unsafeJsonEntry) {
        throw new Error(
          `${directory}/${unsafeJsonEntry[0]} is not a regular JSON file; refusing unsafe migration.`
        );
      }
      return entries
        .filter(([name, type]) =>
          type === vscode.FileType.File && name.toLowerCase().endsWith('.json')
        )
        .map(([name]) => name)
        .sort((left, right) => left.localeCompare(right));
    },

    async writeJsonAtomic(path, value, expectedOriginal): Promise<void> {
      const target = relativeUri(root, path);
      const parentParts = path.split('/').slice(0, -1);
      if (parentParts.length > 0) {
        await vscode.workspace.fs.createDirectory(relativeUri(root, parentParts.join('/')));
      }
      if (expectedOriginal !== undefined) {
        const current = await this.readJson(path);
        if (JSON.stringify(current) !== JSON.stringify(expectedOriginal)) {
          throw new Error(
            `${path} changed during migration; refusing to overwrite concurrent edits.`
          );
        }
      }
      const temporary = target.with({
        path: `${target.path}.snl-migration-tmp-${process.pid}-${++temporaryFileSequence}`
      });
      const bytes = ENCODER.encode(`${JSON.stringify(value, null, 2)}\n`);
      try {
        await vscode.workspace.fs.writeFile(temporary, bytes);
        await vscode.workspace.fs.rename(temporary, target, { overwrite: true });
      } catch (error) {
        try {
          if (await exists(temporary)) {
            await vscode.workspace.fs.delete(temporary, { recursive: false, useTrash: false });
          }
        } catch {
          // Preserve the original write/rename error; stale temp files are
          // deliberately named and ignored by SNL readers/watchers.
        }
        throw error;
      }
    },

    async deleteJsonAtomic(path, expectedOriginal): Promise<void> {
      const current = await this.readJson(path);
      if (JSON.stringify(current) !== JSON.stringify(expectedOriginal)) {
        throw new Error(`${path} changed during migration; refusing unsafe rollback deletion.`);
      }
      await vscode.workspace.fs.delete(relativeUri(root, path), {
        recursive: false,
        useTrash: false
      });
    }
  };
}

export async function inspectWorkspaceDataVersion(
  workspaceRoot: vscode.Uri
): Promise<WorkspaceDataInspection> {
  return inspectStoredWorkspaceData(createVscodeDataMigrationStorage(workspaceRoot));
}

export async function migrateWorkspaceData(
  workspaceRoot: vscode.Uri,
  canonicalizeMacroPackage: CanonicalizeMacroPackage = canonicalizeMacroPackageData
): Promise<DataMigrationReport<WorkspaceMigrationContext>> {
  const key = workspaceRoot.toString();
  if (workspaceRoot.scheme !== 'file') {
    throw new Error(
      `Data migration requires a local file workspace with atomic replacement; ` +
      `URI scheme "${workspaceRoot.scheme}" is not supported safely.`
    );
  }
  if (activeWorkspaceMigrations.has(key)) {
    throw new Error('A data migration is already running for this workspace.');
  }
  activeWorkspaceMigrations.add(key);
  try {
    return await withWorkspaceDataLock(workspaceRoot, 'migration', async () =>
      migrateStoredWorkspaceData(
        createVscodeDataMigrationStorage(workspaceRoot),
        canonicalizeMacroPackage
      )
    );
  } finally {
    activeWorkspaceMigrations.delete(key);
  }
}
