const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const API = '/__snl/api/';

export function remoteReaderOrigin(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new Error('Enter the HTTPS origin of the Reader service, without credentials or a path.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Enter the HTTPS origin of the Reader service, without credentials or a path.');
  }
  return url.origin;
}

export function validRemoteReaderToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32,256}$/.test(token);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateResponse(value: unknown, library: string | undefined): void {
  if (!record(value)) throw new Error('Invalid Reader response.');
  if (library === undefined) {
    const count = (value: unknown) => value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
    if (value.id !== 'remote' || typeof value.name !== 'string' || !record(value.capabilities) ||
      value.capabilities.edit !== false || !Array.isArray(value.libraries) ||
      !value.libraries.every(row => record(row) && typeof row.slug === 'string' && !!row.slug && typeof row.title === 'string' &&
        count(row.entryCount) && count(row.relationshipCount)) ||
      new Set(value.libraries.map(row => row.slug)).size !== value.libraries.length) {
      throw new Error('Invalid remote Reader workspace catalog.');
    }
    return;
  }
  if (value.version !== 1 || typeof value.renderSnapshotId !== 'string' || !record(value.library) ||
    value.library.slug !== library || typeof value.library.title !== 'string' ||
    !Array.isArray(value.library.outline) || !Array.isArray(value.library.warnings) ||
    !['entries', 'entryKinds', 'macroKinds', 'relationships', 'languages'].every(key => Array.isArray(value[key])) ||
    !['entryPackages', 'macros', 'resources', 'preferences'].every(key => record(value[key])) ||
    typeof value.contentLanguage !== 'string') {
    throw new Error('Invalid remote Reader snapshot version or Library data.');
  }
  for (const asset of Object.values(value.resources as Record<string, unknown>)) {
    if (!record(asset) || typeof asset.url !== 'string' || typeof asset.revision !== 'string' ||
      (asset.text !== undefined && typeof asset.text !== 'string') ||
      !/^data:(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml)|application\/octet-stream);base64,[A-Za-z0-9+/]*={0,2}$/.test(asset.url)) {
      throw new Error('Invalid frozen Reader asset.');
    }
  }
}

export async function fetchRemoteReader(
  origin: string,
  token: string,
  library: string | undefined,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<unknown> {
  const url = new URL(API + (library === undefined ? 'workspace' : 'snapshot'), remoteReaderOrigin(origin));
  if (library !== undefined) url.searchParams.set('library', library);
  if (!validRemoteReaderToken(token)) throw new Error('Invalid Reader token.');
  const response = await request(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    redirect: 'error', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  });
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
    Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error(response.ok ? 'Invalid or oversized Reader response.' : `Reader service returned HTTP ${response.status}.`);
  }
  const stream = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await stream.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await stream.cancel();
        throw new Error('Reader response exceeds 64 MiB.');
      }
      chunks.push(value);
    }
  } finally { stream.releaseLock(); }
  const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  validateResponse(data, library);
  return data;
}
