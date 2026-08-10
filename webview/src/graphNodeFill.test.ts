import { describe, expect, it } from 'vitest';
import { graphNodeFill } from './SnlGraphApp';

describe('graph node themed fill', () => {
  it('keeps the resolved dark background while hovered or selected', () => {
    expect(graphNodeFill('#102030', false)).toBe('#102030');
    expect(graphNodeFill('#102030', true)).toBe('#102030');
  });

  it('uses the editor widget fallback only for transparent backgrounds', () => {
    expect(graphNodeFill('transparent', true)).toContain('editorWidget-background');
  });
});