import { useCallback, useEffect, useRef } from 'react';
import { useVsCodeApiRef, type VsCodeApi } from '../vscodeApi';

interface MessageTarget {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export function bindMessageBridge<T>(
  target: MessageTarget,
  api: VsCodeApi | undefined,
  onMessage: (message: T) => void,
  readyMessage?: unknown
): () => void {
  const listener = (event: MessageEvent): void => onMessage(event.data as T);
  target.addEventListener('message', listener);
  if (readyMessage !== undefined) api?.postMessage(readyMessage);
  return () => target.removeEventListener('message', listener);
}

/** Shared lifecycle for VS Code webview message listeners and ready handshake. */
export function useVsCodeBridge<T>(
  onMessage: (message: T) => void,
  sendReady = true
): { apiRef: React.MutableRefObject<VsCodeApi | undefined>; post: (message: unknown) => void } {
  const apiRef = useVsCodeApiRef();
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;
  useEffect(() => {
    return bindMessageBridge<T>(
      window,
      apiRef.current,
      (message) => handlerRef.current(message),
      sendReady ? { type: 'ready' } : undefined
    );
  }, [sendReady]);
  const post = useCallback((message: unknown): void => apiRef.current?.postMessage(message), []);
  return { apiRef, post };
}
