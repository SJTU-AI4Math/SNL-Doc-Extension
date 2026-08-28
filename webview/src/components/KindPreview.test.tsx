// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KindPreview } from './KindPreview';

afterEach(() => {
  cleanup();
  document.body.className = '';
  delete document.documentElement.dataset.snlColorScheme;
});

const coloring = {
  light: { stroke: '#123456', background: '#abcdef' },
  dark: { stroke: '#fedcba', background: '#654321' }
};

describe('KindPreview Entry-style interaction', () => {
  it('paints exact light hover and Ctrl-hover feedback with a 150ms transition', () => {
    const view = render(<KindPreview coloring={coloring} name="Theorem" />);
    const preview = view.getByTestId('kind-preview');
    fireEvent.mouseEnter(preview);
    expect(preview.style.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(preview.style.boxShadow).toBe('inset 0 0 0 5px #123456');
    expect(preview.style.transition).toContain('150ms');

    fireEvent.keyDown(document, { key: 'Control', ctrlKey: true });
    expect(preview.style.backgroundColor).toBe('rgb(243, 244, 246)');
    expect(preview.style.cursor).toBe('default');
  });

  it('uses the exact dark hover colors from the Entry runtime color scheme', () => {
    document.documentElement.dataset.snlColorScheme = 'dark';
    const view = render(<KindPreview coloring={coloring} name="Rule" />);
    const preview = view.getByTestId('kind-preview');
    fireEvent.mouseEnter(preview);
    expect(preview.style.backgroundColor).toBe('rgb(31, 41, 55)');
    expect(preview.style.boxShadow).toBe('inset 0 0 0 5px #fedcba');
    fireEvent.keyDown(document, { key: 'Control', ctrlKey: true });
    expect(preview.style.backgroundColor).toBe('rgb(55, 65, 81)');
  });

  it('navigates exactly once only on Ctrl-click and contains parent activation', () => {
    const navigate = vi.fn();
    const parent = vi.fn();
    const view = render(<div onClick={parent}><KindPreview coloring={coloring} name="Theorem" kindId="theorem" onEditKind={navigate} /></div>);
    const preview = view.getByTestId('kind-preview');

    fireEvent.click(preview);
    expect(navigate).not.toHaveBeenCalled();
    expect(parent).not.toHaveBeenCalled();

    fireEvent.mouseEnter(preview);
    fireEvent.keyDown(document, { key: 'Control', ctrlKey: true });
    expect(preview.style.cursor).toBe('pointer');
    fireEvent.click(preview, { ctrlKey: true });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('theorem');
    expect(parent).not.toHaveBeenCalled();
  });

  it('clears Ctrl state on keyup and window blur', () => {
    const view = render(<KindPreview coloring={coloring} name="Theorem" kindId="theorem" onEditKind={() => {}} />);
    const preview = view.getByTestId('kind-preview');
    fireEvent.mouseEnter(preview);
    fireEvent.keyDown(document, { key: 'Control', ctrlKey: true });
    expect(preview.style.cursor).toBe('pointer');
    fireEvent.keyUp(document, { key: 'Control', ctrlKey: false });
    expect(preview.style.cursor).toBe('default');
    fireEvent.keyDown(document, { key: 'Control', ctrlKey: true });
    fireEvent.blur(window);
    expect(preview.style.cursor).toBe('default');
  });
});
