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
  type VsCodeApi
} from './vscodeApi';
import { PanelNav } from './components/PanelNav';
import { Button } from './components/Button';
import { isEntityIdUnique } from './components/formValidation';
import { ensureTreeIdentity, treeIdentity } from './components/treeIdentity';
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
  // Name → owning package (bare filename) for the row-side "open Macro
  // editor" button in the GUI editor. Pushed by the host on `context`.
  const [macroOrigin, setMacroOrigin] = useState<Record<string, string>>({});

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
            seedId?: string;
            kinds: EntryKind[];
            macros?: Record<string, WirePackageMacro>;
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
          setMacroOrigin(
            msg.macroOrigin && typeof msg.macroOrigin === 'object'
              ? msg.macroOrigin
              : {},
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
              macroOrigin={macroOrigin}
              onOpenMacroEditor={(payload) =>
                apiRef.current?.postMessage({
                  type: 'openMacroEditor',
                  ...payload
                })
              }
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
  style?: string;
} {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { name: '' };
  }
  // Cat 2026-07-15: the GUI editor is deliberately dumb about sigils —
  // `@`, `%`, `$` and friends are just literal characters that belong in
  // `name` verbatim. Only `()` and `[]` carry structural meaning:
  //   - `(` / `,` are handled at the row boundary (children), so if they
  //     show up inside the head we treat the whole raw string as an
  //     opaque name (defensive; the paren guard on the caller side
  //     usually keeps them out).
  //   - A trailing `[style]` is peeled into `node.style` so the dedicated
  //     style box on the right can drive it independently.
  if (trimmed.includes('(') || trimmed.includes(',')) {
    return { name: raw };
  }
  const styleMatch = trimmed.match(/^(.*)\[([^\[\]]*)\]$/);
  if (styleMatch) {
    return {
      name: styleMatch[1],
      style: styleMatch[2].length > 0 ? styleMatch[2] : undefined
    };
  }
  return { name: trimmed };
}

/**
 * Render an SnlSyntaxTree leaf's identity back to the source text the user
 * would have typed for it. Inverse of `parseLeafSource` (round-trippable for
 * the surface forms the row input accepts).
 */
function stringifyLeafSource(node: SnlSyntaxTree): string {
  const stylePart = node.style ? `[${node.style}]` : '';
  return `${stringifyLeafHead(node)}${stylePart}`;
}

/**
 * Same as `stringifyLeafSource` but omits the `[style]` suffix. Used for
 * the InductiveNode name-box `rawInput`, paired with a separate style
 * box on the right.
 *
 * Cat 2026-07-15 (v2): the name box shows literal characters — the
 * editor no longer reconstructs sigils (`@`, `%…%`, `$…$`, `$${'$'}…$${'$'}`)
 * from `node.envMode` / `node.kind`. Those fields are meaningful for
 * trees that came from an external SNL parse; for those, the name still
 * carries the identifier without the sigils and we prepend/wrap them so
 * the first render truthfully mirrors the source. But on ANY user edit,
 * `commitRaw` clears envMode + kind and stores whatever the user typed
 * verbatim into `name` — so if you backspace the `@` off `@foo` it
 * actually goes away instead of the useEffect re-adding it. See
 * "GUI Editor 应该只管圆括号和方括号" for the design directive.
 */
function stringifyLeafHead(node: SnlSyntaxTree): string {
  const binderPrefix = node.kind === 'binder' ? '@' : '';
  if (node.envMode === 'text') {
    return `${binderPrefix}%${node.name}%`;
  }
  if (node.envMode === 'formula_inline') {
    return `${binderPrefix}$${node.name}$`;
  }
  if (node.envMode === 'formula_display') {
    return `${binderPrefix}$${'$'}${node.name}$${'$'}`;
  }
  return `${binderPrefix}${node.name}`;
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
    const tpl = style.template ?? '';
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
 * and, on create, uses envMode to prefill the mode + template.
 */
interface MacroOpenRequest {
  name: string;
  envMode?: 'formula_inline' | 'formula_display' | 'text';
  style?: string;
}

function GuiInductiveEditor({
  snl,
  macroDb,
  macroOrigin,
  onOpenMacroEditor,
  onChange
}: {
  snl: string;
  macroDb: SnlMacroDb;
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
        macroDb={macroDb}
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
 * `serializeSnlSyntaxTree` from @snl-basics/react drops on the floor.
 *
 * The library's serializer emits `name(children)` verbatim — it ignores
 * `envMode`, `style`, and `kind='binder'`. That's fine when the tree came
 * from a parser that stripped delimiters into the payload, but for us it's
 * catastrophic: a leaf `{name:'foo', envMode:'text'}` (which the user typed
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
    .filter((c) => !(c.name.trim() === '' && c.children.length === 0));
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
  macroDb,
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
  macroDb: SnlMacroDb;
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
  }, [node.name, node.envMode, node.kind, node.style]);

  const commitRaw = (nextRaw: string): void => {
    setRawInput(nextRaw);
    const leaf = parseLeafSource(nextRaw);
    // Macro auto-fill lookup: use the literal typed name. If the user
    // has typed sigil chars (e.g. `%foo%`) into the name box, this
    // lookup will (correctly) miss — the row is now a raw literal, not
    // a macro reference. Cat 2026-07-15.
    const matched = leaf.name ? macroDb[leaf.name] : undefined;
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
      name: leaf.name,
      // Cat 2026-07-15: the GUI editor no longer manages sigils. Any
      // user edit collapses the node's parsed envMode/kind meta into
      // whatever literal chars are now in `name`, so backspacing a
      // sigil actually deletes it (previously `kind: leaf.kind ||
      // node.kind` re-latched the old `binder` and the `@` came back).
      envMode: undefined,
      kind: '',
      // Style still has its own dedicated box — only overwrite when the
      // typed source explicitly carried a bracket suffix.
      style: leaf.style !== undefined ? leaf.style : node.style,
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
  const effectiveKind = resolveRowKind(node, macroDb);
  const palette = paletteFor(effectiveKind);
  const macroEntry = macroDb[node.name];
  const macroMatched = Boolean(macroEntry) || node.envMode !== undefined;

  // Frame: kind palette when the row resolved to a pool macro (or an
  // envMode leaf); default gray when the name doesn't match anything.
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
  //   - Disabled entirely when no macro matches the current name (envMode
  //     leaves don't carry `[style]` either — they're literal payloads).
  //   - When node.style is set explicitly (user typed one, or parser
  //     extracted `[foo]` from the name), show it at full opacity.
  //   - When node.style is unset AND the macro has styles, prefill the
  //     input with `styles[0].tag` at low opacity so the user sees which
  //     style would be picked without polluting the serialized SNL. Typing
  //     into it commits the value; clearing to empty (or typing the
  //     default) drops back to the implicit-default form.
  const defaultStyleTag = macroEntry?.styles?.[0]?.tag ?? '';
  const styleAvailable = Boolean(macroEntry) && macroEntry.styles.length > 0;
  const styleIsExplicit = node.style !== undefined && node.style !== '';
  const styleDisplay = styleIsExplicit ? node.style! : defaultStyleTag;

  const commitStyle = (nextValue: string): void => {
    const trimmed = nextValue.trim();
    // Empty or default → implicit (drop the field so serialization stays
    // as `foo(…)` rather than `foo[default](…)`).
    const nextStyle =
      trimmed === '' || trimmed === defaultStyleTag ? undefined : trimmed;
    onChange({ ...node, style: nextStyle });
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
          <button
            type="button"
            onClick={() => onToggleCollapsed(nodeId)}
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
            borderColor: frameBorder,
            background: frameBackground,
            color: 'var(--vscode-input-foreground, #ddd)'
          }}
          title={
            macroMatched
              ? `kind: ${effectiveKind}${macroEntry ? '' : ' (from envMode)'}`
              : 'name does not match any macro in the current DB'
          }
        />

        {/* Style input (cat 2026-07-12). Sits to the right of the name.
            - Disabled when no macro matches (no style semantics available).
            - Full opacity when node.style is explicitly set.
            - Low opacity + prefilled with styles[0].tag when the resolved
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
                ? `explicit style: [${node.style}]`
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
            const trimmed = node.name.trim();
            const known = trimmed !== '' && Boolean(macroOrigin[trimmed]);
            const title = known
              ? `Open Edit Macro: ${trimmed} (${macroOrigin[trimmed]})`
              : node.envMode === 'text'
                ? `Open Create Macro (text mode, prefill "${trimmed}")`
                : node.envMode === 'formula_inline'
                  ? `Open Create Macro (formula_inline, prefill "${trimmed}")`
                  : node.envMode === 'formula_display'
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
                    envMode: node.envMode,
                    style: node.style
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
                macroDb={macroDb}
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
