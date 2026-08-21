import type {
  SvgTemplateAssetIdentity,
  SvgTemplateAssetLoader
} from '@sjtu-ai4math/snl-basics';
import type { VsCodeApi } from '../vscodeApi';

let nextRequest = 0;

interface SvgSourceMessage {
  type?: unknown;
  request_id?: unknown;
  source?: unknown;
  base_identity?: unknown;
  revision?: unknown;
  value?: unknown;
  error?: unknown;
}

/** Build the fail-closed consumer loader required by Basics 0.3 SVG templates. */
export function createWorkspaceSvgAssetLoader(
  api: Pick<VsCodeApi, 'postMessage'>
): SvgTemplateAssetLoader {
  return (identity: SvgTemplateAssetIdentity, signal: AbortSignal): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('SVG template asset request aborted', 'AbortError'));
        return;
      }
      const request_id = `snl-svg-asset-${++nextRequest}`;
      const cleanup = (): void => {
        signal.removeEventListener('abort', abort);
        window.removeEventListener('message', receive);
      };
      const abort = (): void => {
        cleanup();
        reject(new DOMException('SVG template asset request aborted', 'AbortError'));
      };
      const receive = (event: MessageEvent): void => {
        const message = event.data as SvgSourceMessage | null;
        if (message?.type !== 'snl.assets/svg-source' ||
            message.request_id !== request_id ||
            message.source !== identity.source ||
            message.base_identity !== identity.baseIdentity ||
            message.revision !== identity.revision) return;
        cleanup();
        if (typeof message.value === 'string') resolve(message.value);
        else reject(new Error(typeof message.error === 'string' ? message.error : 'SVG template asset is unavailable'));
      };
      signal.addEventListener('abort', abort, { once: true });
      window.addEventListener('message', receive);
      try {
        api.postMessage({
          type: 'snl.assets/read-svg', request_id,
          source: identity.source,
          base_identity: identity.baseIdentity,
          revision: identity.revision
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
}
