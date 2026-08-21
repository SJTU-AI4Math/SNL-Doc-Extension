import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import { SVG_ASSET_BASE_IDENTITY, readWorkspaceSvgSource } from './workspaceAssets';
import { withWorkspaceDataLock } from './workspaceDataLock';
import { validateSvgTemplateForPersistence } from './svgTemplateHostValidation';

const MAX_SVG_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const SAFE_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export interface WriteWorkspaceSvgMacroAssetsOptions {
  workspaceRoot: vscode.Uri;
  slug: string;
  sourceSvg: string;
  templateSvg: string;
  accessibilityLabel: string;
  operations: unknown[];
}

export interface SvgTemplateProjectionRecord {
  asset: {
    source: string;
    base_identity: typeof SVG_ASSET_BASE_IDENTITY;
    revision: string;
    request_epoch: 0;
  };
  generation: 1;
  producer_revision: 'snl-doc-extension-svg-editor:v1';
  accessibility: { label: string };
  editor: { source: string; source_revision: string; manifest: string };
}

export interface WrittenWorkspaceSvgMacroAssets {
  sourcePath: string;
  manifestPath: string;
  projection: SvgTemplateProjectionRecord;
}

function bytes(text: string, label: string, limit: number): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength === 0 || encoded.byteLength > limit) {
    throw new Error(`${label} must be non-empty and no larger than ${Math.floor(limit / 1024)} KiB.`);
  }
  return encoded;
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

interface FileIdentity { dev: bigint; ino: bigint }

async function requireDirectoryWithoutSymlink(path: string, label: string): Promise<FileIdentity> {
  const stat = await fs.lstat(path, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory.`);
  return { dev: stat.dev, ino: stat.ino };
}

async function requireIdentity(path: string, expected: FileIdentity, label: string): Promise<void> {
  const stat = await fs.lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
    throw new Error(`${label} changed during SVG Asset publication.`);
  }
}

async function unlinkOwned(path: string, expected: FileIdentity): Promise<void> {
  await requireIdentity(path, expected, 'Owned SVG Asset entry');
  await fs.unlink(path);
}

async function writeImmutable(
  path: string,
  value: Uint8Array,
  directoryPath: string,
  directoryIdentity: FileIdentity
): Promise<FileIdentity | null> {
  await requireIdentity(directoryPath, directoryIdentity, 'SVG Asset directory');
  const temporary = `${path}.${randomUUID()}.next`;
  const handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  const tempStat = await handle.stat({ bigint: true });
  const tempIdentity = { dev: tempStat.dev, ino: tempStat.ino };
  let temporaryExists = true;
  try {
    await requireIdentity(directoryPath, directoryIdentity, 'SVG Asset directory');
    await requireIdentity(temporary, tempIdentity, 'SVG Asset temporary file');
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  let created: FileIdentity | null = null;
  try {
    await requireIdentity(directoryPath, directoryIdentity, 'SVG Asset directory');
    await requireIdentity(temporary, tempIdentity, 'SVG Asset temporary file');
    try {
      await fs.link(temporary, path);
      created = tempIdentity;
      const targetStat = await fs.lstat(path, { bigint: true });
      if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.dev !== tempIdentity.dev || targetStat.ino !== tempIdentity.ino) {
        throw new Error('Published SVG Asset identity does not match its flushed temporary inode.');
      }
      created = { dev: targetStat.dev, ino: targetStat.ino };
    } catch (reason) {
      const code = (reason as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw reason;
      const existingStat = await fs.lstat(path, { bigint: true });
      if (existingStat.isSymbolicLink()) {
        throw new Error('Content-addressed SVG Asset destination is a symbolic link.');
      }
      if (!existingStat.isFile()) {
        throw new Error('Content-addressed SVG Asset destination must be a regular file.');
      }
      const existing = await fs.readFile(path);
      if (!existing.equals(Buffer.from(value))) {
        throw new Error('Content-addressed SVG Asset already exists with different bytes.');
      }
    }
  } catch (reason) {
    if (created) {
      try {
        await unlinkOwned(path, created);
        created = null;
      } catch (rollbackReason) {
        throw new Error('SVG Asset publication failed and its newly linked destination could not be rolled back.', { cause: new AggregateError([reason, rollbackReason]) });
      }
    }
    throw reason;
  } finally {
    try {
      await unlinkOwned(temporary, tempIdentity);
      temporaryExists = false;
    } catch (reason) {
      if (created) {
        try { await unlinkOwned(path, created); } catch { /* preserve the original identity failure */ }
      }
      if (temporaryExists) throw reason;
    }
  }
  return created;
}

async function verifyExactFile(path: string, expected: Uint8Array): Promise<void> {
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expected.byteLength) throw new Error('Published SVG Asset has the wrong file type or size.');
    const actual = await handle.readFile();
    if (!actual.equals(Buffer.from(expected))) throw new Error('Published SVG Asset bytes do not match the committed content.');
  } finally {
    await handle.close();
  }
}

function assertRuntimeTemplate(source: string, label: string): void {
  try {
    validateSvgTemplateForPersistence(source);
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : String(reason);
    throw new Error(`${label} is not a safe SVG template: ${detail}`);
  }
}

/**
 * Persist one editor compilation as immutable, content-addressed workspace
 * Assets. The raw source is provenance only; the Macro projection references
 * only the validated runtime template. All committed files are created through
 * an atomic hard-link from a fully flushed temporary inode.
 */
async function writeWorkspaceSvgMacroAssetsUnlocked(
  options: WriteWorkspaceSvgMacroAssetsOptions
): Promise<WrittenWorkspaceSvgMacroAssets> {
  if (options.workspaceRoot.scheme !== 'file') {
    throw new Error('SVG Macro Assets require a file-backed workspace.');
  }
  if (!SAFE_SLUG.test(options.slug) || options.slug === '.' || options.slug === '..' || WINDOWS_RESERVED_NAME.test(options.slug)) {
    throw new Error('SVG Macro Asset name must be a safe filename slug.');
  }
  if (!options.accessibilityLabel.trim() || options.accessibilityLabel.length > 500) {
    throw new Error('SVG Macro accessibility label must be between 1 and 500 characters.');
  }
  assertRuntimeTemplate(options.sourceSvg, 'Raw SVG source');
  assertRuntimeTemplate(options.templateSvg, 'Runtime SVG template');
  const sourceBytes = bytes(options.sourceSvg, 'Raw SVG source', MAX_SVG_BYTES);
  const templateBytes = bytes(options.templateSvg, 'Runtime SVG template', MAX_SVG_BYTES);
  const sourceDigest = digest(sourceBytes);
  const templateDigest = digest(templateBytes);

  const snlDocRoot = join(options.workspaceRoot.fsPath, '.SNL_Doc');
  await requireDirectoryWithoutSymlink(snlDocRoot, '.SNL_Doc');
  const assetsRoot = join(snlDocRoot, 'assets');
  await fs.mkdir(assetsRoot, { recursive: true });
  await requireDirectoryWithoutSymlink(assetsRoot, '.SNL_Doc/assets');
  const svgRoot = join(assetsRoot, 'svg');
  await fs.mkdir(svgRoot, { recursive: true });
  const svgRootIdentity = await requireDirectoryWithoutSymlink(svgRoot, '.SNL_Doc/assets/svg');

  const sourceFile = `${options.slug}.source.${sourceDigest}.svg`;
  const templateFile = `${options.slug}.template.${templateDigest}.svg`;
  const sourcePath = `svg/${sourceFile}`;
  const templatePath = `svg/${templateFile}`;
  const outputRevision = `sha256:${templateDigest}`;
  const producerRevision = 'snl-doc-extension-svg-editor:v1' as const;
  const manifestRecord = {
    version: 1,
    compiler: producerRevision,
    source: sourcePath,
    source_revision: `sha256:${sourceDigest}`,
    output: templatePath,
    output_revision: outputRevision,
    operations: options.operations
  };
  let manifestText: string;
  try {
    manifestText = `${JSON.stringify(manifestRecord, null, 2)}\n`;
  } catch {
    throw new Error('SVG Macro operation manifest must be JSON-serializable.');
  }
  const manifestBytes = bytes(manifestText, 'SVG Macro manifest', MAX_MANIFEST_BYTES);
  const manifestDigest = digest(manifestBytes);
  const manifestFile = `${options.slug}.manifest.${manifestDigest}.json`;
  const manifestPath = `svg/${manifestFile}`;
  const projection: SvgTemplateProjectionRecord = {
    asset: {
      source: templatePath,
      base_identity: SVG_ASSET_BASE_IDENTITY,
      revision: outputRevision,
      request_epoch: 0
    },
    generation: 1,
    producer_revision: producerRevision,
    accessibility: { label: options.accessibilityLabel.trim() },
    editor: { source: sourcePath, source_revision: `sha256:${sourceDigest}`, manifest: manifestPath }
  };

  const createdPaths: Array<{ path: string; identity: FileIdentity }> = [];
  try {
    const sourceTarget = join(svgRoot, sourceFile);
    const sourceIdentity = await writeImmutable(sourceTarget, sourceBytes, svgRoot, svgRootIdentity);
    if (sourceIdentity) createdPaths.push({ path: sourceTarget, identity: sourceIdentity });
    const templateTarget = join(svgRoot, templateFile);
    const templateIdentity = await writeImmutable(templateTarget, templateBytes, svgRoot, svgRootIdentity);
    if (templateIdentity) createdPaths.push({ path: templateTarget, identity: templateIdentity });
    const manifestTarget = join(svgRoot, manifestFile);
    const manifestIdentity = await writeImmutable(manifestTarget, manifestBytes, svgRoot, svgRootIdentity);
    if (manifestIdentity) createdPaths.push({ path: manifestTarget, identity: manifestIdentity });
    await requireIdentity(svgRoot, svgRootIdentity, 'SVG Asset directory');
    const [verifiedSource, verifiedTemplate] = await Promise.all([
      readWorkspaceSvgSource({ workspaceRoot: options.workspaceRoot, relativePath: sourcePath, baseIdentity: SVG_ASSET_BASE_IDENTITY, revision: `sha256:${sourceDigest}` }),
      readWorkspaceSvgSource({ workspaceRoot: options.workspaceRoot, relativePath: templatePath, baseIdentity: SVG_ASSET_BASE_IDENTITY, revision: outputRevision })
    ]);
    await verifyExactFile(manifestTarget, manifestBytes);
    if (verifiedSource !== options.sourceSvg || verifiedTemplate !== options.templateSvg) {
      throw new Error('Published SVG Macro Asset verification changed the exact UTF-8 text.');
    }
    return { sourcePath, manifestPath, projection };
  } catch (reason) {
    const rollbackFailures: string[] = [];
    for (const entry of createdPaths.reverse()) {
      try {
        await unlinkOwned(entry.path, entry.identity);
      } catch (rollbackReason) {
        rollbackFailures.push(`${entry.path}: ${rollbackReason instanceof Error ? rollbackReason.message : String(rollbackReason)}`);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new Error(`SVG Macro Asset publication failed and rollback was incomplete: ${rollbackFailures.join('; ')}`, { cause: reason });
    }
    throw reason;
  }
}

export async function writeWorkspaceSvgMacroAssets(
  options: WriteWorkspaceSvgMacroAssetsOptions
): Promise<WrittenWorkspaceSvgMacroAssets> {
  return withWorkspaceDataLock(options.workspaceRoot, 'write SVG Macro Assets', () =>
    writeWorkspaceSvgMacroAssetsUnlocked(options)
  );
}
