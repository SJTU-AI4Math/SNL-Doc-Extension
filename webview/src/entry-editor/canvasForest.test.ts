import { describe, expect, it } from 'vitest';
import type { SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import { canPersistCanvasForest, detachCanvasSubtree } from './canvasForest';

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
    expect(result[0].children.map((child) => child.macro_name)).toEqual(['left']);
    expect(result[1].children[0].macro_name).toBe('leaf');
    expect(original.children.map((child) => child.macro_name)).toEqual(['left', 'right']);
  });

  it('supports detaching from an already detached root', () => {
    const forest = [node('root'), node('detached', [node('inner')])];
    const result = detachCanvasSubtree(forest, 1, [0]);

    expect(result.map((root) => root.macro_name)).toEqual(['root', 'detached', 'inner']);
    expect(result[1].children).toEqual([]);
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
