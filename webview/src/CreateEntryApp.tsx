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
import {
  attachCanvasRoot,
  canPersistCanvasForest,
  createCanvasHole,
  deleteCanvasTarget,
  detachCanvasSubtree,
  isCanvasHole,
  moveCanvasCursor,
  reconcileCanvasArity,
  replaceCanvasTarget
} from './entry-editor/canvasForest';
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
      for (const [name, macro] of Object.entries(bundledMacros)) {
        candidates.set(name, { id: name, labels: macro.tags ?? [] });
      }
      for (const [name, macro] of Object.entries(wireMacros)) {
        candidates.set(name, { id: name, labels: macro.tags ?? [] });
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

  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const apiRef = useRef<VsCodeApi | undefined>(undefined);
  const formDirtyRef = useRef(false);
  const contentDirtyRef = useRef<Set<LocalizableContentFormat>>(new Set());
  const editingIdRef = useRef('');
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

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | { type: 'kinds'; kinds: EntryKind[] }
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
        case 'context':
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
            const preserveDraft = !!msg.existing &&
              formDirtyRef.current &&
              editingIdRef.current === incomingId;
            if (msg.id) {
              setId(msg.id);
            }
            if (msg.existing && !preserveDraft) {
              editingIdRef.current = incomingId;
              setTitle(msg.existing.title || '');
              setSelectedKind(msg.existing.kind || '');
              const typst = projectLocalizedContent(msg.existing.content?.typst);
              const latex = projectLocalizedContent(msg.existing.content?.latex);
              const markdown = projectLocalizedContent(msg.existing.content?.markdown);
              const text = projectLocalizedContent(msg.existing.content?.text);
              setContent({
                snl: msg.existing.content?.snl ?? '',
                typst: typst.text,
                latex: latex.text,
                markdown: markdown.text,
                text: text.text
              });
              setContentI18n({
                ...(typst.i18n ? { typst: typst.i18n } : {}),
                ...(latex.i18n ? { latex: latex.i18n } : {}),
                ...(markdown.i18n ? { markdown: markdown.i18n } : {}),
                ...(text.i18n ? { text: text.i18n } : {})
              });
              existingMetadataRef.current = {
                contribution_info: msg.existing.contribution_info ?? null,
                pointer: msg.existing.pointer ?? null
              };
              contentDirtyRef.current.clear();
              formDirtyRef.current = false;
            }
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
        case 'created':
          setStatus({ kind: 'created', id: msg.id });
          break;
        case 'updated':
          formDirtyRef.current = false;
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

  function handleCancel(): void {
    if (mode === 'edit') {
      // Cancel in edit mode is a no-op reset that's rarely useful; just clear
      // the status banner so the user can keep editing.
      setStatus({ kind: 'idle' });
      return;
    }
    setTitle('');
    setId('');
    setContent({ snl: '', typst: '', latex: '', markdown: '', text: '' });
    setContentI18n({});
    contentDirtyRef.current.clear();
    formDirtyRef.current = false;
    setActiveFormat('snl');
    setSnlMode('text');
    setStatus({ kind: 'idle' });
    setSelectedKind(kinds.length > 0 ? kinds[0].id : '');
  }

  const noKinds = kindsLoaded && kinds.length === 0;

  return (
    <main
      style={PANEL_STYLE}
      onInputCapture={() => { formDirtyRef.current = true; }}
      onClickCapture={() => { formDirtyRef.current = true; }}
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
                formDirtyRef.current = true;
                setContent((prev) => ({ ...prev, snl: next }));
              }}
            />
          ) : activeFormat === 'snl' && snlMode === 'canvas' ? (
            <GuiCanvasEditor
              forest={canvasForest}
              macroDataDriver={macroDataDriver}
              macroCandidates={macroCandidates}
              kindPalette={kindPalette}
              onForestChange={(nextForest) => {
                setCanvasForest(nextForest);
                if (canPersistCanvasForest(nextForest)) {
                  const nextSnl = serializeTreePreserving(nextForest[0]);
                  formDirtyRef.current = true;
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
                  formDirtyRef.current = true;
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

        {/* 5. Contributor ============================================= */}
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
            Save is disabled while the Canvas syntax forest has multiple roots or
            unresolved placeholders. Attach/fill them or reset the Canvas.
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
}

/**
 * What a Canvas inline editor is allowed to rewrite.
 *
 *   - 'macro'   (F2)      — only this block's own macro head (`name[style]`).
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
  kindPalette,
  onForestChange,
  onResetFromSnl
}: {
  forest: SnlSyntaxTree[];
  macroDataDriver: MacroDataDriver;
  macroCandidates?: readonly SnooglSearchCandidate[];
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
  const forestRef = React.useRef(forest);
  const suppressClickRef = React.useRef(false);
  const suppressCanvasClickRef = React.useRef(false);
  const dragRef = React.useRef<CanvasPendingDrag | null>(null);
  const lastPointerTargetRef = React.useRef<CanvasFocus | null>(null);
  // Local undo stack (Ctrl/Cmd+Z). Canvas edits are structural and easy to
  // mis-aim, so every mutation pushes the pre-change forest before applying.
  const undoStackRef = React.useRef<Array<{ forest: SnlSyntaxTree[]; focused: CanvasFocus | null }>>([]);
  forestRef.current = forest;

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
    setEditingNode(null);
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
  }, [forest]);

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
        const nextForest = detachCanvasSubtree(
          forestRef.current,
          drag.rootIndex,
          drag.path
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
        target.path
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
    const encoded = target.path.join('.');
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
    setEditingNode({
      ...target,
      scope: effectiveScope,
      left: rect.left - canvasRect.left + canvas.scrollLeft,
      top: rect.top - canvasRect.top + canvas.scrollTop,
      value: isCanvasHole(node)
        ? ''
        : effectiveScope === 'macro'
          ? stringifyLeafSource(node)
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
    const editorSurface = editorRef.current?.closest('[data-macro-id-control]');
    return Boolean(editorRef.current?.contains(node) || editorSurface?.contains(node));
  };

  /**
   * The context menu is rendered inside the canvas, so the canvas' own
   * capture-phase click handler and the block pointer handlers would
   * otherwise swallow or preventDefault its clicks — which is exactly why it
   * felt dead. `data-canvas-menu` marks the menu subtree as off-limits.
   *
   * The click guard is defensive against capture-phase ordering: jsdom lets
   * the menu item's onClick run even after the canvas clears the menu, so
   * only the pointerdown path is observable in tests.
   */
  const insideContextMenu = (node: Node | null): boolean =>
    Boolean(node && (node as HTMLElement).closest?.('[data-canvas-menu]'));

  const handleCanvasClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (insideOpenEditor(event.target as Node)) return;
    if (insideContextMenu(event.target as Node)) return;
    if (suppressCanvasClickRef.current) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setContextMenu(null);
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
    setEditingNode(null);
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
    if (editingNode) return;
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
      const next = deleteCanvasTarget(forestRef.current, focused.rootIndex, focused.path);
      applyForestChange(next, null);
      return;
    }
  };

  /**
   * Required child count for a Macro, or null when unknown / dynamic arity
   * (in which case children are left exactly as they are).
   */
  const macroArityForName = async (macroName: string): Promise<number | null> => {
    const name = macroName.trim();
    if (!name) return null;
    try {
      const macro = await macroDataDriver.query_macro({ macro_name: name });
      if (!macro || macro.dynamic_arity === true) return null;
      return macroTemplateArity(macro);
    } catch {
      return null;
    }
  };

  const commitNodeEdit = async (): Promise<void> => {
    if (!editingNode) return;
    const previousNode = getNodeAtPath(
      forestRef.current[editingNode.rootIndex],
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
      const base = previousNode ?? parsedHead.tree;
      replacement = {
        ...base,
        macro_name: parsedHead.tree.macro_name,
        kind: parsedHead.tree.kind,
        env_mode: parsedHead.tree.env_mode,
        style_name: parsedHead.tree.style_name,
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
      forestRef.current,
      editingNode.rootIndex,
      editingNode.path,
      replacement
    );
    if (replaced === forestRef.current) return;
    // Cat 2026-07-25: the new Macro's arity decides what happens to the old
    // children — surplus subtrees pop out as their own root blocks, missing
    // slots become empty placeholders the author fills in manually. Never
    // swallow a subtree and never resurrect one.
    const arity = await macroArityForName(replacement.macro_name);
    const next = arity === null
      ? replaced
      : reconcileCanvasArity(
          replaced,
          editingNode.rootIndex,
          editingNode.path,
          arity,
          // Evicted subtrees become their own blocks; they must keep a stable
          // identity so their canvas position is preserved rather than reset.
          ensureTreeIdentity
        );
    applyForestChange(next);
    setEditingNode(null);
    window.setTimeout(() => canvasRef.current?.focus(), 0);
  };

  React.useEffect(() => {
    if (!editingNode) return;
    const commitOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      const editorSurface = editorRef.current?.closest('[data-macro-id-control]');
      if (target && (editorRef.current?.contains(target) || editorSurface?.contains(target))) return;
      suppressCanvasClickRef.current = true;
      document.addEventListener('click', () => {
        suppressCanvasClickRef.current = false;
      }, { once: true });
      document.addEventListener('pointerup', () => {
        window.setTimeout(() => { suppressCanvasClickRef.current = false; }, 0);
      }, { once: true });
      // Clicking away has the same semantics as Escape: discard the draft.
      setEditingNode(null);
      window.setTimeout(() => canvasRef.current?.focus(), 0);
    };
    document.addEventListener('pointerdown', commitOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', commitOnOutsidePointer, true);
  }, [editingNode]);

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
                hooks={{ renderTooltip: () => null }}
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
              if (event.key === 'Enter') {
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
                : 'Enter SNL DSL and press Enter')
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
            autoFocus
            openSnooglOnMount
            aria-label="Insert Canvas root Macro"
            macroCandidates={macroCandidates}
            value=""
            onChange={(value) => {
              const parsed = tryParseSnlSyntaxTree(value.trim());
              if (!parsed.ok) return;
              ensureTreeIdentity(parsed.tree);
              const next = [...forestRef.current, parsed.tree];
              const rootIndex = next.length - 1;
              setAddingRootFromMacro(false);
              applyForestChange(next, { rootIndex, path: [] });
              window.setTimeout(() => canvasRef.current?.focus(), 0);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') {
                event.preventDefault();
                setAddingRootFromMacro(false);
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
        {contextMenu ? (
          <CanvasContextMenuView
            menu={contextMenu}
            node={contextMenu.rootIndex < 0 ? undefined : getNodeAtPath(
              forestRef.current[contextMenu.rootIndex],
              contextMenu.path.join('.')
            )}
            onAddRoot={() => setAddingRootFromMacro(true)}
            onEditMacro={() => startEditingTarget(contextMenu, 'macro')}
            onEditSubtree={() => startEditingTarget(contextMenu, 'subtree')}
            onDetach={() => {
              if (contextMenu.path.length === 0) return;
              const next = detachCanvasSubtree(
                forestRef.current,
                contextMenu.rootIndex,
                contextMenu.path
              );
              setContextMenu(null);
              applyForestChange(next, { rootIndex: next.length - 1, path: [] });
            }}
            onDelete={() => {
              const next = deleteCanvasTarget(
                forestRef.current,
                contextMenu.rootIndex,
                contextMenu.path
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
              setEditingNode(null);
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
  onAddRoot,
  onEditMacro,
  onEditSubtree,
  onDetach,
  onDelete,
  onClose
}: {
  menu: CanvasContextMenu;
  node: SnlSyntaxTree | undefined;
  onAddRoot: () => void;
  onEditMacro: () => void;
  onEditSubtree: () => void;
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
  //   - A trailing `[style]` is peeled into `node.style_name` so the dedicated
  //     style box on the right can drive it independently.
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
  useEffect(() => {
    const controller = new AbortController();
    setMacro(undefined);
    void driver.query_macro({ macro_name: macroName, signal: controller.signal })
      .then((value) => setMacro(value ?? undefined))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setMacro(undefined);
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

function GuiInductiveEditor({
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
      // Filter empty-name childless leaves before serializing. `+ child`
      // creates a placeholder row with name='' so the user can type into
      // it; if we serialized that verbatim, we'd get `foo(a,)` /
      // `foo(,b)` — both fail the SNL parser and every downstream
      // consumer (preview, save) trips on "Expected IDENT / macro name".
      // Local tree state keeps the empty row so the UI keeps showing it;
      // only the serialized-for-parent view is pruned. (Cat 2026-07-12:
      // "删一个节点就容易不过编译了".)
      const pruned = stripEmptyPlaceholders(nextTree);
      const nextSnl = serializeTreePreserving(pruned);
      lastSerializedRef.current = nextSnl;
      setParseError(null);
      onChange(nextSnl);
    },
    [onChange]
  );

  // Path-based tree operations (cat 2026-07-15): '+ parent', indent,
  // outdent. Implemented as single top-level transforms so cross-node
  // rearrangements (indent/outdent) don't need to chain multiple
  // stale-state onChange calls up the tree. Path is the same dotted
  // form used by `collapsed` — '' for root, '0', '0.1', etc.
  const treeOp = useCallback(
    (op: 'wrapParent' | 'indent' | 'outdent' | 'moveUp' | 'moveDown', path: string): void => {
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
      style={{
        border:
          '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
        borderRadius: '3px',
        padding: '0.4rem 0.3rem',
        background: 'var(--vscode-editorWidget-background, #252526)'
      }}
    >
      {/* Pure-CSS hover-reveal for the per-row toolbar. Same pattern as
          CreateLibraryApp OutlineRow — opacity toggle keeps the buttons in
          layout so hover doesn't shift columns, and browser-native `:hover`
          never drops a leave event. */}
      <style>{`
        .snl-tree-row-toolbar {
          opacity: 0;
          transition: opacity 90ms ease-in;
        }
        .snl-tree-row:hover .snl-tree-row-toolbar,
        .snl-tree-row:focus-within .snl-tree-row-toolbar {
          opacity: 1;
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
      />
      <p
        style={{
          margin: '0.4rem 0.3rem 0',
          fontSize: '0.72rem',
          opacity: 0.55,
          fontStyle: 'italic'
        }}
      >
        Inductive editor — hover a row for + child / − delete. Delimited
        forms are recognized: <code>$foo$</code>, <code>$$x+y$$</code>,{' '}
        <code>%text%</code>, <code>@$x$</code>, <code>foo[style]</code>.
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
function serializeTreePreserving(node: SnlSyntaxTree): string {
  const head = stringifyLeafSource(node);
  const childrenPart =
    node.children.length > 0
      ? `(${node.children.map(serializeTreePreserving).join(',')})`
      : '';
  return `${head}${childrenPart}`;
}

/**
 * Drop empty placeholder rows before serializing. A row with name='' and no
 * children is a `+ child` slot the user hasn't filled yet — keep it in local
 * tree state so the UI shows the empty input, but never let it reach the
 * serializer, which would produce `foo(a,)` / `foo(,b)` / bare empty
 * identifiers that fail the parser at every downstream site (preview, save,
 * lint). Root itself is exempt: an empty root name is the initial stub and
 * we let the parser reject it downstream with a real error.
 */
function stripEmptyPlaceholders(node: SnlSyntaxTree): SnlSyntaxTree {
  const kids = node.children
    .map(stripEmptyPlaceholders)
    .filter((c) => !(c.macro_name.trim() === '' && c.children.length === 0));
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
function applyTreeOp(
  tree: SnlSyntaxTree,
  op: 'wrapParent' | 'indent' | 'outdent' | 'moveUp' | 'moveDown',
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
  treeOp
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
  treeOp: (
    op: 'wrapParent' | 'indent' | 'outdent' | 'moveUp' | 'moveDown',
    path: string
  ) => void;
}): React.ReactElement {
  const nodeId = treeIdentity(node);
  const [rawInput, setRawInput] = React.useState<string>(() =>
    stringifyLeafHead(node)
  );

  // Sync from external changes (e.g. text mode edit → re-parse → new tree).
  // Only reset if the incoming node's stringified form differs from what we
  // last showed, so mid-typing user edits aren't clobbered.
  React.useEffect(() => {
    const canonical = stringifyLeafHead(node);
    setRawInput((prev) => (prev.trim() === canonical.trim() ? prev : canonical));
  }, [node.macro_name, node.env_mode, node.kind, node.style_name]);

  const commitRaw = (nextRaw: string): void => {
    setRawInput(nextRaw);
    const leaf = parseLeafSource(nextRaw);
    // Macro auto-fill lookup: use the literal typed name. If the user
    // has typed sigil chars (e.g. `%foo%`) into the name box, this
    // lookup will (correctly) miss — the row is now a raw literal, not
    // a macro reference. Cat 2026-07-15.
    const matched = leaf.macro_name === node.macro_name ? macroEntry : undefined;
    let nextChildren = node.children;
    if (matched && matched.dynamic_arity !== true) {
      const requiredArity = macroTemplateArity(matched);
      if (requiredArity > node.children.length) {
        const padding = Array.from(
          { length: requiredArity - node.children.length },
          () => createSnlSyntaxTreeNode('')
        );
        nextChildren = [...node.children, ...padding];
        // Expand the row so the newly-created child slots are visible
        // immediately — otherwise the user just sees the frame border
        // change color and has no cue that slots opened.
        if (collapsed.has(nodeId)) onToggleCollapsed(nodeId);
      }
    }
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
      // Style still has its own dedicated box — only overwrite when the
      // typed source explicitly carried a bracket suffix.
      style_name: leaf.style_name !== undefined ? leaf.style_name : node.style_name,
      children: nextChildren
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
  const effectiveKind = resolveRowKind(node, macroEntry);
  const palette = paletteFor(effectiveKind);
  const macroMatched = Boolean(macroEntry) || node.env_mode !== undefined;

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

  // Style-box state (cat 2026-07-12). Behaviour:
  //   - Disabled entirely when no macro matches the current name (env_mode
  //     leaves don't carry `[style]` either — they're literal payloads).
  //   - When node.style_name is set explicitly (user typed one, or parser
  //     extracted `[foo]` from the name), show it at full opacity.
  //   - When node.style_name is unset AND the macro has styles, prefill the
  //     input with `style_name` at low opacity so the user sees which
  //     style would be picked without polluting the serialized SNL. Typing
  //     into it commits the value; clearing to empty (or typing the
  //     default) drops back to the implicit-default form.
  const defaultStyleTag = macroEntry?.styles?.[0]?.style_name ?? '';
  const styleAvailable = (macroEntry?.styles.length ?? 0) > 0;
  const styleIsExplicit = node.style_name !== undefined && node.style_name !== '';
  const styleDisplay = styleIsExplicit ? node.style_name! : defaultStyleTag;

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
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
          padding: '0.15rem 0.3rem',
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

        {/* Style input (cat 2026-07-12). Sits to the right of the name.
            - Disabled when no macro matches (no style semantics available).
            - Full opacity when node.style_name is explicitly set.
            - Low opacity + prefilled with style_name when the resolved
              style is the implicit default — makes it visible which style
              the parser will pick without polluting the SNL. */}
        <input
          type="text"
          value={styleDisplay}
          disabled={!styleAvailable}
          onChange={(e) => commitStyle(e.target.value)}
          placeholder="style"
          spellCheck={false}
          title={
            !styleAvailable
              ? 'style has no meaning here — name does not match a macro'
              : styleIsExplicit
                ? `explicit style: [${node.style_name}]`
                : `default style (implicit): [${defaultStyleTag}]`
          }
          style={{
            ...inputStyle,
            width: '5.5rem',
            flexShrink: 0,
            padding: '0.25rem 0.4rem',
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: '0.8rem',
            opacity: !styleAvailable ? 0.35 : styleIsExplicit ? 1 : 0.5,
            fontStyle: styleIsExplicit ? 'normal' : 'italic',
            background: 'var(--vscode-input-background, #2a2a2a)',
            color: 'var(--vscode-input-foreground, #ddd)',
            borderColor:
              'var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
            cursor: !styleAvailable ? 'not-allowed' : 'text'
          }}
        />

        <div
          className="snl-tree-row-toolbar"
          style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}
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
          <Button
            variant="ghost"
            size="sm"
            onClick={addChild}
            title="Add a child under this node"
            aria-label="Add child"
          >
            + child
          </Button>
          {(() => {
            const parts = path.split('.').filter((s) => s.length > 0);
            const idx =
              parts.length > 0 ? Number(parts[parts.length - 1]) : -1;
            const canIndent = parts.length > 0 && idx > 0;
            const canOutdent = parts.length >= 2;
            const canMoveUp = parts.length > 0 && idx > 0;
            const canMoveDown = parts.length > 0 && idx < siblingCount - 1;
            return (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => treeOp('wrapParent', path)}
                  title="Wrap this row in a new empty parent"
                  aria-label="Add parent"
                >
                  + parent
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => canOutdent && treeOp('outdent', path)}
                  disabled={!canOutdent}
                  title={
                    canOutdent
                      ? 'Outdent — move up one level (become sibling of parent)'
                      : 'Cannot outdent — already at top-level'
                  }
                  aria-label="Outdent"
                >
                  ⇤
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => canIndent && treeOp('indent', path)}
                  disabled={!canIndent}
                  title={
                    canIndent
                      ? 'Indent — become child of preceding sibling'
                      : 'Cannot indent — no preceding sibling'
                  }
                  aria-label="Indent"
                >
                  ⇥
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => canMoveUp && treeOp('moveUp', path)}
                  disabled={!canMoveUp}
                  title={
                    canMoveUp
                      ? 'Move up — swap with preceding sibling'
                      : 'Cannot move up — already first'
                  }
                  aria-label="Move up"
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => canMoveDown && treeOp('moveDown', path)}
                  disabled={!canMoveDown}
                  title={
                    canMoveDown
                      ? 'Move down — swap with following sibling'
                      : 'Cannot move down — already last'
                  }
                  aria-label="Move down"
                >
                  ↓
                </Button>
              </>
            );
          })()}
          {onDelete ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              title="Delete this subtree"
              aria-label="Delete subtree"
              style={{
                color: 'var(--vscode-errorForeground, #f48771)'
              }}
            >
              ✕
            </Button>
          ) : null}
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
