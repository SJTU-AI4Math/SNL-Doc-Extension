/** Injected platform message port used by shared rendering and asset loaders. */
export interface ReaderPlatformApi { postMessage(message: unknown): void }
let api: ReaderPlatformApi | undefined;
let resolvePlatform: (() => ReaderPlatformApi | undefined) | undefined;
export function setReaderPlatformApi(value: ReaderPlatformApi): void { api = value; }
export function setReaderPlatformResolver(resolve: () => ReaderPlatformApi | undefined): void { resolvePlatform = resolve; }
export function getReaderPlatformApi(): ReaderPlatformApi | undefined { return api ?? resolvePlatform?.(); }
