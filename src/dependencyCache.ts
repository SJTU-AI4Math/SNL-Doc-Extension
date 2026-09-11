import type { EntryData, MacroPackageEntry, RelationshipData } from './snlDoc';
import { extractSnlReferences } from './snlReferences';
import { getOrGenerateCache } from './derivedCache';

// ===========================================================================
// Auto-generated dependency relationships (cat 2026-07-10 §3)
// ===========================================================================
//
// For each entry E, walk E.content.snl, collect every macro identifier
// used, and — for each macro whose `source.entries[]` names an existing
// entry — emit a relationship  `E → src`  with:
//
//   label:    "depends"
//   metadata: {
//     isAtomic: bool,                 // filled in by computeAtomicity
//     generator: "macro-source-scan",
//     macros: string[],                // deduped macro names that induced
//                                        this edge (many-to-one collapse)
//   }
//
// Atomicity per cat's spec: "若一个 dependency 可以表示为其他几个 dependency
// 的复合，则它不是 Atomic." Implemented as transitive-reducibility over the
// current depends-graph — a A→B edge is NOT atomic iff there is an
// alternative path A→x1→…→xk→B of length ≥ 2 using only depends edges.
//
// SNL macro-name extraction: the parser lives in @sjtu-ai4math/snl-basics
// (browser bundle, React-linked). Host code can't load it, so we run a
// lightweight tokenizer that mirrors the parser's macro-identifier
// recognition:
//   - skip `%…%`, `$…$`, `$$…$$` delimited spans (opaque leaves);
//   - skip `@` bare-binder introductions (bindings, not uses);
//   - collect the identifier that starts with [A-Za-z_.][A-Za-z0-9_.]*
//     everywhere else.
// False positives (over-counted names) are harmless — an unregistered
// name yields no source.entries and generates no edge.

/** Identity marker written into metadata.generator for auto rows so we
 *  know it's safe to regenerate without stomping user-authored edges. */
const AUTO_GENERATOR_TAG = 'macro-source-scan';
const AUTO_LABEL = 'depends';
/** Labels that {@link regenerateDependencyRelationships} manages. Both
 *  are (label, generator) tuples on the metadata side; treat this list
 *  as the source of truth for "is this row auto-managed?". */
const AUTO_LABELS: readonly string[] = ['depends', 'uses_context'];
const AUTO_LABEL_USES_CONTEXT = 'uses_context';



/** Report from {@link regenerateDependencyRelationships}. */
export interface DependencyGenReport {
  added: number;
  removed: number;
  updated: number;
  preservedUser: number;
  totalDepends: number;
  totalUsesContext: number;
  atomicCount: number;
}

export interface DependencyScope {
  /** Restrict scan to a subset of entry ids. `null` = every entry. */
  entryIds: Set<string> | null;
}

/** Pure snapshot reconciliation used by the writer and focused tests. */
export function reconcileDependencyRelationships(
  entries: readonly Pick<EntryData, 'id' | 'content'>[],
  macros: Readonly<Record<string, Pick<MacroPackageEntry, 'source'>>>,
  existing: readonly RelationshipData[],
  scope: DependencyScope
): { relationships: RelationshipData[]; report: DependencyGenReport } {
  const poolIds = new Set(entries.map((entry) => entry.id));
  const isSystemAutoRow = (relationship: RelationshipData): boolean =>
    AUTO_LABELS.includes(relationship.label) &&
    relationship.metadata !== null &&
    typeof relationship.metadata === 'object' &&
    (relationship.metadata as { generator?: unknown }).generator === AUTO_GENERATOR_TAG;
  const isManagedDependencyRow = (relationship: RelationshipData): boolean =>
    relationship.label === AUTO_LABEL && isSystemAutoRow(relationship);

  const preservedRows: RelationshipData[] = [];
  const inScopeAuto = new Map<string, RelationshipData>();
  for (const relationship of existing) {
    const inScope = scope.entryIds === null || scope.entryIds.has(relationship.from);
    if (isManagedDependencyRow(relationship) && inScope) {
      inScopeAuto.set(JSON.stringify([relationship.label, relationship.from, relationship.to]), relationship);
    } else {
      preservedRows.push(relationship);
    }
  }
  const preservedUser = preservedRows.filter((relationship) =>
    !isSystemAutoRow(relationship)
  ).length;

  const generated = new Map<string, { rel: RelationshipData; witnesses: Set<string> }>();
  const idPrefix: Record<string, string> = {
    [AUTO_LABEL]: 'dep',
    [AUTO_LABEL_USES_CONTEXT]: 'ctx'
  };
  const witnessField: Record<string, string> = {
    [AUTO_LABEL]: 'macros',
    [AUTO_LABEL_USES_CONTEXT]: 'postfixes'
  };
  const allocatedIds = new Set(preservedRows.map(({ id }) => id));
  const allocateGeneratedId = (
    label: string,
    from: string,
    to: string,
    previous: RelationshipData | undefined
  ): string => {
    if (previous && !allocatedIds.has(previous.id)) {
      allocatedIds.add(previous.id);
      return previous.id;
    }
    const base = `${idPrefix[label]}.${from}.${to}`;
    let candidate = base;
    let suffix = 1;
    while (allocatedIds.has(candidate)) candidate = `${base}.${suffix++}`;
    allocatedIds.add(candidate);
    return candidate;
  };
  const upsert = (label: string, from: string, to: string, witness: string): void => {
    if (!to || from === to || !poolIds.has(to)) return;
    const key = JSON.stringify([label, from, to]);
    let bucket = generated.get(key);
    if (!bucket) {
      const previous = inScopeAuto.get(key);
      bucket = {
        rel: {
          id: allocateGeneratedId(label, from, to, previous),
          from,
          to,
          label,
          metadata: {
            generator: AUTO_GENERATOR_TAG,
            [witnessField[label]]: [] as string[],
            isAtomic: true
          }
        },
        witnesses: new Set<string>()
      };
      generated.set(key, bucket);
    }
    bucket.witnesses.add(witness);
  };

  for (const entry of entries) {
    if (scope.entryIds !== null && !scope.entryIds.has(entry.id)) continue;
    const snl = entry.content?.snl ?? '';
    if (!snl.trim()) continue;
    const references = extractSnlReferences(snl);
    for (const name of references.macros) {
      const macro = Object.hasOwn(macros, name) ? macros[name] : undefined;
      if (!macro || !Array.isArray(macro.source?.entries)) continue;
      for (const source of macro.source.entries) upsert(AUTO_LABEL, entry.id, source, name);
    }
  }

  for (const bucket of generated.values()) {
    const metadata = bucket.rel.metadata as Record<string, unknown>;
    metadata[witnessField[bucket.rel.label]] = Array.from(bucket.witnesses).sort();
  }

  const relationships = [...preservedRows, ...Array.from(generated.values(), ({ rel }) => rel)];
  const generatedRows = new Set(Array.from(generated.values(), ({ rel }) => rel));
  computeAtomicityInPlace(relationships, (relationship) => generatedRows.has(relationship));
  relationships.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );

  let added = 0;
  let updated = 0;
  for (const key of generated.keys()) {
    if (inScopeAuto.has(key)) updated += 1;
    else added += 1;
  }
  let removed = 0;
  for (const key of inScopeAuto.keys()) {
    if (!generated.has(key)) removed += 1;
  }
  return {
    relationships,
    report: {
      added,
      removed,
      updated,
      preservedUser,
      totalDepends: relationships.filter(({ label }) => label === AUTO_LABEL).length,
      totalUsesContext: relationships.filter(({ label }) => label === AUTO_LABEL_USES_CONTEXT).length,
      atomicCount: relationships.filter((relationship) =>
        AUTO_LABELS.includes(relationship.label) &&
        relationship.metadata !== null &&
        typeof relationship.metadata === 'object' &&
        (relationship.metadata as { isAtomic?: unknown }).isAtomic === true
      ).length
    }
  };
}

/**
 * Mark each auto-managed edge (label ∈ AUTO_LABELS) with
 * `metadata.isAtomic = true|false`. Atomicity is computed PER LABEL:
 * an A→B edge with label L is atomic iff no alternative path A→…→B of
 * length ≥ 2 exists using only label-L edges.
 *
 * Algorithm: bucket by label, for each edge BFS from source over
 * same-label edges excluding that one direct edge; if target reachable,
 * not atomic. O(V × (V+E)) per label.
 */
export function computeAtomicityInPlace(
  rels: RelationshipData[],
  shouldUpdate: (relationship: RelationshipData) => boolean = () => true
): void {
  for (const label of AUTO_LABELS) {
    const bucket: { rel: RelationshipData; idx: number }[] = [];
    rels.forEach((r) => {
      if (r.label === label) bucket.push({ rel: r, idx: bucket.length });
    });
    const adj = new Map<string, { to: string; edgeIdx: number }[]>();
    bucket.forEach(({ rel, idx }) => {
      if (!adj.has(rel.from)) adj.set(rel.from, []);
      adj.get(rel.from)!.push({ to: rel.to, edgeIdx: idx });
    });
    bucket.forEach(({ rel }) => {
      if (!shouldUpdate(rel)) return;
      const seen = new Set<string>([rel.from]);
      const queue: string[] = [rel.from];
      let hit = false;
      while (queue.length > 0 && !hit) {
        const cur = queue.shift()!;
        const outs = adj.get(cur) ?? [];
        for (const e of outs) {
          // Parallel direct edges are still paths of length one, not composites.
          if (cur === rel.from && e.to === rel.to) continue;
          if (e.to === rel.to) { hit = true; break; }
          if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
        }
      }
      const md = (rel.metadata ?? {}) as { isAtomic?: boolean } & Record<string, unknown>;
      md.isAtomic = !hit;
      rel.metadata = md;
    });
  }
}


/** Exactly this generator's rows are derived; uses_context is not owned. */
export function isAutomaticDependency(relationship: Pick<RelationshipData, 'label' | 'metadata'>): boolean {
  return relationship.label === 'depends' && relationship.metadata !== null &&
    typeof relationship.metadata === 'object' &&
    (relationship.metadata as { generator?: unknown }).generator === AUTO_GENERATOR_TAG;
}

export interface DependencySnapshot {
  entries: readonly Pick<EntryData, 'id' | 'content'>[];
  macros: Readonly<Record<string, Pick<MacroPackageEntry, 'source'>>>;
  relationships: readonly RelationshipData[];
}
const compareId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Cache only generated rows; never cache or publish a second Authoring pool. */
export async function readDependencyCache(root: string, snapshot: DependencySnapshot): Promise<RelationshipData[]> {
  // Detach a complete semantic global snapshot. No Uri, Set, Map or UI scope
  // enters the cache hash. Authored rows affect identity allocation/atomicity.
  const input = JSON.parse(JSON.stringify({
    entries: snapshot.entries.map(e => ({ id: e.id, content: { snl: e.content?.snl ?? '' } })).sort(compareId),
    macros: Object.fromEntries(Object.keys(snapshot.macros).sort().map(name => [name, { source: { entries: snapshot.macros[name].source?.entries ?? [] } }])),
    relationships: [...snapshot.relationships].sort(compareId)
  })) as DependencySnapshot;
  const pool = new Set(input.entries.map(e => e.id));
  const reserved = new Set(input.relationships.filter(r => !isAutomaticDependency(r)).map(r => r.id));
  return getOrGenerateCache(root, {
    id: 'dependencies', version: '1', input,
    validate(value): value is RelationshipData[] {
      if (!Array.isArray(value)) return false;
      const ids = new Set<string>(); const pairs = new Set<string>();
      return value.every(r => {
        if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || r.id !== r.id.trim() ||
            !isAutomaticDependency(r) || !pool.has(r.from) || !pool.has(r.to) || r.from === r.to ||
            reserved.has(r.id) || ids.has(r.id) || typeof r.metadata?.isAtomic !== 'boolean' ||
            !Array.isArray(r.metadata.macros) || !r.metadata.macros.every((m: unknown) => typeof m === 'string')) return false;
        const pair = JSON.stringify([r.from, r.to]);
        if (pairs.has(pair)) return false;
        ids.add(r.id); pairs.add(pair); return true;
      });
    },
    generate: () => reconcileDependencyRelationships(input.entries, input.macros, input.relationships, { entryIds: null })
      .relationships.filter(isAutomaticDependency)
  });
}

export function mergeDependencyRelationships(authored: readonly RelationshipData[], generated: readonly RelationshipData[]): RelationshipData[] {
  return [...authored.filter(r => !isAutomaticDependency(r)), ...generated].sort(compareId);
}
