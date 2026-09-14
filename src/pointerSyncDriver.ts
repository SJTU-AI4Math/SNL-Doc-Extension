import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { CURRENT_DATA_VERSION } from './dataMigrationCore';
import { buildPointerIndex, updatePointerIndexText, findNearestEntries, stableStringify, type PointerIndex } from './pointerSync';
import { readPointerIndex, writePointerIndex } from './pointerSync/persistence';
import { readEntries } from './snlDoc';
import { is_valid_i18n_string, resolve_localized_string } from './localizedContent';
import { read_extension_preferences } from './preferences';
import type { PointerHostDriver } from './pointerSyncHost';

/** Disk snapshots are candidates, never navigation authority. Cold starts reconcile
 * canonical metadata first; buildPointerIndex then checks current source fingerprints. */
export function createPointerHostDriver(): PointerHostDriver<PointerIndex> {
  let overlay: { base: PointerIndex; file: string; index: PointerIndex } | undefined;
  return {
    async build(root, previous) {
      const config = JSON.parse(await fs.readFile(path.join(root.fsPath, '.SNL_Doc/config.json'), 'utf8')) as { version?: unknown };
      if (config?.version !== CURRENT_DATA_VERSION) throw new Error('Pointer indexing requires the current SNL data format; run SNL data repair first.');
      const entries = (await readEntries(root, true)).map(entry => ({
        id: entry.id, package: entry.package,
        title: entry.title, pointer: entry.pointer,
      }));
      if (previous === undefined) {
        const candidate = await readPointerIndex(root.fsPath);
        if (candidate) {
          // Admission is by complete current Entry/Pointer metadata, not just file
          // or id. Source freshness is checked by the builder, once per file.
          const identities = new Set(entries.map(entry => stableStringify(entry)));
          previous = { version: 3, unfiled: [], files: Object.fromEntries(
            Object.entries(candidate.files).map(([file, bucket]) => [file, {
              fingerprint: bucket.fingerprint,
              entries: bucket.entries.filter(({ entryId, package: pkg, title, pointer }) =>
                identities.has(stableStringify({ id: entryId, package: pkg, title, pointer }))),
            }])
          ) };
        }
      }
      // Never return/publish the candidate itself. Missing/changed metadata and
      // sources go through normal path/shape checks and bounded regex resolution.
      return buildPointerIndex(root.fsPath, entries, previous);
    },
    publish: (root, index) => writePointerIndex(root.fsPath, index),
    async query(_root, index, file, line, text, column) {
      const previous = overlay && overlay.base === index && overlay.file === file ? overlay.index : index;
      const current = await updatePointerIndexText(previous, file, text);
      overlay = { base: index, file, index: current };
      const result = findNearestEntries(current, file, line, column);
      const language = read_extension_preferences().language;
      return {
        complete: result.complete,
        candidates: result.candidates.map(candidate => ({
          entryId: candidate.entryId, package: candidate.package,
          title: is_valid_i18n_string(candidate.title)
            ? resolve_localized_string(candidate.title, language)
            : typeof candidate.title === 'string' ? candidate.title : candidate.title?.[language] ?? candidate.title?.en ?? Object.values(candidate.title ?? {})[0],
          startLine: candidate.range.startLine, endLine: candidate.range.endLine,
          startColumn: candidate.range.startColumn, endColumn: candidate.range.endColumn, priority: candidate.priority,
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
