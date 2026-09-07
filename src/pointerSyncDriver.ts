import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { CURRENT_DATA_VERSION } from './dataMigrationCore';
import { buildPointerIndex, updatePointerIndexText, findNearestEntries, type PointerIndex } from './pointerSync';
import { writePointerIndex } from './pointerSync/persistence';
import { readEntries } from './snlDoc';
import { is_valid_i18n_string, resolve_localized_string } from './localizedContent';
import { read_extension_preferences } from './preferences';
import type { PointerHostDriver } from './pointerSyncHost';

/** Only verified in-process snapshots are reused. A disk cache is never its own authority:
 * cold start and manual metadata discovery read canonical Entries before publishing. */
export function createPointerHostDriver(): PointerHostDriver<PointerIndex> {
  let overlay: { base: PointerIndex; file: string; index: PointerIndex } | undefined;
  return {
    async build(root, previous) {
      const config = JSON.parse(await fs.readFile(path.join(root.fsPath, '.SNL_Doc/config.json'), 'utf8')) as { version?: unknown };
      if (config?.version !== CURRENT_DATA_VERSION) throw new Error('Pointer indexing requires the current SNL data format; run SNL data repair first.');
      const entries = await readEntries(root, true);
      return buildPointerIndex(root.fsPath, entries.map(entry => ({
        id: entry.id, package: entry.package,
        title: entry.title, pointer: entry.pointer,
      })), previous);
    },
    publish: (root, index) => writePointerIndex(root.fsPath, index),
    async query(_root, index, file, line, text) {
      const previous = overlay && overlay.base === index && overlay.file === file ? overlay.index : index;
      const current = await updatePointerIndexText(previous, file, text);
      overlay = { base: index, file, index: current };
      const result = findNearestEntries(current, file, line);
      const language = read_extension_preferences().language;
      return {
        complete: result.complete,
        candidates: result.candidates.map(candidate => ({
          entryId: candidate.entryId, package: candidate.package,
          title: is_valid_i18n_string(candidate.title)
            ? resolve_localized_string(candidate.title, language)
            : typeof candidate.title === 'string' ? candidate.title : candidate.title?.[language] ?? candidate.title?.en ?? Object.values(candidate.title ?? {})[0],
          startLine: candidate.range.startLine, endLine: candidate.range.coveredEndLine,
          distance: candidate.distance,
        })),
      };
    },
    files: index => Object.keys(index.files),
    summary(index) {
      const records = [...Object.entries(index.files).flatMap(([file, bucket]) => bucket.entries.map(entry => ({ file, entry }))), ...index.unfiled.map(entry => ({ file: '', entry }))];
      const failed = records.filter(({ entry }) => entry.resolution.status !== 'ok');
      return {
        files: Object.keys(index.files).length, pointers: records.length, unresolved: failed.length,
        details: failed.map(({ file, entry }) => `${entry.entryId}${entry.package ? ` [${entry.package}]` : ''} ${file}: ${JSON.stringify(entry.resolution)}`),
      };
    },
  };
}
