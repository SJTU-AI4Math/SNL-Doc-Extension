import { createHash } from 'node:crypto';
import { EntityStorageValidationError, type EntityReadStorage } from './entityStorageIo';

/** Bind these operations to one .SNL_Doc URI using the provider's joinPath.
 * rootKey must be its full URI, never fsPath. No native-fs or stat fallback. */
export interface LibraryPointReadProvider {
  readFile(path: string): Promise<Uint8Array>;
  readDirectory(path: string): Promise<readonly (readonly [string, number])[]>;
}
export interface PointReadOptions { allowEnoent?: boolean }
export interface PointReadReceipt {
  root: string;
  epoch: number;
  phase: 'identity-metadata' | 'body-point-read';
  path: string;
  op: 'readFile' | 'readDirectory';
  outcome: 'ok' | 'missing' | 'error';
  /** Hash of exact bytes (or ordered directory listing), not an mtime guess. */
  revision: string | null;
}
export const pointReadRevision = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function strictPointReadStorage(
  provider: LibraryPointReadProvider, root: string, epoch: number,
  phase: PointReadReceipt['phase'], receipts: PointReadReceipt[], options: PointReadOptions = {},
): EntityReadStorage {
  const missing = (error: unknown): boolean => {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    return code === 'FileNotFound' || (options.allowEnoent === true && code === 'ENOENT');
  };
  return {
    async listJsonFiles(path) {
      if (path !== 'packages' || phase !== 'identity-metadata') throw new Error('Body directory enumeration is forbidden.');
      const receipt: PointReadReceipt = { root, epoch, phase, path, op: 'readDirectory', outcome: 'error', revision: null };
      receipts.push(receipt);
      // Missing metadata directory is not proof of an empty current workspace.
      const rows = await provider.readDirectory(path);
      const files = rows.filter(([name, type]) => type === 1 && name.endsWith('.json')).map(([name]) => name).sort();
      if (files.some(name => name.includes('/') || name.includes('\\') || name === '..')) throw new Error('Invalid provider directory filename.');
      receipt.revision = pointReadRevision(rows); receipt.outcome = 'ok';
      return files;
    },
    async readJson(path) {
      const receipt: PointReadReceipt = { root, epoch, phase, path, op: 'readFile', outcome: 'error', revision: null };
      receipts.push(receipt);
      let bytes: Uint8Array;
      try { bytes = await provider.readFile(path); }
      catch (error) {
        if (missing(error)) { receipt.outcome = 'missing'; return null; }
        throw error;
      }
      receipt.revision = createHash('sha256').update(bytes).digest('hex');
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (value === null) throw new EntityStorageValidationError(`${path} contains JSON null, not a missing file.`);
      receipt.outcome = 'ok';
      return value;
    },
  };
}
