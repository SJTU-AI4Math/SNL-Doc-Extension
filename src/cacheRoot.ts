import type { CacheRoot } from './derivedCache';

/** Preserve provider identity at the host boundary, before fsPath loses it. */
export function cacheRootForWorkspace(uri: { scheme?: string; fsPath: string; toString(skipEncoding?: boolean): string }): CacheRoot {
  // Older host test doubles expose only fsPath. An explicit non-file scheme
  // must never take this compatibility branch.
  return uri.scheme === 'file' || uri.scheme === undefined ? uri.fsPath : { uri: uri.toString(true) };
}
