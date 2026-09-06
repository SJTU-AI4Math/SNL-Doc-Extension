import { DEFAULT_SOURCE_OPTIONS, type SourceExportOptions } from './types';
import { renderDependencyId } from './renderSnapshot';

export function parseSourceOptions(raw: unknown): SourceExportOptions {
  if (raw === undefined) return structuredClone(DEFAULT_SOURCE_OPTIONS);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid source export options');
  const obj = raw as Record<string, unknown>;
  const result = structuredClone(DEFAULT_SOURCE_OPTIONS);
  for (const key of ['enabled', 'allowMissing'] as const) {
    if (obj[key] !== undefined) {
      if (typeof obj[key] !== 'boolean') throw new Error(`Invalid ${key}`);
      result[key] = obj[key];
    }
  }
  if (obj.scope !== undefined) {
    if (obj.scope !== 'pointer-files' && obj.scope !== 'project') throw new Error('Invalid source scope');
    result.scope = obj.scope;
  }
  for (const key of ['keep', 'exclude', 'companionFiles', 'allowedExternalRoots'] as const) {
    if (obj[key] === undefined) continue;
    const list = obj[key];
    if (!Array.isArray(list) || list.length > 1000 || list.some(v => typeof v !== 'string' || !v || v.length > 4096 || /[\x00-\x1f\x7f]/.test(v))) throw new Error(`Invalid ${key}`);
    if (key !== 'allowedExternalRoots' && list.some(v => /^[\\/]|^[a-z]:/i.test(v) || v.replace(/\\/g, '/').split('/').includes('..'))) throw new Error('Source rules must be workspace-relative, without ..');
    result[key] = [...list];
  }
  for (const key of ['maxFileBytes', 'maxTotalBytes'] as const) {
    if (obj[key] === undefined) continue;
    if (typeof obj[key] !== 'number' || !Number.isSafeInteger(obj[key]) || obj[key] < 1) throw new Error(`Invalid ${key}`);
    result[key] = obj[key];
  }
  return result;
}
export function sourceRequestKey(options: SourceExportOptions, destination: string, shape: string, renderSnapshotId: string): string {
  return renderDependencyId({ options, destination, shape, renderSnapshotId });
}
