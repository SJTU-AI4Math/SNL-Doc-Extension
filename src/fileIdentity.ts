/** Windows can omit the volume ID in a pathname stat while fstat reports it. */
export function matchesPathFileIdentity(
  entry: { dev: bigint; ino: bigint },
  opened: { dev: bigint; ino: bigint },
): boolean {
  return entry.ino !== 0n && entry.ino === opened.ino &&
    (entry.dev === opened.dev || (process.platform === 'win32' && entry.dev === 0n));
}
