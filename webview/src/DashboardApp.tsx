// SNL Dashboard webview: project overview + library management.
//
// The Dashboard mirrors the management/reading split: this is the *manage*
// surface (compare with the Infoview which is the *read* surface). On
// mount it asks the host for an overview; the host re-pushes whenever
// `.SNL_Doc/(config|entries).json` or any `libraries/*/graph.json`
// changes (via FileSystemWatcher).
//
// Section order (top → bottom):
//   1. Libraries    — per-library management (primary content)
//   2. Entries      — shared entry pool (primary content)
//   3. SNL Macros   — term-macro package files
//   4. Entry Kinds  — catalogue of entry categories
//   5. Macro Kinds  — catalogue of macro categories
//
// This matches the reader's natural priority: what libraries exist, what
// entries live in the shared pool, then the packaged macros used by them,
// with the catalogue metadata (kinds) at the bottom as reference.
//
// Every section is a `CollapsibleSection` — the header shows count + toggle
// chevron; the body is only mounted when expanded. Default state = all
// collapsed (极简，用户按需展开). Each section's body ends with a full-width
// dashed "+" bar (`AddBar`) that dispatches the section's create/init
// message; when the list is empty the section shows only that bar.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './components/Button';
import {
  getVsCodeApi,
  PANEL_STYLE,
  primaryButton,
  type VsCodeApi
} from './vscodeApi';

interface LibrarySummary {
  slug: string;
  title: string;
  entryCount: number | null;
  relationshipCount: number | null;
}

interface MacroPackageSummary {
  file: string;
  macroCount: number | null;
  active?: boolean;
}

/**
 * SNoogL search-index entry: one per macro across every package. Mirrors
 * snlDoc.ts's `AllMacroIndexEntry`. Deliberately narrow — no styles /
 * templates — because the search box only matches on `id` and shows the
 * origin package for context.
 */
interface AllMacroIndexEntry {
  id: string;
  packageFile: string;
  packageName: string;
  kind?: string;
}

interface EntryKind {
  id: string;
  name: string;
  coloring: { stroke: string; background: string };
  numbering: string;
  style: string;
}

interface MacroKind {
  id: string;
  name: string;
  description: string;
  coloring: { stroke: string; background: string };
}

interface EntryData {
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

interface RelationshipData {
  id: string;
  from: string;
  to: string;
  label: string;
  metadata: unknown;
}

interface SnlOverview {
  hasSnlDoc: boolean;
  totalEntryCount: number | null;
  entries: EntryData[];
  libraries: LibrarySummary[];
  macroPackages: MacroPackageSummary[];
  /** SNoogL search index — see AllMacroIndexEntry. */
  allMacros: AllMacroIndexEntry[];
  entryKinds: EntryKind[];
  macroKinds: MacroKind[];
  relationships: RelationshipData[];
}

const EMPTY: SnlOverview = {
  hasSnlDoc: false,
  totalEntryCount: null,
  entries: [],
  libraries: [],
  macroPackages: [],
  allMacros: [],
  entryKinds: [],
  macroKinds: [],
  relationships: []
};

export function DashboardApp(): React.ReactElement {
  const [overview, setOverview] = useState<SnlOverview>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | { type: 'overview'; overview: SnlOverview }
        | undefined;
      if (!msg || msg.type !== 'overview') {
        return;
      }
      setOverview(msg.overview);
      setLoaded(true);
    }
    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (!loaded) {
    return (
      <main style={PANEL_STYLE}>
        <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
          SNL Dashboard
        </h1>
        <p style={{ opacity: 0.7 }}>Loading project overview…</p>
      </main>
    );
  }

  if (!overview.hasSnlDoc) {
    return <NotInitialized api={apiRef.current} />;
  }

  return <Initialized overview={overview} api={apiRef.current} />;
}

/** Placeholder shown when `.SNL_Doc/` is missing. */
function NotInitialized({
  api
}: {
  api: VsCodeApi | undefined;
}): React.ReactElement {
  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '36rem' }}>
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
        SNL Dashboard
      </h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.85 }}>
        This workspace does not have an <code>.SNL_Doc/</code> folder yet.
        Run <code>SNL: Init</code> to create the skeleton first.
      </p>
      <button
        type="button"
        onClick={() => api?.postMessage({ type: 'init' })}
        style={primaryButton(true)}
      >
        Run SNL: Init
      </button>
    </main>
  );
}

function Initialized({
  overview,
  api
}: {
  overview: SnlOverview;
  api: VsCodeApi | undefined;
}): React.ReactElement {
  // All sections default collapsed. State is local (per-mount) — cheap and
  // avoids workspaceState round-trips; users open what they care about.
  const [openLibraries, setOpenLibraries] = useState(false);
  const [openEntries, setOpenEntries] = useState(false);
  const [openRelationships, setOpenRelationships] = useState(false);
  const [openMacros, setOpenMacros] = useState(false);
  const [openEntryKinds, setOpenEntryKinds] = useState(false);
  const [openMacroKinds, setOpenMacroKinds] = useState(false);

  const totalEntries =
    overview.totalEntryCount === null ? '—' : overview.totalEntryCount;
  const hasKinds = overview.entryKinds.length > 0;
  const hasMacroKinds = overview.macroKinds.length > 0;

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '62rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem',
          marginBottom: '1rem'
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1.4rem' }}>SNL Dashboard</h1>
        <button
          type="button"
          onClick={() => api?.postMessage({ type: 'openInfoview' })}
          title="Open the Infoview (reading surface)"
          style={{
            flex: '0 0 auto',
            padding: '0.35rem 0.75rem',
            fontFamily: 'inherit',
            fontSize: '0.85rem',
            border:
              '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
            borderRadius: '4px',
            background:
              'var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06))',
            color: 'inherit',
            cursor: 'pointer'
          }}
        >
          Open Infoview →
        </button>
      </div>

      {/* === 1. Libraries ================================================== */}
      <CollapsibleSection
        title="Libraries"
        subtitle={`${overview.libraries.length} librar${
          overview.libraries.length === 1 ? 'y' : 'ies'
        }`}
        expanded={openLibraries}
        onToggle={() => setOpenLibraries((v) => !v)}
      >
        {overview.libraries.length > 0 ? (
          <LibrariesTable
            libraries={overview.libraries}
            onOpen={(slug) =>
              api?.postMessage({ type: 'editLibrary', slug })
            }
            onDelete={(slug) =>
              api?.postMessage({ type: 'deleteLibrary', slug })
            }
          />
        ) : null}
        <AddBar
          label="Create Library"
          onActivate={() => api?.postMessage({ type: 'createLibrary' })}
        />
      </CollapsibleSection>

      {/* === 2. Entries =================================================== */}
      <CollapsibleSection
        title="Entries"
        subtitle={`${totalEntries} entries in shared pool`}
        expanded={openEntries}
        onToggle={() => setOpenEntries((v) => !v)}
      >
        {overview.entries.length > 0 ? (
          <EntriesTable
            entries={overview.entries}
            kinds={overview.entryKinds}
            onOpen={(id) => api?.postMessage({ type: 'editEntry', id })}
            onDelete={(id) =>
              api?.postMessage({ type: 'deleteEntry', id })
            }
          />
        ) : null}
        <AddBar
          label="Create Entry"
          onActivate={() => api?.postMessage({ type: 'createEntry' })}
        />
      </CollapsibleSection>

      {/* === 3. Relationships ============================================ */}
      <CollapsibleSection
        title="Relationships"
        subtitle={`${overview.relationships.length} edge${
          overview.relationships.length === 1 ? '' : 's'
        }`}
        expanded={openRelationships}
        onToggle={() => setOpenRelationships((v) => !v)}
      >
        {overview.relationships.length > 0 ? (
          <RelationshipsTable
            relationships={overview.relationships}
            entries={overview.entries}
            onOpen={(id) =>
              api?.postMessage({ type: 'editRelationship', id })
            }
            onDelete={(id) =>
              api?.postMessage({ type: 'deleteRelationship', id })
            }
          />
        ) : null}
        <AddBar
          label="Create Relationship"
          onActivate={() =>
            api?.postMessage({ type: 'createRelationship' })
          }
        />
      </CollapsibleSection>

      {/* === 4. SNL Macros ================================================ */}
      <CollapsibleSection
        title="SNL Macros"
        subtitle={`${overview.macroPackages.length} package${
          overview.macroPackages.length === 1 ? '' : 's'
        }`}
        expanded={openMacros}
        onToggle={() => setOpenMacros((v) => !v)}
      >
        <SnoogLBar
          allMacros={overview.allMacros}
          onOpenPackage={(file) =>
            api?.postMessage({ type: 'openMacroPackage', file })
          }
        />
        {overview.macroPackages.length > 0 ? (
          <MacroPackagesTable
            packages={overview.macroPackages}
            onOpen={(file) =>
              api?.postMessage({ type: 'openMacroPackage', file })
            }
            onSetActive={(file, active) =>
              api?.postMessage({ type: 'setPackageActive', file, active })
            }
            onDelete={(file) =>
              api?.postMessage({ type: 'deleteMacroPackage', file })
            }
          />
        ) : null}
        <AddBar
          label="Add Package"
          onActivate={() => api?.postMessage({ type: 'createMacroPackage' })}
        />
      </CollapsibleSection>

      {/* === 4. Entry Kinds =============================================== */}
      <CollapsibleSection
        title="Entry Kinds"
        subtitle={`${overview.entryKinds.length} kind${
          overview.entryKinds.length === 1 ? '' : 's'
        }`}
        expanded={openEntryKinds}
        onToggle={() => setOpenEntryKinds((v) => !v)}
      >
        {hasKinds ? (
          <>
            <EntryKindsTable
              kinds={overview.entryKinds}
              onOpen={(id) =>
                api?.postMessage({ type: 'editEntryKind', id })
              }
              onDelete={(id) =>
                api?.postMessage({ type: 'deleteEntryKind', id })
              }
            />
            <AddBar
              label="Create Entry Kind"
              onActivate={() =>
                api?.postMessage({ type: 'createEntryKind' })
              }
            />
          </>
        ) : (
          <AddBar
            label="Initialize Entry Kinds"
            onActivate={() => api?.postMessage({ type: 'initEntryKinds' })}
          />
        )}
      </CollapsibleSection>

      {/* === 5. Macro Kinds =============================================== */}
      <CollapsibleSection
        title="SNL Macro Kinds"
        subtitle={`${overview.macroKinds.length} kind${
          overview.macroKinds.length === 1 ? '' : 's'
        }`}
        expanded={openMacroKinds}
        onToggle={() => setOpenMacroKinds((v) => !v)}
      >
        {hasMacroKinds ? (
          <>
            <MacroKindsTable
              kinds={overview.macroKinds}
              onOpen={(id) =>
                api?.postMessage({ type: 'editMacroKind', id })
              }
              onDelete={(id) =>
                api?.postMessage({ type: 'deleteMacroKind', id })
              }
            />
            <AddBar
              label="Create Macro Kind"
              onActivate={() =>
                api?.postMessage({ type: 'createMacroKind' })
              }
            />
          </>
        ) : (
          <AddBar
            label="Initialize Macro Kinds"
            onActivate={() => api?.postMessage({ type: 'initMacroKinds' })}
          />
        )}
      </CollapsibleSection>
    </main>
  );
}

/**
 * A collapsible section wrapper. Header shows title + subtitle + chevron;
 * body is only rendered when `expanded` is true, so heavy tables don't pay
 * layout cost while collapsed.
 */
function CollapsibleSection({
  title,
  subtitle,
  expanded,
  onToggle,
  children
}: {
  title: string;
  subtitle: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'baseline',
          gap: '0.6rem',
          padding: '0.4rem 0',
          background: 'transparent',
          color: 'inherit',
          border: 'none',
          borderBottom:
            '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'inherit',
          fontSize: '1.05rem'
        }}
      >
        <span style={{ width: '0.9rem', opacity: 0.7 }}>
          {expanded ? '▾' : '▸'}
        </span>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <span style={{ opacity: 0.7, fontSize: '0.9rem' }}>{subtitle}</span>
      </button>
      {expanded ? <div style={{ marginTop: '0.5rem' }}>{children}</div> : null}
    </section>
  );
}

/**
 * SNoogL — the workspace-wide Find Macro search box on the Dashboard
 * (Fulcrum 2026-07-04 spec 4).
 *
  * "点进去以后是一个类似 Google 的搜索框" — starts as a compact button
  * labeled "🔍 Find Macro"; on click / focus it expands to a full-width
  * input that shows a filtered dropdown of matching macro ids beneath it.
  *
  * Matching: case-insensitive substring against `id`. Substring rank
  * prefers prefix matches, then position ascending (earlier = better),
  * then alphabetical.  Client-side only — the overview payload includes
  * every macro's id + origin package. Empty query renders no dropdown
  * (spec: no "top hits" surface until the user types).
  *
  * Selecting a result posts `openMacroPackage` for that macro's package
  * (host opens the package panel). "Reveal the specific macro inside the
  * package" is deferred until the package panel gains a scroll-into-view /
  * highlight-macro API. When 0 packages, the search is disabled with a
  * subtle placeholder.
  */
 function SnoogLBar({
   allMacros,
   onOpenPackage
 }: {
   allMacros: AllMacroIndexEntry[];
   onOpenPackage: (packageFile: string) => void;
 }): React.ReactElement {
   const [expanded, setExpanded] = useState(false);
   const [query, setQuery] = useState('');
   const [activeIdx, setActiveIdx] = useState(0);
   const inputRef = useRef<HTMLInputElement | null>(null);
   const wrapRef = useRef<HTMLDivElement | null>(null);

   // Rank the matches. Prefix > substring position > alphabetical.
  const matches = useMemo<AllMacroIndexEntry[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    const scored: { entry: AllMacroIndexEntry; rank: number; pos: number }[] = [];
    for (const entry of allMacros) {
      const lower = entry.id.toLowerCase();
      const pos = lower.indexOf(q);
      if (pos < 0) continue;
      const isPrefix = pos === 0;
      const rank = isPrefix ? 0 : 1;
      scored.push({ entry, rank, pos });
    }
    scored.sort((a, b) =>
      a.rank !== b.rank
        ? a.rank - b.rank
        : a.pos !== b.pos
          ? a.pos - b.pos
          : a.entry.id.localeCompare(b.entry.id),
    );
    return scored.slice(0, 30).map((s) => s.entry);
  }, [query, allMacros]);

   // Reset the active-row index whenever the match set shrinks below it.
   useEffect(() => {
     if (activeIdx >= matches.length) setActiveIdx(0);
   }, [matches, activeIdx]);

   // Collapse when the user clicks outside the whole component (both the
   // input and the dropdown).
   useEffect(() => {
     if (!expanded) return;
     const handler = (e: MouseEvent): void => {
       const wrap = wrapRef.current;
       if (!wrap) return;
       if (e.target instanceof Node && wrap.contains(e.target)) return;
       setExpanded(false);
     };
     document.addEventListener('mousedown', handler);
     return () => document.removeEventListener('mousedown', handler);
   }, [expanded]);

   const empty = allMacros.length === 0;

   const openMatch = (i: number): void => {
     const m = matches[i];
     if (!m) return;
     onOpenPackage(m.packageFile);
     setQuery('');
     setExpanded(false);
   };

   if (!expanded) {
     return (
       <div
         role="button"
         tabIndex={0}
         aria-label="Find Macro (SNoogL)"
         onClick={() => {
           if (empty) return;
           setExpanded(true);
           requestAnimationFrame(() => inputRef.current?.focus());
         }}
         onKeyDown={(e) => {
           if ((e.key === 'Enter' || e.key === ' ') && !empty) {
             e.preventDefault();
             setExpanded(true);
             requestAnimationFrame(() => inputRef.current?.focus());
           }
         }}
         title={
           empty
             ? 'No macros in workspace yet — add a package first'
             : 'Search macros across every package (⌘/Ctrl-F equivalent)'
         }
         style={{
           display: 'flex',
           alignItems: 'center',
           gap: '0.5rem',
           padding: '0.55rem 0.9rem',
           marginBottom: '0.6rem',
           borderRadius: '20px',
           border:
             '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
           background:
             'var(--vscode-input-background, rgba(255,255,255,0.04))',
           color: empty
             ? 'var(--vscode-descriptionForeground, #999)'
             : 'inherit',
           cursor: empty ? 'not-allowed' : 'text',
           userSelect: 'none',
           opacity: empty ? 0.6 : 1
         }}
       >
         <span aria-hidden style={{ opacity: 0.75 }}>🔍</span>
         <span style={{ fontWeight: 500 }}>Find Macro</span>
         <span style={{ opacity: 0.6, fontSize: '0.8rem', marginLeft: 'auto' }}>
           {empty ? '(no macros)' : `${allMacros.length} macros indexed`}
         </span>
       </div>
     );
   }

   return (
     <div ref={wrapRef} style={{ position: 'relative', marginBottom: '0.6rem' }}>
       <div
         style={{
           display: 'flex',
           alignItems: 'center',
           gap: '0.5rem',
           padding: '0.4rem 0.9rem',
           borderRadius: matches.length > 0 ? '20px 20px 4px 4px' : '20px',
           border:
             '1px solid var(--vscode-focusBorder, var(--vscode-button-background, #0e639c))',
           background: 'var(--vscode-input-background, #252526)'
         }}
       >
         <span aria-hidden style={{ opacity: 0.75 }}>🔍</span>
         <input
           ref={inputRef}
           type="text"
           value={query}
           placeholder="Search macro id — e.g. Set.union, add, Group…"
           onChange={(e) => {
             setQuery(e.target.value);
             setActiveIdx(0);
           }}
           onKeyDown={(e) => {
             if (e.key === 'Escape') {
               e.preventDefault();
               setExpanded(false);
               setQuery('');
               return;
             }
             if (matches.length === 0) return;
             if (e.key === 'ArrowDown') {
               e.preventDefault();
               setActiveIdx((i) => (i + 1) % matches.length);
             } else if (e.key === 'ArrowUp') {
               e.preventDefault();
               setActiveIdx((i) => (i - 1 + matches.length) % matches.length);
             } else if (e.key === 'Enter') {
               e.preventDefault();
               openMatch(activeIdx);
             }
           }}
           style={{
             flex: 1,
             minWidth: 0,
             padding: '0.35rem 0.4rem',
             border: 'none',
             outline: 'none',
             background: 'transparent',
             color: 'var(--vscode-input-foreground, #ddd)',
             fontFamily: 'inherit',
             fontSize: '0.95rem'
           }}
         />
         <span
           style={{
             opacity: 0.6,
             fontSize: '0.75rem',
             fontFamily: 'var(--vscode-editor-font-family, monospace)'
           }}
         >
           {query.trim().length > 0
             ? `${matches.length} hit${matches.length === 1 ? '' : 's'}`
             : `${allMacros.length} indexed`}
         </span>
       </div>
       {matches.length > 0 ? (
         <ul
           role="listbox"
           aria-label="SNoogL matches"
           style={{
             listStyle: 'none',
             margin: 0,
             padding: '0.25rem 0',
             position: 'absolute',
             top: '100%',
             left: 0,
             right: 0,
             maxHeight: '18rem',
             overflowY: 'auto',
             background: 'var(--vscode-dropdown-background, #252526)',
             border:
               '1px solid var(--vscode-focusBorder, var(--vscode-button-background, #0e639c))',
             borderTop: 'none',
             borderRadius: '0 0 4px 4px',
             zIndex: 20,
             boxShadow: '0 4px 12px rgba(0,0,0,0.35)'
           }}
         >
           {matches.map((m, i) => (
             <li
               key={`${m.packageFile}::${m.id}`}
               role="option"
               aria-selected={i === activeIdx}
               onMouseEnter={() => setActiveIdx(i)}
               onMouseDown={(e) => {
                 // mousedown (not click) so the input's onBlur doesn't cancel
                 // us via the outside-click handler above.
                 e.preventDefault();
                 openMatch(i);
               }}
               style={{
                 display: 'flex',
                 alignItems: 'baseline',
                 gap: '0.5rem',
                 padding: '0.35rem 0.9rem',
                 cursor: 'pointer',
                 background:
                   i === activeIdx
                     ? 'var(--vscode-list-activeSelectionBackground, rgba(255,255,255,0.09))'
                     : 'transparent',
                 color:
                   i === activeIdx
                     ? 'var(--vscode-list-activeSelectionForeground, inherit)'
                     : 'inherit'
               }}
             >
               <span
                 style={{
                   fontFamily: 'var(--vscode-editor-font-family, monospace)',
                   fontSize: '0.9rem',
                   flex: 1,
                   minWidth: 0,
                   overflow: 'hidden',
                   textOverflow: 'ellipsis',
                   whiteSpace: 'nowrap'
                 }}
               >
                 <HighlightedMatch text={m.id} q={query.trim()} />
               </span>
               {m.kind ? (
                 <span
                   style={{
                     fontSize: '0.7rem',
                     padding: '0 0.4rem',
                     borderRadius: '3px',
                     opacity: 0.7,
                     border:
                       '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))'
                   }}
                 >
                   {m.kind}
                 </span>
               ) : null}
               <span
                 style={{
                   fontSize: '0.75rem',
                   opacity: 0.6,
                   fontFamily: 'var(--vscode-editor-font-family, monospace)'
                 }}
               >
                 {m.packageName}
               </span>
             </li>
           ))}
         </ul>
       ) : query.trim().length > 0 ? (
         <div
           style={{
             position: 'absolute',
             top: '100%',
             left: 0,
             right: 0,
             padding: '0.55rem 0.9rem',
             background: 'var(--vscode-dropdown-background, #252526)',
             border:
               '1px solid var(--vscode-focusBorder, var(--vscode-button-background, #0e639c))',
             borderTop: 'none',
             borderRadius: '0 0 4px 4px',
             fontSize: '0.85rem',
             opacity: 0.7,
             zIndex: 20,
             boxShadow: '0 4px 12px rgba(0,0,0,0.35)'
           }}
         >
           No macros match "{query}".
         </div>
       ) : null}
     </div>
   );
 }

 /**
  * Renders `text` with the leftmost case-insensitive occurrence of `q`
  * highlighted (bold + accent color). Falls back to plain text when `q`
  * is empty or absent.
  */
 function HighlightedMatch({
   text,
   q
 }: {
   text: string;
   q: string;
 }): React.ReactElement {
   if (q.length === 0) return <>{text}</>;
   const lower = text.toLowerCase();
   const i = lower.indexOf(q.toLowerCase());
   if (i < 0) return <>{text}</>;
   return (
     <>
       {text.slice(0, i)}
       <span
         style={{
           fontWeight: 700,
           color: 'var(--vscode-editorLightBulb-foreground, #dcdcaa)'
         }}
       >
         {text.slice(i, i + q.length)}
       </span>
       {text.slice(i + q.length)}
     </>
   );
 }

 /**
  * Full-width primary "add" bar used as a section CTA. When a section's list
  * is empty the section shows only this bar as its call-to-action.
  */
 function AddBar({
  label,
  onActivate
}: {
  label: string;
  onActivate: () => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.4rem',
        width: '100%',
        boxSizing: 'border-box',
        height: '3rem',
        marginTop: '0.5rem',
        borderRadius: '6px',
        border: hover
          ? '1.5px solid var(--vscode-focusBorder, var(--vscode-button-background, #0e639c))'
          : '2px dashed var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        background: hover
          ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.04))'
          : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontWeight: 600,
        userSelect: 'none'
      }}
    >
      <span style={{ fontSize: '1.4rem', lineHeight: 1 }}>+</span>
      <span>{label}</span>
    </div>
  );
}

const CELL: React.CSSProperties = {
  padding: '0.45rem 0.6rem',
  borderBottom:
    '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
  textAlign: 'left',
  verticalAlign: 'middle'
};
const HEAD: React.CSSProperties = { ...CELL, fontWeight: 600, opacity: 0.85 };
const MONO: React.CSSProperties = {
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
  opacity: 0.75
};

function LibrariesTable({
  libraries,
  onOpen,
  onDelete
}: {
  libraries: LibrarySummary[];
  onOpen: (slug: string) => void;
  onDelete: (slug: string) => void;
}): React.ReactElement {
  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        marginTop: '0.5rem',
        fontSize: '0.95rem'
      }}
    >
      <thead>
        <tr>
          <th style={HEAD}>Title</th>
          <th style={HEAD}>Slug</th>
          <th style={{ ...HEAD, textAlign: 'right' }}>Entries</th>
          <th style={{ ...HEAD, textAlign: 'right' }}>Relationships</th>
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {libraries.map((lib) => (
          <ClickableRow
            key={lib.slug}
            label={`Edit library ${lib.slug}`}
            onActivate={() => onOpen(lib.slug)}
          >
            <td style={CELL}>{lib.title}</td>
            <td style={{ ...CELL, ...MONO }}>{lib.slug}</td>
            <td style={{ ...CELL, textAlign: 'right' }}>
              {lib.entryCount === null ? '—' : lib.entryCount}
            </td>
            <td style={{ ...CELL, textAlign: 'right' }}>
              {lib.relationshipCount === null ? '—' : lib.relationshipCount}
            </td>
            <RowDeleteCell
              label={`Delete library ${lib.slug}`}
              onDelete={() => onDelete(lib.slug)}
            />
          </ClickableRow>
        ))}
      </tbody>
    </table>
  );
}

function MacroPackagesTable({
  packages,
  onOpen,
  onSetActive,
  onDelete
}: {
  packages: MacroPackageSummary[];
  onOpen: (file: string) => void;
  onSetActive: (file: string, active: boolean) => void;
  onDelete: (file: string) => void;
}): React.ReactElement {
  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        marginTop: '0.5rem',
        fontSize: '0.95rem'
      }}
    >
      <thead>
        <tr>
          <th style={{ ...HEAD, width: '4.5rem', textAlign: 'center' }}>Active</th>
          <th style={HEAD}>File</th>
          <th style={{ ...HEAD, textAlign: 'right' }}>Macros</th>
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {packages.map((pkg) => (
          <ClickableRow
            key={pkg.file}
            label={`Open macro package ${pkg.file}`}
            onActivate={() => onOpen(pkg.file)}
          >
            <td style={{ ...CELL, textAlign: 'center' }}>
              <input
                type="checkbox"
                checked={pkg.active !== false}
                aria-label={`Toggle active state for ${pkg.file}`}
                title={
                  pkg.active !== false
                    ? 'Active — contributes macros to the workspace'
                    : 'Inactive — excluded from readAllMacros'
                }
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onSetActive(pkg.file, e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
            </td>
            <td style={{ ...CELL, ...MONO }}>{pkg.file}</td>
            <td style={{ ...CELL, textAlign: 'right' }}>
              {pkg.macroCount === null ? '—' : pkg.macroCount}
            </td>
            <RowDeleteCell
              label={`Delete macro package ${pkg.file}`}
              onDelete={() => onDelete(pkg.file)}
            />
          </ClickableRow>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Shared clickable-row wrapper. Clicking (or Enter/Space) fires `onActivate`;
 * hover / focus paint the row with the theme's list-hover background,
 * matching VS Code list affordances.
 */
/**
 * Trash-icon cell for a Dashboard table row. Placed inside a
 * {@link ClickableRow} — stopPropagation is critical because the surrounding
 * row treats any click as "open this entity", and we absolutely do not want
 * clicking Delete to also open the editor for the doomed row.
 *
 * Cat 2026-07-09: every entity type (entry / library / entry-kind /
 * macro-kind / macro-package) grows a matching Delete action. The confirm
 * modal + reference reporting lives in extension.ts commands; here we just
 * post the intent.
 */
function RowDeleteCell({
  onDelete,
  label
}: {
  onDelete: () => void;
  label: string;
}): React.ReactElement {
  return (
    <td
      style={{ ...CELL, textAlign: 'right', width: '2.5rem' }}
      onClick={(e) => e.stopPropagation()}
    >
      <Button
        variant="destructive"
        size="sm"
        aria-label={label}
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        onKeyDown={(e) => {
          // Prevent the surrounding ClickableRow's Enter/Space handler
          // from firing when a user focuses this button via keyboard.
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
          }
        }}
      >
        ✕
      </Button>
    </td>
  );
}

function ClickableRow({
  label,
  onActivate,
  children
}: {
  label: string;
  onActivate: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        cursor: 'pointer',
        background: hover
          ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.04))'
          : 'transparent'
      }}
    >
      {children}
    </tr>
  );
}

function EntryKindsTable({
  kinds,
  onOpen,
  onDelete
}: {
  kinds: EntryKind[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}): React.ReactElement {
  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        marginTop: '0.5rem',
        fontSize: '0.95rem'
      }}
    >
      <thead>
        <tr>
          <th style={{ ...HEAD, width: '5.5rem' }}>Preview</th>
          <th style={HEAD}>Name</th>
          <th style={HEAD}>ID</th>
          <th style={HEAD}>Numbering</th>
          <th style={HEAD}>Style</th>
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {kinds.map((kind) => (
          <ClickableRow
            key={kind.id}
            label={`Edit entry kind ${kind.id}`}
            onActivate={() => onOpen(kind.id)}
          >
            <td style={CELL}>
              <KindPreview
                stroke={kind.coloring.stroke}
                background={kind.coloring.background}
              />
            </td>
            <td style={CELL}>{kind.name}</td>
            <td style={{ ...CELL, ...MONO }}>{kind.id}</td>
            <td style={{ ...CELL, ...MONO }}>
              {kind.numbering ? kind.numbering : '—'}
            </td>
            <td style={{ ...CELL, ...MONO }}>
              {kind.style ? kind.style : '—'}
            </td>
            <RowDeleteCell
              label={`Delete entry kind ${kind.id}`}
              onDelete={() => onDelete(kind.id)}
            />
          </ClickableRow>
        ))}
      </tbody>
    </table>
  );
}

/** Macro-kinds catalog table for the Dashboard. */
function MacroKindsTable({
  kinds,
  onOpen,
  onDelete
}: {
  kinds: MacroKind[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}): React.ReactElement {
  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        marginTop: '0.5rem',
        fontSize: '0.95rem'
      }}
    >
      <thead>
        <tr>
          <th style={{ ...HEAD, width: '5.5rem' }}>Preview</th>
          <th style={HEAD}>Name</th>
          <th style={HEAD}>ID</th>
          <th style={HEAD}>Description</th>
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {kinds.map((kind) => (
          <ClickableRow
            key={kind.id}
            label={`Edit macro kind ${kind.id}`}
            onActivate={() => onOpen(kind.id)}
          >
            <td style={CELL}>
              <KindPreview
                stroke={kind.coloring.stroke}
                background={kind.coloring.background}
              />
            </td>
            <td style={CELL}>{kind.name}</td>
            <td style={{ ...CELL, ...MONO }}>{kind.id}</td>
            <td style={CELL}>{kind.description ? kind.description : '—'}</td>
            <RowDeleteCell
              label={`Delete macro kind ${kind.id}`}
              onDelete={() => onDelete(kind.id)}
            />
          </ClickableRow>
        ))}
      </tbody>
    </table>
  );
}

/** Compact box preview showing stroke + background together. */
function KindPreview({
  stroke,
  background,
  width = '3.5rem'
}: {
  stroke: string;
  background: string;
  width?: string;
}): React.ReactElement {
  return (
    <span
      title={`stroke ${stroke} / background ${background}`}
      style={{
        display: 'inline-block',
        width,
        height: '1.25rem',
        borderRadius: '3px',
        background,
        border: `2px solid ${stroke}`,
        verticalAlign: 'middle'
      }}
    />
  );
}

/** List of populated content formats for an entry, e.g. "snl, typst". */
function populatedFormats(entry: EntryData): string {
  const order: Array<keyof EntryData['content']> = [
    'snl',
    'typst',
    'latex',
    'markdown',
    'text'
  ];
  const present = order.filter((k) => {
    const v = entry.content?.[k];
    return typeof v === 'string' && v.trim().length > 0;
  });
  return present.length > 0 ? present.join(', ') : '—';
}

function EntriesTable({
  entries,
  kinds,
  onOpen,
  onDelete
}: {
  entries: EntryData[];
  kinds: EntryKind[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}): React.ReactElement {
  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        marginTop: '0.5rem',
        fontSize: '0.95rem'
      }}
    >
      <thead>
        <tr>
          <th style={{ ...HEAD, width: '3.5rem' }}>Preview</th>
          <th style={HEAD}>Title</th>
          <th style={HEAD}>ID</th>
          <th style={HEAD}>Kind</th>
          <th style={HEAD}>Formats</th>
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const kind = kinds.find((k) => k.id === entry.kind);
          return (
            <ClickableRow
              key={entry.id}
              label={`Edit entry ${entry.title}`}
              onActivate={() => onOpen(entry.id)}
            >
              <td style={CELL}>
                <KindPreview
                  stroke={kind ? kind.coloring.stroke : '#888888'}
                  background={kind ? kind.coloring.background : '#f0f0f0'}
                  width="2rem"
                />
              </td>
              <td style={CELL}>{entry.title}</td>
              <td style={{ ...CELL, ...MONO }}>{entry.id}</td>
              <td style={CELL}>
                {kind ? (
                  kind.name
                ) : (
                  <span
                    title={`Unknown kind "${entry.kind}" — no matching entry kind in config.json`}
                    style={{
                      display: 'inline-block',
                      padding: '0.05rem 0.4rem',
                      borderRadius: '3px',
                      fontSize: '0.85rem',
                      color: 'var(--vscode-errorForeground, #f14c4c)',
                      border:
                        '1px solid var(--vscode-errorForeground, #f14c4c)'
                    }}
                  >
                    ⚠ unknown
                  </span>
                )}
              </td>
              <td style={{ ...CELL, ...MONO }}>{populatedFormats(entry)}</td>
              <RowDeleteCell
                label={`Delete entry ${entry.id}`}
                onDelete={() => onDelete(entry.id)}
              />
            </ClickableRow>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Relationships list for the Dashboard (cat 2026-07-10). Each row shows
 * id / from → to / label / metadata-preview. Endpoints resolve to entry
 * titles when available; a missing endpoint (entry deleted after the
 * relationship was written) renders in error color as a hint.
 */
function RelationshipsTable({
  relationships,
  entries,
  onOpen,
  onDelete
}: {
  relationships: RelationshipData[];
  entries: EntryData[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}): React.ReactElement {
  const titleById = new Map(entries.map((e) => [e.id, e.title || '(untitled)']));
  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        marginTop: '0.5rem',
        fontSize: '0.95rem'
      }}
    >
      <thead>
        <tr>
          <th style={HEAD}>ID</th>
          <th style={HEAD}>From</th>
          <th style={HEAD}>→ To</th>
          <th style={HEAD}>Label</th>
          <th style={HEAD}>Metadata</th>
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {relationships.map((r) => (
          <ClickableRow
            key={r.id}
            label={`Edit relationship ${r.id}`}
            onActivate={() => onOpen(r.id)}
          >
            <td style={{ ...CELL, ...MONO }}>{r.id}</td>
            <td style={CELL}>
              <EndpointCell id={r.from} title={titleById.get(r.from)} />
            </td>
            <td style={CELL}>
              <EndpointCell id={r.to} title={titleById.get(r.to)} />
            </td>
            <td style={CELL}>{r.label}</td>
            <td style={{ ...CELL, ...MONO, opacity: 0.75 }}>
              {formatMetadataPreview(r.metadata)}
            </td>
            <RowDeleteCell
              label={`Delete relationship ${r.id}`}
              onDelete={() => onDelete(r.id)}
            />
          </ClickableRow>
        ))}
      </tbody>
    </table>
  );
}

/** id + resolved title (or ⚠ unknown badge when the endpoint is gone). */
function EndpointCell({
  id,
  title
}: {
  id: string;
  title: string | undefined;
}): React.ReactElement {
  if (!title) {
    return (
      <span
        title={`No entry with id "${id}" in the shared pool. The endpoint was likely deleted.`}
        style={{
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
          color: 'var(--vscode-errorForeground, #f14c4c)'
        }}
      >
        ⚠ {id}
      </span>
    );
  }
  return (
    <span>
      <span style={{ ...MONO, marginRight: '0.4rem', opacity: 0.75 }}>
        {id}
      </span>
      <span>{title}</span>
    </span>
  );
}

/** One-line preview of the metadata blob for the table cell. */
function formatMetadataPreview(v: unknown): string {
  if (v === null || v === undefined) return '—';
  try {
    const s = JSON.stringify(v);
    if (s.length <= 48) return s;
    return `${s.slice(0, 45)}…`;
  } catch {
    return '(unserializable)';
  }
}
