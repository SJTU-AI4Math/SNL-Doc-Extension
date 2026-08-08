// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { currentColorScheme, resolveThemeColoring } from './themeColoring';

afterEach(() => { document.body.className = ''; });

describe('theme coloring', () => {
  it('maps VS Code dark and dark high-contrast classes to dark', () => {
    document.body.className = 'vscode-dark';
    expect(currentColorScheme()).toBe('dark');
    document.body.className = 'vscode-high-contrast';
    expect(currentColorScheme()).toBe('dark');
  });

  it('maps light and light high-contrast classes to light', () => {
    document.body.className = 'vscode-light';
    expect(currentColorScheme()).toBe('light');
    document.body.className = 'vscode-high-contrast-light';
    expect(currentColorScheme()).toBe('light');
  });

  it('resolves current and legacy color pairs', () => {
    expect(resolveThemeColoring({ light: { stroke: '#111', background: '#eee' }, dark: { stroke: '#fff', background: '#222' } }, 'dark')).toEqual({ stroke: '#fff', background: '#222' });
    expect(resolveThemeColoring({ stroke: '#123', background: '#abc' }, 'dark')).toEqual({ stroke: '#123', background: '#abc' });
  });
});
