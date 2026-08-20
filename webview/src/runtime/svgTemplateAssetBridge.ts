import type { SvgTemplateAssetIdentity, SvgTemplateAssetLoader } from '@sjtu-ai4math/snl-basics';
import type { VsCodeApi } from '../vscodeApi';

interface PendingRequest {
  identity: SvgTemplateAssetIdentity;
  resolve(value: string): void;
  reject(reason: unknown): void;
  abort(): void;
}

let nextRequest = 0;
const pending = new Map<string, PendingRequest>();
let installed = false;

function installReceiver(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as Record<string, unknown> | null;
    if (message?.type !== 'snl.assets/svg-source-result' || typeof message.request_id !== 'string') return;
    const request = pending.get(message.request_id);
    if (!request) return;
    pending.delete(message.request_id);
    request.abort();
    const identity = request.identity;
    if (message.source !== identity.source || message.base_identity !== identity.baseIdentity ||
        message.revision !== identity.revision) {
      request.reject(new Error('SVG source response identity did not match the immutable request'));
      return;
    }
    if (typeof message.svg_source === 'string') {
      request.resolve(message.svg_source);
      return;
    }
    request.reject(new Error(typeof message.error === 'string' ? message.error : 'SVG source unavailable'));
  });
}

/** Bundle-safe, fetch-free raw SVG loader. Every response is correlated to all
 * immutable identity fields; aborted or stale replies are ignored. */
export function createWorkspaceSvgAssetLoader(
  api: Pick<VsCodeApi, 'postMessage'>
): SvgTemplateAssetLoader {
  installReceiver();
  return (identity, signal) => new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const request_id = `snl-svg-source-${++nextRequest}`;
    const onAbort = (): void => {
      pending.delete(request_id);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.set(request_id, {
      identity: { ...identity }, resolve, reject,
      abort: () => signal.removeEventListener('abort', onAbort)
    });
    api.postMessage({
      type: 'snl.assets/read-svg-source', request_id,
      source: identity.source,
      base_identity: identity.baseIdentity,
      revision: identity.revision
    });
  });
}
