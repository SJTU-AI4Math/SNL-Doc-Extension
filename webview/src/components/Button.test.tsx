import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from './Button';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = '';
  document.getElementById('snl-shared-button-style')?.remove();
});

describe('Button stylesheet ownership', () => {
  it('uses the static webview stylesheet instead of injecting runtime CSS', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => createRoot(host).render(<Button variant="primary">Save</Button>));
    expect(document.getElementById('snl-shared-button-style')).toBeNull();
    expect(host.querySelector('button')?.className).toContain('snl-btn--primary');
  });
});
