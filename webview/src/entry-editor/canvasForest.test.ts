import { describe, expect, it } from 'vitest';
import type { SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import {
  attachCanvasRoot,
  canPersistCanvasForest,
  canvasHoleIndex,
  createCanvasHole,
  detachCanvasSubtree,
  fillCanvasHole,
  isCanvasHole,
  listCanvasTargets
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

  it('preserves the vacated child index with a natural-size numbered hole', () => {
    const forest = [node('root', [node('first'), node('second')])];
    const result = detachCanvasSubtree(forest, 0, [0]);

    expect(result[0].children).toHaveLength(2);
    expect(isCanvasHole(result[0].children[0])).toBe(true);
    expect(canvasHoleIndex(result[0].children[0])).toBe(0);
    expect(result[0].children[0].macro_name).toContain('snlArgPlaceholder');
    expect(result[0].children[0].macro_name).not.toContain('\\rule');
    expect(result[0].children[1].macro_name).toBe('second');
    expect(detachCanvasSubtree(result, 0, [0])).toBe(result);
  });

  it('does not detach a block root or an invalid path', () => {
    const forest = [node('root', [node('child')])];
    expect(detachCanvasSubtree(forest, 0, [])).toBe(forest);
    expect(detachCanvasSubtree(forest, 0, [9])).toBe(forest);
  });

  it('attaches a detached root into a hole and removes that root block', () => {
    const forest = [
      node('root', [createCanvasHole(0), node('tail')]),
      node('detached', [node('leaf')])
    ];
    const result = attachCanvasRoot(forest, 1, 0, [0]);

    expect(result).toHaveLength(1);
    expect(result[0].children[0].macro_name).toBe('detached');
    expect(result[0].children[1].macro_name).toBe('tail');
  });

  it('rejects absorption into a non-hole or into the dragged root itself', () => {
    const forest = [node('root', [node('occupied')]), node('detached', [createCanvasHole(0)])];
    expect(attachCanvasRoot(forest, 1, 0, [0])).toBe(forest);
    expect(attachCanvasRoot(forest, 1, 1, [0])).toBe(forest);
  });

  it('fills a hole with a parsed subtree and lists nodes in depth-first Tab order', () => {
    const forest = [node('root', [createCanvasHole(0), node('tail')])];
    const filled = fillCanvasHole(forest, 0, [0], node('parsed', [node('inner')]));

    expect(filled[0].children[0].macro_name).toBe('parsed');
    expect(listCanvasTargets(filled).map((target) => target.path.join('.'))).toEqual([
      '', '0', '0.0', '1'
    ]);
  });

  it('allows persistence only with one root and no unresolved holes', () => {
    expect(canPersistCanvasForest([node('root')])).toBe(true);
    expect(canPersistCanvasForest([node('root', [createCanvasHole(0)])])).toBe(false);
    expect(canPersistCanvasForest([node('a'), node('b')])).toBe(false);
  });
});
