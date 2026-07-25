import type { SnlSyntaxTree } from '@sjtu-ai4math/snl-basics/core';

const TREE_ID = Symbol('snl.guiTreeNodeId');
type IdentifiedTree = SnlSyntaxTree & { [TREE_ID]?: string };
let nextTreeId = 1;

function allocateTreeId(): string {
  return `snl-tree-node-${nextTreeId++}`;
}

/** Attach non-serializing, spread-preserved UI identities to a parsed tree. */
export function ensureTreeIdentity(node: SnlSyntaxTree): void {
  const identified = node as IdentifiedTree;
  if (!identified[TREE_ID]) {
    Object.defineProperty(identified, TREE_ID, {
      value: allocateTreeId(),
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  for (const child of node.children) ensureTreeIdentity(child);
}

export function treeIdentity(node: SnlSyntaxTree): string {
  ensureTreeIdentity(node);
  return (node as IdentifiedTree)[TREE_ID]!;
}

/** Keep a replacement node in the same visual slot while its children get fresh ids. */
export function inheritTreeIdentity(
  source: SnlSyntaxTree,
  replacement: SnlSyntaxTree
): void {
  const identified = replacement as IdentifiedTree;
  if (!identified[TREE_ID]) {
    Object.defineProperty(identified, TREE_ID, {
      value: treeIdentity(source),
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  for (const child of replacement.children) ensureTreeIdentity(child);
}
