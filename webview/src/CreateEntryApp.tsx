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
// SNL rendering uses a MERGED macroDb: bundledMacroDb (fixture) overridden
// by every macro in every package in the current workspace, shipped via the
// `context` message from createEntryPanel. See 猫猫 2026-07-04 spec 2:
// "Entry 编辑器的 SNL parser 几乎等于没实装 ... 先把它做成能正常根据项目
// 中已有的 Macro 来进行 Parse 和渲染的模式."
//
// GUI Editor (Inductive) wraps @snl-basics/react's SnlSyntaxTreeEditor with
// a Add-child / Remove-node control layer, and syncs bidirectionally with
// the SNL text via parse/serialize round-trips. 猫猫 spec 3: "把 SNL-Basics
// 里的 Syntax Tree Editor 先给它搬过来，变成 GUI Editor (Inductive)".

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import 'katex/dist/katex.min.css';
import '@snl-basics/react/style.css';
import {
  tryParseSnlSyntaxTree,
  serializeSnlSyntaxTree,
  bundledMacroDb,
  createSnlSyntaxTreeNode,
  DEFAULT_KIND_PALETTE,
  type SnlMacro,
  type SnlMacroDb,
  type SnlMacroStyle,
  type SnlSyntaxTree,
  type KindColoring
} from '@snl-basics/react';
import {
  getVsCodeApi,
  PANEL_STYLE,
  primaryButton,
  type VsCodeApi
} from './vscodeApi';
import { PanelNav } from './components/PanelNav';
import { Button } from './components/Button';
import {
  EntityIdSearchBox,
  ENTRY_VALIDATE_RULES
} from './components/EntityIdSearchBox';
import {
  EntryRender,
  type EntryOption,
  type EntryData,
  type EntryKind as RenderEntryKind
} from './render/EntryRender';
import { HoverPopoverProvider } from './render/HoverPopoverProvider';

// ---------------------------------------------------------------------------
// Macro DB merge
// ---------------------------------------------------------------------------

/**
 * The on-disk v6 macro entry shape as shipped from the host (see snlDoc.ts
 * MacroPackageEntry). A superset of the library's render-only SnlMacro:
 * additionally carries the consumer-owned output backends per style.
 * We only mirror the fields the view layer needs.
 */
interface WirePackageStyle {
  tag: string;
  mode: 'formula_inline' | 'formula_display' | 'text' | 'block';
  template: string;
  variadic_left?: string;
  variadic_join?: string;
  variadic_right?: string;
  react_renderer_key?: string;
}
interface WirePackageMacro {
  name: string;
  description?: string;
  source?: { entries?: string[]; urls?: string[] };
  kind?: string;
  dynamic_arity: boolean;
  styles: WirePackageStyle[];
}

/**
 * Convert a wire-shape macro (extended v6 on-disk) to the render-only lib
 * SnlMacro (drops output backends the preview doesn't consume). Mirrors the
 * same shape reduction PackagePanelApp.macroToLibShape does.
 */
function wireMacroToLib(m: WirePackageMacro): SnlMacro {
  const styles: SnlMacroStyle[] = Array.isArray(m.styles)
    ? m.styles.map((s) => {
        const out: SnlMacroStyle = {
          tag: s.tag,
          mode: s.mode,
          template: s.template
        };
        if (s.variadic_left) out.variadic_left = s.variadic_left;
        if (s.variadic_join) out.variadic_join = s.variadic_join;
        if (s.variadic_right) out.variadic_right = s.variadic_right;
        if (s.mode === 'block' && s.react_renderer_key) {
          out.react_renderer_key = s.react_renderer_key;
        }
        return out;
      })
    : [];
  const lib: SnlMacro = {
    name: m.name,
    description: m.description ?? '',
    source: m.source
      ? {
          entries: Array.isArray(m.source.entries) ? m.source.entries : [],
          urls: Array.isArray(m.source.urls) ? m.source.urls : []
        }
      : { entries: [], urls: [] },
    dynamic_arity: !!m.dynamic_arity,
    styles: styles.length > 0
      ? styles
      : [{ tag: 'default', mode: 'formula_inline', template: '' }]
  };
  if (m.kind) lib.kind = m.kind;
  return lib;
}

// Preview now routes through <EntryRender>, which owns its own source
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

type Mode = 'create' | 'edit';

interface ExistingEntry {
  id: string;
  kind: string;
  title: string;
  content: {
    snl?: string;
    typst?: string;
    latex?: string;
    markdown?: string;
    text?: string;
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
  const [mode, setMode] = useState<Mode>('create');
  const [kinds, setKinds] = useState<EntryKind[]>([]);
  const [kindsLoaded, setKindsLoaded] = useState(false);

  /**
   * User-authored macros indexed by name (v6 wire shape from the host).
   * Merged over bundledMacroDb via `macroDb` below. Empty until the first
   * `context` message arrives — parse/render before that only sees the
   * bundled fixture.
   */
  const [wireMacros, setWireMacros] = useState<Record<string, WirePackageMacro>>({});

  // User-only DB (for EntryRender.userMacros, which merges over the core
  // internally via mergeMacroDb) AND merged DB (for the GUI editor which
  // wants a flat lookup).
  const userMacroDb: SnlMacroDb = useMemo(() => {
    const userDb: SnlMacroDb = {};
    for (const [name, m] of Object.entries(wireMacros)) {
      userDb[name] = wireMacroToLib(m);
    }
    return userDb;
  }, [wireMacros]);

  const macroDb: SnlMacroDb = useMemo(
    () => ({ ...bundledMacroDb, ...userMacroDb }),
    [userMacroDb]
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
  const [snlMode, setSnlMode] = useState<'text' | 'gui'>('text');
  const [content, setContent] = useState<Record<ContentFormat, string>>({
    snl: '',
    typst: '',
    latex: '',
    markdown: '',
    text: ''
  });

  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | { type: 'kinds'; kinds: EntryKind[] }
        | {
            type: 'context';
            mode: Mode;
            id?: string;
            kinds: EntryKind[];
            macros?: Record<string, WirePackageMacro>;
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
          setExistingIds(Array.isArray(msg.existingIds) ? msg.existingIds : []);
          if (msg.mode === 'edit') {
            if (msg.id) {
              setId(msg.id);
            }
            if (msg.existing) {
              setTitle(msg.existing.title || '');
              setSelectedKind(msg.existing.kind || '');
              setContent({
                snl: msg.existing.content?.snl ?? '',
                typst: msg.existing.content?.typst ?? '',
                latex: msg.existing.content?.latex ?? '',
                markdown: msg.existing.content?.markdown ?? '',
                text: msg.existing.content?.text ?? ''
              });
            }
          } else {
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
    selectedKind.length > 0 &&
    status.kind !== 'creating';

  function handleSubmit(): void {
    if (!canCreate) {
      return;
    }
    setStatus({ kind: 'creating' });
    const entry = {
      id: trimmedId,
      kind: selectedKind,
      title: trimmedTitle,
      content: {
        snl: content.snl || undefined,
        typst: content.typst || undefined,
        latex: content.latex || undefined,
        markdown: content.markdown || undefined,
        text: content.text || undefined
      },
      contribution_info: null,
      pointer: null
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
    setActiveFormat('snl');
    setSnlMode('text');
    setStatus({ kind: 'idle' });
    setSelectedKind(kinds.length > 0 ? kinds[0].id : '');
  }

  const noKinds = kindsLoaded && kinds.length === 0;

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '48rem' }}>
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
            userMacros={userMacroDb}
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
                active={snlMode === 'text'}
                onClick={() => setSnlMode('text')}
              >
                Text Editor
              </SubTabButton>
              <SubTabButton
                active={snlMode === 'gui'}
                onClick={() => setSnlMode('gui')}
              >
                GUI Editor (Inductive)
              </SubTabButton>
            </div>
          ) : null}

          {activeFormat === 'snl' && snlMode === 'gui' ? (
            <GuiInductiveEditor
              snl={content.snl}
              macroDb={macroDb}
              onChange={(next) =>
                setContent((prev) => ({ ...prev, snl: next }))
              }
            />
          ) : (
            <>
              <textarea
                value={content[activeFormat]}
                onChange={(e) =>
                  setContent((prev) => ({
                    ...prev,
                    [activeFormat]: e.target.value
                  }))
                }
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
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canCreate}
            style={primaryButton(canCreate)}
          >
            {status.kind === 'creating'
              ? mode === 'edit' ? 'Updating\u2026' : 'Creating\u2026'
              : mode === 'edit' ? 'Update Entry' : 'Create Entry'}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            style={{
              ...primaryButton(true),
              background: 'var(--vscode-button-secondaryBackground, #444)'
            }}
          >
            {mode === 'edit' ? 'Reset banner' : 'Cancel'}
          </button>
        </div>

        <StatusLine status={status} />
      </fieldset>
    </main>
  );
}

/**
 * Live preview for the Entry editor. Routes through the SAME `<EntryRender>`
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
  userMacros
}: {
  kind: EntryKind | undefined;
  entryId: string;
  title: string;
  content: Record<ContentFormat, string>;
  entries: EntryOption[];
  userMacros: SnlMacroDb;
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

  // No-op postMessage: preview isn't a navigation surface.
  const noopPostMessage = React.useCallback((_msg: unknown): void => {
    /* preview is inert */
  }, []);

  return (
    <HoverPopoverProvider
      postMessage={noopPostMessage}
      entries={entries}
      userMacros={userMacros}
    >
      <EntryRender
        entry={entry}
        kind={renderKind}
        entries={entries}
        postMessage={noopPostMessage}
        userMacros={userMacros}
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
    <button
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
    </button>
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
    <button
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
    </button>
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
// GUI Editor (Inductive) — library-outline-styled tree editor
// ---------------------------------------------------------------------------
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
//      inherent envMode → mapped kind.
//   6. Syntax the parser understands stays in the text box verbatim: `$foo$`,
//      `$$x + y$$`, `%my text%`, `@$x$`, `foo[style]`, `foo.bar.baz`. On
//      serialize, each row's text is treated as a single leaf's source, then
//      re-hydrated to preserve `envMode` / `kind='binder'` / `style`. This
//      keeps the round-trip clean without demanding new UI knobs — the raw
//      characters are the source of truth until we build proper inline
//      editors.
//
// The `SnlSyntaxTreeEditor` from @snl-basics/react is no longer used here —
// it renders its own recursion + a light-mode autocomplete dropdown that
// clashed with the new row layout. Autocomplete can come back as a separate
// enhancement later.

/**
 * Parse a single-node source string produced by the user (raw text they
 * typed into the row input) into the leaf-level fields of an SnlSyntaxTree.
 * Preserves envMode / kind='binder' / style tag from the surface syntax.
 *
 * Falls back to `{name: raw, ...}` if the input can't be interpreted as a
 * single leaf — that way the user's typing is never destroyed mid-edit.
 */
function parseLeafSource(raw: string): {
  name: string;
  envMode?: 'formula_inline' | 'formula_display' | 'text';
  kind: string;
  style?: string;
} {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { name: '', kind: '' };
  }
  // Parse the source in isolation to let the parser extract envMode /
  // binder / style tag. We synthesize `foo()` if it contains parens
  // already? No — the row input is only the leaf head. If the user typed
  // parens, treat as invalid leaf: keep as raw name.
  if (trimmed.includes('(') || trimmed.includes(',')) {
    return { name: raw, kind: '' };
  }
  const parsed = tryParseSnlSyntaxTree(trimmed);
  if (!parsed.ok) {
    return { name: raw, kind: '' };
  }
  const t = parsed.tree;
  if (t.children.length > 0) {
    // Shouldn't happen given the paren guard above, but be defensive.
    return { name: raw, kind: '' };
  }
  return {
    name: t.name,
    envMode: t.envMode,
    kind: t.kind ?? '',
    style: t.style
  };
}

/**
 * Render an SnlSyntaxTree leaf's identity back to the source text the user
 * would have typed for it. Inverse of `parseLeafSource` (round-trippable for
 * the surface forms the row input accepts).
 */
function stringifyLeafSource(node: SnlSyntaxTree): string {
  const stylePart = node.style ? `[${node.style}]` : '';
  const binderPrefix = node.kind === 'binder' ? '@' : '';
  if (node.envMode === 'text') {
    return `${binderPrefix}%${node.name}%${stylePart}`;
  }
  if (node.envMode === 'formula_inline') {
    return `${binderPrefix}$${node.name}$${stylePart}`;
  }
  if (node.envMode === 'formula_display') {
    return `${binderPrefix}$$${node.name}$$${stylePart}`;
  }
  return `${binderPrefix}${node.name}${stylePart}`;
}

/**
 * Resolve the effective `kind` for a row so we can color its input frame.
 * Priority: node.kind (set by parser for `@`-binder / annotate-bind) →
 * macro's declared kind in the merged DB → envMode-driven default →
 * 'fvar' fallback (mirrors DEFAULT_KIND_PALETTE fallback used elsewhere).
 */
function resolveRowKind(node: SnlSyntaxTree, macroDb: SnlMacroDb): string {
  if (node.kind && node.kind !== '') return node.kind;
  const macro = macroDb[node.name];
  if (macro?.kind) return macro.kind;
  if (node.envMode === 'text') return 'const';
  if (node.envMode === 'formula_inline' || node.envMode === 'formula_display') {
    return 'const';
  }
  return 'fvar';
}

function paletteFor(kindId: string): KindColoring {
  return DEFAULT_KIND_PALETTE[kindId] ?? DEFAULT_KIND_PALETTE.fvar;
}

function GuiInductiveEditor({
  snl,
  macroDb,
  onChange
}: {
  snl: string;
  macroDb: SnlMacroDb;
  onChange: (nextSnl: string) => void;
}): React.ReactElement {
  const [tree, setTree] = useState<SnlSyntaxTree>(() => parseOrDefault(snl));
  const [parseError, setParseError] = useState<string | null>(null);
  // Collapsed paths (dotted, root = ''; children = '0', '0.1', ...).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const lastSerializedRef = useRef<string>(serializeSnlSyntaxTree(tree));

  useEffect(() => {
    if (snl === lastSerializedRef.current) return;
    const parsed = tryParseSnlSyntaxTree(snl.trim() || '_snl_stub');
    if (parsed.ok) {
      setTree(parsed.tree);
      setParseError(null);
      lastSerializedRef.current = serializeSnlSyntaxTree(parsed.tree);
    } else {
      setParseError(parsed.error);
    }
  }, [snl]);

  const propagate = useCallback(
    (nextTree: SnlSyntaxTree): void => {
      setTree(nextTree);
      const nextSnl = serializeSnlSyntaxTree(nextTree);
      lastSerializedRef.current = nextSnl;
      setParseError(null);
      onChange(nextSnl);
    },
    [onChange]
  );

  const toggleCollapsed = useCallback((path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
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
        onChange={propagate}
        onDelete={undefined /* root cannot be deleted */}
        macroDb={macroDb}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
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
 * One row in the inductive editor. See the file-level block comment above
 * `GuiInductiveEditor` for the layout / interaction contract.
 */
function InductiveNode({
  node,
  path,
  numberPath,
  depth,
  onChange,
  onDelete,
  macroDb,
  collapsed,
  onToggleCollapsed
}: {
  node: SnlSyntaxTree;
  /** Dotted path from root; root = "", children = "0", "0.1", ... */
  path: string;
  /** Human-visible number, e.g. "1", "1.2", "1.2.3" (root = ""). */
  numberPath: string;
  depth: number;
  onChange: (next: SnlSyntaxTree) => void;
  /** Undefined for the root row. */
  onDelete: (() => void) | undefined;
  macroDb: SnlMacroDb;
  collapsed: Set<string>;
  onToggleCollapsed: (path: string) => void;
}): React.ReactElement {
  const [rawInput, setRawInput] = React.useState<string>(() =>
    stringifyLeafSource(node)
  );

  // Sync from external changes (e.g. text mode edit → re-parse → new tree).
  // Only reset if the incoming node's stringified form differs from what we
  // last showed, so mid-typing user edits aren't clobbered.
  React.useEffect(() => {
    const canonical = stringifyLeafSource(node);
    setRawInput((prev) => (prev.trim() === canonical.trim() ? prev : canonical));
  }, [node.name, node.envMode, node.kind, node.style]);

  const commitRaw = (nextRaw: string): void => {
    setRawInput(nextRaw);
    const leaf = parseLeafSource(nextRaw);
    onChange({
      ...node,
      name: leaf.name,
      envMode: leaf.envMode,
      kind: leaf.kind || node.kind || '',
      style: leaf.style
    });
  };

  const addChild = (): void => {
    // New child inherits nothing — empty leaf. Expand the parent so the new
    // child is visible immediately.
    if (collapsed.has(path)) onToggleCollapsed(path);
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
  const isCollapsed = collapsed.has(path);
  const effectiveKind = resolveRowKind(node, macroDb);
  const palette = paletteFor(effectiveKind);
  const macroMatched = Boolean(macroDb[node.name]) || node.envMode !== undefined;

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
          <button
            type="button"
            onClick={() => onToggleCollapsed(path)}
            style={chevronButtonStyle}
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
            title={isCollapsed ? 'Expand' : 'Collapse'}
          >
            {isCollapsed ? '▶' : '▼'}
          </button>
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
            fontSize: '0.75rem',
            color: 'var(--vscode-descriptionForeground, #888)',
            minWidth: numberPath ? `${Math.max(2, numberPath.length + 1)}ch` : 0,
            flexShrink: 0
          }}
        >
          {numberPath ? `#${numberPath}` : ''}
        </span>

        {/* Name input — dark-mode uniform styling + kind-colored frame. */}
        <input
          type="text"
          value={rawInput}
          onChange={(e) => commitRaw(e.target.value)}
          placeholder={depth === 0 ? 'root macro' : 'name / $expr$ / %text% / @…'}
          spellCheck={false}
          style={{
            ...inputStyle,
            flex: '1 1 auto',
            padding: '0.25rem 0.5rem',
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: '0.85rem',
            // Kind-colored frame when the name matches a known macro or is a
            // delimited leaf. Unmatched names keep the default dark input
            // border so it's easy to see what's still unbound.
            borderColor: macroMatched
              ? palette.stroke
              : 'var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
            // Tint the input's background with the kind color at low alpha
            // so the shape stays legible on dark themes.
            background: macroMatched
              ? kindBackgroundTint(palette.background)
              : 'var(--vscode-input-background, #2a2a2a)',
            color: 'var(--vscode-input-foreground, #ddd)'
          }}
          title={
            macroMatched
              ? `kind: ${effectiveKind}${macroDb[node.name] ? '' : ' (from envMode)'}`
              : 'name does not match any macro in the current DB'
          }
        />

        <div
          className="snl-tree-row-toolbar"
          style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}
        >
          <button
            type="button"
            onClick={addChild}
            title="Add a child under this node"
            aria-label="Add child"
            style={inductiveMiniButton}
          >
            + child
          </button>
          {onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              title="Delete this subtree"
              aria-label="Delete subtree"
              style={{
                ...inductiveMiniButton,
                color: 'var(--vscode-errorForeground, #f48771)',
                borderColor: 'var(--vscode-errorForeground, #f48771)'
              }}
            >
              − delete
            </button>
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
                key={i}
                node={child}
                path={childPath}
                numberPath={childNumber}
                depth={depth + 1}
                onChange={(next) => updateChild(i, next)}
                onDelete={() => deleteChild(i)}
                macroDb={macroDb}
                collapsed={collapsed}
                onToggleCollapsed={onToggleCollapsed}
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

const inductiveMiniButton: React.CSSProperties = {
  padding: '0.15rem 0.5rem',
  border:
    '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #666))',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  borderRadius: '3px',
  fontFamily: 'inherit',
  fontSize: '0.75rem'
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
