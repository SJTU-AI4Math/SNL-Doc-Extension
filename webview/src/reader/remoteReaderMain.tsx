import { createRoot } from 'react-dom/client';
import { initializeBrowserReaderDocument } from './BrowserReader';
import { LocalWorkspaceReader, type ReaderTransport } from './LocalWorkspaceReader';
import { getVsCodeApi } from '../vscodeApi';

const root = document.getElementById('root');
const api = getVsCodeApi();
if (!root || !api) throw new Error('Remote Reader webview is missing its host.');
initializeBrowserReaderDocument();

let nextId = 0;
function request<T>(library: string | undefined, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const id = ++nextId;
    const cleanup = () => {
      window.removeEventListener('message', receive);
      signal.removeEventListener('abort', cancel);
    };
    const receive = ({ data }: MessageEvent) => {
      if (data?.type !== 'remoteReader.response' || data.id !== id) return;
      cleanup();
      if (typeof data.error === 'string') reject(new Error(data.error));
      else resolve(data.value);
    };
    const cancel = () => {
      cleanup();
      api!.postMessage({ type: 'remoteReader.cancel', id });
      reject(signal.reason);
    };
    window.addEventListener('message', receive);
    signal.addEventListener('abort', cancel, { once: true });
    api!.postMessage({ type: 'remoteReader.request', id, library });
  });
}
const transport: ReaderTransport = {
  catalog: signal => request(undefined, signal),
  snapshot: (slug, signal) => request(slug, signal),
};
createRoot(root).render(<LocalWorkspaceReader transport={transport} />);
