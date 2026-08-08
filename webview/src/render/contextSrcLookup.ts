// Cross-entry `x@foo` src → bvar upgrade (cat 2026-07-09 Stage 1 lookup).
//
// Stage 1 spec §5 (lookup semantics): the parser attaches mdata.src on
// `x@foo` nodes; annotate-bind only sees local scope so it leaves those
// nodes as fvar. This module runs AFTER parseSnlSyntaxTree and walks the
// tree upgrading any node with mdata.src to:
//
//   - kind = 'bvar' when the target entry exists AND SNL-Basics reports an
//     exported @<name> binder declaration matching this node's name;
//   - kind stays whatever annotate-bind set + `mdata.srcStatus =
//     'dangling' | 'srcResolvedNoDecl'` when the target's missing or
//     doesn't declare @<name>. Renderer surfaces srcStatus via a
//     warning-tinted badge (Stage 2).
//
// We don't rewrite bindRef — a context-bound bvar has no local bind
// instance in scope, so scope-highlight machinery just won't light it
// up. That's acceptable Stage 1 behavior; future work can wire
// cross-entry highlight.

import type { SnlSyntaxTree } from '@sjtu-ai4math/snl-basics/core';
import { extractExportedBinders } from '@sjtu-ai4math/snl-basics/core';

export { extractExportedBinders };

/** Payload of an entries.json entry that this module cares about. */
export interface EntryPoolItemForLookup {
  id: string;
  content?: { snl?: string } | null | undefined;
}

/**
 * Build the pool-wide index: entryId → set of exported binder names.
 * Called once per EntryRender pass; O(pool_size × tree_size).
 */
export function buildContextIndex(
  pool: EntryPoolItemForLookup[]
): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  for (const e of pool) {
    const snl = e.content?.snl ?? '';
    const decls = snl ? extractExportedBinders(snl) : new Set<string>();
    // Preserve empty declarations too: an existing entry that exports no
    // matching binder is `srcResolvedNoDecl`, not `dangling`.
    idx.set(e.id, decls);
  }
  return idx;
}

/**
 * Walk `tree` in-place, upgrading any node with `mdata.src` set. Sets:
 *
 *   - node.kind = 'bvar' when src resolves + declares this name;
 *   - node.mdata.srcStatus = 'dangling' when src entry not in pool;
 *   - node.mdata.srcStatus = 'srcResolvedNoDecl' when src exists but
 *     doesn't export @<name>;
 *   - (unset when everything resolves; a resolved bvar just gets its
 *     kind flip).
 *
 * We treat any nodes with kind === 'binder' as-is (a `@x@ctx` decl is
 * still a decl locally; the src is documentation-only per spec §fork-A).
 */
export function applyContextSrcLookup(
  tree: SnlSyntaxTree,
  contextIndex: Map<string, Set<string>>
): void {
  visit(tree);

  function visit(node: SnlSyntaxTree): void {
    if (!node) return;
    const mdata =
      node.mdata && typeof node.mdata === 'object'
        ? (node.mdata as Record<string, unknown>)
        : null;
    const canonicalSrc = node.source?.type === 'entry' ? node.source.entry_id : '';
    const syntaxSrc = node.postfix?.type === 'name' ? node.postfix.name : '';
    const legacySrc = mdata && typeof mdata.src === 'string' ? mdata.src : '';
    const src = canonicalSrc || syntaxSrc || legacySrc;
    if (src && node.kind !== 'binder') {
      const decls = contextIndex.get(src);
      if (!decls) {
        node.kind = 'fvar';
        node.source = undefined;
        node.mdata = { ...(mdata ?? {}), srcStatus: 'dangling' };
      } else if (!decls.has(node.macro_name)) {
        node.kind = 'fvar';
        node.source = undefined;
        node.mdata = { ...(mdata ?? {}), srcStatus: 'srcResolvedNoDecl' };
      } else {
        // Resolved. Upgrade kind so palette / DOM tagging matches a bvar.
        node.kind = 'bvar';
        node.source = { type: 'entry', entry_id: src };
      }
    }
    for (const c of node.children) visit(c);
  }
}
