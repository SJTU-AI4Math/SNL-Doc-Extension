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
      const bestForToken = new Array<number>(this.documents.length).fill(0);
      for (const result of this.fuse.search(token) as FuseResult<IndexedField>[]) {
        const rawScore = result.score ?? 1;
        const weightedScore =
          Math.max(0, 1 - rawScore) * this.weights[result.item.tier];
        const index = result.item.documentIndex;
        if (weightedScore > bestForToken[index]) bestForToken[index] = weightedScore;
      }
      bestForToken.forEach((score, documentIndex) => {
        scoresByDocument[documentIndex].push(score);
      });
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
