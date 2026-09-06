import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export const SOURCE_EXPORT_RECEIPT = '.snl-source-export.json';
export function sourceExportReceipt(files: readonly { path: string }[]): Uint8Array {
  return Buffer.from(JSON.stringify({ format: 'snl-source-export/v1', files: files.map(f => f.path).concat(SOURCE_EXPORT_RECEIPT).sort() }));
}
/** Replacing a directory must never erase unrelated project files. Only empty targets
 * or complete exporter-owned generations are eligible; extra files require a new target. */
export async function assertOwnedExportDestination(destination: string, inline: boolean): Promise<void> {
  let stat;
  try { stat = await fs.lstat(destination); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;
  }
  if (stat.isSymbolicLink()) throw new Error('Export destination must not be a symlink.');
  if (inline) { if (!stat.isFile()) throw new Error('Single HTML destination must be a regular file.'); return; }
  if (!stat.isDirectory()) throw new Error('Directory export destination must be a directory.');
  const children = await fs.readdir(destination);
  if (!children.length) return;
  const fail = () => new Error('Destination contains files not owned by a previous source export. Choose an empty or new directory. / 目标含有非导出器拥有的文件，请选择空目录或新目录。');
  const receiptPath = path.join(destination, SOURCE_EXPORT_RECEIPT);
  let receipt: { format?: unknown; files?: unknown };
  try {
    if (!(await fs.lstat(receiptPath)).isFile()) throw fail();
    receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  } catch { throw fail(); }
  if (receipt.format !== 'snl-source-export/v1' || !Array.isArray(receipt.files) || receipt.files.some(f => typeof f !== 'string')) throw fail();
  const expected = new Set<string>(receipt.files as string[]), actual = new Set<string>();
  async function visit(dir: string, prefix: string): Promise<void> {
    for (const name of await fs.readdir(dir)) {
      const rel = prefix ? prefix + '/' + name : name;
      const item = await fs.lstat(path.join(dir, name));
      if (item.isSymbolicLink()) throw fail();
      if (item.isDirectory()) { if (![...expected].some(f => f.startsWith(rel + '/'))) throw fail(); await visit(path.join(dir, name), rel); }
      else if (item.isFile()) actual.add(rel); else throw fail();
    }
  }
  await visit(destination, '');
  if (actual.size !== expected.size || [...actual].some(f => !expected.has(f))) throw fail();
}
