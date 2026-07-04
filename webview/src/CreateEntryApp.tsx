// SNL Create Entry webview: the Entry editor MVP.
//
// Layout (top → bottom):
//   1. Header    — Title + ID (UUID, regenerate)
//   2. Kind      — dropdown seeded from config.json#entry_kinds
//   3. Preview   — kind-aware live box (stroke + background + mock number)
//   4. Content   — SNL / Typst / LaTeX / Markdown / Text tabs (each its own
//                  textarea; SNL has a Text / GUI sub-switch)
//   5. Contributor — deferred placeholder
//   6. Pointer     — deferred placeholder
//   7. Submit/Cancel + result banner
//
// Preview is intentionally raw-text only: no Typst/LaTeX/Markdown/SNL render
// pipeline yet (that hooks into SNL_Basics later). See Plan.md.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import 'katex/dist/katex.min.css';
import '@snl-basics/react/style.css';
import {
  tryParseSnlSyntaxTree,
  createMacroTemplateQueryFromDb,
  defaultRenderHooks,
  SnlSyntaxTreeView,
  bundledMacroDb,
  type SnlMacroTemplateQuery,
  type SnlRenderHooks
} from '@snl-basics/react';
import {
  getVsCodeApi,
  PANEL_STYLE,
  primaryButton,
  type VsCodeApi
} from './vscodeApi';

// Static, network-free macro DB bundled from @snl-basics/react — typed accessor,
// no cast needed.
const MACRO_DB = bundledMacroDb;
const MACRO_QUERY: SnlMacroTemplateQuery = createMacroTemplateQueryFromDb(MACRO_DB);

// Preview render hooks: demonstrate consumer-side source resolution. The
// CreateEntry panel has no Entry pool loaded, so we surface the raw first
// entry id referenced by a macro's `source` (if any) as an entry ref.
const PREVIEW_HOOKS: SnlRenderHooks = {
  ...defaultRenderHooks,
  resolveSource: (source) => {
    if (source.entries.length === 0) {
      return null;
    }
    const first = source.entries[0];
    return { kind: 'entry', ref: first, displayName: `Entry: ${first}` };
  }
};

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

/**
 * Render a mock number from a numbering DSL. The real counter engine is
 * deferred; for now we show the DSL pattern verbatim as a stand-in (e.g.
 * `"1.1.1"` → `"1.1.1"`, `""` → no number).
 */
function mockNumber(numbering: string): string {
  return (numbering ?? '').trim();
}

export function CreateEntryApp(): React.ReactElement {
  const [mode, setMode] = useState<Mode>('create');
  const [kinds, setKinds] = useState<EntryKind[]>([]);
  const [kindsLoaded, setKindsLoaded] = useState(false);

  const [title, setTitle] = useState('');
  const [id, setId] = useState<string>('');
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
            existing?: ExistingEntry | null;
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
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <input
                id="snl-entry-id"
                type="text"
                value={id}
                placeholder="e.g. pythagorean-theorem"
                onChange={(e) => setId(e.target.value)}
                readOnly={mode === 'edit'}
                title={
                  mode === 'edit'
                    ? 'IDs are immutable; delete + recreate to rename'
                    : undefined
                }
                style={{
                  ...inputStyle,
                  ...monoStyle,
                  marginBottom: 0,
                  color:
                    mode === 'edit'
                      ? 'var(--vscode-descriptionForeground, #999)'
                      : (inputStyle as React.CSSProperties).color,
                  opacity: mode === 'edit' ? 0.7 : 1,
                  cursor: mode === 'edit' ? 'not-allowed' : 'text'
                }}
              />
              {mode === 'edit' ? null : (
                <button
                  type="button"
                  onClick={() => setId(newUuid())}
                  title={
                    trimmedId
                      ? 'Overwrite the ID with a fresh UUID v4'
                      : 'Fill the ID with a fresh UUID v4'
                  }
                  style={{
                    ...primaryButton(true),
                    padding: '0.35rem 0.7rem',
                    whiteSpace: 'nowrap',
                    background:
                      'var(--vscode-button-secondaryBackground, #444)'
                  }}
                >
                  {trimmedId ? 'Regenerate UUID' : 'Generate UUID'}
                </button>
              )}
            </div>
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
                : "Manually enter a semantic id, or click Generate UUID. IDs must be unique in the shared entries pool and stable once created (they're used by future relationship links)."}
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
            title={trimmedTitle}
            format={activeFormat}
            body={content[activeFormat]}
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
                GUI Editor
              </SubTabButton>
            </div>
          ) : null}

          {activeFormat === 'snl' && snlMode === 'gui' ? (
            <PlaceholderBox text="GUI Editor not implemented yet — Tree View / Line View coming later." />
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

function LivePreview({
  kind,
  title,
  format,
  body
}: {
  kind: EntryKind | undefined;
  title: string;
  format: ContentFormat;
  body: string;
}): React.ReactElement {
  const stroke = kind?.coloring.stroke ?? '#888888';
  const background = kind?.coloring.background ?? '#eeeeee';
  const number = kind ? mockNumber(kind.numbering) : '';
  const headerLabel = kind ? kind.name : 'Entry';

  const isSnl = format === 'snl' && body.trim().length > 0;

  return (
    <div
      style={{
        border: `1px solid ${stroke}`,
        background,
        borderRadius: '4px',
        padding: '0.75rem 0.9rem',
        color: '#111'
      }}
    >
      <div
        style={{
          fontWeight: 700,
          marginBottom: '0.4rem',
          color: stroke
        }}
      >
        {headerLabel}
        {number ? ` ${number}` : ''}
        {title ? ` — ${title}` : ''}
      </div>
      {isSnl ? (
        <SnlPreview snl={body} />
      ) : (
        <pre
          style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: '0.85rem',
            color: '#222'
          }}
        >
          {body ? body : '(no content)'}
        </pre>
      )}
    </div>
  );
}

/**
 * Live SNL render for the Entry editor preview. Parses the SNL source and
 * hands the tree to `<SnlSyntaxTreeView>` from @snl-basics/react. Parse
 * failures degrade to a subtle banner + raw-text fallback; render-time throws
 * are caught by {@link SnlRenderErrorBoundary}.
 */
function SnlPreview({ snl }: { snl: string }): React.ReactElement {
  const parsed = useMemo(() => tryParseSnlSyntaxTree(snl), [snl]);

  if (!parsed.ok) {
    return (
      <div>
        <ErrorBanner
          text={`SNL parse error: ${parsed.error}${
            parsed.position !== undefined ? ` (at ${parsed.position})` : ''
          }`}
        />
        <pre
          style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: '0.85rem',
            color: '#222'
          }}
        >
          {snl}
        </pre>
      </div>
    );
  }

  return (
    <SnlRenderErrorBoundary snl={snl}>
      <div style={{ color: '#111', fontSize: '1rem' }}>
        <SnlSyntaxTreeView
          tree={parsed.tree}
          macroDb={MACRO_DB}
          query={MACRO_QUERY}
          hooks={PREVIEW_HOOKS}
        />
      </div>
    </SnlRenderErrorBoundary>
  );
}

function ErrorBanner({ text }: { text: string }): React.ReactElement {
  return (
    <div
      style={{
        margin: '0 0 0.5rem',
        padding: '0.4rem 0.6rem',
        borderRadius: '3px',
        background: '#fdecea',
        border: '1px solid #f5c2c0',
        color: '#8a1f11',
        fontSize: '0.8rem',
        fontFamily: 'var(--vscode-editor-font-family, monospace)'
      }}
    >
      {text}
    </div>
  );
}

/**
 * Catches render-time throws from `<SnlSyntaxTreeView>` (e.g. a KaTeX failure
 * or an unexpected tree shape) and shows a red banner + raw-text fallback
 * instead of blanking the whole webview.
 */
class SnlRenderErrorBoundary extends React.Component<
  { snl: string; children: React.ReactNode },
  { message: string | null }
> {
  constructor(props: { snl: string; children: React.ReactNode }) {
    super(props);
    this.state = { message: null };
  }

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidUpdate(prev: { snl: string }): void {
    if (prev.snl !== this.props.snl && this.state.message !== null) {
      this.setState({ message: null });
    }
  }

  override render(): React.ReactNode {
    if (this.state.message !== null) {
      return (
        <div>
          <ErrorBanner text={`SNL render error: ${this.state.message}`} />
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'var(--vscode-editor-font-family, monospace)',
              fontSize: '0.85rem',
              color: '#222'
            }}
          >
            {this.props.snl}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
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
