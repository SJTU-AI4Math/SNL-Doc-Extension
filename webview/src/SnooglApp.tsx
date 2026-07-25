import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getVsCodeApi, PANEL_STYLE, type VsCodeApi } from './vscodeApi';
import { PanelNav } from './components/PanelNav';
import { Button } from './components/Button';
import {
  listboxKeyAction,
  matchesPendingQuery,
  queryKey
} from './components/interactionModel';

/**
 * SNoogL — the SNL search page (cat 2026-07-12).
 *
 * MVP: single input + Entry/Macro toggle + result list. Filter panel is
 * a left rail with one populated slot (Kind) and an empty
 * "More filters →" placeholder. Toggle and filters are threaded into a
 * single query object the host reranks against.
 */

type Mode = 'entry' | 'macro';

interface Filters {
  kindId?: string;
}

interface HitEntry {
  kind: 'entry';
  id: string;
  title: string;
  entryKind: string | null;
  score: number;
}

interface HitMacro {
  kind: 'macro';
  id: string;
  packageFile: string;
  packageName: string;
  macroKind: string | null;
  tags: string[];
  score: number;
}

type Hit = HitEntry | HitMacro;

interface KindsByMode {
  entry: string[];
  macro: string[];
}

interface ResultsMsg {
  type: 'results';
  query: { q: string; mode: Mode; filters: Filters };
  results: Hit[];
  kindsByMode: KindsByMode;
}

type Incoming =
  | { type: 'ready' }
  | { type: 'setMode'; mode: Mode }
  | ResultsMsg
  | { type: 'error'; message: string }
  | undefined;

export function SnooglApp(): React.ReactElement {
  const apiRef = useRef<VsCodeApi | undefined>(undefined);
  const [mode, setMode] = useState<Mode>('entry');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Filters>({});
  const [results, setResults] = useState<Hit[]>([]);
  const [kindsByMode, setKindsByMode] = useState<KindsByMode>({ entry: [], macro: [] });
  const [error, setError] = useState<string | null>(null);
  const queryTimerRef = useRef<number | null>(null);
  const pendingQueryKeyRef = useRef<string | null>(null);

  const dispatchQuery = (
    query: { q: string; mode: Mode; filters: Filters },
    cancelMatchingDebounce = false
  ): void => {
    if (cancelMatchingDebounce && matchesPendingQuery(pendingQueryKeyRef.current, query)) {
      if (queryTimerRef.current !== null) window.clearTimeout(queryTimerRef.current);
      queryTimerRef.current = null;
      pendingQueryKeyRef.current = null;
    }
    apiRef.current?.postMessage({ type: 'query', ...query });
  };

  // Send `query` messages on every change. Trivially debounced via a
  // 120ms timer so a burst of typing doesn't spam postMessage.
  useEffect(() => {
    apiRef.current = getVsCodeApi();
    const onMessage = (ev: MessageEvent): void => {
      const msg = ev.data as Incoming;
      if (!msg || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'ready':
          setError(null);
          break;
        case 'setMode':
          // Cat 2026-07-13: host may push the tab selection when the
          // panel is opened (or revealed) from a specific Dashboard
          // header button — Entry Search vs Macro Search live on
          // different rows now.
          if (msg.mode === 'entry' || msg.mode === 'macro') {
            setMode(msg.mode as Mode);
          }
          break;
        case 'results':
          setError(null);
          setResults(Array.isArray(msg.results) ? msg.results : []);
          if (msg.kindsByMode && typeof msg.kindsByMode === 'object') {
            setKindsByMode({
              entry: Array.isArray(msg.kindsByMode.entry) ? msg.kindsByMode.entry : [],
              macro: Array.isArray(msg.kindsByMode.macro) ? msg.kindsByMode.macro : []
            });
          }
          break;
        case 'error':
          setError(msg.message);
          break;
      }
    };
    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Debounced query dispatch — cat's plan calls for a real "query system"
  // over time; keep the shape stable now so future filter fields drop
  // straight into `filters`.
  useEffect(() => {
    const query = { q, mode, filters };
    const key = queryKey(query);
    pendingQueryKeyRef.current = key;
    const handle = window.setTimeout(() => {
      if (pendingQueryKeyRef.current !== key) return;
      pendingQueryKeyRef.current = null;
      queryTimerRef.current = null;
      dispatchQuery(query);
    }, 120);
    queryTimerRef.current = handle;
    return () => {
      window.clearTimeout(handle);
      if (pendingQueryKeyRef.current === key) pendingQueryKeyRef.current = null;
      if (queryTimerRef.current === handle) queryTimerRef.current = null;
    };
    // dispatchQuery intentionally closes over this effect's q/mode/filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, mode, filters]);

  // Kind dropdown options track the active mode. When you flip modes, a
  // filter that no longer applies is cleared (so a lingering "kind=lemma"
  // from Entry mode doesn't hide every macro).
  useEffect(() => {
    if (filters.kindId && !kindsByMode[mode].includes(filters.kindId)) {
      setFilters((f) => ({ ...f, kindId: undefined }));
    }
  }, [mode, kindsByMode, filters.kindId]);

  const openHit = (h: Hit): void => {
    if (h.kind === 'entry') {
      apiRef.current?.postMessage({ type: 'openEntry', id: h.id });
    } else {
      apiRef.current?.postMessage({
        type: 'openMacro',
        packageFile: h.packageFile,
        name: h.id
      });
    }
  };

  return (
    <main style={{ ...PANEL_STYLE, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <PanelNav
        vsApi={apiRef.current}
        back={{
          label: '← Dashboard',
          title: 'Return to the SNL Dashboard',
          message: { type: 'nav.openDashboard' }
        }}
      />
      <header className="snl-responsive-row" style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem' }}>SNoogL</h1>
        <span style={{ opacity: 0.65, fontSize: '0.9rem' }}>
          Search across your workspace's entries and macros.
        </span>
      </header>

      <SearchBar
        q={q}
        setQ={setQ}
        mode={mode}
        setMode={setMode}
        onSubmit={() => {
          // Send immediately after cancelling the matching pending debounce,
          // so one Enter press produces exactly one host query.
          dispatchQuery({ q, mode, filters }, true);
        }}
      />

      {error ? (
        <div
          style={{
            padding: '0.6rem 0.9rem',
            borderRadius: '3px',
            background: 'rgba(220, 60, 60, 0.12)',
            border: '1px solid rgba(220, 60, 60, 0.55)',
            color: 'var(--vscode-errorForeground, #f48771)',
            fontSize: '0.9rem'
          }}
        >
          {error}
        </div>
      ) : null}

      <div className="snl-responsive-sidebar-layout" style={{ gap: '1rem', minHeight: '20rem' }}>
        <FiltersRail
          mode={mode}
          filters={filters}
          setFilters={setFilters}
          kinds={kindsByMode[mode]}
        />
        <ResultList results={results} mode={mode} onOpen={openHit} />
      </div>
    </main>
  );
}

function SearchBar({
  q,
  setQ,
  mode,
  setMode,
  onSubmit
}: {
  q: string;
  setQ: (v: string) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  onSubmit: () => void;
}): React.ReactElement {
  return (
    <div
      className="snl-responsive-search-bar"
      style={{
        alignItems: 'stretch',
        gap: '0.4rem'
      }}
    >
      <div
        role="tablist"
        aria-label="Search target"
        style={{
          display: 'inline-flex',
          borderRadius: '20px',
          border: '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
          overflow: 'hidden',
          flexShrink: 0
        }}
      >
        {(['entry', 'macro'] as Mode[]).map((m) => {
          const active = mode === m;
          return (
            <Button
              key={m}
              role="tab"
              aria-selected={active}
              type="button"
              onClick={() => setMode(m)}
              style={{
                padding: '0.4rem 1rem',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: active ? 600 : 400,
                fontSize: '0.9rem',
                background: active
                  ? 'var(--vscode-button-background, #0e639c)'
                  : 'transparent',
                color: active
                  ? 'var(--vscode-button-foreground, #fff)'
                  : 'inherit'
              }}
            >
              {m === 'entry' ? 'Entry' : 'Macro'}
            </Button>
          );
        })}
      </div>
      <input
        type="text"
        value={q}
        placeholder={
          mode === 'entry'
            ? 'Search entries — id or title…'
            : 'Search macros — name across every active package…'
        }
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit();
          }
        }}
        autoFocus
        style={{
          flex: 1,
          padding: '0.5rem 0.9rem',
          borderRadius: '20px',
          border: '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
          background: 'var(--vscode-input-background, #2a2a2a)',
          color: 'var(--vscode-input-foreground, #ddd)',
          fontFamily: 'inherit',
          fontSize: '0.95rem'
        }}
      />
    </div>
  );
}

function FiltersRail({
  mode,
  filters,
  setFilters,
  kinds
}: {
  mode: Mode;
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  kinds: string[];
}): React.ReactElement {
  return (
    <aside
      style={{
        width: '14rem',
        flexShrink: 0,
        padding: '0.75rem',
        borderRadius: '4px',
        border: '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
        background: 'var(--vscode-editorWidget-background, #252526)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
        fontSize: '0.85rem'
      }}
    >
      <div style={{ fontWeight: 600, opacity: 0.85 }}>Filters</div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
        <span style={{ opacity: 0.75, fontSize: '0.8rem' }}>
          Kind ({mode})
        </span>
        <select
          value={filters.kindId ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            setFilters((f) => ({ ...f, kindId: v ? v : undefined }));
          }}
          style={{
            padding: '0.3rem 0.4rem',
            background: 'var(--vscode-input-background, #2a2a2a)',
            color: 'var(--vscode-input-foreground, #ddd)',
            border: '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
            borderRadius: '3px',
            fontFamily: 'inherit',
            fontSize: '0.85rem'
          }}
        >
          <option value="">(any)</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <div
        style={{
          marginTop: 'auto',
          padding: '0.5rem 0.6rem',
          border: '1px dashed var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
          borderRadius: '3px',
          opacity: 0.55,
          fontStyle: 'italic',
          fontSize: '0.75rem'
        }}
      >
        More filters coming — tag / source / content-format / rerank score…
      </div>
    </aside>
  );
}

function ResultList({
  results,
  mode,
  onOpen
}: {
  results: Hit[];
  mode: Mode;
  onOpen: (h: Hit) => void;
}): React.ReactElement {
  const [activeIdx, setActiveIdx] = useState(0);
  const listboxId = `snoogl-${mode}-results`;

  // Reset selection when the result set shifts.
  useEffect(() => {
    setActiveIdx(0);
  }, [results]);

  const maxScore = useMemo(
    () => (results.length > 0 ? Math.max(...results.map((r) => r.score), 1) : 1),
    [results]
  );

  if (results.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '10rem',
          opacity: 0.6,
          fontStyle: 'italic'
        }}
      >
        No matches.
      </div>
    );
  }

  return (
    <ul
      role="listbox"
      id={listboxId}
      tabIndex={0}
      aria-label={`${mode} results`}
      aria-activedescendant={`${listboxId}-option-${activeIdx}`}
      onKeyDown={(event) => {
        const action = listboxKeyAction(event.key, activeIdx, results.length);
        if (!action) return;
        event.preventDefault();
        setActiveIdx(action.index);
        if (action.activate) onOpen(results[action.index]);
        if (action.blur) event.currentTarget.blur();
      }}
      style={{
        flex: 1,
        listStyle: 'none',
        padding: 0,
        margin: 0,
        border: '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
        borderRadius: '4px',
        maxHeight: '32rem',
        overflowY: 'auto'
      }}
    >
      {results.map((r, i) => {
        const active = i === activeIdx;
        return (
          <li
            id={`${listboxId}-option-${i}`}
            key={
              r.kind === 'entry'
                ? `e:${r.id}`
                : `m:${(r as HitMacro).packageFile}::${r.id}`
            }
            role="option"
            aria-selected={active}
            onMouseEnter={() => setActiveIdx(i)}
            onClick={() => onOpen(r)}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: '0.5rem',
              padding: '0.45rem 0.75rem',
              cursor: 'pointer',
              borderBottom:
                '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #2c2c2c))',
              background: active
                ? 'var(--vscode-list-activeSelectionBackground, rgba(255,255,255,0.08))'
                : 'transparent'
            }}
          >
            <ScoreBar score={r.score} max={maxScore} />
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
              {r.id || <em style={{ opacity: 0.65 }}>(untitled)</em>}
            </span>
            {r.kind === 'entry' && r.title ? (
              <span
                style={{
                  opacity: 0.8,
                  fontSize: '0.85rem',
                  flex: 2,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {r.title}
              </span>
            ) : null}
            {r.kind === 'entry' && r.entryKind ? (
              <KindBadge label={r.entryKind} />
            ) : null}
            {r.kind === 'macro' && r.macroKind ? (
              <KindBadge label={r.macroKind} />
            ) : null}
            {r.kind === 'macro' ? (
              <span
                style={{
                  fontFamily: 'var(--vscode-editor-font-family, monospace)',
                  fontSize: '0.75rem',
                  opacity: 0.6
                }}
              >
                {r.packageName}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function ScoreBar({
  score,
  max
}: {
  score: number;
  max: number;
}): React.ReactElement {
  // Rendered even for score=0 (empty-query browse mode) as a neutral pill
  // so hits still line up on the same grid.
  const pct = max > 0 ? Math.max(0, Math.min(1, score / max)) : 0;
  return (
    <span
      title={`rerank score: ${score}`}
      style={{
        width: '2.5rem',
        height: '0.4rem',
        borderRadius: '2px',
        background: 'var(--vscode-input-background, rgba(255,255,255,0.05))',
        position: 'relative',
        flexShrink: 0
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          width: `${Math.round(pct * 100)}%`,
          background: pct > 0.66
            ? 'var(--vscode-testing-iconPassed, #4caf50)'
            : pct > 0.33
              ? 'var(--vscode-editorWarning-foreground, #d7a35a)'
              : 'var(--vscode-descriptionForeground, #888)',
          borderRadius: '2px'
        }}
      />
    </span>
  );
}

function KindBadge({ label }: { label: string }): React.ReactElement {
  return (
    <span
      style={{
        fontSize: '0.7rem',
        padding: '0 0.4rem',
        borderRadius: '3px',
        opacity: 0.75,
        border: '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))'
      }}
    >
      {label}
    </span>
  );
}
