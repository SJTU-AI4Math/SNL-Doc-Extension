import { createHash } from 'node:crypto';
import { stableStringify } from '../pointerSync/index';
import type { SourceEntryInput, SourceRoute } from './types';
import type { LibraryGraph } from '../libraryGraph';

export interface RenderSourceContext {
  rootPath: string;
  renderSnapshotId: string;
  entries: SourceEntryInput[];
  entryRoutes: SourceRoute[];
  /** Captures owning host state; never accepted from a webview message. */
  revalidate: () => Promise<void>;
}
/** Complete source-navigation routes for a frozen Library and its Entry closure. */
export function renderSourceRoutes(nodes: LibraryGraph['nodes'], entries: ReadonlyArray<{ id: string }>): SourceRoute[] {
  const routes: SourceRoute[] = nodes.flatMap(node => node.label === 'Entry' && typeof node.props?.entryId === 'string'
    ? [{ entryId: node.props.entryId, nodeId: node.id, hash: '#/node/' + encodeURIComponent(node.id) }] : []);
  // Dependency-only entries have standalone routes, never synthetic node IDs.
  for (const entry of entries) routes.push({ entryId: entry.id, hash: '#/entry/' + encodeURIComponent(entry.id) });
  return routes;
}
export function renderDependencyId(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
export function assertRenderSnapshot(expected: string, value: unknown): void {
  if (renderDependencyId(value) !== expected) {
    throw new Error('Document dependencies changed. Refresh the Library, recapture all variants and confirm a new source preview. / 文档依赖已变化，请刷新 Library 并重新捕获、预览。');
  }
}
