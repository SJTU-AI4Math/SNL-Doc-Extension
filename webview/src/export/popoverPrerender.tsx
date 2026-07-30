// Pre-render popover bodies at export time.
//
// ── Why pre-render instead of shipping a renderer ────────────────────────────
//
// A popover body is a full Entry render: React + KaTeX + SNL macro expansion.
// Putting that machinery into the exported runtime would take it from ~7 kB to
// several hundred. But the webview ALREADY has all of it loaded, so the cheap
// move is to render each Entry here, harvest the resulting markup, and ship
// plain HTML fragments. The exported runtime then only has to position and
// show them — it stays pure DOM and dependency-free.
//
// ── Why we must wait, and for what ───────────────────────────────────────────
//
// EntrySurface resolves its SNL context asynchronously and KaTeX paints after
// that, so a synchronous render only ever yields SNL-Basics's
// `.snl-entry-loading` stub ("Resolving Entry context…"). We therefore mount
// into an off-screen but ATTACHED container (KaTeX measures layout, which a
// detached node cannot provide) and poll until the render settles.
//
// Settle signal, read off SNL-Basics's own markup rather than guessed:
//   - `.snl-entry-loading` is what it renders while the context query is in
//     flight (dist-lib/entry.js), so its ABSENCE is the primary signal;
//   - `[data-entry-body]` is only emitted once the surface has content, so its
//     PRESENCE confirms we captured a body and not an empty shell.
// An Entry legitimately without a body (`content_kind === 'none'`) never grows
// `[data-entry-body]`, so the absence of the loading stub alone is accepted
// after the body grace window — otherwise such Entries would always time out.
//
// A timeout is not fatal: we fall back to a title-only fragment. An export
// that shows a slightly poorer popover beats an export that fails.

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { KindPalette } from '@sjtu-ai4math/snl-basics';
import { HoverPopoverProvider } from '../render/HoverPopoverProvider';
import { EntrySurface, type EntryOption } from '../render/EntrySurface';
import type { MacroRecord } from '../render/macroData';
import { buildPopoverClosure, type ClosureResult } from './popoverClosure';
import type { EntryDetail } from './entryDetailBridge';

/** How long one Entry may take to settle before we ship the fallback. */
export const PRERENDER_TIMEOUT_MS = 4000;
/** Polling cadence while waiting for settle. */
const POLL_MS = 25;
/**
 * Extra grace after the loading stub disappears, before accepting a render
 * with no `[data-entry-body]`. One frame is not enough — React commits the
 * body in a follow-up effect — but a bodyless Entry must not burn the full
 * timeout either.
 */
const BODY_GRACE_MS = 250;

export type { EntryDetail };

export interface PrerenderDeps {
  /** Resolve one Entry's full record. `entry: null` ⇒ unknown id. */
  loadDetail: (entryId: string) => Promise<EntryDetail>;
  entries: EntryOption[];
  userMacros?: MacroRecord;
  kindPalette?: KindPalette;
  markdownImageUrlTransform?: (source: string) => string;
  /** Abort an obsolete export between Entry renders. */
  isCancelled?: () => boolean;
  /** Hard cap for a pathological reference graph. */
  maxEntries?: number;
  /** Overridable so tests do not have to wait seconds for the fallback. */
  timeoutMs?: number;
  /** Injected in tests; defaults to `document`. */
  doc?: Document;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Off-screen but attached host.
 *
 * `position:fixed; left:-10000px` rather than `display:none` on purpose:
 * a `display:none` subtree has no layout boxes, and KaTeX sizes delimiters by
 * measuring rendered glyphs, so it would produce visibly wrong markup.
 */
function createStage(doc: Document): HTMLElement {
  const stage = doc.createElement('div');
  stage.setAttribute('data-snl-export-stage', '');
  stage.setAttribute(
    'style',
    'position:fixed;left:-10000px;top:0;width:900px;visibility:hidden;pointer-events:none;'
  );
  doc.body.appendChild(stage);
  return stage;
}

function isSettled(host: HTMLElement, sinceStubGone: number | null): boolean {
  if (host.querySelector('.snl-entry-loading')) return false;
  // Nothing rendered at all yet — React has not committed.
  if (!host.firstElementChild) return false;
  if (host.querySelector('[data-entry-body]')) return true;
  return sinceStubGone !== null && Date.now() - sinceStubGone >= BODY_GRACE_MS;
}

/** Strip what makes no sense inside a static popover, mirroring the harvest. */
function harvestFragment(host: HTMLElement): string {
  const clone = host.cloneNode(true) as HTMLElement;
  for (const node of Array.from(
    clone.querySelectorAll('button,[role="button"],[data-export-strip]')
  )) {
    node.remove();
  }
  return clone.innerHTML;
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(text: string): string {
  return escapeText(text)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Degraded popover: still tells the reader what they pointed at. */
export function fallbackFragment(entryId: string, title: string | null): string {
  return (
    `<div class="snl-export-popover-fallback" data-entry-id="${escapeAttribute(entryId)}">` +
    `<strong>${escapeText(title ?? entryId)}</strong>` +
    `<div style="opacity:0.7;font-size:0.85em">${escapeText(entryId)}</div>` +
    '</div>'
  );
}

/**
 * Render every Entry reachable from `seedHtml`, transitively.
 *
 * The closure walk lives in `popoverClosure.ts`; this function supplies the
 * "render one Entry" step it drives.
 */
export async function prerenderPopovers(
  seedHtml: string,
  deps: PrerenderDeps
): Promise<ClosureResult> {
  const doc = deps.doc ?? document;
  const timeoutMs = deps.timeoutMs ?? PRERENDER_TIMEOUT_MS;
  const stage = createStage(doc);
  let root: Root | null = null;

  try {
    return await buildPopoverClosure(seedHtml, {
      isCancelled: deps.isCancelled,
      maxEntries: deps.maxEntries,
      renderEntry: async (entryId) => {
        const detail = await deps.loadDetail(entryId);
        if (!detail.entry) return null;

        const host = doc.createElement('div');
        stage.appendChild(host);
        root = createRoot(host);
        root.render(
          <HoverPopoverProvider
            postMessage={() => {
              /* A pre-render must never talk to the host. */
            }}
            entries={deps.entries}
            userMacros={deps.userMacros}
            kindPalette={deps.kindPalette}
            markdownImageUrlTransform={deps.markdownImageUrlTransform}
          >
            <EntrySurface
              entry={detail.entry}
              kind={detail.kind}
              entries={deps.entries}
              postMessage={() => {
                /* idem */
              }}
              disableTitleJump
            />
          </HoverPopoverProvider>
        );

        const deadline = Date.now() + timeoutMs;
        let stubGoneAt: number | null = null;
        let settled = false;
        while (Date.now() < deadline) {
          await sleep(POLL_MS);
          if (!host.querySelector('.snl-entry-loading') && stubGoneAt === null) {
            stubGoneAt = Date.now();
          }
          if (isSettled(host, stubGoneAt)) {
            settled = true;
            break;
          }
        }

        const html = settled
          ? harvestFragment(host)
          : fallbackFragment(entryId, detail.entry.title);

        root.unmount();
        root = null;
        host.remove();
        return html;
      }
    });
  } finally {
    if (root) (root as Root).unmount();
    stage.remove();
  }
}
