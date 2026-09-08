/** Message ports are installed only for committed reader lifetimes. */
export interface ReaderPlatformApi { postMessage(message: unknown): void }
let fallback: ReaderPlatformApi | undefined;
let resolvePlatform: (() => ReaderPlatformApi | undefined) | undefined;
const leases: Array<{ api: ReaderPlatformApi }> = [];
export function setReaderPlatformApi(value: ReaderPlatformApi | undefined): void { fallback = value; }
export function setReaderPlatformResolver(resolve: () => ReaderPlatformApi | undefined): void { resolvePlatform = resolve; }
export function installReaderPlatformApi(api: ReaderPlatformApi): () => void {
  const lease = { api }; leases.push(lease);
  return () => { const index = leases.indexOf(lease); if (index >= 0) leases.splice(index, 1); };
}
export function getReaderPlatformApi(): ReaderPlatformApi | undefined {
  return leases.at(-1)?.api ?? fallback ?? resolvePlatform?.();
}
