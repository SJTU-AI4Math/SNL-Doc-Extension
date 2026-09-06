import { createHash } from 'node:crypto';
import { stableStringify } from '../pointerSync/index';
import type { SourceEntryInput, SourceRoute } from './types';

export interface RenderSourceContext {
  rootPath: string;
  renderSnapshotId: string;
  entries: SourceEntryInput[];
  entryRoutes: SourceRoute[];
  /** Captures owning host state; never accepted from a webview message. */
  revalidate: () => Promise<void>;
}
export function renderDependencyId(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
export function assertRenderSnapshot(expected: string, value: unknown): void {
  if (renderDependencyId(value) !== expected) {
    throw new Error('Document dependencies changed. Refresh the Library, recapture all variants and confirm a new source preview. / 文档依赖已变化，请刷新 Library 并重新捕获、预览。');
  }
}
