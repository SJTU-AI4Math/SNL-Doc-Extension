import Fuse, { type FuseResult } from 'fuse.js';

export type SnooglFieldTier = 'primary' | 'secondary' | 'tertiary';

export interface SnooglSearchFields {
  primary: readonly string[];
  secondary: readonly string[];
  tertiary: readonly string[];
}

export interface SnooglSearchDocument<T> {
  /** Stable deterministic tie-break key. */
  id: string;
  value: T;
  fields: SnooglSearchFields;
}

export interface SnooglRankedResult<T> {
  value: T;
  score: number;
  tokenScores: number[];
}

export interface SnooglSearchOptions {
  fieldWeights?: Partial<Record<SnooglFieldTier, number>>;
  /** Minimum weighted score required for every whitespace-delimited token. */
  minTokenScore?: number;
  /** Fuse's maximum accepted raw error score (0 exact, 1 mismatch). */
  fuseThreshold?: number;
}

interface IndexedField {
  documentIndex: number;
  text: string;
  tier: SnooglFieldTier;
}

const DEFAULT_FIELD_WEIGHTS: Record<SnooglFieldTier, number> = {
  primary: 1,
  secondary: 0.85,
  tertiary: 0.65
};

const DEFAULT_MIN_TOKEN_SCORE = 0.2;
const DEFAULT_FUSE_THRESHOLD = 0.72;

export function tokenizeSnooglQuery(query: string): string[] {
  return query.trim().split(/\s+/u).filter(Boolean);
}

/** One scoring probe: a needle plus the field tiers it may match against. */
interface SnooglProbe {
  text: string;
  tiers: readonly SnooglFieldTier[];
}

const ALL_TIERS: readonly SnooglFieldTier[] = ['primary', 'secondary', 'tertiary'];
const TAIL_TIERS: readonly SnooglFieldTier[] = ['primary', 'secondary'];
const MIDDLE_TIERS: readonly SnooglFieldTier[] = ['tertiary'];

/**
 * How completely the needle covers the matched field.
 *
 * Fuse with `ignoreLocation` scores a substring hit almost perfectly no
 * matter how much trailing text follows, so `to` scored the same against
 * `to`, `tot` and `toFun`. This factor keeps a whole-field match strictly
 * ahead of a prefix-of-something-longer without hard-gating fuzzy hits.
 */
function exactnessFactor(needle: string, fieldText: string): number {
  const field = fieldText.toLowerCase();
  if (needle === field) return 1;
  if (field.length === 0) return 0.85;
  const coverage = Math.min(1, needle.length / field.length);
  const base = field.startsWith(needle) ? 0.9 : 0.85;
  return base * (0.6 + 0.4 * coverage);
}

/**
 * Expand one whitespace token into scoring probes.
 *
 * A dotted token is itself a namespace, so it must be matched the same way
 * documents are split — last segment against the namespace tail, earlier
 * segments against the namespace middle. Matching `Type.to` as one opaque
 * string never matches any single field (the tail is `to`, the middle is
 * `Type`), so Fuse used to score every `Type.*` candidate identically and
 * the exact hit sank into the pile. Cat 2026-07-25.
 */
export function expandSnooglToken(token: string): SnooglProbe[] {
  if (!token.includes('.')) return [{ text: token, tiers: ALL_TIERS }];
  const segments = token.split('.').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return [];
  if (segments.length === 1) return [{ text: segments[0], tiers: ALL_TIERS }];
  return [
    { text: segments[segments.length - 1], tiers: TAIL_TIERS },
    ...segments.slice(0, -1).map((segment) => ({ text: segment, tiers: MIDDLE_TIERS }))
  ];
}

/**
 * Shared SNoogL ranker.
 *
 * Each whitespace-delimited token is scored independently. Within one token,
 * the best weighted field match wins; across tokens, an AND gate followed by
 * a geometric mean prevents one excellent match from hiding a missing term.
 */
export function rankSnooglDocuments<T>(
  query: string,
  documents: readonly SnooglSearchDocument<T>[],
  options: SnooglSearchOptions = {}
): SnooglRankedResult<T>[] {
  return new SnooglSearchIndex(documents, options).search(query);
}

/** Reusable Fuse index for search surfaces that issue many successive queries. */
export class SnooglSearchIndex<T> {
  private readonly documents: readonly SnooglSearchDocument<T>[];
  private readonly weights: Record<SnooglFieldTier, number>;
  private readonly minTokenScore: number;
  private readonly fuse: Fuse<IndexedField>;
  private readonly hasFields: boolean;

  public constructor(
    documents: readonly SnooglSearchDocument<T>[],
    options: SnooglSearchOptions = {}
  ) {
    this.documents = documents;
    this.weights = {
      primary: options.fieldWeights?.primary ?? DEFAULT_FIELD_WEIGHTS.primary,
      secondary: options.fieldWeights?.secondary ?? DEFAULT_FIELD_WEIGHTS.secondary,
      tertiary: options.fieldWeights?.tertiary ?? DEFAULT_FIELD_WEIGHTS.tertiary
    };
    this.minTokenScore = options.minTokenScore ?? DEFAULT_MIN_TOKEN_SCORE;
    const indexedFields: IndexedField[] = [];
    documents.forEach((document, documentIndex) => {
      (Object.keys(DEFAULT_FIELD_WEIGHTS) as SnooglFieldTier[]).forEach((tier) => {
        for (const rawText of document.fields[tier]) {
          const text = rawText.trim();
          if (text) indexedFields.push({ documentIndex, text, tier });
        }
      });
    });
    this.hasFields = indexedFields.length > 0;
    this.fuse = new Fuse(indexedFields, {
      keys: ['text'],
      includeScore: true,
      ignoreLocation: true,
      threshold: options.fuseThreshold ?? DEFAULT_FUSE_THRESHOLD,
      minMatchCharLength: 1,
      shouldSort: false
    });
  }

  public search(query: string): SnooglRankedResult<T>[] {
    const tokens = tokenizeSnooglQuery(query);
    if (tokens.length === 0) {
      return [...this.documents]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((document) => ({ value: document.value, score: 0, tokenScores: [] }));
    }
    if (!this.hasFields) return [];

    const scoresByDocument = this.documents.map(() => [] as number[]);
    for (const token of tokens) {
      // A dotted token is scored segment-wise against the matching tiers and
      // the parts are combined, so `Type.to` beats `Type.toFun` instead of
      // tying with every other `Type.*`.
      const probes = expandSnooglToken(token);
      if (probes.length === 0) continue;
      const probeScores = probes.map((probe) => {
        const needle = probe.text.toLowerCase();
        const best = new Array<number>(this.documents.length).fill(0);
        for (const result of this.fuse.search(probe.text) as FuseResult<IndexedField>[]) {
          if (!probe.tiers.includes(result.item.tier)) continue;
          const rawScore = result.score ?? 1;
          const weightedScore =
            Math.max(0, 1 - rawScore) * this.weights[result.item.tier] *
            exactnessFactor(needle, result.item.text);
          const index = result.item.documentIndex;
          if (weightedScore > best[index]) best[index] = weightedScore;
        }
        return best;
      });
      for (let documentIndex = 0; documentIndex < this.documents.length; documentIndex += 1) {
        // Every segment of a dotted token must land: geometric mean keeps a
        // strong tail from masking a missing namespace prefix.
        const parts = probeScores.map((scores) => scores[documentIndex]);
        const combined = parts.some((score) => score <= 0)
          ? 0
          : Math.exp(
              parts.reduce((sum, score) => sum + Math.log(score), 0) / parts.length
            );
        scoresByDocument[documentIndex].push(combined);
      }
    }

    const ranked: Array<SnooglRankedResult<T> & { id: string }> = [];
    this.documents.forEach((document, documentIndex) => {
      const tokenScores = scoresByDocument[documentIndex];
      if (
        tokenScores.length !== tokens.length ||
        tokenScores.some((score) => score < this.minTokenScore)
      ) return;
      const score = Math.exp(
        tokenScores.reduce((sum, tokenScore) => sum + Math.log(tokenScore), 0) /
        tokenScores.length
      );
      ranked.push({ id: document.id, value: document.value, score, tokenScores });
    });

    ranked.sort((left, right) =>
      right.score - left.score || left.id.localeCompare(right.id)
    );
    return ranked.map(({ id: _id, ...result }) => result);
  }
}

export interface SnooglSearchCandidate {
  id: string;
  labels: readonly string[];
  /**
   * Style names this Macro declares, in order — `styles[0]` is the implicit
   * default. Lets a Macro-ID surface offer `id[style]` in one place instead of
   * making the author remember the bracket syntax. Cat 2026-07-25.
   */
  styles?: readonly string[];
}

export function rankSnooglCandidates<T extends SnooglSearchCandidate>(
  query: string,
  candidates: readonly T[],
  options: SnooglSearchOptions = {}
): T[] {
  const byId = new Map<string, T>();
  for (const candidate of candidates) byId.set(candidate.id, candidate);
  const unique = Array.from(byId.values());
  return rankSnooglDocuments(
    query,
    unique.map((candidate) => createSnooglSearchDocument({
      id: candidate.id,
      value: candidate,
      labels: candidate.labels
    })),
    options
  ).map((result) => result.value);
}

export function createSnooglSearchDocument<T>({
  id,
  value,
  labels = []
}: {
  id: string;
  value: T;
  labels?: readonly string[];
}): SnooglSearchDocument<T> {
  const namespace = splitSnooglNamespace(id);
  return {
    id,
    value,
    fields: {
      primary: [namespace.tail],
      secondary: labels,
      tertiary: namespace.middle
    }
  };
}

export function splitSnooglNamespace(id: string): {
  tail: string;
  middle: string[];
} {
  const segments = id.split('.').map((segment) => segment.trim()).filter(Boolean);
  return {
    tail: segments.at(-1) ?? id,
    middle: segments.slice(0, -1)
  };
}
