import type { EntryPointer } from '../pointerSync/schema';
import type { CompiledPointerScope } from '../pointerSync/scope';
import type { PointerRange } from '../pointerSync/text';

/** Derived export format. This does not change canonical workspace schemas. */
export interface SourceExportOptions {
  enabled: boolean;
  scope: 'pointer-files' | 'project';
  keep: string[];
  exclude: string[];
  companionFiles: string[];
  allowedExternalRoots: string[];
  allowMissing: boolean;
  maxFileBytes: number;
  maxTotalBytes: number;
}
export const DEFAULT_SOURCE_OPTIONS: SourceExportOptions = {
  enabled: false, scope: 'pointer-files', keep: [], exclude: [], companionFiles: [],
  allowedExternalRoots: [], allowMissing: true,
  maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 25 * 1024 * 1024
};
export interface SourceEntryInput {
  id: string;
  package?: string;
  title?: string | Record<string, string>;
  pointer?: unknown;
}
export interface SourceRoute {
  entryId: string;
  nodeId?: string;
  hash: string;
}
export interface SourceFile {
  fileId: string;
  displayPath: string;
  kind: 'text' | 'binary' | 'unsupported';
  language: string;
  byteLength: number;
  sha256: string;
  bom: boolean;
  eol: 'lf' | 'crlf' | 'mixed' | 'none';
  chunkId: string;
  symlink?: boolean;
}
export interface SourcePointer {
  entryId: string;
  package?: string;
  title?: string | Record<string, string>;
  pointer: EntryPointer | unknown;
  fileId?: string;
  sourceSha256?: string;
  range?: PointerRange;
  /** Separate inverse geometry; range remains the raw forward-navigation target. */
  inverseScope?: CompiledPointerScope;
  status: 'ok' | 'excluded' | 'unavailable' | 'unsupported' | 'unresolved';
  reason?: string;
}
export interface SourceManifest {
  schemaVersion: 'snl.export.sources/v2';
  exportId: string;
  renderSnapshotId: string;
  workspaceName: string;
  snapshot: { mode: 'disk'; gitCommit?: string; dirty?: boolean };
  options: Pick<SourceExportOptions, 'scope' | 'keep' | 'exclude' | 'companionFiles'>;
  files: SourceFile[];
  directories: string[];
  pointers: SourcePointer[];
  entryRoutes: SourceRoute[];
}
export interface SourceChunk {
  fileId: string;
  sha256: string;
  base64: string;
}
/** Host-only preview data; external absolute paths never enter SourceManifest. */
export interface SourcePreview {
  manifest: SourceManifest;
  chunks: SourceChunk[];
  totalBytes: number;
  estimatedBytes: number;
  exclusions: { path: string; reason: string }[];
  warnings: string[];
  externalRoots: string[];
  confirmationId: string;
}
