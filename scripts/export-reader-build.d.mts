import type { BuildResult } from 'esbuild';

export type ExportReaderBuildResult = BuildResult<{ write: false; metafile: true }>;

export function buildExportReader(root: string): Promise<ExportReaderBuildResult>;
export function assertSelfContainedReader(result: BuildResult, root?: string): void;
