// Which Entries must travel with an exported document so its popovers work.
//
// A static file has no host to ask, so every popover a reader can possibly
// open has to be baked in. That set is the TRANSITIVE closure of `data-src`
// references starting from the harvested body: hovering a reference inside a
// popover opens another popover, and so on.
//
// The closure cannot be computed before rendering. "Which Entries does E
// reference" is only knowable from E's RENDERED markup — SNL macros expand to
// references that do not exist in the stored source. So discovery and
// rendering interleave: render one Entry, scan its output, enqueue whatever it
// revealed. This module owns the fixed-point loop and stays free of React; its
// HTML-aware scanner uses a detached template so escaped ids round-trip exactly
// and markup-shaped text is never mistaken for a real attribute.

/** Extract every `data-src` reference from a markup fragment. */
export function collectEntryRefs(html: string, doc: Document = document): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const template = doc.createElement('template');
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll<HTMLElement>('[data-src]')) {
    const id = (element.getAttribute('data-src') ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export interface ClosureOptions {
  /**
   * Render one Entry to a self-contained markup fragment, or return `null`
   * when the id resolves to nothing (unknown Entry). Rejections are treated
   * as "unrenderable" rather than fatal — one broken Entry must not sink the
   * whole export.
   */
  renderEntry: (entryId: string) => Promise<string | null>;
  /** Abort an obsolete export's closure walk between Entries. */
  isCancelled?: () => boolean;
  /** Safety valve against a pathological library; 0 means unlimited. */
  maxEntries?: number;
  /** HTML-aware reference reader; injectable for documents from another realm. */
  collectRefs?: (html: string) => string[];
}

export interface ClosureResult {
  /** entryId → pre-rendered popover markup. Only successful renders. */
  fragments: Record<string, string>;
  /** Ids that were referenced but produced nothing (unknown or failed). */
  missing: string[];
  /** True when {@link ClosureOptions.maxEntries} cut the walk short. */
  truncated: boolean;
}

/**
 * Walk the reference graph to a fixed point.
 *
 * Cycles (A→B→A) and self-references (A→A) terminate because an id is marked
 * visited BEFORE its render is awaited, so it can never be enqueued twice.
 */
export async function buildPopoverClosure(
  seedHtml: string,
  options: ClosureOptions
): Promise<ClosureResult> {
  const {
    renderEntry,
    maxEntries = 0,
    isCancelled = () => false,
    collectRefs = collectEntryRefs
  } = options;

  const fragments = Object.create(null) as Record<string, string>;
  const missing: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [];
  let truncated = false;
  let processed = 0;

  const enqueue = (ids: string[]): void => {
    for (const id of ids) {
      if (visited.has(id)) continue;
      visited.add(id);
      queue.push(id);
    }
  };

  enqueue(collectRefs(seedHtml));

  while (queue.length > 0) {
    if (isCancelled()) {
      truncated = true;
      break;
    }
    if (maxEntries > 0 && processed >= maxEntries) {
      truncated = true;
      break;
    }
    const entryId = queue.shift() as string;
    processed += 1;
    let html: string | null = null;
    try {
      html = await renderEntry(entryId);
    } catch {
      html = null;
    }
    if (html === null) {
      missing.push(entryId);
      continue;
    }
    fragments[entryId] = html;
    // The newly rendered markup is the ONLY place the next hop is visible.
    enqueue(collectRefs(html));
  }

  return { fragments, missing, truncated };
}
