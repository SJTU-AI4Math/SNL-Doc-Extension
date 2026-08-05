// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getVsCodeApi,
  useVsCodeApiRef,
  type VsCodeApi
} from './vscodeApi';

afterEach(cleanup);

describe('useVsCodeApiRef', () => {
  it('provides the cached API during the first render', () => {
    const fallback: VsCodeApi = { postMessage: () => undefined };
    (globalThis as { __snlApi?: VsCodeApi }).__snlApi ??= fallback;
    const expected = getVsCodeApi();
    let firstRenderValue: VsCodeApi | undefined;

    function Probe(): null {
      firstRenderValue = useVsCodeApiRef().current;
      return null;
    }

    render(<Probe />);
    expect(firstRenderValue).toBe(expected);
    expect(firstRenderValue).toBeDefined();
  });
});
