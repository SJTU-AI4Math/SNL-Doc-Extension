import { describe, expect, it } from 'vitest';
import type { SnlSyntaxTree } from '@snl-basics/react';
import { ensureTreeIdentity, treeIdentity } from './treeIdentity';

const node = (macro_name: string, children: SnlSyntaxTree[] = []): SnlSyntaxTree => ({ macro_name, kind: '', mdata: null, children });

describe('GUI tree identity', () => {
  it('survives immutable clones and sibling reorder', () => {
    const left = node('left');
    const right = node('right');
    const root = node('root', [left, right]);
    ensureTreeIdentity(root);
    const leftId = treeIdentity(left);
    const clonedLeft = { ...left };
    const movedRoot = { ...root, children: [right, clonedLeft] };
    expect(treeIdentity(clonedLeft)).toBe(leftId);
    expect(treeIdentity(movedRoot.children[1])).toBe(leftId);
  });

  it('assigns distinct identities to structurally identical nodes', () => {
    const root = node('root', [node('x'), node('x')]);
    ensureTreeIdentity(root);
    expect(treeIdentity(root.children[0])).not.toBe(treeIdentity(root.children[1]));
  });
});
