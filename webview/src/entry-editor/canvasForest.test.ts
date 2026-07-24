import { describe, expect, it } from 'vitest';
import type { SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import {
  canPersistCanvasForest,
  createCanvasHole,
  detachCanvasSubtree,
  isCanvasHole
} from './canvasForest';

const node = (macro_name: string, children: SnlSyntaxTree[] = []): SnlSyntaxTree => ({
  macro_name,
  kind: '',
  mdata: null,
  children
});

describe('Canvas forest detach semantics', () => {
  it('removes a nested subtree from its parent and appends it as a new root', () => {
    const original = node('root', [node('left'), node('right', [node('leaf')])]);
    const result = detachCanvasSubtree([original], 0, [1]);

    expect(result.map((root) => root.macro_name)).toEqual(['root', 'right']);
    expect(result[0].children).toHaveLength(2);
    expect(result[0].children[0].macro_name).toBe('left');
    expect(isCanvasHole(result[0].children[1])).toBe(true);
    expect(result[1].children[0].macro_name).toBe('leaf');
    expect(original.children.map((child) => child.macro_name)).toEqual(['left', 'right']);
  });

  it('supports detaching from an already detached root', () => {
    const forest = [node('root'), node('detached', [node('inner')])];
    const result = detachCanvasSubtree(forest, 1, [0]);

    expect(result.map((root) => root.macro_name)).toEqual(['root', 'detached', 'inner']);
    expect(result[1].children).toHaveLength(1);
    expect(isCanvasHole(result[1].children[0])).toBe(true);
  });

  it('preserves the vacated child index with a sized non-detachable hole', () => {
    const forest = [node('root', [node('first'), node('second')])];
    const hole = createCanvasHole(96, 32);
    const result = detachCanvasSubtree(forest, 0, [0], hole);

    expect(result[0].children).toHaveLength(2);
    expect(isCanvasHole(result[0].children[0])).toBe(true);
    expect(result[0].children[1].macro_name).toBe('second');
    expect(result[0].children[0].macro_name).toContain('6em');
    expect(detachCanvasSubtree(result, 0, [0])).toBe(result);
  });

  it('does not detach a block root or an invalid path', () => {
    const forest = [node('root', [node('child')])];
    expect(detachCanvasSubtree(forest, 0, [])).toBe(forest);
    expect(detachCanvasSubtree(forest, 0, [9])).toBe(forest);
  });

  it('allows persistence only while the syntax forest has one root', () => {
    expect(canPersistCanvasForest([node('root')])).toBe(true);
    expect(canPersistCanvasForest([node('a'), node('b')])).toBe(false);
  });
});
