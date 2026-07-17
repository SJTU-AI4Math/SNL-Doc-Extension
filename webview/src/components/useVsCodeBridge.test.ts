import { describe, expect, it, vi } from 'vitest';
import { bindMessageBridge } from './useVsCodeBridge';

describe('bindMessageBridge', () => {
  it('owns ready handshake, dispatch and cleanup in one place', () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const target = {
      addEventListener: (_: 'message', fn: (event: MessageEvent) => void) => listeners.add(fn),
      removeEventListener: (_: 'message', fn: (event: MessageEvent) => void) => listeners.delete(fn)
    };
    const postMessage = vi.fn();
    const onMessage = vi.fn();
    const cleanup = bindMessageBridge(target, { postMessage }, onMessage, { type: 'ready' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });
    listeners.forEach((fn) => fn({ data: { type: 'context' } } as MessageEvent));
    expect(onMessage).toHaveBeenCalledWith({ type: 'context' });
    cleanup();
    expect(listeners.size).toBe(0);
  });
});
