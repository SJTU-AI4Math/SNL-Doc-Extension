// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceSvgAssetLoader } from './svgTemplateAssetBridge';

describe('workspace SVG source bridge', () => {
  afterEach(() => vi.restoreAllMocks());

  it('correlates the complete immutable identity and resolves raw source', async () => {
    const postMessage = vi.fn();
    const loader = createWorkspaceSvgAssetLoader({ postMessage });
    const identity = { source: 'diagrams/task.svg', baseIdentity: 'workspace:.SNL_Doc/assets', revision: 'sha256:abc' };
    const promise = loader(identity, new AbortController().signal);
    const request = postMessage.mock.calls[0][0];
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/svg-source-result', request_id: request.request_id,
      source: identity.source, base_identity: identity.baseIdentity,
      revision: identity.revision, svg_source: '<svg viewBox="0 0 1 1"/>'
    }}));
    await expect(promise).resolves.toBe('<svg viewBox="0 0 1 1"/>');
  });

  it('fails closed on a response with a mismatched revision', async () => {
    const postMessage = vi.fn();
    const loader = createWorkspaceSvgAssetLoader({ postMessage });
    const identity = { source: 'diagram.svg', baseIdentity: 'workspace:.SNL_Doc/assets', revision: 'sha256:new' };
    const promise = loader(identity, new AbortController().signal);
    const request = postMessage.mock.calls[0][0];
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/svg-source-result', request_id: request.request_id,
      source: identity.source, base_identity: identity.baseIdentity,
      revision: 'sha256:stale', svg_source: '<svg/>'
    }}));
    await expect(promise).rejects.toThrow(/identity/i);
  });

  it('cancels pending correlation on abort and ignores late replies', async () => {
    const postMessage = vi.fn();
    const loader = createWorkspaceSvgAssetLoader({ postMessage });
    const controller = new AbortController();
    const promise = loader({ source: 'diagram.svg', baseIdentity: 'workspace:.SNL_Doc/assets', revision: 'sha256:x' }, controller.signal);
    const request = postMessage.mock.calls[0][0];
    controller.abort(new DOMException('detached', 'AbortError'));
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/svg-source-result', request_id: request.request_id,
      source: 'diagram.svg', base_identity: 'workspace:.SNL_Doc/assets', revision: 'sha256:x', svg_source: '<svg/>'
    }}));
    expect(postMessage).toHaveBeenCalledOnce();
  });
});
