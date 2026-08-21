import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type * as vscode from 'vscode';
import { SVG_ASSET_BASE_IDENTITY } from './workspaceAssets';
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

async function openDirectoryAuthority(path: string, expected: FileIdentity): Promise<Awaited<ReturnType<typeof fs.open>>> {
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw new Error('SVG Asset directory changed before its authority handle was acquired.');
    }
    await requireIdentity(path, expected, 'SVG Asset directory');
    return handle;
  } catch (reason) {
    await handle.close();
    throw reason;
  }
}

async function syncDirectory(handle: Awaited<ReturnType<typeof fs.open>>): Promise<void> {
  try {
    await handle.sync();
  } catch (reason) {
    const code = (reason as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EPERM')) return;
    throw reason;
  }
}

interface SvgDirectoryAuthority {
  svgRoot: string;
  authorityRoot: string;
  svgIdentity: FileIdentity;
  svgHandle: Awaited<ReturnType<typeof fs.open>>;
  handles: Array<Awaited<ReturnType<typeof fs.open>>>;
}

function heldDirectoryPath(handle: Awaited<ReturnType<typeof fs.open>>, fallback: string): string {
  return process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : fallback;
}

async function openSvgDirectoryAuthority(workspaceRoot: string): Promise<SvgDirectoryAuthority> {
  if (process.platform !== 'linux') {
    throw new Error('Secure SVG Macro Asset publication requires Linux descriptor-relative filesystem authority.');
  }
  const handles: Array<Awaited<ReturnType<typeof fs.open>>> = [];
  try {
    const workspaceIdentity = await requireDirectoryWithoutSymlink(workspaceRoot, 'Workspace root');
    const workspaceHandle = await openDirectoryAuthority(workspaceRoot, workspaceIdentity);
    handles.push(workspaceHandle);
    const heldWorkspace = heldDirectoryPath(workspaceHandle, workspaceRoot);

    const snlDocHeld = join(heldWorkspace, '.SNL_Doc');
    const snlDocIdentity = await requireDirectoryWithoutSymlink(snlDocHeld, '.SNL_Doc');
    const snlDocHandle = await openDirectoryAuthority(snlDocHeld, snlDocIdentity);
    handles.push(snlDocHandle);
    const heldSnlDoc = heldDirectoryPath(snlDocHandle, join(workspaceRoot, '.SNL_Doc'));

    const assetsHeld = join(heldSnlDoc, 'assets');
    await fs.mkdir(assetsHeld).catch((reason: NodeJS.ErrnoException) => {
      if (reason.code !== 'EEXIST') throw reason;
    });
    const assetsIdentity = await requireDirectoryWithoutSymlink(assetsHeld, '.SNL_Doc/assets');
    const assetsHandle = await openDirectoryAuthority(assetsHeld, assetsIdentity);
    handles.push(assetsHandle);
    const heldAssets = heldDirectoryPath(assetsHandle, join(workspaceRoot, '.SNL_Doc', 'assets'));

    const svgHeld = join(heldAssets, 'svg');
    await fs.mkdir(svgHeld).catch((reason: NodeJS.ErrnoException) => {
      if (reason.code !== 'EEXIST') throw reason;
    });
    const svgIdentity = await requireDirectoryWithoutSymlink(svgHeld, '.SNL_Doc/assets/svg');
    const svgHandle = await openDirectoryAuthority(svgHeld, svgIdentity);
    handles.push(svgHandle);
    return {
      svgRoot: join(workspaceRoot, '.SNL_Doc', 'assets', 'svg'),
      authorityRoot: heldDirectoryPath(svgHandle, join(workspaceRoot, '.SNL_Doc', 'assets', 'svg')),
      svgIdentity,
      svgHandle,
      handles
    };
  } catch (reason) {
    await Promise.allSettled(handles.reverse().map((handle) => handle.close()));
    throw reason;
  }
}

async function requireIdentity(path: string, expected: FileIdentity, label: string): Promise<void> {
  const stat = await fs.lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
    throw new Error(`${label} changed during SVG Asset publication.`);
  }
}

async function quarantineOwned(path: string, expected: FileIdentity): Promise<void> {
  const quarantine = join(dirname(path), `.snl-quarantine-${randomUUID()}`);
  await fs.rename(path, quarantine);
  const stat = await fs.lstat(quarantine, { bigint: true });
  if (stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
    throw new Error(`Owned SVG Asset entry changed during quarantine; the ambiguous entry was preserved at ${quarantine}.`);
  }
}

const O_TMPFILE = 0o20200000;

function linkAnonymousFile(handle: { fd: number }, directoryHandle: { fd: number }, fileName: string): { ok: boolean; detail: string } {
  const linker = '/bin/ln';
  const result = spawnSync(linker, [
    '-L', '-T', '/proc/self/fd/3', `/proc/self/fd/4/${fileName}`
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe', handle.fd, directoryHandle.fd]
  });
  return {
    ok: result.status === 0,
    detail: result.error?.message ?? result.stderr ?? `linker exited ${String(result.status)}`
  };
}

async function writeImmutable(
  path: string,
  value: Uint8Array,
  directoryPath: string,
  directoryIdentity: FileIdentity,
  directoryHandle: { fd: number }
): Promise<FileIdentity | null> {
  await requireIdentity(directoryPath, directoryIdentity, 'SVG Asset directory');
  const handle = await fs.open(directoryPath, fsConstants.O_RDWR | O_TMPFILE, 0o600);
  let linked = false;
  let created: FileIdentity | undefined;
  try {
    const initial = await handle.stat({ bigint: true });
    created = { dev: initial.dev, ino: initial.ino };
    await handle.writeFile(value);
    await handle.sync();
    await handle.chmod(0o400);
    await handle.sync();
    const sealed = await handle.stat({ bigint: true });
    if (!sealed.isFile() || sealed.size !== BigInt(value.byteLength) || (sealed.mode & 0o777n) !== 0o400n) {
      throw new Error('Private SVG Asset inode was not sealed exactly before publication.');
    }
    const actual = Buffer.alloc(value.byteLength);
    const read = await handle.read(actual, 0, value.byteLength, 0);
    if (read.bytesRead !== value.byteLength || !actual.equals(Buffer.from(value))) {
      throw new Error('Private SVG Asset inode bytes changed before publication.');
    }
    await requireIdentity(directoryPath, directoryIdentity, 'SVG Asset directory');
    const link = linkAnonymousFile(handle, directoryHandle, path.split('/').pop() ?? '');
    if (!link.ok) {
      try {
        await verifyExactFile(path, value, directoryPath, directoryIdentity);
        return null;
      } catch (verificationReason) {
        if (link.detail) void link.detail;
        throw verificationReason;
      }
    }
    linked = true;
    await requireIdentity(directoryPath, directoryIdentity, 'SVG Asset directory');
    await requireIdentity(path, created, 'Published SVG Asset');
    return created;
  } catch (reason) {
    if (linked && created) {
      try {
        await quarantineOwned(path, created);
      } catch (quarantineReason) {
        throw new Error('SVG Asset publication failed and its ambiguous destination was preserved.', { cause: new AggregateError([reason, quarantineReason]) });
      }
    }
    throw reason;
  } finally {
    await handle.close();
  }
}

async function verifyExactFile(
  path: string,
  expected: Uint8Array,
  directoryPath: string,
  directoryIdentity: FileIdentity
): Promise<void> {
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    const fileIdentity = { dev: stat.dev, ino: stat.ino };
    await requireIdentity(directoryPath, directoryIdentity, 'SVG Asset directory');
    await requireIdentity(path, fileIdentity, 'Published SVG Asset');
    if (!stat.isFile() || stat.size !== BigInt(expected.byteLength)) throw new Error('Published SVG Asset has the wrong file type or size.');
    const actual = await handle.readFile();
    if (!actual.equals(Buffer.from(expected))) throw new Error('Published SVG Asset bytes do not match the committed content.');
    await requireIdentity(directoryPath, directoryIdentity, 'SVG Asset directory');
    await requireIdentity(path, fileIdentity, 'Published SVG Asset');
  } finally {
    await handle.close();
  }
}

async function verifyExactFiles(
  entries: Array<{ path: string; expected: Uint8Array }>,
  directoryPath: string,
  directoryIdentity: FileIdentity
): Promise<void> {
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  try {
    for (const entry of entries) handles.push(await fs.open(entry.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW));
    await requireIdentity(directoryPath, directoryIdentity, 'SVG Asset directory');
    const stats = await Promise.all(handles.map((handle) => handle.stat({ bigint: true })));
    const identities = stats.map((stat) => ({ dev: stat.dev, ino: stat.ino }));
    for (let index = 0; index < entries.length; index += 1) {
      const stat = stats[index];
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== BigInt(entries[index].expected.byteLength)) {
        throw new Error('Published SVG Asset has the wrong file type or size.');
      }
      if ((stat.mode & 0o777n) !== 0o400n) throw new Error('Published SVG Asset must have exact mode 0400 after publication.');
      await requireIdentity(entries[index].path, identities[index], 'Published SVG Asset');
    }
    const actual = await Promise.all(handles.map((handle) => handle.readFile()));
    actual.forEach((value, index) => {
      if (!value.equals(Buffer.from(entries[index].expected))) throw new Error('Published SVG Asset bytes do not match the committed content.');
    });
    await requireIdentity(directoryPath, directoryIdentity, 'SVG Asset directory');
    for (let index = 0; index < entries.length; index += 1) {
      const stat = await handles[index].stat({ bigint: true });
      if (stat.dev !== identities[index].dev || stat.ino !== identities[index].ino || (stat.mode & 0o777n) !== 0o400n) {
        throw new Error('Published SVG Asset inode changed during final verification.');
      }
      await requireIdentity(entries[index].path, identities[index], 'Published SVG Asset');
    }
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.close()));
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
  const sourceBytes = bytes(options.sourceSvg, 'Raw SVG source', MAX_SVG_BYTES);
  const templateBytes = bytes(options.templateSvg, 'Runtime SVG template', MAX_SVG_BYTES);
  assertRuntimeTemplate(options.sourceSvg, 'Raw SVG source');
  assertRuntimeTemplate(options.templateSvg, 'Runtime SVG template');
  const sourceDigest = digest(sourceBytes);
  const templateDigest = digest(templateBytes);

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

  const authority = await openSvgDirectoryAuthority(options.workspaceRoot.fsPath);
  const { svgRoot, authorityRoot, svgIdentity: svgRootIdentity, svgHandle: directoryHandle } = authority;
  const createdPaths: Array<{ path: string; identity: FileIdentity }> = [];
  try {
    try {
      const sourceTarget = join(authorityRoot, sourceFile);
      const sourceIdentity = await writeImmutable(sourceTarget, sourceBytes, svgRoot, svgRootIdentity, directoryHandle);
      if (sourceIdentity) createdPaths.push({ path: sourceTarget, identity: sourceIdentity });
      const templateTarget = join(authorityRoot, templateFile);
      const templateIdentity = await writeImmutable(templateTarget, templateBytes, svgRoot, svgRootIdentity, directoryHandle);
      if (templateIdentity) createdPaths.push({ path: templateTarget, identity: templateIdentity });
      const manifestTarget = join(authorityRoot, manifestFile);
      const manifestIdentity = await writeImmutable(manifestTarget, manifestBytes, svgRoot, svgRootIdentity, directoryHandle);
      if (manifestIdentity) createdPaths.push({ path: manifestTarget, identity: manifestIdentity });
      await verifyExactFiles([
        { path: sourceTarget, expected: sourceBytes },
        { path: templateTarget, expected: templateBytes },
        { path: manifestTarget, expected: manifestBytes }
      ], svgRoot, svgRootIdentity);
      await syncDirectory(directoryHandle);
      await requireIdentity(svgRoot, svgRootIdentity, 'SVG Asset directory');
      return { sourcePath, manifestPath, projection };
    } catch (reason) {
      const rollbackFailures: string[] = [];
      for (const entry of createdPaths.reverse()) {
        try {
          await quarantineOwned(entry.path, entry.identity);
        } catch (rollbackReason) {
          rollbackFailures.push(`${entry.path}: ${rollbackReason instanceof Error ? rollbackReason.message : String(rollbackReason)}`);
        }
      }
      if (rollbackFailures.length > 0) {
        throw new Error(`SVG Macro Asset publication failed and rollback was incomplete: ${rollbackFailures.join('; ')}`, { cause: reason });
      }
      throw reason;
    }
  } finally {
    await Promise.allSettled(authority.handles.reverse().map((handle) => handle.close()));
  }

}

export async function writeWorkspaceSvgMacroAssets(
  options: WriteWorkspaceSvgMacroAssetsOptions
): Promise<WrittenWorkspaceSvgMacroAssets> {
  return withWorkspaceDataLock(options.workspaceRoot, 'write SVG Macro Assets', () =>
    writeWorkspaceSvgMacroAssetsUnlocked(options)
  );
}
