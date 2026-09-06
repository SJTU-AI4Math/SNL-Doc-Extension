import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { EntryPointer, normalizeEntryPointer, normalizePointerFile } from './schema';
import { PointerDiagnostic, RegexOffsets, TextResolution, resolvePointerText, resolveRegexOffsets } from './text';

export const DEFAULT_REGEX_TIMEOUT_MS = 250;

/** Worker is terminated on every completion, error, exit or deadline. No unbounded regex on host. */
export async function resolvePointerTextAsync(
  value: EntryPointer, text: string, timeoutMs = DEFAULT_REGEX_TIMEOUT_MS
): Promise<TextResolution> {
  const pointer = normalizeEntryPointer(value);
  if (!pointer || !normalizePointerFile(pointer.file)) {
    return { status: 'invalid-shape', message: 'pointer failed structural/path validation' };
  }
  if (pointer.mode === 'lines') return resolvePointerText(pointer, text);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid regex timeout');
  const offsets = await new Promise<RegexOffsets>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
        parentPort.postMessage((${resolveRegexOffsets.toString()})(workerData.pointer, workerData.text));`,
      { eval: true, workerData: { pointer, text }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
    } catch (error) {
      resolve({ status: 'regex-worker-error', file: pointer.file, message: String(error) });
      return;
    }
    let settled = false;
    const finish = (result: RegexOffsets) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().then(() => resolve(result), () => resolve(result));
    };
    const timer = setTimeout(() => finish({ status: 'regex-timeout', file: pointer.file, timeoutMs }), timeoutMs);
    worker.once('message', finish);
    worker.once('error', error => finish({ status: 'regex-worker-error', file: pointer.file, message: error.message }));
    worker.once('exit', code => finish({ status: 'regex-worker-error', file: pointer.file, message: `Worker exited (${code})` }));
  });
  return resolvePointerText(pointer, text, offsets);
}

/** Filesystem trust boundary: lexical workspace-relative paths only; stat/read follow symlinks,
 * including .lake shared-cache links outside root. This is NOT realpath confinement. Call only
 * for trusted workspaces; dangling links/non-files fail closed. No external path is persisted.
 */
export async function readPointerSource(rootPath: string, file: string): Promise<
  { status: 'ok'; text: string; absolutePath: string } | PointerDiagnostic
> {
  const relative = normalizePointerFile(file);
  if (!relative) return { status: 'invalid-shape', message: 'pointer.file must be workspace-relative without traversal' };
  const absolutePath = path.resolve(rootPath, relative);
  try {
    if (!(await fs.stat(absolutePath)).isFile()) return { status: 'file-missing', file: relative };
    return { status: 'ok', text: await fs.readFile(absolutePath, 'utf8'), absolutePath };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'file-missing', file: relative };
    return { status: 'file-read-error', file: relative, message: String(error) };
  }
}
