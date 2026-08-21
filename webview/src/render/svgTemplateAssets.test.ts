// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { createWorkspaceSvgAssetLoader } from './svgTemplateAssets';

afterEach(() => cleanup());

describe('workspace SVG template asset loader', () => {
  it('correlates the complete immutable asset identity before accepting source', async () => {
    const postMessage = vi.fn();
    const loader = createWorkspaceSvgAssetLoader({ postMessage });
    const identity = {
      source: 'assets/figures/proof.svg',
      baseIdentity: 'Logic',
      revision: 'sha256:abc'
    };
    const promise = loader(identity, new AbortController().signal);
    const request = postMessage.mock.calls[0][0];
    expect(request).toMatchObject({
      type: 'snl.assets/read-svg', source: identity.source,
      base_identity: identity.baseIdentity, revision: identity.revision,
    });

    window.dispatchEvent(new MessageEvent('message', { data: {
      ...request, type: 'snl.assets/svg-source', revision: 'wrong', value: '<svg id="wrong"/>'
    } }));
    let settled = false;
    void promise.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    window.dispatchEvent(new MessageEvent('message', { data: {
      ...request, type: 'snl.assets/svg-source', value: '<svg viewBox="0 0 1 1"/>'
    } }));
    await expect(promise).resolves.toBe('<svg viewBox="0 0 1 1"/>');
  });

  it('rejects an aborted request and ignores its late reply', async () => {
    const postMessage = vi.fn();
    const loader = createWorkspaceSvgAssetLoader({ postMessage });
    const controller = new AbortController();
    const promise = loader({ source: 'x.svg', baseIdentity: 'P', revision: 'r1' }, controller.signal);
    const request = postMessage.mock.calls[0][0];
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    window.dispatchEvent(new MessageEvent('message', { data: {
      ...request, type: 'snl.assets/svg-source', value: '<svg/>'
    } }));
  });
});
