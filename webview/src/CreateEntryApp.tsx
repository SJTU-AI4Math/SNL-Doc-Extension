// SNL Create Entry webview: the Entry editor MVP.
//
// Layout (top → bottom):
//   1. Header    — Title + ID (UUID, regenerate)
//   2. Kind      — dropdown seeded from config.json#entry_kinds
//   3. Preview   — kind-aware live box (stroke + background + mock number)
//   4. Content   — SNL / Typst / LaTeX / Markdown / Text tabs (each its own
//                  textarea; SNL has a Text / GUI (Inductive) sub-switch)
//   5. Contributor — deferred placeholder
//   6. Pointer     — deferred placeholder
//   7. Submit/Cancel + result banner
//
// SNL rendering uses one merged MacroDataDriver: bundled macros overridden
// by every macro in every package in the current workspace, shipped via the
// `context` message from createEntryPanel. See 猫猫 2026-07-04 spec 2:
// "Entry 编辑器的 SNL parser 几乎等于没实装 ... 先把它做成能正常根据项目
// 中已有的 Macro 来进行 Parse 和渲染的模式."
//
// GUI Editor (Inductive) wraps @sjtu-ai4math/snl-basics's SnlSyntaxTreeEditor with
// a Add-child / Remove-node control layer, and syncs bidirectionally with
// the SNL text via parse/serialize round-trips. 猫猫 spec 3: "把 SNL-Basics
// 里的 Syntax Tree Editor 先给它搬过来，变成 GUI Editor (Inductive)".

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import 'katex/dist/katex.min.css';
import '@sjtu-ai4math/snl-basics/style.css';
import './entry-editor/canvas.css';
import {
  tryParseSnlSyntaxTree,
  createSnlSyntaxTreeNode,
  SnlSyntaxTreeView,
  DEFAULT_KIND_PALETTE,
  read_localized,
  resolve_style_template,
  type I18n,
  type Localized,
  type MacroDataDriver,
  type SnlMacro,
  type SnlSyntaxTree,
  type KindColoring,
  type KindPalette
} from '@sjtu-ai4math/snl-basics';
import {
  getVsCodeApi,
  PANEL_STYLE,
  type VsCodeApi
} from './vscodeApi';
import { traceFirstPaint, traceMark } from './runtime/trace';
import {
  EntryRelationshipsSection,
  type EntryRelationshipRow
} from './components/EntryRelationshipsSection';
import { PanelNav } from './components/PanelNav';
import { Button } from './components/Button';
import { MacroIdInput } from './components/MacroIdInput';
import { isEntityIdUnique } from './components/formValidation';
import { ensureTreeIdentity, inheritTreeIdentity, treeIdentity } from './components/treeIdentity';
import {
  EntityIdSearchBox,
  ENTRY_VALIDATE_RULES
} from './components/EntityIdSearchBox';
import {
  EntrySurface,
  type EntryOption,
  type EntryData,
  type EntryKind as RenderEntryKind
} from './render/EntrySurface';
import { HoverPopoverProvider } from './render/HoverPopoverProvider';
import { wireMacroToRenderable, type WireMacro } from './render/macroWire';
import {
  bundledMacros,
  createMacroDataDriver,
  type MacroRecord
} from './render/macroData';
import { mergeDraftIntoEntryPool } from './render/entryPreviewPool';
import { extensionRenderers } from './render/blockRenderers';
import {
  attachCanvasRoot,
  canPersistCanvasForest,
  createCanvasHole,
  deleteCanvasTarget,
  detachCanvasSubtree,
  isCanvasHole,
  moveCanvasCursor,
  reconcileCanvasArity,
  replaceCanvasTarget,
  setCanvasDynamicArity
} from './entry-editor/canvasForest';
import { loadDraft, saveDraft, usePersistedDraft, useSaveShortcut } from './components/draftState';
import { merge_localized_projection } from './runtime/localizedDraft';
import {
  use_preferences_revision,
  webview_language_runtime
} from './runtime/preferencesRuntime';
import {
  macroKindsToPalette,
  type MacroKindPaletteSource
} from './render/macroKindPalette';
import type { SnooglSearchCandidate } from '../../src/snooglSearch';

// ---------------------------------------------------------------------------
// Macro DB merge
// ---------------------------------------------------------------------------

/**
 * The on-disk v6 macro entry shape as shipped from the host (see snlDoc.ts
 * MacroPackageEntry). A superset of the library's render-only SnlMacro:
 * additionally carries the consumer-owned output backends per style.
 * We only mirror the fields the view layer needs.
 */
type WirePackageMacro = WireMacro;

// Preview now routes through <EntrySurface>, which owns its own source
// resolution against the entry pool. The bespoke PREVIEW_HOOKS constant
// (used by the old SnlSyntaxTreeView-based preview) is no longer needed.

interface EntryKind {
  id: string;
  name: string;
  coloring: { stroke: string; background: string };
  numbering: string;
  style: string;
}

type ContentFormat = 'snl' | 'typst' | 'latex' | 'markdown' | 'text';
type LocalizableContentFormat = Exclude<ContentFormat, 'snl'>;

const LOCALIZABLE_CONTENT_FORMATS: readonly LocalizableContentFormat[] = [
  'typst',
  'latex',
  'markdown',
  'text'
];

type Mode = 'create' | 'edit';

interface ExistingEntry {
  id: string;
  kind: string;
  title: string;
  content: {
    snl?: string;
    typst?: Localized<string, string>;
    latex?: Localized<string, string>;
    markdown?: Localized<string, string>;
    text?: Localized<string, string>;
  };
  contribution_info?: unknown;
  pointer?: unknown;
}

const FORMAT_TABS: { id: ContentFormat; label: string }[] = [
  { id: 'snl', label: 'SNL' },
  { id: 'typst', label: 'Typst' },
  { id: 'latex', label: 'LaTeX' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'text', label: 'Text' }
];

type Status =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; id: string }
  | { kind: 'updated'; id: string }
  | { kind: 'duplicate'; id: string; message: string }
  | { kind: 'notFound'; id: string; message: string }
  | { kind: 'unknownKind'; kindId: string; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'noSnlDoc'; message: string }
  | { kind: 'noWorkspace'; message: string }
  | { kind: 'error'; message: string };

function projectLocalizedContent(
  value: Localized<string, string> | undefined
): { text: string; i18n?: I18n<string, string> } {
  if (value === undefined) return { text: '' };
  if (typeof value === 'string') return { text: value };
  return {
    text: webview_language_runtime.run_reader(
      read_localized<string, string>(value)
    ),
    i18n: value
  };
}

function newUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback (should not happen in a modern webview host).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Number rendering: the real counter engine is deferred; EntryRender is
// fed `counterLabel={undefined}` so the header just shows "<KindName> --
// <title>" without a mock digit.

export function CreateEntryApp(): React.ReactElement {
  const preferencesRevision = use_preferences_revision();
  const languageRef = useRef(webview_language_runtime.query_environment().language);
  const [mode, setMode] = useState<Mode>('create');
  const [kinds, setKinds] = useState<EntryKind[]>([]);
  const [kindsLoaded, setKindsLoaded] = useState(false);

  /**
   * User-authored macros indexed by name (strict v7 wire shape from the host).
   * Merged over the bundled record via `macroDataDriver` below. Empty until the first
   * `context` message arrives — parse/render before that only sees the
   * bundled fixture.
   */
  const [wireMacros, setWireMacros] = useState<Record<string, WirePackageMacro>>({});
  const [kindPalette, setKindPalette] = useState<KindPalette | undefined>(undefined);
  // Name → owning package (bare filename) for the row-side "open Macro
  // editor" button in the GUI editor. Pushed by the host on `context`.
  const [macroOrigin, setMacroOrigin] = useState<Record<string, string>>({});

  // User-only DB (for EntryRender.userMacros, which merges over the core
  // internally via mergeMacroDb) AND merged DB (for the GUI editor which
  // wants a flat lookup).
  const userMacros: MacroRecord = useMemo(() => {
    const userDb: MacroRecord = {};
    for (const [name, m] of Object.entries(wireMacros)) {
      userDb[name] = wireMacroToRenderable(m);
    }
    return userDb;
  }, [wireMacros]);

  const macroDataDriver = useMemo(
    () => createMacroDataDriver(bundledMacros, userMacros),
    [userMacros]
  );
  const macroCandidates = useMemo(
    () => {
      const candidates = new Map<string, SnooglSearchCandidate>();
      const styleNames = (macro: { styles?: readonly { style_name: string }[] }): string[] =>
        (macro.styles ?? []).map((style) => style.style_name).filter(Boolean);
      for (const [name, macro] of Object.entries(bundledMacros)) {
        candidates.set(name, { id: name, labels: macro.tags ?? [], styles: styleNames(macro) });
      }
      for (const [name, macro] of Object.entries(wireMacros)) {
        candidates.set(name, { id: name, labels: macro.tags ?? [], styles: styleNames(macro) });
      }
      return Array.from(candidates.values()).sort((left, right) =>
        left.id.localeCompare(right.id)
      );
    },
    [wireMacros]
  );

  // (`macroQuery` used to be threaded into the SnlSyntaxTreeView-based
  // preview; the EntryRender path derives its own query internally so we
  // no longer need one at this layer.)

  const [title, setTitle] = useState('');
  const [id, setId] = useState<string>('');
  // Full shared pool (id+title) for dedupe validation in create mode
  // (`requireUnique`). In edit mode we still use it — the widget is
  // suppressed but the pool would enable future reference features
  // without another host roundtrip. Cat 2026-07-09.
  const [existingIds, setExistingIds] = useState<EntryOption[]>([]);
  const [selectedKind, setSelectedKind] = useState<string>('');

  const [activeFormat, setActiveFormat] = useState<ContentFormat>('snl');
  const [snlMode, setSnlMode] = useState<'text' | 'gui' | 'canvas'>('canvas');
  const [content, setContent] = useState<Record<ContentFormat, string>>({
    snl: '',
    typst: '',
    latex: '',
    markdown: '',
    text: ''
  });
  const [canvasForest, setCanvasForest] = useState<SnlSyntaxTree[]>(() => {
    const root = createSnlSyntaxTreeNode('_snl_stub');
    ensureTreeIdentity(root);
    return [root];
  });
  const canvasAuthoredSnlRef = useRef<string | null>(null);
  useEffect(() => {
    if (canvasAuthoredSnlRef.current === content.snl) {
      canvasAuthoredSnlRef.current = null;
      return;
    }
    canvasAuthoredSnlRef.current = null;
    const root = parseOrDefault(content.snl);
    ensureTreeIdentity(root);
    setCanvasForest([root]);
  }, [content.snl]);
  const [contentI18n, setContentI18n] = useState<
    Partial<Record<LocalizableContentFormat, I18n<string, string>>>
  >({});

  /** Rows for the Relationships section; replaced wholesale on every push. */
  const [relationships, setRelationships] = useState<EntryRelationshipRow[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const apiRef = useRef<VsCodeApi | undefined>(undefined);
  const formDirtyRef = useRef(false);
  /**
   * Mirror of `formDirtyRef` as real state.
   *
   * The ref alone cannot drive the draft-stashing effect: writing a ref does
   * not re-render, so an interaction that sets dirty without changing any
   * state would never persist. Review 2026-07-25.
   */
  const [formDirty, setFormDirty] = useState(false);
  const markFormDirty = React.useCallback((dirty: boolean): void => {
    formDirtyRef.current = dirty;
    setFormDirty(dirty);
  }, []);
  /**
   * Which entry id the restored draft belongs to, or null when nothing was
   * restored. Panels now run with `retainContextWhenHidden: true`, so merely
   * hiding the tab keeps React state alive; a window reload / VS Code restart
   * still destroys it, and the draft stashed in webview state is what
   * survives that. See components/draftState.ts.
   */
  const restoredDraftIdRef = useRef<string | null>(null);
  const contentDirtyRef = useRef<Set<LocalizableContentFormat>>(new Set());
  const editingIdRef = useRef('');
  /**
   * Id of an entry this panel just created, until the host's follow-up
   * `edit` context has been absorbed. Cat 2026-07-27: after a create the
   * panel flips itself into Edit mode in place, and the context that lands
   * a moment later must NOT re-fill the form from the host's copy — see the
   * `preserveDraft` computation in the `context` handler.
   */
  const justCreatedIdRef = useRef<string | null>(null);
  const existingMetadataRef = useRef<{
    contribution_info: unknown;
    pointer: unknown;
  }>({ contribution_info: null, pointer: null });

  useEffect(() => {
    const nextLanguage = webview_language_runtime.query_environment().language;
    const previousLanguage = languageRef.current;
    if (nextLanguage === previousLanguage) return;
    const nextMaps = { ...contentI18n };
    const nextContent = { ...content };
    for (const format of ['typst', 'latex', 'markdown', 'text'] as const) {
      const original = contentI18n[format];
      if (!original) continue;
      const updated = merge_localized_projection(
        original,
        content[format],
        previousLanguage,
        contentDirtyRef.current.has(format)
      );
      nextMaps[format] = updated;
      nextContent[format] = webview_language_runtime.run_reader(
        read_localized<string, string>(updated)
      );
    }
    setContentI18n(nextMaps);
    setContent(nextContent);
    contentDirtyRef.current.clear();
    languageRef.current = nextLanguage;
  }, [preferencesRevision]);

  // Report the first painted frame exactly once, so the timeline ends at
  // "the author can actually see the panel".
  const paintReportedRef = useRef(false);
  useEffect(() => {
    if (!paintReportedRef.current) {
      paintReportedRef.current = true;
      traceMark('app-mounted');
      traceFirstPaint();
    }
  }, []);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | { type: 'kinds'; kinds: EntryKind[] }
        | { type: 'retarget'; mode: Mode; id?: string }
        | {
            type: 'context';
            mode: Mode;
            id?: string;
            seedId?: string;
            kinds: EntryKind[];
            macros?: Record<string, WirePackageMacro>;
            macroKinds?: MacroKindPaletteSource[];
            macroOrigin?: Record<string, string>;
            existing?: ExistingEntry | null;
            existingIds?: EntryOption[];
            relationships?: EntryRelationshipRow[];
          }
        | { type: 'created'; id: string }
        | { type: 'updated'; id: string }
        | { type: 'duplicate'; id: string; message: string }
        | { type: 'notFound'; id: string; message: string }
        | { type: 'unknownKind'; kind: string; message: string }
        | { type: 'invalid'; reason: string }
        | { type: 'noSnlDoc'; message: string }
        | { type: 'noWorkspace'; message: string }
        | { type: 'error'; message: string }
        | undefined;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'kinds':
          setKinds(Array.isArray(msg.kinds) ? msg.kinds : []);
          setKindsLoaded(true);
          setSelectedKind((prev) => {
            if (prev) return prev;
            return msg.kinds && msg.kinds.length > 0 ? msg.kinds[0].id : '';
          });
          break;
        case 'retarget': {
          // One panel serves every entry now (cat 2026-07-25). Clear the
          // form before the new entry's context lands so the previous
          // entry's text is never shown against the new id, and drop the
          // dirty/draft bookkeeping that belonged to the old target.
          restoredDraftIdRef.current = null;
          editingIdRef.current = '';
          contentDirtyRef.current.clear();
          markFormDirty(false);
          setStatus({ kind: 'idle' });
          setTitle('');
          setSelectedKind('');
          setContentI18n({});
          setRelationships([]);
          setContent({ snl: '', typst: '', latex: '', markdown: '', text: '' });
          setId(typeof msg.id === 'string' ? msg.id : '');
          if (msg.mode === 'create' || msg.mode === 'edit') setMode(msg.mode);
          break;
        }
        case 'context':
          // The payload has arrived and is about to be applied to state.
          traceMark('context-received');
          setRelationships(
            Array.isArray(msg.relationships) ? msg.relationships : []
          );
          setMode(msg.mode);
          setKinds(Array.isArray(msg.kinds) ? msg.kinds : []);
          setKindsLoaded(true);
          setWireMacros(
            msg.macros && typeof msg.macros === 'object' ? msg.macros : {},
          );
          setKindPalette(macroKindsToPalette(msg.macroKinds));
          setMacroOrigin(
            msg.macroOrigin && typeof msg.macroOrigin === 'object'
              ? msg.macroOrigin
              : {},
          );
          setExistingIds(Array.isArray(msg.existingIds) ? msg.existingIds : []);
          if (msg.mode === 'edit') {
            const incomingId = msg.id ?? msg.existing?.id ?? '';
            // Cat 2026-07-27: the context that immediately follows our own
            // successful create. What is on screen IS what was just written,
            // and it carries state the host's copy cannot reproduce (Canvas
            // node identity / multi-root forests are not recoverable from
            // `content.snl`). Always preserve, never re-fill.
            const justCreated = justCreatedIdRef.current === incomingId;
            const preserveDraft = justCreated ||
              (!!msg.existing &&
              formDirtyRef.current &&
              editingIdRef.current === incomingId) ||
              // A restored draft is unsaved work that outlived the panel
              // being hidden; the host's copy is by definition older.
              (restoredDraftIdRef.current !== null &&
                restoredDraftIdRef.current === incomingId);
            if (msg.id) {
              setId(msg.id);
            }
            if (msg.existing) {
              // Metadata the panel does not edit but DOES write back on
              // Update. It must be absorbed even when a draft wins, or
              // saving from a restored draft silently nulls out
              // contribution_info/pointer and drops every non-current
              // language, because updateEntry overwrites the whole record.
              // Review 2026-07-25.
              existingMetadataRef.current = {
                contribution_info: msg.existing.contribution_info ?? null,
                pointer: msg.existing.pointer ?? null
              };
              const typst = projectLocalizedContent(msg.existing.content?.typst);
              const latex = projectLocalizedContent(msg.existing.content?.latex);
              const markdown = projectLocalizedContent(msg.existing.content?.markdown);
              const text = projectLocalizedContent(msg.existing.content?.text);
              setContentI18n({
                ...(typst.i18n ? { typst: typst.i18n } : {}),
                ...(latex.i18n ? { latex: latex.i18n } : {}),
                ...(markdown.i18n ? { markdown: markdown.i18n } : {}),
                ...(text.i18n ? { text: text.i18n } : {})
              });
              if (!preserveDraft) {
                editingIdRef.current = incomingId;
                setTitle(msg.existing.title || '');
                setSelectedKind(msg.existing.kind || '');
                setContent({
                  snl: msg.existing.content?.snl ?? '',
                  typst: typst.text,
                  latex: latex.text,
                  markdown: markdown.text,
                  text: text.text
                });
                contentDirtyRef.current.clear();
                markFormDirty(false);
              } else if (restoredDraftIdRef.current === incomingId) {
                // ONLY on the restored-draft path: the stash carries no
                // record of which formats were edited, so treating them all
                // as edited is the lesser evil — otherwise `persist` merges
                // the draft text into the host's i18n as if untouched and
                // the author's work is dropped.
                //
                // The other `preserveDraft` source (a live dirty form being
                // re-pushed by the file watcher) must NOT come here: its
                // `contentDirtyRef` is accurate, and widening it would
                // freeze every untouched format's language fallback into an
                // explicit translation. Review 2026-07-25.
                editingIdRef.current = incomingId;
                for (const format of LOCALIZABLE_CONTENT_FORMATS) {
                  contentDirtyRef.current.add(format);
                }
              } else {
                editingIdRef.current = incomingId;
              }
            }
            // One-shot: consumed by the single context push that follows the
            // create. Later pushes (file watcher, retarget) must go through
            // the normal dirty-form rules.
            if (justCreated) justCreatedIdRef.current = null;
          } else {
            // Cat 2026-07-15: seed the id field with the caller-provided
            // hint (e.g. the id the user typed into the Library outline's
            // Add form that didn't resolve). Only overwrite an empty
            // field — a user who already started typing in this panel
            // shouldn't have their input clobbered by a late re-push.
            if (typeof msg.seedId === 'string' && msg.seedId) {
              setId((prev) => (prev ? prev : msg.seedId!));
            }
            setSelectedKind((prev) => {
              if (prev) return prev;
              return msg.kinds && msg.kinds.length > 0 ? msg.kinds[0].id : '';
            });
          }
          break;
        case 'created': {
          // Cat 2026-07-27: the host now flips this panel into Edit mode for
          // the entry we just created and re-pushes context. Record the id so
          // the follow-up `edit` context is recognised as the SAME target and
          // preserves what is already on screen instead of re-filling it.
          const createdId = typeof msg.id === 'string' ? msg.id : '';
          editingIdRef.current = createdId;
          justCreatedIdRef.current = createdId;
          // The form was just persisted, so it is by definition no longer
          // dirty (mirrors `updated` below). This also makes
          // `justCreatedIdRef` the SOLE reason the follow-up context
          // preserves the form rather than one of two redundant guards —
          // without it a mutation to the flip logic would be masked by the
          // ordinary dirty-form rule and no test could see the difference.
          markFormDirty(false);
          // `draftKey` embeds `mode`, so the flip switches to
          // `createEntry:edit:<id>`. A stale stash left there by an earlier
          // session for the same id would be restored on top of the content
          // that was just written. Drop it before the key changes.
          saveDraft(getVsCodeApi(), `createEntry:edit:${createdId}`, undefined);
          setStatus({ kind: 'created', id: msg.id });
          break;
        }
        case 'updated':
          markFormDirty(false);
          contentDirtyRef.current.clear();
          setStatus({ kind: 'updated', id: msg.id });
          break;
        case 'duplicate':
          setStatus({ kind: 'duplicate', id: msg.id, message: msg.message });
          break;
        case 'notFound':
          setStatus({ kind: 'notFound', id: msg.id, message: msg.message });
          break;
        case 'unknownKind':
          setStatus({
            kind: 'unknownKind',
            kindId: msg.kind,
            message: msg.message
          });
          break;
        case 'invalid':
          setStatus({ kind: 'invalid', message: msg.reason });
          break;
        case 'noSnlDoc':
          setStatus({ kind: 'noSnlDoc', message: msg.message });
          break;
        case 'noWorkspace':
          setStatus({ kind: 'noWorkspace', message: msg.message });
          break;
        case 'error':
          setStatus({ kind: 'error', message: msg.message });
          break;
        default:
          break;
      }
    }

    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const kind = useMemo(
    () => kinds.find((k) => k.id === selectedKind),
    [kinds, selectedKind]
  );

  const trimmedTitle = title.trim();
  const trimmedId = id.trim();
  const canCreate =
    kinds.length > 0 &&
    trimmedTitle.length > 0 &&
    trimmedId.length > 0 &&
    isEntityIdUnique(trimmedId, existingIds, mode === 'edit' ? trimmedId : undefined) &&
    selectedKind.length > 0 &&
    canPersistCanvasForest(canvasForest) &&
    status.kind !== 'creating';

  function handleSubmit(): void {
    if (!canCreate) {
      return;
    }
    setStatus({ kind: 'creating' });
    const persist = (
      format: LocalizableContentFormat
    ): Localized<string, string> | undefined => {
      const value = content[format];
      const original = contentI18n[format];
      if (!original) return value || undefined;
      if (!contentDirtyRef.current.has(format)) return original;
      return merge_localized_projection(
        original,
        value,
        webview_language_runtime.query_environment().language,
        true
      );
    };
    const persistedContent = {
      typst: persist('typst'),
      latex: persist('latex'),
      markdown: persist('markdown'),
      text: persist('text')
    };
    setContentI18n((previous) => {
      const next = { ...previous };
      for (const format of ['typst', 'latex', 'markdown', 'text'] as const) {
        const value = persistedContent[format];
        if (value && typeof value === 'object') next[format] = value;
      }
      return next;
    });
    const entry = {
      id: trimmedId,
      kind: selectedKind,
      title: trimmedTitle,
      content: {
        snl: content.snl || undefined,
        ...persistedContent
      },
      contribution_info:
        mode === 'edit' ? existingMetadataRef.current.contribution_info : null,
      pointer: mode === 'edit' ? existingMetadataRef.current.pointer : null
    };
    apiRef.current?.postMessage({
      type: mode === 'edit' ? 'update' : 'create',
      entry
    });
  }

  // Restore unsaved work stashed before the panel was hidden, and keep the
  // stash current while the form is dirty. Runs before the host's `init`
  // arrives, so `preserveDraft` can see it.
  //
  // Namespaced per entry: since 2026-07-25 ONE panel serves every entry
  // (retargeted instead of recreated, to skip the ~1.09s webview stand-up),
  // so a single shared key would restore entry A's unsaved text over entry
  // B the moment you navigated between them.
  const draftKey = `createEntry:${mode}:${mode === 'edit' ? id : ''}`;
  // Resolved eagerly rather than read off `apiRef`: a ref written in an effect
  // is still undefined during the first render, and writing it never triggers
  // one, so the persist hook would keep the stale undefined forever.
  // `getVsCodeApi` caches internally, so this is the same object as apiRef.
  const draftApi = getVsCodeApi();
  // Re-runs when the panel is retargeted at a different entry, so the new
  // entry gets ITS stash rather than keeping the previous one's.
  useEffect(() => {
    const restored = loadDraft<{
      id: string;
      title: string;
      selectedKind: string;
      content: Record<ContentFormat, string>;
      activeFormat: ContentFormat;
      snlMode: 'text' | 'gui' | 'canvas';
      canvasForest?: SnlSyntaxTree[];
    }>(draftApi, draftKey);
    if (!restored) return;
    restoredDraftIdRef.current = restored.id;
    markFormDirty(true);
    // The stash records no per-format edit history, so treat every format it
    // carries as edited. Without this `persist` returns the host's original
    // i18n unchanged and the author's restored text is silently dropped.
    // This lives here (not only in the `init` handler) because the draft key
    // depends on mode+id, so a restore can land AFTER init — which is the
    // normal order now that one panel is retargeted between entries.
    for (const format of LOCALIZABLE_CONTENT_FORMATS) {
      contentDirtyRef.current.add(format);
    }
    setId(restored.id);
    setTitle(restored.title);
    setSelectedKind(restored.selectedKind);
    setContent(restored.content);
    setActiveFormat(restored.activeFormat);
    setSnlMode(restored.snlMode);
    // The Canvas forest is NOT recoverable from `content.snl`: a multi-root
    // or half-finished forest has no serialized form at all, and node
    // identity (which drives block positions) is lost either way. Restore it
    // directly, and suppress the reparse that `content.snl` would otherwise
    // trigger. Review 2026-07-25.
    if (restored.canvasForest && restored.canvasForest.length > 0) {
      canvasAuthoredSnlRef.current = restored.content.snl;
      for (const root of restored.canvasForest) ensureTreeIdentity(root);
      setCanvasForest(restored.canvasForest);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  usePersistedDraft(
    draftApi,
    draftKey,
    { id, title, selectedKind, content, activeFormat, snlMode, canvasForest },
    formDirty && status.kind !== 'created' && status.kind !== 'updated'
  );

  // A completed save makes the stash obsolete — keeping it would resurrect
  // old text the next time the panel opens.
  useEffect(() => {
    if (status.kind === 'created' || status.kind === 'updated') {
      restoredDraftIdRef.current = null;
      saveDraft(draftApi, draftKey, undefined);
    }
  }, [status.kind]);

  useSaveShortcut(handleSubmit, canCreate, () => {
    // A save already in flight is not a refusal: reporting one here would
    // overwrite the `creating` status, which is the very latch that keeps
    // `canCreate` false — clearing it would let the next Ctrl+S submit the
    // same entry a second time. Review 2026-07-25.
    if (status.kind === 'creating') return;
    // Never leave the key looking dead: say why the save was refused.
    setStatus({ kind: 'invalid', message: saveBlockingReason() });
  });

  /** The most specific reason the save button is currently disabled. */
  function saveBlockingReason(): string {
    if (kinds.length === 0) return 'Cannot save yet — no Entry kinds are defined.';
    if (!trimmedTitle) return 'Cannot save yet — the title is empty.';
    if (!trimmedId) return 'Cannot save yet — the id is empty.';
    if (!isEntityIdUnique(trimmedId, existingIds, mode === 'edit' ? trimmedId : undefined)) {
      return `Cannot save yet — the id "${trimmedId}" is already taken.`;
    }
    if (!selectedKind) return 'Cannot save yet — pick a kind first.';
    return canvasBlockingReason() ?? 'Cannot save yet.';
  }

  /** Why the Canvas is blocking a save, if it is. */
  function canvasBlockingReason(): string | null {
    if (canPersistCanvasForest(canvasForest)) return null;
    return canvasForest.length > 1
      ? 'Cannot save yet — the Canvas has several loose blocks. Attach them first.'
      : 'Cannot save yet — a Macro has a single unfilled slot, which cannot be written to SNL.';
  }

  function handleCancel(): void {
    if (mode === 'edit') {
      // Cancel in edit mode is a no-op reset that's rarely useful; just clear
      // the status banner so the user can keep editing. The draft stays —
      // the author did not ask to throw their edits away.
      setStatus({ kind: 'idle' });
      return;
    }
    restoredDraftIdRef.current = null;
    saveDraft(draftApi, draftKey, undefined);
    setTitle('');
    setId('');
    setContent({ snl: '', typst: '', latex: '', markdown: '', text: '' });
    setContentI18n({});
    contentDirtyRef.current.clear();
    markFormDirty(false);
    setActiveFormat('snl');
    setSnlMode('text');
    setStatus({ kind: 'idle' });
    setSelectedKind(kinds.length > 0 ? kinds[0].id : '');
  }

  const noKinds = kindsLoaded && kinds.length === 0;

  return (
    <main
      style={PANEL_STYLE}
      onInputCapture={() => { markFormDirty(true); }}
      onClickCapture={() => { markFormDirty(true); }}
    >
      {/* cat 2026-07-09: top nav — back to Dashboard; in edit mode also
          jump to this entry's per-entry Infoview. */}
      <PanelNav
        vsApi={apiRef.current}
        back={{
          label: 'Dashboard',
          title: 'Back to Dashboard',
          message: { type: 'nav.openDashboard' }
        }}
        viewInInfoview={
          mode === 'edit' && id
            ? {
                label: 'View in Infoview',
                title: `Open entry "${id}" in the Infoview reading surface`,
                message: { type: 'nav.openInfoview', entryId: id }
              }
            : undefined
        }
      />
      <h1 style={{ margin: '0 0 0.75rem', fontSize: '1.35rem' }}>
        {mode === 'edit' ? 'Edit Entry' : 'Create Entry'}
      </h1>

      {noKinds ? (
        <div
          style={{
            padding: '0.75rem 1rem',
            marginBottom: '1rem',
            border:
              '1px solid var(--vscode-editorWarning-foreground, #cca700)',
            borderRadius: '3px',
            color: 'var(--vscode-editorWarning-foreground, #cca700)'
          }}
        >
          No entry kinds defined — run <strong>Initialize Entry Kinds</strong>{' '}
          first. The form is disabled until at least one kind exists.
        </div>
      ) : null}

      <fieldset
        disabled={noKinds}
        style={{
          border: 'none',
          margin: 0,
          padding: 0,
          opacity: noKinds ? 0.5 : 1
        }}
      >
        {/* 1. Header row: Title + ID ==================================== */}
        <div
          style={{
            display: 'flex',
            gap: '1rem',
            marginBottom: '1rem',
            flexWrap: 'wrap'
          }}
        >
          <div style={{ flex: '2 1 16rem' }}>
            <Label htmlFor="snl-entry-title">Title</Label>
            <input
              id="snl-entry-title"
              type="text"
              value={title}
              placeholder="e.g. Pythagorean Theorem"
              onChange={(e) => setTitle(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ flex: '3 1 20rem' }}>
            <Label htmlFor="snl-entry-id">
              {mode === 'edit' ? 'ID (readonly)' : 'ID'}
            </Label>
            {mode === 'edit' ? (
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <input
                  id="snl-entry-id"
                  type="text"
                  value={id}
                  placeholder="e.g. pythagorean-theorem"
                  onChange={(e) => setId(e.target.value)}
                  readOnly
                  title="IDs are immutable; delete + recreate to rename"
                  style={{
                    ...inputStyle,
                    ...monoStyle,
                    marginBottom: 0,
                    color: 'var(--vscode-descriptionForeground, #999)',
                    opacity: 0.7,
                    cursor: 'not-allowed'
                  }}
                />
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-start' }}>
                {/* create mode: EntityIdSearchBox with requireUnique so
                    typing a colliding id gets a red border + inline
                    "already exists" message. The picker still shows
                    autocomplete of existing ids — useful for "I want to
                    reference-like a similar id" pattern recognition —
                    but the message + border-color make it obvious the
                    duplicate would fail. Cat 2026-07-09. */}
                <div style={{ flex: 1 }}>
                  <EntityIdSearchBox
                    entries={existingIds}
                    value={id}
                    validate={ENTRY_VALIDATE_RULES.requireUnique}
                    hideResolvedChip
                    idPrefix="snl-entry-id"
                    placeholder="e.g. pythagorean-theorem"
                    onChange={setId}
                    inputStyle={{ ...monoStyle, marginBottom: 0 }}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => setId(newUuid())}
                  title={
                    trimmedId
                      ? 'Overwrite the ID with a fresh UUID v4 (tolerated but not preferred — semantic ids are strongly preferred)'
                      : 'Fill the ID with a fresh UUID v4 (only when no meaningful semantic id fits)'
                  }
                  style={{ whiteSpace: 'nowrap', opacity: 0.75 }}
                >
                  {trimmedId ? 'Regenerate UUID' : 'Use UUID instead'}
                </Button>
              </div>
            )}
            <p
              style={{
                margin: '0.35rem 0 0',
                fontSize: '0.8rem',
                opacity: 0.75,
                lineHeight: 1.4
              }}
            >
              {mode === 'edit'
                ? 'IDs are stable references used by relationship links; they cannot be edited here.'
                : "Prefer a semantic id like " +
                  "'pythagorean-theorem' or 'context-linalg-vars' — human-readable ids " +
                  "render better in cross-entry references (macro sources, library graph nodes, bvar `x@<id>` context refs). " +
                  "The UUID button is a fallback for when no meaningful name fits. IDs are immutable once created."}
            </p>
          </div>
        </div>

        {/* 2. Kind dropdown ============================================ */}
        <div style={{ marginBottom: '1rem' }}>
          <Label htmlFor="snl-entry-kind">Kind</Label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <select
              id="snl-entry-kind"
              value={selectedKind}
              onChange={(e) => setSelectedKind(e.target.value)}
              style={{ ...inputStyle, marginBottom: 0, flex: '1 1 auto' }}
            >
              {kinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} ({k.id})
                </option>
              ))}
            </select>
            {kind ? (
              <span
                title={`stroke ${kind.coloring.stroke} / background ${kind.coloring.background}`}
                style={{
                  display: 'inline-block',
                  width: '2.5rem',
                  height: '1.4rem',
                  borderRadius: '3px',
                  background: kind.coloring.background,
                  border: `2px solid ${kind.coloring.stroke}`,
                  flex: '0 0 auto'
                }}
              />
            ) : null}
          </div>
        </div>

        {/* 3. Live preview ============================================= */}
        <div style={{ marginBottom: '1rem' }}>
          <Label>Live Preview</Label>
          <LivePreview
            kind={kind}
            entryId={trimmedId || '(new-entry)'}
            title={trimmedTitle}
            content={content}
            entries={existingIds}
            userMacros={userMacros}
            kindPalette={kindPalette}
            postMessage={(message) => apiRef.current?.postMessage(message)}
          />
        </div>

        {/* 4. Content tabs ============================================= */}
        <div style={{ marginBottom: '1rem' }}>
          <Label>Content</Label>
          <div
            style={{
              display: 'flex',
              gap: '0.25rem',
              marginBottom: '0.5rem',
              flexWrap: 'wrap'
            }}
          >
            {FORMAT_TABS.map((tab) => (
              <TabButton
                key={tab.id}
                active={activeFormat === tab.id}
                onClick={() => setActiveFormat(tab.id)}
              >
                {tab.label}
              </TabButton>
            ))}
          </div>

          {activeFormat === 'snl' ? (
            <div
              style={{
                display: 'flex',
                gap: '0.25rem',
                marginBottom: '0.5rem'
              }}
            >
              <SubTabButton
                active={snlMode === 'canvas'}
                onClick={() => setSnlMode('canvas')}
              >
                GUI Editor (Canvas)
              </SubTabButton>
              <SubTabButton
                active={snlMode === 'gui'}
                onClick={() => setSnlMode('gui')}
              >
                GUI Editor (Inductive)
              </SubTabButton>
              <SubTabButton
                active={snlMode === 'text'}
                onClick={() => setSnlMode('text')}
              >
                Text Editor
              </SubTabButton>
            </div>
          ) : null}

          {activeFormat === 'snl' && snlMode === 'gui' ? (
            <GuiInductiveEditor
              snl={content.snl}
              macroDataDriver={macroDataDriver}
              macroCandidates={macroCandidates}
              macroOrigin={macroOrigin}
              onOpenMacroEditor={(payload) =>
                apiRef.current?.postMessage({
                  type: 'openMacroEditor',
                  ...payload
                })
              }
              onChange={(next) => {
                markFormDirty(true);
                setContent((prev) => ({ ...prev, snl: next }));
              }}
            />
          ) : activeFormat === 'snl' && snlMode === 'canvas' ? (
            <GuiCanvasEditor
              forest={canvasForest}
              macroDataDriver={macroDataDriver}
              macroCandidates={macroCandidates}
              macroOrigin={macroOrigin}
              onOpenMacroEditor={(payload) =>
                apiRef.current?.postMessage({
                  type: 'openMacroEditor',
                  ...payload
                })
              }
              kindPalette={kindPalette}
              onForestChange={(nextForest) => {
                setCanvasForest(nextForest);
                if (canPersistCanvasForest(nextForest)) {
                  const nextSnl = serializeTreePreserving(nextForest[0]);
                  markFormDirty(true);
                  setContent((previous) => {
                    if (previous.snl === nextSnl) return previous;
                    canvasAuthoredSnlRef.current = nextSnl;
                    return { ...previous, snl: nextSnl };
                  });
                }
              }}
              onResetFromSnl={() => {
                const root = parseOrDefault(content.snl);
                ensureTreeIdentity(root);
                setCanvasForest([root]);
              }}
            />
          ) : (
            <>
              <textarea
                value={content[activeFormat]}
                onChange={(e) => {
                  markFormDirty(true);
                  if (activeFormat !== 'snl') {
                    contentDirtyRef.current.add(activeFormat);
                  }
                  setContent((prev) => ({
                    ...prev,
                    [activeFormat]: e.target.value
                  }));
                }}
                rows={8}
                placeholder={`${activeFormat.toUpperCase()} source…`}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '0.5rem 0.6rem',
                  color: 'var(--vscode-input-foreground, #ddd)',
                  background: 'var(--vscode-input-background, #2a2a2a)',
                  border:
                    '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
                  borderRadius: '2px',
                  fontFamily:
                    'var(--vscode-editor-font-family, monospace)',
                  fontSize: '0.9rem',
                  resize: 'vertical'
                }}
              />
              <p
                style={{
                  margin: '0.25rem 0 0',
                  fontSize: '0.8rem',
                  opacity: 0.6,
                  fontStyle: 'italic'
                }}
              >
                Monaco editor integration planned; for now a plain textarea.
              </p>
            </>
          )}
        </div>

        {/* 5. Relationships ============================================ */}
        {mode === 'edit' ? (
          <EntryRelationshipsSection
            relationships={relationships}
            onOpenEntry={(entryId) =>
              // Reuse the existing nav contract rather than inventing a
              // message the host does not handle: `nav.openInfoview` with an
              // entryId opens that entry's reading view.
              apiRef.current?.postMessage({
                type: 'nav.openInfoview',
                entryId
              })
            }
          />
        ) : null}

        {/* 6. Contributor ============================================= */}
        <div style={{ marginBottom: '1rem' }}>
          <Label>Contributor</Label>
          <PlaceholderBox text="Not implemented yet — deferred until the contribution_info schema is defined." />
        </div>

        {/* 6. Pointer ================================================= */}
        <div style={{ marginBottom: '1rem' }}>
          <Label>Pointer</Label>
          <PlaceholderBox text="Not implemented yet — deferred until the pointer (code-binding) schema is defined." />
        </div>

        {/* 7. Submit / Cancel ========================================= */}
        {!canPersistCanvasForest(canvasForest) ? (
          <p
            role="alert"
            style={{
              margin: '0 0 0.65rem',
              color: 'var(--vscode-editorWarning-foreground, #cca700)',
              fontWeight: 600
            }}
          >
            {canvasForest.length > 1
              ? 'Save is disabled while the Canvas syntax forest has multiple roots. Attach the loose blocks or reset the Canvas.'
              : 'Save is disabled because a Macro has a single unfilled slot, which cannot be written to SNL — an empty slot needs a comma, so give that Macro another argument or fill the slot.'}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!canCreate}
          >
            {status.kind === 'creating'
              ? mode === 'edit' ? 'Updating\u2026' : 'Creating\u2026'
              : mode === 'edit' ? 'Update Entry' : 'Create Entry'}
          </Button>
          <Button
            variant="secondary"
            onClick={handleCancel}
          >
            {mode === 'edit' ? 'Reset banner' : 'Cancel'}
          </Button>
        </div>

        <StatusLine status={status} />
      </fieldset>
    </main>
  );
}

/**
 * Live preview for the Entry editor. Routes through the SAME `<EntrySurface>`
 * that the Infoview / hover popovers use, so the WYSIWYG surface exactly
 * matches what a reader will see. Body-surface dispatch (snl > markdown >
 * latex > text) is owned by EntryRender itself — we just feed the full
 * `content` bag.
 *
 * Wrapped in a local `<HoverPopoverProvider>` because EntryRender's hooks
 * consume its context. `postMessage` is a no-op inside the preview —
 * clicking an in-body reference shouldn't navigate away from the editor,
 * and pointer resolution ("↗ source" button) only fires against a saved
 * entry, which draft edits don't have.
 */
function LivePreview({
  kind,
  entryId,
  title,
  content,
  entries,
  userMacros,
  kindPalette,
  postMessage
}: {
  kind: EntryKind | undefined;
  entryId: string;
  title: string;
  content: Record<ContentFormat, string>;
  entries: EntryOption[];
  userMacros: MacroRecord;
  kindPalette: KindPalette | undefined;
  postMessage: (message: unknown) => void;
}): React.ReactElement {
  const entry: EntryData = useMemo(
    () => ({
      id: entryId,
      kind: kind?.id ?? '',
      title,
      content: {
        snl: content.snl,
        typst: content.typst,
        latex: content.latex,
        markdown: content.markdown,
        text: content.text
      },
      contribution_info: null,
      pointer: null
    }),
    [entryId, kind?.id, title, content]
  );

  // Adapt local EntryKind shape to EntryRender's (identical fields today
  // but kept type-distinct so a future divergence is caught at the border).
  const renderKind: RenderEntryKind | null = kind
    ? {
        id: kind.id,
        name: kind.name,
        coloring: kind.coloring,
        numbering: kind.numbering,
        style: kind.style
      }
    : null;

  const previewEntries = useMemo(
    () => mergeDraftIntoEntryPool(entries, {
      id: entryId,
      title,
      snl: content.snl
    }),
    [entries, entryId, title, content.snl]
  );
  const localDetails = useMemo(
    () => ({ [entryId]: { entry, kind: renderKind } }),
    [entryId, entry, renderKind]
  );

  return (
    <HoverPopoverProvider
      postMessage={postMessage}
      entries={previewEntries}
      userMacros={userMacros}
      kindPalette={kindPalette}
      localDetails={localDetails}
    >
      <div className="snl-entry-live-preview">
        <EntrySurface
          entry={entry}
          kind={renderKind}
          entries={previewEntries}
          postMessage={postMessage}
          userMacros={userMacros}
          kindPalette={kindPalette}
          counterLabel={undefined}
          disableTitleJump={true}
        />
      </div>
    </HoverPopoverProvider>
  );
}


function Label({
  htmlFor,
  children
}: {
  htmlFor?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: 'block',
        marginBottom: '0.35rem',
        fontWeight: 600,
        fontSize: '0.95rem'
      }}
    >
      {children}
    </label>
  );
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Button
      type="button"
      onClick={onClick}
      style={{
        padding: '0.35rem 0.8rem',
        border:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        borderBottom: active
          ? '2px solid var(--vscode-focusBorder, #0e639c)'
          : '1px solid var(--vscode-panel-border, #444)',
        background: active
          ? 'var(--vscode-tab-activeBackground, #1e1e1e)'
          : 'var(--vscode-tab-inactiveBackground, transparent)',
        color: 'inherit',
        cursor: 'pointer',
        borderRadius: '3px 3px 0 0',
        fontFamily: 'inherit',
        fontSize: '0.9rem',
        fontWeight: active ? 600 : 400
      }}
    >
      {children}
    </Button>
  );
}

function SubTabButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Button
      type="button"
      onClick={onClick}
      style={{
        padding: '0.2rem 0.6rem',
        border:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        background: active
          ? 'var(--vscode-button-background, #0e639c)'
          : 'transparent',
        color: active ? 'var(--vscode-button-foreground, #fff)' : 'inherit',
        cursor: 'pointer',
        borderRadius: '3px',
        fontFamily: 'inherit',
        fontSize: '0.8rem'
      }}
    >
      {children}
    </Button>
  );
}

function PlaceholderBox({ text }: { text: string }): React.ReactElement {
  return (
    <div
      style={{
        padding: '0.7rem 0.9rem',
        border:
          '1px dashed var(--vscode-panel-border, var(--vscode-contrastBorder, #555))',
        borderRadius: '3px',
        opacity: 0.7,
        fontStyle: 'italic',
        fontSize: '0.9rem'
      }}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GUI Editor (Canvas) — DOM/SVG canvas shell
// ---------------------------------------------------------------------------

interface CanvasBlockPosition {
  x: number;
  y: number;
}

interface CanvasPointerTarget {
  path: readonly number[];
  rect: DOMRect;
}

function canvasTreePaths(
  tree: SnlSyntaxTree,
  prefix: readonly number[] = []
): Array<readonly number[]> {
  return tree.children.flatMap((child, index) => {
    const path = [...prefix, index];
    return [path, ...canvasTreePaths(child, path)];
  });
}

function unionRects(rects: readonly DOMRect[]): DOMRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * Resolve the rendered macro under the pointer. Most nodes have their own
 * data-tree-path wrapper. Dynamic KaTeX environments cannot always carry that
 * wrapper, so for those nodes we infer a padded hit box from all rendered
 * descendants and prefer it over a shallower direct ancestor.
 */
export function resolveCanvasPointerTarget(
  target: HTMLElement,
  block: HTMLElement,
  tree: SnlSyntaxTree,
  clientX: number,
  clientY: number
): CanvasPointerTarget | null {
  const directElement = target.closest<HTMLElement>('[data-tree-path]');
  const directEncoded =
    directElement && block.contains(directElement)
      ? directElement.getAttribute('data-tree-path') ?? ''
      : '';
  const directPath = directEncoded
    ? directEncoded.split('.').map(Number).filter(Number.isInteger)
    : [];
  let resolved: CanvasPointerTarget | null = directElement
    ? { path: directPath, rect: directElement.getBoundingClientRect() }
    : null;

  const pathElements = Array.from(
    block.querySelectorAll<HTMLElement>('[data-tree-path]')
  );
  for (const path of canvasTreePaths(tree)) {
    if (path.length <= (resolved?.path.length ?? -1)) continue;
    const encoded = path.join('.');
    const own = pathElements.find(
      (element) => element.getAttribute('data-tree-path') === encoded
    );
    // Cat 2026-07-25: a node that has its own wrapper still competes here.
    // `closest()` only walks DOM ancestors, so when KaTeX lays a deeper
    // node's box under the pointer without making it a DOM ancestor of the
    // hit target, the click used to fall back to a shallower node (often the
    // root). Geometry decides, and deeper always wins.
    const padding = own ? 0 : 18;
    const baseRect = own
      ? own.getBoundingClientRect()
      : (() => {
          const prefix = `${encoded}.`;
          return unionRects(
            pathElements
              .filter((element) => (element.getAttribute('data-tree-path') ?? '').startsWith(prefix))
              .map((element) => element.getBoundingClientRect())
              .filter((rect) => rect.width > 0 || rect.height > 0)
          );
        })();
    if (!baseRect || (baseRect.width === 0 && baseRect.height === 0)) continue;
    const hitRect = new DOMRect(
      baseRect.left - padding,
      baseRect.top - padding,
      baseRect.width + padding * 2,
      baseRect.height + padding * 2
    );
    if (
      clientX >= hitRect.left &&
      clientX <= hitRect.right &&
      clientY >= hitRect.top &&
      clientY <= hitRect.bottom
    ) {
      resolved = { path, rect: hitRect };
    }
  }
  return resolved;
}

interface CanvasPendingDrag {
  pointerId: number;
  rootIndex: number;
  path: readonly number[];
  blockId: string;
  startClientX: number;
  startClientY: number;
  startPosition: CanvasBlockPosition;
  active: boolean;
}

interface CanvasFocus {
  rootIndex: number;
  path: readonly number[];
  /**
   * Drop-target only: the path points one past a variadic Macro's last child,
   * so the drop grows its arity rather than filling an existing slot.
   */
  append?: boolean;
}

/**
 * What a Canvas inline editor is allowed to rewrite.
 *
 *   - 'macro'   (F2)      — only this block's own Macro name; Style is separate.
 *                           Children are preserved verbatim.
 *   - 'subtree' (Ctrl+F2) — the whole subtree serialized as SNL DSL.
 */
type CanvasEditScope = 'macro' | 'subtree';

interface CanvasNodeEditor extends CanvasFocus {
  scope: CanvasEditScope;
  left: number;
  top: number;
  value: string;
  error: string | null;
}

interface CanvasContextMenu extends CanvasFocus {
  left: number;
  top: number;
}

function sameCanvasTarget(
  left: CanvasFocus | null,
  right: CanvasFocus | null
): boolean {
  return Boolean(
    left &&
    right &&
    left.rootIndex === right.rootIndex &&
    left.path.join('.') === right.path.join('.')
  );
}

/**
 * Where a freshly-added root block starts. The first block is centred on the
 * canvas (cat 2026-07-25: "默认应该把根节点放在画布正中间"); later blocks fan out
 * from there so they don't stack on top of each other.
 */
/**
 * Canvas arity shortcuts, keyed by `KeyboardEvent.code` first so the numpad
 * and the main row stay distinguishable, with a `key` fallback for layouts
 * that do not report a code.
 *
 * Cat 2026-07-25 asked for numpad priority and for this to be user-rebindable
 * later, so the bindings live in one exported table rather than inline
 * conditionals — a future settings surface has exactly one place to read.
 */
export const CANVAS_ARITY_KEYS: {
  increase: { codes: readonly string[]; keys: readonly string[] };
  decrease: { codes: readonly string[]; keys: readonly string[] };
} = {
  increase: { codes: ['NumpadAdd', 'Equal'], keys: ['+', '='] },
  decrease: { codes: ['NumpadSubtract', 'Minus'], keys: ['-', '_'] }
};

export function canvasArityDelta(event: {
  code?: string;
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): number | null {
  // Ctrl/Cmd +/- is browser zoom and Alt +/- belongs to the OS; claiming
  // those would hijack a shortcut the author expects to work everywhere.
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const { increase, decrease } = CANVAS_ARITY_KEYS;
  if (event.code && increase.codes.includes(event.code)) return 1;
  if (event.code && decrease.codes.includes(event.code)) return -1;
  // `key` fallback for layouts that report no code at all.
  if (increase.keys.includes(event.key)) return 1;
  if (decrease.keys.includes(event.key)) return -1;
  return null;
}

export function canvasInitialPosition(
  index: number,
  canvas: { clientWidth: number; clientHeight: number } | null,
  block: { offsetWidth: number; offsetHeight: number } | null
): CanvasBlockPosition {
  // Only the first root is centred; extra blocks keep the original grid so
  // detached subtrees land in predictable, non-overlapping slots.
  if (index > 0) {
    return {
      x: 24 + (index % 2) * 330,
      y: 24 + Math.floor(index / 2) * 220
    };
  }
  const width = canvas?.clientWidth ?? 0;
  const height = canvas?.clientHeight ?? 0;
  if (width <= 0 || height <= 0) return { x: 24, y: 24 };
  return {
    x: Math.max(8, Math.round((width - (block?.offsetWidth ?? Math.min(320, width / 2))) / 2)),
    y: Math.max(8, Math.round((height - (block?.offsetHeight ?? Math.min(160, height / 2))) / 2))
  };
}

export function GuiCanvasEditor({
  forest,
  macroDataDriver,
  macroCandidates = [],
  macroOrigin = {},
  onOpenMacroEditor = () => undefined,
  kindPalette,
  onForestChange,
  onResetFromSnl
}: {
  forest: SnlSyntaxTree[];
  macroDataDriver: MacroDataDriver;
  macroCandidates?: readonly SnooglSearchCandidate[];
  macroOrigin?: Record<string, string>;
  onOpenMacroEditor?: (req: MacroOpenRequest) => void;
  kindPalette: KindPalette | undefined;
  onForestChange: (next: SnlSyntaxTree[]) => void;
  onResetFromSnl: () => void;
}): React.ReactElement {
  const [positions, setPositions] = React.useState<Record<string, CanvasBlockPosition>>({});
  const [draggingBlockId, setDraggingBlockId] = React.useState<string | null>(null);
  const [hoveredBlockId, setHoveredBlockId] = React.useState<string | null>(null);
  const [focused, setFocused] = React.useState<CanvasFocus | null>(null);
  const [editingNode, setEditingNode] = React.useState<CanvasNodeEditor | null>(null);
  const [addingRootFromMacro, setAddingRootFromMacro] = React.useState(false);
  const [dropTarget, setDropTarget] = React.useState<CanvasFocus | null>(null);
  const [contextMenu, setContextMenu] = React.useState<CanvasContextMenu | null>(null);
  const canvasRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const addRootRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  // Async arity lookup belongs to the exact SNooGL selection that launched it.
  // A second selection, Escape, or an external forest replacement invalidates
  // the older result before it can append a stale/duplicate root.
  const addRootRequestRef = React.useRef(0);
  const nodeEditRequestRef = React.useRef(0);
  const forestRef = React.useRef(forest);
  const suppressClickRef = React.useRef(false);
  const suppressCanvasClickRef = React.useRef(false);
  const dragRef = React.useRef<CanvasPendingDrag | null>(null);
  const lastPointerTargetRef = React.useRef<CanvasFocus | null>(null);
  // Local undo stack (Ctrl/Cmd+Z). Canvas edits are structural and easy to
  // mis-aim, so every mutation pushes the pre-change forest before applying.
  const undoStackRef = React.useRef<Array<{ forest: SnlSyntaxTree[]; focused: CanvasFocus | null }>>([]);
  /**
   * Synchronous `dynamic_arity` lookup.
   *
   * `macroDataDriver.query_macro` is async, but the keyboard handler is not:
   * awaiting inside it would let two fast `+` presses both read the
   * pre-change forest. Every rendered Macro is resolved into this cache, so
   * the shortcut can decide instantly. Cat 2026-07-25.
   */
  const dynamicArityRef = React.useRef<Map<string, boolean>>(new Map());
  const [dynamicArityVersion, setDynamicArityVersion] = React.useState(0);
  const noteDynamicArity = React.useCallback((macroName: string, dynamic: boolean): void => {
    if (dynamicArityRef.current.get(macroName) === dynamic) return;
    dynamicArityRef.current.set(macroName, dynamic);
    setDynamicArityVersion((version) => version + 1);
  }, []);
  const isDynamicMacro = (macroName: string): boolean =>
    dynamicArityRef.current.get(macroName) === true;
  const macroStylesByName = React.useMemo(
    () => new Map(
      macroCandidates.map((candidate) => [candidate.id, candidate.styles ?? []] as const)
    ),
    [macroCandidates]
  );
  forestRef.current = forest;

  React.useEffect(() => () => {
    // A MacroDataDriver request may outlive the Canvas. Never publish into the
    // parent after the user switches modes or closes the editor.
    addRootRequestRef.current += 1;
    nodeEditRequestRef.current += 1;
  }, []);

  /** Apply a structural change, recording the previous state for undo. */
  const applyForestChange = (
    next: SnlSyntaxTree[],
    nextFocused: CanvasFocus | null | undefined = undefined
  ): boolean => {
    if (next === forestRef.current) return false;
    undoStackRef.current.push({ forest: forestRef.current, focused });
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    forestRef.current = next;
    if (nextFocused !== undefined) setFocused(nextFocused);
    onForestChange(next);
    return true;
  };

  const undoForestChange = (): void => {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    forestRef.current = previous.forest;
    closeCanvasInputs();
    setContextMenu(null);
    setFocused(previous.focused);
    onForestChange(previous.forest);
  };

  React.useEffect(() => {
    setPositions((previous) => {
      const next: Record<string, CanvasBlockPosition> = {};
      forest.forEach((root, index) => {
        const id = treeIdentity(root);
        next[id] = previous[id] ?? canvasInitialPosition(
          index,
          canvasRef.current,
          index === 0
            ? canvasRef.current?.querySelector<HTMLElement>('[data-canvas-root-index="0"]') ?? null
            : null
        );
      });
      return next;
    });
  }, [forest]);

  // The first root starts centred on the canvas. Only ever done once per
  // mount: later identity changes (edits, Clear) must not yank a block the
  // user has already dragged somewhere.
  const centredRootRef = React.useRef(false);
  React.useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const first = forest[0];
    if (!canvas || !first || centredRootRef.current) return;
    const id = treeIdentity(first);
    const block = canvas.querySelector<HTMLElement>('[data-canvas-root-index="0"]');
    if (!block) return;
    const canvasRect = canvas.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    if (canvasRect.width === 0 || blockRect.width === 0) return;
    centredRootRef.current = true;
    setPositions((previous) => ({
      ...previous,
      [id]: {
        x: Math.max(8, Math.round((canvasRect.width - blockRect.width) / 2)),
        y: Math.max(8, Math.round((canvasRect.height - blockRect.height) / 2))
      }
    }));
  }, [forest]);

  React.useEffect(() => {
    if (focused) {
      const root = forest[focused.rootIndex];
      if (!root || !getNodeAtPath(root, focused.path.join('.'))) {
        setFocused(null);
      }
    }
    // Any external forest replacement invalidates the source snapshot held by
    // an open editor. Internal editor commits clear editingNode in the same
    // state transition, so this only cancels genuinely stale overlays.
    if (editingNode) setEditingNode(null);
    // Invalidate every arity lookup started against the old forest.
    addRootRequestRef.current += 1;
    nodeEditRequestRef.current += 1;
    // The add-root input is anchored to nothing in the tree, but a forest
    // replacement (Reset, external push, undo) still means its draft is
    // orphaned — destroy it rather than leave it floating (Cat 2026-07-26).
    setAddingRootFromMacro(false);
  }, [forest]);

  // Resolve dynamic_arity for every Macro currently on the Canvas so the
  // synchronous shortcut path always has an answer ready. The cache is
  // dropped whenever the Macro source changes, so editing a Macro from
  // fixed to variadic (or back) mid-session is picked up.
  React.useEffect(() => {
    dynamicArityRef.current.clear();
    setDynamicArityVersion((version) => version + 1);
  }, [macroDataDriver]);

  React.useEffect(() => {
    let cancelled = false;
    const names = new Set<string>();
    const visit = (node: SnlSyntaxTree): void => {
      const name = node.macro_name.trim();
      if (name && !node.env_mode) names.add(name);
      node.children.forEach(visit);
    };
    forest.forEach(visit);
    void (async () => {
      for (const name of names) {
        if (dynamicArityRef.current.has(name)) continue;
        try {
          const macro = await macroDataDriver.query_macro({ macro_name: name });
          if (cancelled) return;
          noteDynamicArity(name, macro?.dynamic_arity === true);
        } catch {
          if (cancelled) return;
          noteDynamicArity(name, false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [forest, macroDataDriver, noteDynamicArity]);

  const updateDropTarget = (next: CanvasFocus | null): void => {
    setDropTarget((previous) => sameCanvasTarget(previous, next) ? previous : next);
  };

  const findDropTarget = (
    clientX: number,
    clientY: number,
    draggedRootIndex: number
  ): CanvasFocus | null => {
    if (typeof document.elementsFromPoint !== 'function') return null;
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      const holeElement = (element as HTMLElement).closest<HTMLElement>(
        '[data-kind="argPlaceholder"], .snlArgPlaceholder'
      );
      if (!holeElement) continue;
      const pathElement = holeElement.closest<HTMLElement>('[data-tree-path]');
      const block = holeElement.closest<HTMLElement>('[data-canvas-root-index]');
      if (!pathElement || !block) continue;
      const rootIndex = Number(block.dataset.canvasRootIndex);
      if (!Number.isInteger(rootIndex) || rootIndex === draggedRootIndex) continue;
      const encoded = pathElement.getAttribute('data-tree-path') ?? '';
      const path = encoded ? encoded.split('.').map(Number) : [];
      if (!isCanvasHole(getNodeAtPath(forestRef.current[rootIndex], encoded))) continue;
      return { rootIndex, path };
    }
    // Route C (cat 2026-07-25): a variadic Macro has no fixed slots, so
    // dropping anywhere on its own box appends a new argument. Checked after
    // the slot search so an explicit empty slot always wins.
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      const pathElement = (element as HTMLElement).closest<HTMLElement>('[data-tree-path]');
      const block = pathElement?.closest<HTMLElement>('[data-canvas-root-index]');
      if (!pathElement || !block) continue;
      const rootIndex = Number(block.dataset.canvasRootIndex);
      if (!Number.isInteger(rootIndex) || rootIndex === draggedRootIndex) continue;
      const encoded = pathElement.getAttribute('data-tree-path') ?? '';
      const node = getNodeAtPath(forestRef.current[rootIndex], encoded);
      if (!node || !isDynamicMacro(node.macro_name)) continue;
      const path = encoded ? encoded.split('.').map(Number) : [];
      // The append position is one past the last child.
      return { rootIndex, path: [...path, node.children.length], append: true };
    }
    return null;
  };

  const beginPointer = (
    event: React.PointerEvent<HTMLDivElement>,
    rootIndex: number,
    blockId: string
  ): void => {
    // Cleared unconditionally: every early return below (right button, open
    // editor, empty slot) must invalidate the previous gesture's target so a
    // stale entry can never hijack a later click / double-click / right-click.
    lastPointerTargetRef.current = null;
    if (event.button !== 0 || editingNode) return;
    const resolved =
      resolveCanvasPointerTarget(
        event.target as HTMLElement,
        event.currentTarget,
        forest[rootIndex],
        event.clientX,
        event.clientY
      ) ?? {
        path: [],
        rect: event.currentTarget.getBoundingClientRect()
      };
    if (isCanvasHole(getNodeAtPath(forest[rootIndex], resolved.path.join('.')))) {
      return;
    }
    const canvas = event.currentTarget.closest<HTMLElement>('[data-entry-gui-canvas]');
    const canvasRect = canvas?.getBoundingClientRect();
    const startPosition =
      resolved.path.length > 0 && canvas && canvasRect
        ? {
            x: resolved.rect.left - canvasRect.left + canvas.scrollLeft,
            y: resolved.rect.top - canvasRect.top + canvas.scrollTop
          }
        : positions[blockId] ?? { x: 24, y: 24 };
    // Pointer-down must suppress the browser's native text-selection gesture;
    // the Canvas owns this drag surface, while editing uses a separate input.
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      rootIndex,
      path: resolved.path,
      blockId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPosition,
      active: false
    };
    // Cat 2026-07-25: a plain click must focus exactly the subtree that a
    // drag from this same spot would carry away. Record the drag's resolved
    // target here so the click handler can reuse it verbatim instead of
    // re-resolving (and possibly landing on a shallower ancestor).
    lastPointerTargetRef.current = { rootIndex, path: resolved.path };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const movePointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.active && Math.hypot(dx, dy) < 6) return;

    if (!drag.active) {
      drag.active = true;
      if (drag.path.length > 0) {
        const sourceRootIndex = drag.rootIndex;
        const sourcePath = [...drag.path];
        // A variadic parent must not keep the vacated slot: the drop lands
        // somewhere else and the blank would be left behind for good. It can
        // still take the subtree back by appending (route C).
        const nextForest = detachCanvasSubtree(
          forestRef.current,
          drag.rootIndex,
          drag.path,
          parentIsDynamic({ rootIndex: drag.rootIndex, path: drag.path })
        );
        if (nextForest === forestRef.current) {
          dragRef.current = null;
          return;
        }
        const detached = nextForest[nextForest.length - 1];
        ensureTreeIdentity(detached);
        const detachedId = treeIdentity(detached);
        drag.blockId = detachedId;
        drag.rootIndex = nextForest.length - 1;
        if (
          focused?.rootIndex === sourceRootIndex &&
          sourcePath.every((part, index) => focused.path[index] === part)
        ) {
          setFocused({
            rootIndex: drag.rootIndex,
            path: focused.path.slice(sourcePath.length)
          });
        }
        // Must run before forestRef is advanced: applyForestChange snapshots
        // the current forest for undo.
        applyForestChange(nextForest);
        forestRef.current = nextForest;
      }
      suppressClickRef.current = true;
      setDraggingBlockId(drag.blockId);
    }

    event.preventDefault();
    const nextDropTarget = findDropTarget(
      event.clientX,
      event.clientY,
      drag.rootIndex
    );
    const canvas = canvasRef.current;
    const targetElement = nextDropTarget ? elementForTarget(nextDropTarget) : null;
    const canvasRect = canvas?.getBoundingClientRect();
    const snappedPosition = targetElement && canvas && canvasRect
      ? (() => {
          const targetRect = targetElement.getBoundingClientRect();
          return {
            x: targetRect.left - canvasRect.left + canvas.scrollLeft,
            y: targetRect.top - canvasRect.top + canvas.scrollTop
          };
        })()
      : null;
    setPositions((previous) => ({
      ...previous,
      [drag.blockId]: snappedPosition ?? {
        x: drag.startPosition.x + dx,
        y: drag.startPosition.y + dy
      }
    }));
    updateDropTarget(nextDropTarget);
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = drag.active
      ? findDropTarget(event.clientX, event.clientY, drag.rootIndex)
      : null;
    if (drag.active && target) {
      const attached = attachCanvasRoot(
        forestRef.current,
        drag.rootIndex,
        target.rootIndex,
        target.path,
        target.append === true
      );
      if (attached !== forestRef.current) {
        setEditingNode(null);
        // One drag = one undo step. The detach half already snapshotted the
        // pre-drag forest, so drop it and let the attach entry stand in.
        const detachEntry = drag.path.length > 0 ? undoStackRef.current.pop() : undefined;
        applyForestChange(attached, null);
        if (detachEntry) {
          undoStackRef.current[undoStackRef.current.length - 1] = detachEntry;
        }
      }
    }
    dragRef.current = null;
    setDraggingBlockId(null);
    updateDropTarget(null);
    if (drag.active) {
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDraggingBlockId(null);
    updateDropTarget(null);
    suppressClickRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const elementForTarget = (target: CanvasFocus): HTMLElement | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const block = canvas.querySelector<HTMLElement>(
      `[data-canvas-root-index="${target.rootIndex}"]`
    );
    if (!block) return null;
    // An append target points one past the last child, so it has no element
    // of its own — highlight the variadic parent that will grow instead.
    const encoded = (target.append ? target.path.slice(0, -1) : target.path).join('.');
    const pathElements = Array.from(
      block.querySelectorAll<HTMLElement>('[data-tree-path]')
    );
    const exact = pathElements.find(
      (element) => (element.getAttribute('data-tree-path') ?? '') === encoded
    );
    if (exact) return exact;
    if (target.path.length === 0) return block;

    const prefix = `${encoded}.`;
    const descendants = pathElements.filter((element) =>
      (element.getAttribute('data-tree-path') ?? '').startsWith(prefix)
    );
    if (descendants.length === 0) return null;
    let common = descendants[0].parentElement;
    while (
      common &&
      common !== block &&
      !descendants.every((element) => common!.contains(element))
    ) {
      common = common.parentElement;
    }
    return common && block.contains(common) ? common : null;
  };

  const startEditingTarget = (
    target: CanvasFocus,
    scope: CanvasEditScope = 'macro'
  ): void => {
    const node = getNodeAtPath(forestRef.current[target.rootIndex], target.path.join('.'));
    if (!node) return;
    const element = elementForTarget(target);
    const canvas = canvasRef.current;
    if (!element || !canvas) return;
    // An empty slot has no Macro of its own to rename — filling it always
    // means authoring a whole subtree.
    const effectiveScope: CanvasEditScope = isCanvasHole(node) ? 'subtree' : scope;
    const rect = element.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    setFocused(target);
    setContextMenu(null);
    // The two floating inputs are mutually exclusive by construction.
    setAddingRootFromMacro(false);
    setEditingNode({
      ...target,
      scope: effectiveScope,
      left: rect.left - canvasRect.left + canvas.scrollLeft,
      top: rect.top - canvasRect.top + canvas.scrollTop,
      value: isCanvasHole(node)
        ? ''
        : effectiveScope === 'macro'
          ? stringifyLeafHead(node)
          : serializeTreePreserving(node),
      error: null
    });
  };

  /**
   * Resolve the mouse position to the subtree a drag from the same spot
   * would detach. Prefers the target the pointer-down handler already
   * resolved so click focus and drag payload can never disagree.
   */
  const targetForMouseEvent = (
    event: React.MouseEvent<HTMLDivElement>
  ): CanvasFocus | null => {
    const block = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-canvas-root-index]'
    );
    if (!block) return null;
    const rootIndex = Number(block.dataset.canvasRootIndex);
    if (!Number.isInteger(rootIndex) || !forestRef.current[rootIndex]) return null;
    const remembered = lastPointerTargetRef.current;
    // Only reuse the drag-resolved target when this very gesture landed on the
    // same block; otherwise re-resolve from the DOM.
    if (remembered && remembered.rootIndex === rootIndex) {
      const element = elementForTarget(remembered);
      if (element && (element === event.target || element.contains(event.target as Node))) {
        return remembered;
      }
    }
    const resolved = resolveCanvasPointerTarget(
      event.target as HTMLElement,
      block,
      forestRef.current[rootIndex],
      event.clientX,
      event.clientY
    ) ?? { path: [], rect: block.getBoundingClientRect() };
    return { rootIndex, path: resolved.path };
  };

  const insideOpenEditor = (node: Node | null): boolean => {
    if (!node) return false;
    // Both floating inputs count: the node editor AND the add-root input.
    // Missing the latter is how it used to survive clicks that should have
    // destroyed it (Cat 2026-07-26).
    return [editorRef.current, addRootRef.current].some((control) => {
      if (!control) return false;
      const surface = control.closest('[data-macro-id-control]');
      return Boolean(control.contains(node) || surface?.contains(node));
    });
  };

  /** Tear down every floating Canvas input. One exit door, no leaks. */
  const closeCanvasInputs = (): void => {
    addRootRequestRef.current += 1;
    nodeEditRequestRef.current += 1;
    setEditingNode(null);
    setAddingRootFromMacro(false);
  };

  /**
   * The context menu and the arity control are rendered inside the canvas, so
   * the canvas' own capture-phase click handler and the block pointer
   * handlers would otherwise swallow or preventDefault their clicks — which
   * is exactly why the menu felt dead. These attributes mark those subtrees
   * as off-limits.
   *
   * The click guard is defensive against capture-phase ordering: jsdom lets
   * the menu item's onClick run even after the canvas clears the menu, so
   * only the pointerdown path is observable in tests.
   */
  const insideContextMenu = (node: Node | null): boolean =>
    Boolean(
      node &&
        (node as HTMLElement).closest?.(
          '[data-canvas-menu], [data-canvas-arity-control], [data-canvas-macro-control]'
        )
    );

  const handleCanvasClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (insideOpenEditor(event.target as Node)) return;
    if (insideContextMenu(event.target as Node)) return;
    if (suppressCanvasClickRef.current) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setContextMenu(null);
    // A stray click anywhere on the Canvas dismisses a pending root insert.
    setAddingRootFromMacro(false);
    const target = targetForMouseEvent(event);
    if (!target) {
      setFocused(null);
      return;
    }
    setFocused(target);
    const node = getNodeAtPath(
      forestRef.current[target.rootIndex],
      target.path.join('.')
    );
    if (isCanvasHole(node)) startEditingTarget(target, 'subtree');
  };

  /** Double click == click here + F2: edit this node's own macro. */
  const handleCanvasDoubleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (insideOpenEditor(event.target as Node)) return;
    if (insideContextMenu(event.target as Node)) return;
    const target = targetForMouseEvent(event);
    if (!target) return;
    event.preventDefault();
    setAddingRootFromMacro(false);
    setFocused(target);
    startEditingTarget(target, 'macro');
  };

  const handleCanvasContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (insideOpenEditor(event.target as Node)) return;
    // The menu itself is inside the canvas; never re-open on top of itself.
    if ((event.target as HTMLElement).closest('[data-canvas-menu]')) {
      event.preventDefault();
      return;
    }
    const target = targetForMouseEvent(event);
    event.preventDefault();
    event.stopPropagation();
    const canvas = canvasRef.current;
    const canvasRect = canvas?.getBoundingClientRect();
    const left = canvas && canvasRect
      ? event.clientX - canvasRect.left + canvas.scrollLeft
      : event.clientX;
    const top = canvas && canvasRect
      ? event.clientY - canvasRect.top + canvas.scrollTop
      : event.clientY;
    closeCanvasInputs();
    // Blank canvas space gets its own menu whose only action adds a root.
    if (!target) {
      setFocused(null);
      setContextMenu({ rootIndex: -1, path: [], left, top });
      return;
    }
    setFocused(target);
    setContextMenu({ ...target, left, top });
  };

  const handleCanvasKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // A floating input owns the keyboard while it is open.
    if (editingNode || addingRootFromMacro) return;
    if (
      !focused &&
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'f'
    ) {
      event.preventDefault();
      setAddingRootFromMacro(true);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (contextMenu) {
        setContextMenu(null);
        return;
      }
      setFocused(null);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undoForestChange();
      return;
    }
    // Cat 2026-07-25 navigation model:
    //   Tab / ArrowRight        -> next sibling (roots cycle among roots)
    //   Shift+Tab / ArrowLeft   -> previous sibling
    //   Enter / ArrowDown       -> first child (no-op on a leaf)
    //   Shift+Enter / ArrowUp   -> parent (no-op at a root)
    const move =
      event.key === 'Tab'
        ? (event.shiftKey ? 'previous' : 'next')
        : event.key === 'ArrowRight'
          ? 'next'
          : event.key === 'ArrowLeft'
            ? 'previous'
            : event.key === 'Enter'
              ? (event.shiftKey ? 'parent' : 'child')
              : event.key === 'ArrowDown'
                ? 'child'
                : event.key === 'ArrowUp'
                  ? 'parent'
                  : null;
    if (move) {
      event.preventDefault();
      const next = moveCanvasCursor(forestRef.current, focused, move);
      if (next) setFocused(next);
      return;
    }
    if (event.key === 'F2' && focused) {
      event.preventDefault();
      // Cat 2026-07-25: F2 now edits only this block's Macro; the old
      // whole-subtree DSL editor moved to Ctrl/Cmd+F2.
      startEditingTarget(focused, event.ctrlKey || event.metaKey ? 'subtree' : 'macro');
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && focused) {
      event.preventDefault();
      const next = deleteCanvasTarget(
        forestRef.current,
        focused.rootIndex,
        focused.path,
        parentIsDynamic(focused)
      );
      applyForestChange(next, null);
      return;
    }
    // Dynamic-arity nodes own their argument count, so `+` / `-` edit it
    // directly (numpad preferred — see CANVAS_ARITY_KEYS).
    if (focused) {
      const delta = canvasArityDelta(event);
      if (delta !== null) {
        const node = getNodeAtPath(
          forestRef.current[focused.rootIndex],
          focused.path.join('.')
        );
        if (node && isDynamicMacro(node.macro_name)) {
          event.preventDefault();
          changeDynamicArity(focused, delta);
        }
      }
    }
  };

  /** True when the focused node's PARENT is a variadic Macro. */
  const parentIsDynamic = (target: CanvasFocus): boolean => {
    if (target.path.length === 0) return false;
    const parent = getNodeAtPath(
      forestRef.current[target.rootIndex],
      target.path.slice(0, -1).join('.')
    );
    return Boolean(parent && isDynamicMacro(parent.macro_name));
  };

  const changeCanvasStyle = (
    target: CanvasFocus,
    selected: string,
    styleNames: readonly string[]
  ): void => {
    const root = forestRef.current[target.rootIndex];
    const node = getNodeAtPath(root, target.path.join('.'));
    if (!root || !node) return;
    const defaultStyle = styleNames[0] ?? '';
    const replacement: SnlSyntaxTree = {
      ...node,
      style_name:
        selected === '' || selected === defaultStyle ? undefined : selected
    };
    inheritTreeIdentity(node, replacement);
    const next = replaceCanvasTarget(
      forestRef.current,
      target.rootIndex,
      target.path,
      replacement
    );
    applyForestChange(next, target);
  };

  const changeDynamicArity = (target: CanvasFocus, delta: number): void => {
    const node = getNodeAtPath(
      forestRef.current[target.rootIndex],
      target.path.join('.')
    );
    if (!node) return;
    const next = setCanvasDynamicArity(
      forestRef.current,
      target.rootIndex,
      target.path,
      node.children.length + delta,
      ensureTreeIdentity
    );
    applyForestChange(next);
  };

  /** Resolve whether an inserted Macro is fixed, variadic, or unknown. */
  const macroArityForName = async (
    macroName: string
  ): Promise<number | 'dynamic' | null> => {
    const name = macroName.trim();
    if (!name) return null;
    try {
      const macro = await macroDataDriver.query_macro({ macro_name: name });
      if (!macro) return null;
      if (macro.dynamic_arity === true) return 'dynamic';
      return macroTemplateArity(macro);
    } catch {
      return null;
    }
  };

  /**
   * Position and metadata for the floating focused-Macro control. Every real
   * Macro gets ↗; variadic ones share the same panel with [- n +].
   */
  const focusedMacroControl = React.useMemo(() => {
    if (!focused || editingNode || contextMenu) return null;
    const node = getNodeAtPath(forest[focused.rootIndex], focused.path.join('.'));
    if (!node || isCanvasHole(node) || !node.macro_name.trim()) return null;
    const element = elementForTarget(focused);
    const canvas = canvasRef.current;
    if (!element || !canvas) return null;
    const rect = element.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return {
      target: focused,
      node,
      dynamic: isDynamicMacro(node.macro_name),
      count: node.children.length,
      left: rect.left - canvasRect.left + canvas.scrollLeft,
      top: rect.bottom - canvasRect.top + canvas.scrollTop + 4
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, editingNode, contextMenu, forest, dynamicArityVersion]);

  const commitNodeEdit = async (): Promise<void> => {
    if (!editingNode) return;
    const request = ++nodeEditRequestRef.current;
    const sourceForest = forestRef.current;
    const previousNode = getNodeAtPath(
      sourceForest[editingNode.rootIndex],
      editingNode.path.join('.')
    );
    let replacement: SnlSyntaxTree;
    if (editingNode.scope === 'macro') {
      // Macro scope rewrites only the head; children stay exactly as they are.
      const head = editingNode.value.trim();
      if (head.includes('(') || head.includes(',')) {
        setEditingNode((previous) => previous
          ? { ...previous, error: 'Macro edit accepts a single macro id; use Ctrl+F2 to edit the subtree.' }
          : null);
        return;
      }
      const parsedHead = tryParseSnlSyntaxTree(head);
      if (!parsedHead.ok) {
        setEditingNode((previous) => previous ? { ...previous, error: parsedHead.error } : null);
        return;
      }
      if (parsedHead.tree.style_name !== undefined) {
        setEditingNode((previous) => previous
          ? { ...previous, error: 'Macro edit accepts a Macro name only; use the Style dropdown.' }
          : null);
        return;
      }
      const base = previousNode ?? parsedHead.tree;
      replacement = {
        ...base,
        macro_name: parsedHead.tree.macro_name,
        kind: parsedHead.tree.kind,
        env_mode: parsedHead.tree.env_mode,
        style_name: previousNode ? previousNode.style_name : undefined,
        children: previousNode ? previousNode.children : parsedHead.tree.children
      };
      if (previousNode) inheritTreeIdentity(previousNode, replacement);
      else ensureTreeIdentity(replacement);
    } else {
      const parsed = tryParseSnlSyntaxTree(editingNode.value.trim());
      if (!parsed.ok) {
        setEditingNode((previous) => previous ? { ...previous, error: parsed.error } : null);
        return;
      }
      if (previousNode) inheritTreeIdentity(previousNode, parsed.tree);
      else ensureTreeIdentity(parsed.tree);
      replacement = parsed.tree;
    }
    const replaced = replaceCanvasTarget(
      sourceForest,
      editingNode.rootIndex,
      editingNode.path,
      replacement
    );
    if (replaced === sourceForest) return;
    // Cat 2026-07-25: the new Macro's arity decides what happens to the old
    // children — surplus subtrees pop out as their own root blocks, missing
    // slots become empty placeholders the author fills in manually. Never
    // swallow a subtree and never resurrect one.
    const arity = await macroArityForName(replacement.macro_name);
    if (
      request !== nodeEditRequestRef.current ||
      forestRef.current !== sourceForest
    ) return;
    const isNewMacro =
      !previousNode ||
      isCanvasHole(previousNode) ||
      previousNode.macro_name !== replacement.macro_name;
    const targetArity: number | null =
      arity === 'dynamic'
        ? (isNewMacro && replacement.children.length === 0 ? 1 : null)
        : arity;
    const next = targetArity === null
      ? replaced
      : reconcileCanvasArity(
          replaced,
          editingNode.rootIndex,
          editingNode.path,
          targetArity,
          // Evicted subtrees become their own blocks; they must keep a stable
          // identity so their canvas position is preserved rather than reset.
          ensureTreeIdentity
        );
    applyForestChange(next);
    setEditingNode(null);
    window.setTimeout(() => canvasRef.current?.focus(), 0);
  };

  React.useEffect(() => {
    if (!editingNode && !addingRootFromMacro) return;
    const commitOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (insideOpenEditor(target)) return;
      suppressCanvasClickRef.current = true;
      document.addEventListener('click', () => {
        suppressCanvasClickRef.current = false;
      }, { once: true });
      document.addEventListener('pointerup', () => {
        window.setTimeout(() => { suppressCanvasClickRef.current = false; }, 0);
      }, { once: true });
      // Clicking away has the same semantics as Escape: discard the draft.
      closeCanvasInputs();
      window.setTimeout(() => canvasRef.current?.focus(), 0);
    };
    document.addEventListener('pointerdown', commitOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', commitOnOutsidePointer, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingNode, addingRootFromMacro]);

  // A right-click menu must also close when the user clicks anywhere outside
  // the Canvas (the canvas click handler only sees clicks inside it).
  React.useEffect(() => {
    if (!contextMenu) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const canvas = canvasRef.current;
      const target = event.target as Node | null;
      if (canvas && target && canvas.contains(target)) return;
      setContextMenu(null);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, [contextMenu]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const decorate = (): void => {
      canvas.querySelectorAll('.snl-canvas-focused').forEach((element) =>
        element.classList.remove('snl-canvas-focused')
      );
      canvas.querySelectorAll('.snl-canvas-drop-target').forEach((element) =>
        element.classList.remove('snl-canvas-drop-target')
      );
      if (focused) elementForTarget(focused)?.classList.add('snl-canvas-focused');
      if (dropTarget) elementForTarget(dropTarget)?.classList.add('snl-canvas-drop-target');
    };
    decorate();
    const observer = new MutationObserver(decorate);
    observer.observe(canvas, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [forest, focused, dropTarget]);

  return (
    <section>
      <div
        ref={canvasRef}
        data-entry-gui-canvas
        aria-label="GUI Editor canvas"
        tabIndex={0}
        onClickCapture={handleCanvasClick}
        onDoubleClickCapture={handleCanvasDoubleClick}
        onContextMenu={handleCanvasContextMenu}
        onKeyDown={handleCanvasKeyDown}
        style={{
          position: 'relative',
          minHeight: '32rem',
          overflow: 'visible',
          fontSize: '1.05rem',
          border: '1px solid var(--vscode-panel-border, #444)',
          borderRadius: '6px',
          backgroundColor: 'var(--vscode-editor-background)',
          backgroundImage:
            'radial-gradient(circle, var(--vscode-editorWidget-border, #555) 1px, transparent 1px)',
          backgroundSize: '20px 20px'
        }}
      >
        {forest.map((root, rootIndex) => {
          const blockId = treeIdentity(root);
          const position = positions[blockId] ?? { x: 24, y: 24 };
          return (
            <div
              key={blockId}
              data-canvas-root={blockId}
              data-canvas-root-index={rootIndex}
              onPointerEnter={() => setHoveredBlockId(blockId)}
              onPointerLeave={() => setHoveredBlockId((current) => current === blockId ? null : current)}
              onPointerDownCapture={(event) => beginPointer(event, rootIndex, blockId)}
              onPointerMoveCapture={movePointer}
              onPointerUpCapture={endPointer}
              onPointerCancelCapture={cancelPointer}
              style={{
                position: 'absolute',
                left: position.x,
                top: position.y,
                display: 'inline-block',
                width: 'max-content',
                maxWidth: `calc(100% - ${Math.max(0, position.x) + 8}px)`,
                boxSizing: 'border-box',
                overflow: 'visible',
                padding: '0.3rem',
                border: '1px solid var(--vscode-focusBorder, #007fd4)',
                borderRadius: '5px',
                background: hoveredBlockId === blockId
                  ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.08))'
                  : 'var(--vscode-editorWidget-background, #252526)',
                boxShadow: '0 3px 12px rgba(0,0,0,0.28)',
                touchAction: 'none',
                zIndex: draggingBlockId === blockId ? 1000 : hoveredBlockId === blockId ? 1 : 0,
                cursor: draggingBlockId === blockId ? 'grabbing' : 'grab',
                userSelect: 'none',
                WebkitUserSelect: 'none'
              }}
            >
              <SnlSyntaxTreeView
                tree={root}
                macro_data_driver={macroDataDriver}
                reader_runtime={webview_language_runtime}
                kindPalette={kindPalette}
                hooks={{ renderTooltip: () => null, renderers: extensionRenderers }}
              />
            </div>
          );
        })}
        {editingNode ? (
          <MacroIdInput
            ref={editorRef}
            multiline
            autoSize
            autoFocus
            className="snl-canvas-node-input"
            aria-label="Edit focused SNL"
            selectAllOnMount
            macroCandidates={macroCandidates}
            snooglInsertsMacroId={editingNode.scope === 'subtree'}
            value={editingNode.value}
            onChange={(value) => setEditingNode({
              ...editingNode,
              value,
              error: null
            })}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (
                event.key === 'Enter' &&
                (editingNode.scope === 'macro' || event.ctrlKey || event.metaKey)
              ) {
                event.preventDefault();
                commitNodeEdit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setEditingNode(null);
                window.setTimeout(() => canvasRef.current?.focus(), 0);
              }
            }}
            title={
              editingNode.error ??
              (editingNode.scope === 'macro'
                ? 'Edit this block\u2019s Macro and press Enter'
                : 'Enter SNL DSL; Enter adds a line, Ctrl/Cmd+Enter commits')
            }
            style={{
              position: 'absolute',
              left: editingNode.left,
              top: editingNode.top,
              maxWidth: `calc(100% - ${Math.max(0, editingNode.left) + 8}px)`,
              zIndex: 20,
              borderColor: editingNode.error
                ? 'var(--vscode-errorForeground, #f48771)'
                : undefined
            }}
          />
        ) : null}
        {addingRootFromMacro ? (
          <MacroIdInput
            ref={addRootRef}
            autoFocus
            openSnooglOnMount
            aria-label="Insert Canvas root Macro"
            macroCandidates={macroCandidates}
            value=""
            onChange={(value) => {
              const parsed = tryParseSnlSyntaxTree(value.trim());
              if (!parsed.ok) return;
              // Root insertion used to bypass the arity reconciliation shared
              // by every existing-node edit. Consequently a fixed-arity Macro
              // selected from SNooGL entered the Canvas with zero children and
              // no placeholders. Resolve before publishing the new forest, so
              // the first observable frame already has the required slots.
              void (async () => {
                const request = ++addRootRequestRef.current;
                const sourceForest = forestRef.current;
                ensureTreeIdentity(parsed.tree);
                const arity = await macroArityForName(parsed.tree.macro_name);
                if (
                  request !== addRootRequestRef.current ||
                  forestRef.current !== sourceForest
                ) return;
                const next = [...sourceForest, parsed.tree];
                const rootIndex = next.length - 1;
                const targetArity: number | null =
                  arity === 'dynamic'
                    ? (parsed.tree.children.length === 0 ? 1 : null)
                    : arity;
                const reconciled = targetArity === null
                  ? next
                  : reconcileCanvasArity(
                      next,
                      rootIndex,
                      [],
                      targetArity,
                      ensureTreeIdentity
                    );
                setAddingRootFromMacro(false);
                applyForestChange(reconciled, { rootIndex, path: [] });
                window.setTimeout(() => canvasRef.current?.focus(), 0);
              })();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') {
                event.preventDefault();
                closeCanvasInputs();
                window.setTimeout(() => canvasRef.current?.focus(), 0);
              }
            }}
            style={{
              position: 'absolute',
              left: 24,
              top: 24,
              width: '18rem',
              zIndex: 20
            }}
          />
        ) : null}
        {focusedMacroControl ? (
          <div
            data-canvas-macro-control
            data-canvas-arity-control={focusedMacroControl.dynamic ? true : undefined}
            aria-label={focusedMacroControl.dynamic ? 'Argument count' : 'Macro actions'}
            onPointerDown={(event) => event.stopPropagation()}
            style={{
              position: 'absolute',
              left: focusedMacroControl.left,
              top: focusedMacroControl.top,
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem',
              padding: '0.15rem 0.3rem',
              borderRadius: '0.35rem',
              background: 'var(--vscode-editorWidget-background, #252526)',
              border: '1px solid var(--vscode-editorWidget-border, #454545)',
              zIndex: 19
            }}
          >
            {focusedMacroControl.dynamic ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label="Remove an argument"
                  disabled={focusedMacroControl.count === 0}
                  onClick={() => changeDynamicArity(focusedMacroControl.target, -1)}
                >
                  −
                </Button>
                <span aria-label="Argument count value" style={{ minWidth: '1.2rem', textAlign: 'center' }}>
                  {focusedMacroControl.count}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label="Add argument"
                  onClick={() => changeDynamicArity(focusedMacroControl.target, 1)}
                >
                  +
                </Button>
              </>
            ) : null}
            {(() => {
              const node = focusedMacroControl.node;
              const name = node.macro_name.trim();
              const known = Boolean(macroOrigin[name]);
              const styleNames = macroStylesByName.get(name) ?? [];
              const selectedStyle = node.style_name ?? styleNames[0] ?? '';
              const explicitStyleMissing =
                Boolean(node.style_name) && !styleNames.includes(node.style_name!);
              return (
                <>
                  {styleNames.length > 0 || explicitStyleMissing ? (
                    <select
                      aria-label="Macro style"
                      value={selectedStyle}
                      onChange={(event) =>
                        changeCanvasStyle(
                          focusedMacroControl.target,
                          event.target.value,
                          styleNames
                        )
                      }
                      onKeyDown={(event) => event.stopPropagation()}
                      title="Select Macro style"
                      style={{
                        maxWidth: '9rem',
                        padding: '0.15rem 0.3rem',
                        background: 'var(--vscode-dropdown-background, #2a2a2a)',
                        color: 'var(--vscode-dropdown-foreground, #ddd)',
                        border: '1px solid var(--vscode-dropdown-border, #555)'
                      }}
                    >
                      {explicitStyleMissing && styleNames.length === 0 ? (
                        <option value="">(clear style)</option>
                      ) : null}
                      {explicitStyleMissing ? (
                        <option value={node.style_name}>{node.style_name} (missing)</option>
                      ) : null}
                      {styleNames.map((style, index) => (
                        <option key={style} value={style}>
                          {style}{index === 0 ? ' (default)' : ''}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={known ? 'Edit macro' : 'Create macro'}
                    title={
                      known
                        ? `Open Edit Macro: ${name} (${macroOrigin[name]})`
                        : `Open Create Macro (prefill id "${name}")`
                    }
                    onClick={() =>
                      onOpenMacroEditor({
                        name,
                        env_mode: node.env_mode === 'block' ? undefined : node.env_mode,
                        style_name: node.style_name
                      })
                    }
                  >
                    ↗
                  </Button>
                </>
              );
            })()}
          </div>
        ) : null}
        {contextMenu ? (
          <CanvasContextMenuView
            menu={contextMenu}
            node={contextMenu.rootIndex < 0 ? undefined : getNodeAtPath(
              forestRef.current[contextMenu.rootIndex],
              contextMenu.path.join('.')
            )}
            onAddRoot={() => {
              setEditingNode(null);
              setAddingRootFromMacro(true);
            }}
            onEditMacro={() => startEditingTarget(contextMenu, 'macro')}
            onEditSubtree={() => startEditingTarget(contextMenu, 'subtree')}
            isDynamic={
              contextMenu.rootIndex >= 0 &&
              isDynamicMacro(
                getNodeAtPath(
                  forestRef.current[contextMenu.rootIndex],
                  contextMenu.path.join('.')
                )?.macro_name ?? ''
              )
            }
            onAddArgument={() => {
              setContextMenu(null);
              changeDynamicArity(contextMenu, 1);
            }}
            onRemoveArgument={() => {
              setContextMenu(null);
              changeDynamicArity(contextMenu, -1);
            }}
            onDetach={() => {
              if (contextMenu.path.length === 0) return;
              const next = detachCanvasSubtree(
                forestRef.current,
                contextMenu.rootIndex,
                contextMenu.path,
                parentIsDynamic(contextMenu)
              );
              setContextMenu(null);
              applyForestChange(next, { rootIndex: next.length - 1, path: [] });
            }}
            onDelete={() => {
              const next = deleteCanvasTarget(
                forestRef.current,
                contextMenu.rootIndex,
                contextMenu.path,
                parentIsDynamic(contextMenu)
              );
              setContextMenu(null);
              applyForestChange(next, null);
            }}
            onClose={() => setContextMenu(null)}
          />
        ) : null}
      </div>
      {!canPersistCanvasForest(forest) ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.45rem' }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setFocused(null);
              closeCanvasInputs();
              updateDropTarget(null);
              onResetFromSnl();
            }}
          >
            Reset Canvas from SNL
          </Button>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// GUI Editor (Inductive) — library-outline-styled tree editor
// ---------------------------------------------------------------------------

/**
 * Canvas right-click menu (cat 2026-07-25). Right click on a block owns the
 * gesture: it focuses that subtree and offers the same operations the
 * keyboard exposes, so the Canvas never falls through to the host menu.
 */
function CanvasContextMenuView({
  menu,
  node,
  isDynamic,
  onAddRoot,
  onEditMacro,
  onEditSubtree,
  onAddArgument,
  onRemoveArgument,
  onDetach,
  onDelete,
  onClose
}: {
  menu: CanvasContextMenu;
  node: SnlSyntaxTree | undefined;
  isDynamic: boolean;
  onAddRoot: () => void;
  onEditMacro: () => void;
  onEditSubtree: () => void;
  onAddArgument: () => void;
  onRemoveArgument: () => void;
  onDetach: () => void;
  onDelete: () => void;
  onClose: () => void;
}): React.ReactElement {
  const onBlankSpace = menu.rootIndex < 0;
  const isRoot = menu.path.length === 0;
  const isHole = isCanvasHole(node);
  const items: Array<{ label: string; hint?: string; disabled?: boolean; run: () => void }> =
    onBlankSpace
      ? [{ label: 'Add root Macro', hint: 'Ctrl+F', run: onAddRoot }]
      : [
          { label: 'Edit Macro', hint: 'F2', disabled: isHole, run: onEditMacro },
          { label: 'Edit subtree as SNL', hint: 'Ctrl+F2', run: onEditSubtree },
          // Only a variadic Macro owns its argument count; a fixed-arity one
          // gets it from the template and must not be edited by hand.
          ...(isDynamic
            ? [
                { label: 'Add argument', hint: '+', run: onAddArgument },
                {
                  label: 'Remove an argument',
                  hint: '-',
                  disabled: (node?.children.length ?? 0) === 0,
                  run: onRemoveArgument
                }
              ]
            : []),
          {
            label: 'Detach into its own block',
            disabled: isRoot || isHole,
            run: onDetach
          },
          { label: 'Delete', hint: 'Del', disabled: isHole, run: onDelete }
        ];
  return (
    <div
      role="menu"
      data-canvas-menu
      aria-label="Canvas block actions"
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      style={{
        position: 'absolute',
        left: menu.left,
        top: menu.top,
        zIndex: 50,
        minWidth: '14rem',
        padding: '0.25rem',
        borderRadius: '5px',
        border: '1px solid var(--vscode-widget-border, #555)',
        background: 'var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526))',
        boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
        fontSize: '0.9rem'
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.run();
            onClose();
          }}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '1rem',
            width: '100%',
            padding: '0.3rem 0.5rem',
            border: 'none',
            borderRadius: '3px',
            background: 'transparent',
            color: item.disabled
              ? 'var(--vscode-disabledForeground, #777)'
              : 'var(--vscode-menu-foreground, inherit)',
            cursor: item.disabled ? 'not-allowed' : 'pointer',
            font: 'inherit',
            textAlign: 'left'
          }}
        >
          <span>{item.label}</span>
          {item.hint ? <span style={{ opacity: 0.6 }}>{item.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}

//
// Cat 2026-07-12 reset. The old row was `[input] [+child] [-delete]` with an
// unconditional +child button and a light-mode inline input. This version
// mimics the Library outline (see CreateLibraryApp.tsx `OutlineRow`):
//
//   [chevron?] [#1.2.3] [ ─────── name input ─────── ] [+ child] [− delete]
//                                                       (hover only)
//
// Design notes:
//   1. Input CSS unified to the dark-mode `inputStyle` used across the panel
//      so it stops looking pasted-in.
//   2. Number label sits on the SAME line as the input, and is a full path
//      (`1.2.3`) that grows with depth. Indent + label length correlate so
//      deeper rows look visually anchored.
//   3. Rows with children render a chevron (▶/▼) on the far left; leaves
//      render a same-width spacer so numbers align. Toggle is per-row, held
//      in a `Set<path>` at the editor root.
//   4. +child / −delete only appear on hover (CSS `.snl-tree-row:hover
//      .snl-tree-row-toolbar`), same pattern as OutlineRow.
//   5. When the input text (parsed as a single leaf) resolves to a macro in
//      the merged DB with a `kind`, the input border+bg flip to that kind's
//      palette color. Delimited leaves (`$…$`, `%…%`) also color per their
//      inherent env_mode → mapped kind.
//   6. Syntax the parser understands stays in the text box verbatim: `$foo$`,
//      `$$x + y$$`, `%my text%`, `@$x$`, `foo[style]`, `foo.bar.baz`. On
//      serialize, each row's text is treated as a single leaf's source, then
//      re-hydrated to preserve `env_mode` / `kind='binder'` / `style`. This
//      keeps the round-trip clean without demanding new UI knobs — the raw
//      characters are the source of truth until we build proper inline
//      editors.
//
// The `SnlSyntaxTreeEditor` from @sjtu-ai4math/snl-basics is no longer used here —
// it renders its own recursion + a light-mode autocomplete dropdown that
// clashed with the new row layout. Autocomplete can come back as a separate
// enhancement later.

/**
 * Parse a single-node source string produced by the user (raw text they
 * typed into the row input) into the leaf-level fields of an SnlSyntaxTree.
 * Preserves env_mode / kind='binder' / style tag from the surface syntax.
 *
 * Falls back to `{name: raw, ...}` if the input can't be interpreted as a
 * single leaf — that way the user's typing is never destroyed mid-edit.
 */
function parseLeafSource(raw: string): {
  macro_name: string;
  style_name?: string;
} {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { macro_name: '' };
  }
  // Cat 2026-07-15: the GUI editor is deliberately dumb about sigils —
  // `@`, `%`, `$` and friends are just literal characters that belong in
  // `name` verbatim. Only `()` and `[]` carry structural meaning:
  //   - `(` / `,` are handled at the row boundary (children), so if they
  //     show up inside the head we treat the whole raw string as an
  //     opaque name (defensive; the paren guard on the caller side
  //     usually keeps them out).
  //   - A trailing `[style]` is recognized only so the Macro-name input can
  //     immediately strip it; the independent dropdown is the sole Style writer.
  if (trimmed.includes('(') || trimmed.includes(',')) {
    return { macro_name: raw };
  }
  const styleMatch = trimmed.match(/^(.*)\[([^\[\]]*)\]$/);
  if (styleMatch) {
    return {
      macro_name: styleMatch[1],
      style_name: styleMatch[2].length > 0 ? styleMatch[2] : undefined
    };
  }
  return { macro_name: trimmed };
}

/**
 * Render an SnlSyntaxTree leaf's identity back to the source text the user
 * would have typed for it. Inverse of `parseLeafSource` (round-trippable for
 * the surface forms the row input accepts).
 */
function stringifyLeafSource(node: SnlSyntaxTree): string {
  const stylePart = node.style_name ? `[${node.style_name}]` : '';
  return `${stringifyLeafHead(node)}${stylePart}`;
}

/**
 * Same as `stringifyLeafSource` but omits the `[style]` suffix. Used for
 * the InductiveNode name-box `rawInput`, paired with a separate style
 * box on the right.
 *
 * Cat 2026-07-15 (v2): the name box shows literal characters — the
 * editor no longer reconstructs sigils (`@`, `%…%`, `$…$`, `$${'$'}…$${'$'}`)
 * from `node.env_mode` / `node.kind`. Those fields are meaningful for
 * trees that came from an external SNL parse; for those, the name still
 * carries the identifier without the sigils and we prepend/wrap them so
 * the first render truthfully mirrors the source. But on ANY user edit,
 * `commitRaw` clears env_mode + kind and stores whatever the user typed
 * verbatim into `name` — so if you backspace the `@` off `@foo` it
 * actually goes away instead of the useEffect re-adding it. See
 * "GUI Editor 应该只管圆括号和方括号" for the design directive.
 */
function stringifyLeafHead(node: SnlSyntaxTree): string {
  const binderPrefix = node.kind === 'binder' ? '@' : '';
  if (node.env_mode === 'text') {
    return `${binderPrefix}%${node.macro_name}%`;
  }
  if (node.env_mode === 'formula_inline') {
    return `${binderPrefix}$${node.macro_name}$`;
  }
  if (node.env_mode === 'formula_display') {
    return `${binderPrefix}$${'$'}${node.macro_name}$${'$'}`;
  }
  return `${binderPrefix}${node.macro_name}`;
}

/**
 * Resolve the effective `kind` for a row so we can color its input frame.
 * Priority: node.kind (set by parser for `@`-binder / annotate-bind) →
 * macro's declared kind in the merged DB → env_mode-driven default →
 * 'fvar' fallback (mirrors DEFAULT_KIND_PALETTE fallback used elsewhere).
 */
function resolveRowKind(node: SnlSyntaxTree, macro: SnlMacro | undefined): string {
  if (node.kind && node.kind !== '') return node.kind;
  if (macro?.kind) return macro.kind;
  if (node.env_mode === 'text') return 'const';
  if (node.env_mode === 'formula_inline' || node.env_mode === 'formula_display') {
    return 'const';
  }
  return 'fvar';
}

function useQueriedMacro(
  driver: MacroDataDriver,
  macroName: string
): SnlMacro | undefined {
  const [macro, setMacro] = useState<SnlMacro | undefined>(undefined);
  // Epoch guard: `query_macro` has an LRU cache, so a cache HIT for the new
  // name can resolve long before an in-flight MISS for the previous one. The
  // AbortController only guards the driver's entry point, not a promise that
  // already resolved, so without this a late answer for an old name lands on
  // the current node — either opening slots that belong to the previous Macro
  // or clearing a result that had already arrived. Review 2026-07-25.
  const epochRef = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++epochRef.current;
    const settle = (value: SnlMacro | undefined): void => {
      if (epochRef.current === epoch) setMacro(value);
    };
    settle(undefined);
    void driver.query_macro({ macro_name: macroName, signal: controller.signal })
      .then((value) => settle(value ?? undefined))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          settle(undefined);
        }
      });
    return () => controller.abort();
  }, [driver, macroName]);
  return macro;
}

/**
 * Fixed-arity a macro's default-style template implies. Returns the
 * required child count (i.e. max #N + 1 across all styles, since child
 * slots are numbered from 0). Returns 0 for dynamic-arity macros or
 * templates with no `#N` placeholders. Ignores escaped `\#`. Mirrors
 * `maxChildIndex` in CreateMacroApp.tsx — kept local to avoid a shared
 * module just for one 8-line helper.
 */
function macroTemplateArity(macro: SnlMacro): number {
  let max = -1;
  for (const style of macro.styles ?? []) {
    const tpl = resolve_style_template(style, webview_language_runtime);
    const re = /(?<!\\)#(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tpl)) !== null) {
      const idx = Number(m[1]);
      if (Number.isFinite(idx) && idx > max) max = idx;
    }
  }
  return max + 1;
}

function paletteFor(kindId: string): KindColoring {
  return DEFAULT_KIND_PALETTE[kindId] ?? DEFAULT_KIND_PALETTE.fvar;
}

/**
 * Payload for opening the Macro editor from a row (cat 2026-07-12). Sent
 * verbatim as a `openMacroEditor` message; the host picks edit vs create
 * and, on create, uses env_mode to prefill the mode + template.
 */
interface MacroOpenRequest {
  name: string;
  env_mode?: 'formula_inline' | 'formula_display' | 'text';
  style_name?: string;
}

export function GuiInductiveEditor({
  snl,
  macroDataDriver,
  macroCandidates,
  macroOrigin,
  onOpenMacroEditor,
  onChange
}: {
  snl: string;
  macroDataDriver: MacroDataDriver;
  macroCandidates: readonly SnooglSearchCandidate[];
  macroOrigin: Record<string, string>;
  onOpenMacroEditor: (req: MacroOpenRequest) => void;
  onChange: (nextSnl: string) => void;
}): React.ReactElement {
  const [tree, setTree] = useState<SnlSyntaxTree>(() => {
    const initial = parseOrDefault(snl);
    ensureTreeIdentity(initial);
    return initial;
  });
  const [parseError, setParseError] = useState<string | null>(null);
  // Collapse follows stable UI node identity, not a dotted array-index path.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const lastSerializedRef = useRef<string>(serializeTreePreserving(tree));

  useEffect(() => {
    if (snl === lastSerializedRef.current) return;
    const parsed = tryParseSnlSyntaxTree(snl.trim() || '_snl_stub');
    if (parsed.ok) {
      ensureTreeIdentity(parsed.tree);
      setTree(parsed.tree);
      setParseError(null);
      lastSerializedRef.current = serializeTreePreserving(parsed.tree);
    } else {
      setParseError(parsed.error);
    }
  }, [snl]);

  const propagate = useCallback(
    (nextTree: SnlSyntaxTree): void => {
      ensureTreeIdentity(nextTree);
      setTree(nextTree);
      // Unfilled `+ child` rows now survive serialization: `foo(a,)` and
      // `foo(,b)` are valid SNL that round trips (cat 2026-07-25), so the
      // Inductive and Canvas editors agree on what a half-finished tree
      // means. Only the one unserializable shape is pruned — see
      // `stripEmptyPlaceholders`.
      const pruned = stripEmptyPlaceholders(nextTree);
      const nextSnl = serializeTreePreserving(pruned);
      lastSerializedRef.current = nextSnl;
      setParseError(null);
      onChange(nextSnl);
    },
    [onChange]
  );

  /**
   * Set a row's child count, addressed by path and applied against the LATEST
   * tree rather than a render-time snapshot.
   *
   * Arity auto-fill runs from an effect, so every unfilled sibling fires in
   * the same commit. Routing those writes through `onChange({...node})` made
   * each sibling overwrite the previous one's result — only the last sibling
   * kept its slots. A functional, path-addressed update composes instead.
   * Review 2026-07-25.
   */
  const setRowArity = useCallback(
    (path: string, count: number): void => {
      setTree((previous) => {
        const next = withArityAtPath(previous, path, count);
        if (next === previous) return previous;
        ensureTreeIdentity(next);
        const nextSnl = serializeTreePreserving(stripEmptyPlaceholders(next));
        lastSerializedRef.current = nextSnl;
        onChange(nextSnl);
        return next;
      });
    },
    [onChange]
  );

  // Path-based tree operations (cat 2026-07-15): add parent/sibling, indent,
  // outdent. Implemented as single top-level transforms so cross-node
  // rearrangements (indent/outdent) don't need to chain multiple
  // stale-state onChange calls up the tree. Path is the same dotted
  // form used by `collapsed` — '' for root, '0', '0.1', etc.
  const treeOp = useCallback(
    (op: 'wrapParent' | 'addSibling' | 'indent' | 'outdent' | 'moveUp' | 'moveDown', path: string): void => {
      const next = applyTreeOp(tree, op, path);
      if (next !== tree) propagate(next);
    },
    [tree, propagate]
  );

  const toggleCollapsed = useCallback((nodeId: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  return (
    <div
      className="snl-inductive-editor"
      style={{
        border:
          '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
        borderRadius: '3px',
        padding: '0.4rem 0.3rem',
        background: 'var(--vscode-editorWidget-background, #252526)'
      }}
    >
      {/* Pure-CSS hover/focus reveal for the per-row toolbar. The row reserves
          the toolbar's width only while it is visible, so the flexible Macro
          input contracts instead of letting the actions spill outside. */}
      <style>{`
        .snl-inductive-editor {
          container-name: snl-inductive;
          container-type: inline-size;
        }
        .snl-tree-row-toolbar {
          position: absolute;
          right: 0.3rem;
          top: 50%;
          transform: translateY(-50%);
          opacity: 0;
          pointer-events: none;
          transition: opacity 90ms ease-in;
        }
        .snl-tree-row {
          padding-block: 0.15rem;
          padding-right: 0.3rem;
          transition: padding-right 90ms ease-in, padding-bottom 90ms ease-in;
        }
        .snl-tree-row:hover .snl-tree-row-toolbar,
        .snl-tree-row:focus-within .snl-tree-row-toolbar {
          opacity: 1;
          pointer-events: auto;
        }
        .snl-tree-row:hover,
        .snl-tree-row:focus-within {
          padding-right: 6.65rem;
        }
        @container snl-inductive (max-width: 30rem) {
          .snl-tree-row:hover,
          .snl-tree-row:focus-within {
            padding-right: 0.3rem;
            padding-bottom: 3.8rem;
          }
          .snl-tree-row-toolbar {
            top: auto;
            bottom: 0.15rem;
            transform: none;
          }
          .snl-tree-row:has(.snl-tree-add-menu) {
            padding-bottom: 5.8rem;
          }
          .snl-tree-row:has(.snl-tree-add-menu) .snl-tree-row-toolbar {
            bottom: 2.15rem;
          }
        }
      `}</style>

      {parseError ? (
        <div
          style={{
            margin: '0 0.3rem 0.4rem',
            padding: '0.3rem 0.5rem',
            background: 'rgba(220, 60, 60, 0.12)',
            border: '1px solid rgba(220, 60, 60, 0.55)',
            color: 'var(--vscode-errorForeground, #f48771)',
            borderRadius: '3px',
            fontSize: '0.78rem'
          }}
        >
          Text-mode SNL is not parseable ({parseError}). Tree shown reflects
          the last successful parse; editing here will overwrite the Text
          content on next change.
        </div>
      ) : null}

      <InductiveNode
        node={tree}
        path=""
        numberPath=""
        depth={0}
        siblingCount={1 /* root has no siblings; move-up/down guarded by path==='' */}
        onChange={propagate}
        onDelete={undefined /* root cannot be deleted */}
        macroDataDriver={macroDataDriver}
        macroCandidates={macroCandidates}
        macroOrigin={macroOrigin}
        onOpenMacroEditor={onOpenMacroEditor}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        treeOp={treeOp}
        setRowArity={setRowArity}
      />
      <p
        style={{
          margin: '0.4rem 0.3rem 0',
          fontSize: '0.72rem',
          opacity: 0.55,
          fontStyle: 'italic'
        }}
      >
        Inductive editor — hover a row for the action dial. Delimited
        forms are recognized: <code>$foo$</code>, <code>$$x+y$$</code>,{' '}
        <code>%text%</code>, <code>@$x$</code>. Choose Style from the adjacent dropdown.
      </p>
    </div>
  );
}

/** Best-effort parse: returns a stub root when the text is empty / invalid. */
function parseOrDefault(text: string): SnlSyntaxTree {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return createSnlSyntaxTreeNode('_snl_stub');
  }
  const parsed = tryParseSnlSyntaxTree(trimmed);
  return parsed.ok ? parsed.tree : createSnlSyntaxTreeNode('_snl_stub');
}

/**
 * Serialize a tree back to SNL source, preserving the surface syntax that
 * `serializeSnlSyntaxTree` from @sjtu-ai4math/snl-basics drops on the floor.
 *
 * The library's serializer emits `name(children)` verbatim — it ignores
 * `env_mode`, `style`, and `kind='binder'`. That's fine when the tree came
 * from a parser that stripped delimiters into the payload, but for us it's
 * catastrophic: a leaf `{name:'foo', env_mode:'text'}` (which the user typed
 * as `%foo%`) round-trips as bare `foo`, and the parser rejects it on the
 * next reparse. Cat 2026-07-12: "GUI Editor 改完会把 % 等语法元素吃掉".
 *
 * Fix: use `stringifyLeafSource` for the head at every level so `%…%` /
 * `$…$` / `$$…$$` / `@` / `[style]` all survive. Children still recurse.
 */
export function serializeTreePreserving(node: SnlSyntaxTree): string {
  const head = stringifyLeafSource(node);
  const childrenPart =
    node.children.length > 0
      ? `(${node.children.map(serializeTreePreserving).join(',')})`
      : '';
  return `${head}${childrenPart}`;
}

/**
 * Drop empty placeholder rows that cannot be serialized.
 *
 * Cat 2026-07-25: an empty row is now a real SNL empty node — `foo(a,)` and
 * `foo(,b)` parse fine and round trip — so unfilled slots are KEPT, matching
 * what the Canvas editor does. Switching between the two editors must not
 * silently drop the author's slots.
 *
 * The one exception is a lone empty child (`foo(<empty>)`), which would
 * serialize to `foo()` and reparse as ZERO arguments, losing the slot. That
 * single shape is still pruned so the text stays readable-back.
 */
export function stripEmptyPlaceholders(node: SnlSyntaxTree): SnlSyntaxTree {
  const kids = node.children.map(stripEmptyPlaceholders);
  const isEmptyRow = (child: SnlSyntaxTree): boolean =>
    child.macro_name.trim() === '' && child.children.length === 0;
  if (kids.length === 1 && isEmptyRow(kids[0])) {
    return { ...node, children: [] };
  }
  return { ...node, children: kids };
}

/**
 * Structural tree operations invoked from row-side buttons (cat
 * 2026-07-15). All three are pure — they return a new tree and never
 * mutate. Path is the dotted form used elsewhere ('', '0', '0.1', ...).
 *
 *   - wrapParent: insert an empty parent above the row at `path`. The
 *     original row becomes the sole child of the new parent. Root can
 *     be wrapped (result: the whole tree becomes the new root's only
 *     child).
 *   - indent: turn the row at `path` into a child of its immediate
 *     preceding sibling. No-op if the row has no preceding sibling
 *     (first child) or if `path` is root.
 *   - outdent: promote the row at `path` up one level, inserted right
 *     after its former parent among the grandparent's children. No-op
 *     for root or for direct children of root (nothing to outdent to).
 *
 * Returns the same object when the op is a no-op, so treeOp can bail
 * without triggering a needless propagate.
 */
/**
 * Return `tree` with the node at `path` padded to `count` children.
 *
 * Grows with empty rows and shrinks only while the surplus is entirely
 * empty — the same contract the arity effect used to apply in place, but
 * expressed as a pure transform so concurrent sibling updates compose
 * instead of overwriting each other. Returns the SAME tree when nothing
 * changes, so callers keep their no-op semantics.
 */
export function withArityAtPath(
  tree: SnlSyntaxTree,
  path: string,
  count: number
): SnlSyntaxTree {
  const steps = path === '' ? [] : path.split('.').map(Number);
  const isEmptyRow = (child: SnlSyntaxTree): boolean =>
    child.macro_name.trim() === '' && child.children.length === 0;

  const walk = (node: SnlSyntaxTree, depth: number): SnlSyntaxTree => {
    if (depth === steps.length) {
      if (count > node.children.length) {
        return {
          ...node,
          children: [
            ...node.children,
            ...Array.from(
              { length: count - node.children.length },
              () => createSnlSyntaxTreeNode('')
            )
          ]
        };
      }
      const surplus = node.children.slice(count);
      if (surplus.length === 0 || !surplus.every(isEmptyRow)) return node;
      return { ...node, children: node.children.slice(0, count) };
    }
    const index = steps[depth];
    const child = node.children[index];
    if (!child) return node;
    const nextChild = walk(child, depth + 1);
    if (nextChild === child) return node;
    const children = node.children.slice();
    children[index] = nextChild;
    return { ...node, children };
  };

  return walk(tree, 0);
}

function applyTreeOp(
  tree: SnlSyntaxTree,
  op: 'wrapParent' | 'addSibling' | 'indent' | 'outdent' | 'moveUp' | 'moveDown',
  path: string
): SnlSyntaxTree {
  if (op === 'wrapParent') {
    if (path === '') {
      // Wrap the whole root inside a new empty parent.
      return { ...createSnlSyntaxTreeNode(''), children: [tree] };
    }
    return transformAtPath(tree, path, (row) => ({
      ...createSnlSyntaxTreeNode(''),
      children: [row]
    }));
  }
  const parts = path.split('.').filter((s) => s.length > 0);
  if (parts.length === 0) return tree;
  const idx = Number(parts[parts.length - 1]);
  const parentPath = parts.slice(0, -1).join('.');
  if (op === 'addSibling') {
    return transformChildrenAtPath(tree, parentPath, (kids) => {
      const nextKids = kids.slice();
      nextKids.splice(idx + 1, 0, createSnlSyntaxTreeNode(''));
      return nextKids;
    });
  }
  if (op === 'indent') {
    if (idx === 0) return tree; // no preceding sibling
    return transformChildrenAtPath(tree, parentPath, (kids) => {
      const moving = kids[idx];
      const prev = kids[idx - 1];
      const nextKids = kids.slice();
      nextKids.splice(idx, 1);
      nextKids[idx - 1] = { ...prev, children: [...prev.children, moving] };
      return nextKids;
    });
  }
  if (op === 'moveUp' || op === 'moveDown') {
    // Sibling reorder among the same parent's children (cat 2026-07-15).
    // No-op at the edge (first row can't move up; last row can't move down).
    return transformChildrenAtPath(tree, parentPath, (kids) => {
      const swapWith = op === 'moveUp' ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= kids.length) return kids;
      const nextKids = kids.slice();
      [nextKids[idx], nextKids[swapWith]] = [nextKids[swapWith], nextKids[idx]];
      return nextKids;
    });
  }
  // outdent: needs a grandparent (parentPath must be non-root).
  if (op === 'outdent') {
    if (parentPath === '') return tree;
    const parentParts = parentPath.split('.').filter((s) => s.length > 0);
    const parentIdx = Number(parentParts[parentParts.length - 1]);
    const grandpaPath = parentParts.slice(0, -1).join('.');
    // Snapshot the moving row BEFORE mutating the parent's children,
    // otherwise the closure reads a stale reference.
    const parentNode = getNodeAtPath(tree, parentPath);
    if (!parentNode) return tree;
    const moving = parentNode.children[idx];
    if (!moving) return tree;
    // Two-step: (1) remove `moving` from parent; (2) insert it after
    // parent in grandpa. Do both in a single transformChildrenAtPath on
    // the grandpa — build a fresh parent shorn of `moving`, then insert
    // `moving` right after it.
    return transformChildrenAtPath(tree, grandpaPath, (kids) => {
      const oldParent = kids[parentIdx];
      const newParent = {
        ...oldParent,
        children: oldParent.children.filter((_, j) => j !== idx)
      };
      const nextKids = kids.slice();
      nextKids[parentIdx] = newParent;
      nextKids.splice(parentIdx + 1, 0, moving);
      return nextKids;
    });
  }
  return tree;
}

function transformAtPath(
  tree: SnlSyntaxTree,
  path: string,
  fn: (n: SnlSyntaxTree) => SnlSyntaxTree
): SnlSyntaxTree {
  if (path === '') return fn(tree);
  const parts = path.split('.').filter((s) => s.length > 0);
  const [head, ...rest] = parts;
  const idx = Number(head);
  if (!Number.isInteger(idx) || idx < 0 || idx >= tree.children.length) {
    return tree;
  }
  const nextChild = transformAtPath(tree.children[idx], rest.join('.'), fn);
  if (nextChild === tree.children[idx]) return tree;
  const nextChildren = tree.children.slice();
  nextChildren[idx] = nextChild;
  return { ...tree, children: nextChildren };
}

function transformChildrenAtPath(
  tree: SnlSyntaxTree,
  path: string,
  fn: (kids: SnlSyntaxTree[]) => SnlSyntaxTree[]
): SnlSyntaxTree {
  return transformAtPath(tree, path, (n) => ({ ...n, children: fn(n.children) }));
}

function getNodeAtPath(
  tree: SnlSyntaxTree,
  path: string
): SnlSyntaxTree | undefined {
  if (path === '') return tree;
  const parts = path.split('.').filter((s) => s.length > 0);
  let cur: SnlSyntaxTree | undefined = tree;
  for (const p of parts) {
    const i = Number(p);
    if (!cur || !Number.isInteger(i) || i < 0 || i >= cur.children.length) {
      return undefined;
    }
    cur = cur.children[i];
  }
  return cur;
}

/**
 * One row in the inductive editor. See the file-level block comment above
 * `GuiInductiveEditor` for the layout / interaction contract.
 */
function InductiveNode({
  node,
  path,
  numberPath,
  depth,
  siblingCount,
  onChange,
  onDelete,
  macroDataDriver,
  macroCandidates,
  macroOrigin,
  onOpenMacroEditor,
  collapsed,
  onToggleCollapsed,
  treeOp,
  setRowArity
}: {
  node: SnlSyntaxTree;
  /** Dotted path from root; root = "", children = "0", "0.1", ... */
  path: string;
  /** Human-visible number, e.g. "1", "1.2", "1.2.3" (root = ""). */
  numberPath: string;
  depth: number;
  /**
   * Number of children the parent has (i.e. this row's sibling group
   * size, including self). Root is passed 1. Used to disable ↓ move-down
   * at the last row without a second tree lookup. Cat 2026-07-15.
   */
  siblingCount: number;
  onChange: (next: SnlSyntaxTree) => void;
  /** Undefined for the root row. */
  onDelete: (() => void) | undefined;
  macroDataDriver: MacroDataDriver;
  macroCandidates: readonly SnooglSearchCandidate[];
  macroOrigin: Record<string, string>;
  onOpenMacroEditor: (req: MacroOpenRequest) => void;
  collapsed: Set<string>;
  onToggleCollapsed: (nodeId: string) => void;
  /**
   * Path-based structural ops routed to the top-level GuiInductiveEditor
   * (cat 2026-07-15). Row-side buttons '+ parent', '⇥ indent', '⇤ outdent',
   * '↑ move up', '↓ move down' all dispatch through here so cross-node
   * rearrangements don't need multi-level onChange chaining.
   */
  setRowArity: (path: string, count: number) => void;
  treeOp: (
    op: 'wrapParent' | 'addSibling' | 'indent' | 'outdent' | 'moveUp' | 'moveDown',
    path: string
  ) => void;
}): React.ReactElement {
  const nodeId = treeIdentity(node);
  const [rawInput, setRawInput] = React.useState<string>(() =>
    stringifyLeafHead(node)
  );
  const [addMenuOpen, setAddMenuOpen] = React.useState(false);
  const addControlRef = React.useRef<HTMLDivElement>(null);
  const addMenuId = React.useId();

  React.useEffect(() => {
    if (!addMenuOpen) return;
    addControlRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (!addControlRef.current?.contains(event.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [addMenuOpen]);

  // Sync from external changes (e.g. text mode edit → re-parse → new tree).
  // Only reset if the incoming node's stringified form differs from what we
  // last showed, so mid-typing user edits aren't clobbered.
  React.useEffect(() => {
    const canonical = stringifyLeafHead(node);
    setRawInput((prev) => (prev.trim() === canonical.trim() ? prev : canonical));
  }, [node.macro_name, node.env_mode, node.kind, node.style_name]);

  const commitRaw = (nextRaw: string): void => {
    const leaf = parseLeafSource(nextRaw);
    // Never leave bracket syntax looking accepted in the Macro-name channel.
    // Canonicalize it immediately while preserving the model's independent Style.
    setRawInput(
      leaf.style_name !== undefined ? leaf.macro_name : nextRaw
    );
    onChange({
      ...node,
      macro_name: leaf.macro_name,
      // Cat 2026-07-15: the GUI editor no longer manages sigils. Any
      // user edit collapses the node's parsed env_mode/kind meta into
      // whatever literal chars are now in `name`, so backspacing a
      // sigil actually deletes it (previously `kind: leaf.kind ||
      // node.kind` re-latched the old `binder` and the `@` came back).
      env_mode: undefined,
      kind: '',
      // Macro text owns identity/env syntax only. Style is changed exclusively
      // by the adjacent dropdown, so typing/pasting `id[style]` cannot mutate it.
      style_name: node.style_name,
      children: node.children
    });
  };


  const addChild = (): void => {
    // New child inherits nothing — empty leaf. Expand the parent so the new
    // child is visible immediately.
    if (collapsed.has(nodeId)) onToggleCollapsed(nodeId);
    onChange({
      ...node,
      children: [...node.children, createSnlSyntaxTreeNode('')]
    });
  };
  const chooseAddPosition = (position: 'parent' | 'child' | 'sibling'): void => {
    setAddMenuOpen(false);
    if (position === 'parent') treeOp('wrapParent', path);
    else if (position === 'child') addChild();
    else if (path !== '') treeOp('addSibling', path);
    // Structural operations may move or remount this row. Restore focus by its
    // stable tree identity, not by a ref that can point at an unmounted dial.
    window.requestAnimationFrame(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-snl-tree-node-id]'))
        .find((candidate) => candidate.dataset.snlTreeNodeId === nodeId);
      row?.querySelector<HTMLButtonElement>('[aria-label="Choose add position"]')?.focus();
    });
  };
  const updateChild = (i: number, next: SnlSyntaxTree): void => {
    const nextChildren = node.children.slice();
    nextChildren[i] = next;
    onChange({ ...node, children: nextChildren });
  };
  const deleteChild = (i: number): void => {
    const nextChildren = node.children.filter((_, idx) => idx !== i);
    onChange({ ...node, children: nextChildren });
  };

  const hasKids = node.children.length > 0;
  const isCollapsed = collapsed.has(nodeId);
  const macroEntry = useQueriedMacro(macroDataDriver, node.macro_name);
  /**
   * The Macro whose arity has already been reconciled for this row, so
   * reclaiming surplus slots happens once per Macro change rather than on
   * every render — otherwise `+ child` would be undone as fast as it is
   * clicked.
   */
  const reconciledMacroRef = useRef<string | null>(null);
  const effectiveKind = resolveRowKind(node, macroEntry);
  const palette = paletteFor(effectiveKind);
  const macroMatched = Boolean(macroEntry) || node.env_mode !== undefined;

  /**
   * Open the child rows a fixed-arity Macro requires, as soon as the row
   * actually resolves to one.
   *
   * This used to live in `commitRaw`, which made it dead in the common case:
   * `useQueriedMacro` is keyed on `node.macro_name`, so at the moment the
   * author finishes typing `pair` the lookup for `pair` has not run yet —
   * `macroEntry` still holds the PREVIOUS name's result, the
   * `leaf.macro_name === node.macro_name` guard fails, and no slots appear.
   * It only ever fired when re-committing an already-resolved name.
   *
   * Reacting to the resolved macro instead fires exactly once, when the
   * answer arrives. Cat 2026-07-25.
   */
  useEffect(() => {
    // No stale-name check needed: `useQueriedMacro` is keyed on
    // `node.macro_name` and clears to undefined while a new lookup is in
    // flight, so a defined `macroEntry` always describes the current name.
    if (!macroEntry || macroEntry.dynamic_arity === true) return;
    const requiredArity = macroTemplateArity(macroEntry);
    if (requiredArity > node.children.length) {
      setRowArity(path, requiredArity);
      // Expand the row so the new slots are visible immediately — otherwise
      // the author just sees the frame border change color with no other cue.
      if (collapsed.has(nodeId)) onToggleCollapsed(nodeId);
      return;
    }
    // Retyping one Macro over another leaves the previous Macro's slots
    // behind (`pair` opens two, then `atom` needs none and the row would
    // serialize as `atom(,)`). Reclaim that surplus — but only on the edit
    // that actually changed the Macro, and only while the surplus is
    // entirely empty.
    //
    // Both conditions matter. Without the first, `+ child` on a fixed-arity
    // row is undone the instant the author clicks it and the button looks
    // broken; without the second, work the author already typed would be
    // silently deleted. Review 2026-07-25.
    if (reconciledMacroRef.current === macroEntry.name) return;
    reconciledMacroRef.current = macroEntry.name;
    if (node.children.length > requiredArity) setRowArity(path, requiredArity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [macroEntry, node.macro_name, node.children.length]);

  // Frame: kind palette when the row resolved to a pool macro (or an
  // env_mode leaf); default gray when the name doesn't match anything.
  // fvar-kind macros DO get the palette's fvar color (red) — that's the
  // author's declared kind, so it's what we surface. If a macro looks red
  // and shouldn't, fix its `kind` in .SNL_Doc/term_macros/*.json.
  const frameBorder = macroMatched
    ? palette.stroke
    : 'var(--vscode-input-border, var(--vscode-contrastBorder, #555))';
  const frameBackground = macroMatched
    ? kindBackgroundTint(palette.background)
    : 'var(--vscode-input-background, #2a2a2a)';

  // Style is a separate dropdown channel; MacroIdInput owns identity only.
  const styleTags = (macroEntry?.styles ?? [])
    .map((style) => style.style_name)
    .filter((style): style is string => Boolean(style));
  const defaultStyleTag = styleTags[0] ?? '';
  const styleAvailable = styleTags.length > 0;
  const styleIsExplicit = node.style_name !== undefined && node.style_name !== '';
  const styleDisplay = styleIsExplicit ? node.style_name! : defaultStyleTag;
  const styleUsesDefault = styleAvailable && styleDisplay === defaultStyleTag;
  const explicitStyleMissing =
    styleIsExplicit && !styleTags.includes(node.style_name!);
  const styleSelectable = styleAvailable || explicitStyleMissing;

  const commitStyle = (nextValue: string): void => {
    const trimmed = nextValue.trim();
    // Empty or default → implicit (drop the field so serialization stays
    // as `foo(…)` rather than `foo[default](…)`).
    const nextStyle =
      trimmed === '' || trimmed === defaultStyleTag ? undefined : trimmed;
    onChange({ ...node, style_name: nextStyle });
  };

  return (
    <div>
      <div
        className="snl-tree-row"
        data-snl-tree-node-id={nodeId}
        style={{
          display: 'flex',
          position: 'relative',
          overflow: 'visible',
          alignItems: 'center',
          gap: '0.35rem',
          paddingLeft: `${0.3 + depth * 1.1}rem`,
          // Very subtle depth-tint so nested rows visually anchor.
          background:
            depth === 0
              ? 'transparent'
              : `rgba(255,255,255,${Math.min(0.015 * depth, 0.08)})`
        }}
      >
        {/* Chevron toggle OR spacer, so numbers/inputs line up regardless. */}
        {hasKids ? (
          <Button
            type="button"
            onClick={() => onToggleCollapsed(nodeId)}
            style={chevronButtonStyle}
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
            title={isCollapsed ? 'Expand' : 'Collapse'}
          >
            {isCollapsed ? '▶' : '▼'}
          </Button>
        ) : (
          <span
            style={{ width: '1.1rem', flexShrink: 0, display: 'inline-block' }}
          />
        )}

        {/* Full number path (e.g. #1.2.3). Root shows nothing so the input
            starts flush. Width scales with depth so indent visually
            correlates with number length. */}
        <span
          style={{
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: '0.9rem',
            color: 'var(--vscode-descriptionForeground, #888)',
            minWidth: numberPath ? `${Math.max(2, numberPath.length + 1)}ch` : 0,
            flexShrink: 0
          }}
        >
          {numberPath ? `#${numberPath}` : ''}
        </span>

        {/* Name input — dark-mode uniform styling + kind-colored frame. */}
        <MacroIdInput
          value={rawInput}
          macroCandidates={macroCandidates}
          onChange={commitRaw}
          placeholder={depth === 0 ? 'root macro' : 'name / $expr$ / %text% / @…'}
          spellCheck={false}
          style={{
            ...inputStyle,
            flex: '1 1 auto',
            padding: '0.25rem 0.5rem',
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: '1rem',
            borderColor: frameBorder,
            background: frameBackground,
            color: 'var(--vscode-input-foreground, #ddd)'
          }}
          title={
            macroMatched
              ? `kind: ${effectiveKind}${macroEntry ? '' : ' (from env_mode)'}`
              : 'name does not match any macro in the current DB'
          }
        />

        <select
          value={styleDisplay}
          disabled={!styleSelectable}
          onChange={(event) => commitStyle(event.target.value)}
          aria-label={`Macro style for ${node.macro_name || 'unresolved Macro'}`}
          title={
            explicitStyleMissing
              ? `Style [${node.style_name}] is missing; choose clear or a declared Style`
              : !styleAvailable
                ? 'Style unavailable — name does not match a Macro with styles'
                : styleIsExplicit
                  ? `explicit style: [${node.style_name}]`
                  : `default style (implicit): [${defaultStyleTag}]`
          }
          style={{
            ...inputStyle,
            width: '7rem',
            minWidth: '4rem',
            flexShrink: 1,
            padding: '0.25rem 0.4rem',
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: '0.8rem',
            opacity: !styleSelectable ? 0.35 : 1,
            background: 'var(--vscode-dropdown-background, var(--vscode-input-background, #2a2a2a))',
            color: styleUsesDefault
              ? 'var(--vscode-descriptionForeground, #999)'
              : 'var(--vscode-dropdown-foreground, var(--vscode-input-foreground, #ddd))',
            borderColor:
              'var(--vscode-dropdown-border, var(--vscode-input-border, #555))',
            cursor: !styleSelectable ? 'not-allowed' : 'default'
          }}
        >
          {!styleAvailable ? (
            <option value="">{explicitStyleMissing ? '(clear style)' : 'style'}</option>
          ) : null}
          {explicitStyleMissing ? (
            <option value={node.style_name}>{node.style_name} (missing)</option>
          ) : null}
          {styleTags.map((style, index) => (
            <option key={style} value={style}>
              {style}{index === 0 ? ' ★' : ''}
            </option>
          ))}
        </select>

        <div
          className="snl-tree-row-toolbar"
          style={{ zIndex: 10 }}
        >
          {(() => {
            const trimmed = node.macro_name.trim();
            const known = trimmed !== '' && Boolean(macroOrigin[trimmed]);
            const title = known
              ? `Open Edit Macro: ${trimmed} (${macroOrigin[trimmed]})`
              : node.env_mode === 'text'
                ? `Open Create Macro (text mode, prefill "${trimmed}")`
                : node.env_mode === 'formula_inline'
                  ? `Open Create Macro (formula_inline, prefill "${trimmed}")`
                  : node.env_mode === 'formula_display'
                    ? `Open Create Macro (formula_display, prefill "${trimmed}")`
                    : trimmed === ''
                      ? 'Open Create Macro (blank)'
                      : `Open Create Macro (prefill id "${trimmed}")`;
            return (
              <Button
                variant="ghost"
                size="sm"
                className="snl-tree-compact-action"
                onClick={() =>
                  onOpenMacroEditor({
                    name: trimmed,
                    env_mode: node.env_mode === 'block' ? undefined : node.env_mode,
                    style_name: node.style_name
                  })
                }
                title={title}
                aria-label={known ? 'Edit macro' : 'Create macro'}
                style={{
                  color: known
                    ? 'var(--vscode-textLink-foreground, #4a9eff)'
                    : 'var(--vscode-descriptionForeground, #999)'
                }}
              >
                ↗
              </Button>
            );
          })()}
          {(() => {
            const parts = path.split('.').filter((part) => part.length > 0);
            const index = parts.length > 0 ? Number(parts[parts.length - 1]) : -1;
            const canIndent = parts.length > 0 && index > 0;
            const canOutdent = parts.length >= 2;
            const canMoveUp = parts.length > 0 && index > 0;
            const canMoveDown = parts.length > 0 && index < siblingCount - 1;
            return (
              <div className="snl-tree-operation-cluster">
                <div ref={addControlRef} className="snl-tree-operation-dial">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="snl-tree-dial-action snl-tree-dial-action--up"
                    onClick={() => canMoveUp && treeOp('moveUp', path)}
                    disabled={!canMoveUp}
                    title={canMoveUp ? 'Move up — swap with preceding sibling' : 'Cannot move up — already first'}
                    aria-label="Move up"
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="snl-tree-dial-action snl-tree-dial-action--outdent"
                    onClick={() => canOutdent && treeOp('outdent', path)}
                    disabled={!canOutdent}
                    title={canOutdent ? 'Outdent — move up one level' : 'Cannot outdent — already at top-level'}
                    aria-label="Outdent"
                  >
                    ←
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="snl-tree-dial-action snl-tree-dial-action--add"
                    onClick={() => setAddMenuOpen((open) => !open)}
                    title="Choose where to add a node"
                    aria-label="Choose add position"
                    aria-haspopup="menu"
                    aria-expanded={addMenuOpen}
                    aria-controls={addMenuOpen ? addMenuId : undefined}
                  >
                    +
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="snl-tree-dial-action snl-tree-dial-action--indent"
                    onClick={() => canIndent && treeOp('indent', path)}
                    disabled={!canIndent}
                    title={canIndent ? 'Indent — become child of preceding sibling' : 'Cannot indent — no preceding sibling'}
                    aria-label="Indent"
                  >
                    →
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="snl-tree-dial-action snl-tree-dial-action--down"
                    onClick={() => canMoveDown && treeOp('moveDown', path)}
                    disabled={!canMoveDown}
                    title={canMoveDown ? 'Move down — swap with following sibling' : 'Cannot move down — already last'}
                    aria-label="Move down"
                  >
                    ↓
                  </Button>
                  {addMenuOpen ? (
                    <div
                      id={addMenuId}
                      role="menu"
                      aria-label="Add node position"
                      className="snl-tree-add-menu"
                      onBlur={(event) => {
                        const next = event.relatedTarget as Node | null;
                        if (!next || !addControlRef.current?.contains(next)) {
                          setAddMenuOpen(false);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.stopPropagation();
                          setAddMenuOpen(false);
                          addControlRef.current
                            ?.querySelector<HTMLButtonElement>('[aria-label="Choose add position"]')
                            ?.focus();
                          return;
                        }
                        if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;
                        event.preventDefault();
                        const items = Array.from(
                          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
                        );
                        const current = items.indexOf(document.activeElement as HTMLButtonElement);
                        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
                        items[(current + step + items.length) % items.length]?.focus();
                      }}
                    >
                      <Button role="menuitem" variant="secondary" size="sm" aria-label="Add parent" onClick={() => chooseAddPosition('parent')} title="Add a parent around this node">parent</Button>
                      <Button role="menuitem" variant="secondary" size="sm" aria-label="Add child" onClick={() => chooseAddPosition('child')} title="Add a child under this node">child</Button>
                      <Button role="menuitem" variant="secondary" size="sm" aria-label="Add sibling" disabled={path === ''} onClick={() => chooseAddPosition('sibling')} title={path === '' ? 'Root cannot have a sibling' : 'Add a sibling after this node'}>sibling</Button>
                    </div>
                  ) : null}
                </div>
                {onDelete ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="snl-tree-compact-action snl-tree-delete-action"
                    onClick={onDelete}
                    title="Delete this subtree"
                    aria-label="Delete subtree"
                  >
                    ×
                  </Button>
                ) : null}
              </div>
            );
          })()}
        </div>
      </div>

      {hasKids && !isCollapsed ? (
        <div>
          {node.children.map((child, i) => {
            const childPath = path === '' ? String(i) : `${path}.${i}`;
            const childNumber =
              numberPath === '' ? String(i + 1) : `${numberPath}.${i + 1}`;
            return (
              <InductiveNode
                key={treeIdentity(child)}
                node={child}
                path={childPath}
                numberPath={childNumber}
                depth={depth + 1}
                siblingCount={node.children.length}
                onChange={(next) => updateChild(i, next)}
                onDelete={() => deleteChild(i)}
                macroDataDriver={macroDataDriver}
                macroCandidates={macroCandidates}
                macroOrigin={macroOrigin}
                onOpenMacroEditor={onOpenMacroEditor}
                collapsed={collapsed}
                onToggleCollapsed={onToggleCollapsed}
                treeOp={treeOp}
                setRowArity={setRowArity}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Map a light-mode palette background (`#DAF0FF` etc.) to a dark-mode tint
 * that's readable behind white text. We take the kind's stroke color at ~15%
 * alpha over the panel bg — small enough to keep contrast, strong enough to
 * signal "this matches kind X".
 */
function kindBackgroundTint(lightBg: string): string {
  // Naive: use the light bg at 18% alpha over transparent. VS Code themes
  // supply their own base; the tint reads as a subtle colored wash on dark.
  const hex = /^#([0-9a-fA-F]{6})$/.exec(lightBg.trim());
  if (hex) {
    const r = parseInt(hex[1].slice(0, 2), 16);
    const g = parseInt(hex[1].slice(2, 4), 16);
    const b = parseInt(hex[1].slice(4, 6), 16);
    return `rgba(${r},${g},${b},0.18)`;
  }
  return 'var(--vscode-input-background, #2a2a2a)';
}

const chevronButtonStyle: React.CSSProperties = {
  width: '1.1rem',
  height: '1.1rem',
  padding: 0,
  fontSize: '0.65rem',
  lineHeight: 1,
  border: 'none',
  background: 'transparent',
  color: 'var(--vscode-descriptionForeground, #888)',
  cursor: 'pointer',
  flexShrink: 0
};

function StatusLine({
  status
}: {
  status: Status;
}): React.ReactElement | null {
  if (status.kind === 'idle' || status.kind === 'creating') {
    return null;
  }

  let text = '';
  let color = 'var(--vscode-foreground, #ddd)';
  if (status.kind === 'created') {
    text = `\u2705 Created entry (id: ${status.id}).`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'updated') {
    text = `\u2705 Updated entry (id: ${status.id}).`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'duplicate') {
    text = `\u26a0\ufe0f ${status.message}`;
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else if (status.kind === 'notFound') {
    text = `\u274c ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'unknownKind') {
    text = `\u26a0\ufe0f ${status.message}`;
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else if (status.kind === 'invalid') {
    text = `\u274c Invalid: ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (
    status.kind === 'noSnlDoc' ||
    status.kind === 'noWorkspace' ||
    status.kind === 'error'
  ) {
    text = `\u274c ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  }

  return (
    <p style={{ marginTop: '1rem', marginBottom: 0, color, fontWeight: 600 }}>
      {text}
    </p>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.4rem 0.55rem',
  marginBottom: 0,
  color: 'var(--vscode-input-foreground, #ddd)',
  background: 'var(--vscode-input-background, #2a2a2a)',
  border:
    '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
  borderRadius: '2px',
  fontFamily: 'inherit',
  fontSize: '0.95rem'
};

const monoStyle: React.CSSProperties = {
  fontFamily: 'var(--vscode-editor-font-family, monospace)'
};
