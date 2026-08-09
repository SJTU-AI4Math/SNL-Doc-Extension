import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as nodeFs } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
const ABSOLUTE_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export interface CacheWorkspaceAssetOptions {
  workspaceRoot: vscode.Uri;
  cacheRoot: vscode.Uri;
  relativePath: string;
  fsApi?: vscode.FileSystem;
  asWebviewUri(target: vscode.Uri): string;
}

export interface ReadWorkspaceAssetOptions {
  workspaceRoot: vscode.Uri;
  relativePath: string;
  fsApi?: vscode.FileSystem;
}

function validateRelativeImagePath(value: string): string[] {
  if (!value || value.length > 2048 || value.includes('\0') || value.includes('\\') ||
      value.startsWith('/') || value.startsWith('//') || ABSOLUTE_SCHEME.test(value) ||
      value.includes('?') || value.includes('#')) {
    throw new Error('Image must use a safe path relative to .SNL_Doc/assets.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Image must use a safe path relative to .SNL_Doc/assets.');
  }
  const extension = extname(value).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw new Error('Image must use a supported image file extension.');
  }
  return segments;
}

async function assertLocalRealpathContainment(
  assetRoot: vscode.Uri,
  target: vscode.Uri
): Promise<void> {
  if (assetRoot.scheme !== 'file' || target.scheme !== 'file') return;
  const localSegments = relative(assetRoot.fsPath, target.fsPath).split(sep);
  let cursor = assetRoot.fsPath;
  for (const segment of ['', ...localSegments]) {
    if (segment) cursor = resolve(cursor, segment);
    if ((await nodeFs.lstat(cursor)).isSymbolicLink()) {
      throw new Error('Workspace image path contains a symbolic link.');
    }
  }
  const [realRoot, realTarget] = await Promise.all([
    nodeFs.realpath(assetRoot.fsPath),
    nodeFs.realpath(target.fsPath)
  ]);
  const displacement = relative(resolve(realRoot), resolve(realTarget));
  if (!displacement || displacement === '..' || displacement.startsWith(`..${sep}`)) {
    throw new Error('Image target escapes the real .SNL_Doc/assets directory.');
  }
}

/**
 * Copy one workspace image into extension-owned storage after proving every
 * workspace path component is a real, non-symlink entry. Webviews receive only
 * the trusted-cache URI, never direct permission to the author-controlled path.
 */
export async function cacheWorkspaceAsset(
  options: CacheWorkspaceAssetOptions
): Promise<string> {
  const fsApi = options.fsApi ?? vscode.workspace.fs;
  const bytes = await readWorkspaceAsset(options);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const cacheAssets = vscode.Uri.joinPath(options.cacheRoot, 'assets');
  const cached = vscode.Uri.joinPath(
    cacheAssets,
    `${digest}${extname(options.relativePath).toLowerCase()}`
  );
  await fsApi.createDirectory(cacheAssets);
  await fsApi.writeFile(cached, bytes);
  return options.asWebviewUri(cached);
}

/** Read one image through the shared path, no-symlink, type, and size boundary. */
export async function readWorkspaceAsset(
  options: ReadWorkspaceAssetOptions
): Promise<Uint8Array> {
  const fsApi = options.fsApi ?? vscode.workspace.fs;
  const segments = validateRelativeImagePath(options.relativePath);
  const assetRoot = vscode.Uri.joinPath(options.workspaceRoot, '.SNL_Doc', 'assets');
  const target = vscode.Uri.joinPath(assetRoot, ...segments);

  let cursor = assetRoot;
  const rootStat = await fsApi.stat(cursor);
  if ((rootStat.type & vscode.FileType.SymbolicLink) !== 0) {
    throw new Error('Workspace image assets root is a symbolic link.');
  }
  for (const segment of segments) {
    cursor = vscode.Uri.joinPath(cursor, segment);
    const stat = await fsApi.stat(cursor);
    if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
      throw new Error('Workspace image path contains a symbolic link.');
    }
  }
  const targetStat = await fsApi.stat(target);
  if ((targetStat.type & vscode.FileType.File) === 0 || targetStat.size > MAX_IMAGE_BYTES) {
    throw new Error('Workspace image must be a regular file no larger than 10 MiB.');
  }
  await assertLocalRealpathContainment(assetRoot, target);

  let bytes: Uint8Array;
  if (target.scheme === 'file') {
    const handle = await nodeFs.open(
      target.fsPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_IMAGE_BYTES) {
        throw new Error('Workspace image must be a regular file no larger than 10 MiB.');
      }
      // Revalidate after opening, then bind the path to the opened inode. A
      // check-then-swap cannot redirect the bytes without changing this pair.
      await assertLocalRealpathContainment(assetRoot, target);
      const current = await nodeFs.stat(target.fsPath);
      if (opened.dev !== current.dev || opened.ino !== current.ino) {
        throw new Error('Workspace image changed while it was being opened.');
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } else {
    // Virtual providers expose no stable read handle/inode contract. Fail
    // closed rather than claiming symlink containment from path checks alone.
    throw new Error('Workspace images require a file-backed workspace.');
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('Workspace image must be no larger than 10 MiB.');
  }
  return bytes;
}
