// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HoverPopoverProvider,
  useHoverPopovers,
  useRegisterPopoverActivation
} from './HoverPopoverProvider';
import type { SnlActivationLease } from '@sjtu-ai4math/snl-basics';

const detail = (id: string) => ({
  entry: {
    id, kind: 'definition', title: id,
    content: { text: `${id} body` }, contribution_info: null, pointer: null
  },
  kind: null
});

function StackTrigger({ activations = [] }: {
  activations?: readonly SnlActivationLease[];
}): React.ReactElement {
  const popovers = useHoverPopovers();
  const registerActivation = useRegisterPopoverActivation();
  return <button type="button" onClick={(event) => {
    const root = popovers.pin('root', event.currentTarget, 10, 10, null);
    const child = popovers.pin('child', event.currentTarget, 20, 20, root);
    for (const activation of activations) registerActivation(child, activation);
  }}>open stack</button>;
}

afterEach(cleanup);

describe('layered Escape dismissal', () => {
  it('dismisses only the deepest popover on each Escape press', async () => {
    const firstDeactivate = vi.fn(() => { throw new Error('broken activation consumer'); });
    const secondDeactivate = vi.fn(() => true);
    render(
      <HoverPopoverProvider
        postMessage={() => undefined}
        entries={[]}
        localDetails={{ root: detail('root'), child: detail('child') }}
      >
        <StackTrigger activations={[
          { activation_id: 11, request_deactivate: firstDeactivate },
          { activation_id: 11, request_deactivate: secondDeactivate }
        ]} />
      </HoverPopoverProvider>
    );

    fireEvent.click(document.querySelector('button')!);
    await waitFor(() => expect(document.querySelectorAll('[data-popover-id]')).toHaveLength(2));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.querySelectorAll('[data-popover-id]')).toHaveLength(1));
    expect(document.body.textContent).toContain('root body');
    expect(document.body.textContent).not.toContain('child body');
    expect(firstDeactivate).toHaveBeenCalledWith('popover-dismiss', expect.any(KeyboardEvent));
    expect(secondDeactivate).toHaveBeenCalledWith('popover-dismiss', expect.any(KeyboardEvent));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.querySelectorAll('[data-popover-id]')).toHaveLength(0));
    expect(firstDeactivate).toHaveBeenCalledTimes(1);
    expect(secondDeactivate).toHaveBeenCalledTimes(1);
  });

  it('preserves the existing outside-click behavior by dismissing the complete stack', async () => {
    render(
      <HoverPopoverProvider
        postMessage={() => undefined}
        entries={[]}
        localDetails={{ root: detail('root'), child: detail('child') }}
      >
        <StackTrigger />
      </HoverPopoverProvider>
    );

    fireEvent.click(document.querySelector('button')!);
    await waitFor(() => expect(document.querySelectorAll('[data-popover-id]')).toHaveLength(2));
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(document.querySelectorAll('[data-popover-id]')).toHaveLength(0));
  });
});
