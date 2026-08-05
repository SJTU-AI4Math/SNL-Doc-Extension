import * as vscode from 'vscode';
import { createHostTranslator, defineHostMessages } from './hostI18n';
import { read_extension_preferences } from './preferences';

const MESSAGES = defineHostMessages(
  { title: 'SNoogL — Search', noWorkspace: 'Open a folder / workspace to search.', packageReadFailed: 'Could not read Macro Package {file}: {error}', searchFailed: 'Search failed: {error}' },
  { title: 'SNoogL — 搜索', noWorkspace: '请打开文件夹或工作区以进行搜索。', packageReadFailed: '无法读取宏包 {file}：{error}', searchFailed: '搜索失败：{error}' }
);
const hostText = () => createHostTranslator(read_extension_preferences().language, MESSAGES);
import {
  readAllMacros,
  readEntries,
  readMacroPackage,
  readMacroPackages,
  resolveActiveMacroPackages,
  type EntryData
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage } from './panelUtil';
import {
  createSnooglSearchDocument,
  rankSnooglDocuments
} from './snooglSearch';

/**
 * SNoogL — SNL search panel (cat 2026-07-12).
 *
 * A single search surface for BOTH entries and macros. The mode toggle
 * (`entry` / `macro`) is a first-class member of the query object; a
 * filter payload sits alongside it and drives host-side rerank. The
 * MVP has one filter slot (`kindId?`) — the shape is ready for more.
 *
 * Message protocol with the webview (`snoogl` bundle):
 *   in : { type: 'ready' }                                (bootstrap)
 *      | { type: 'query'; q: string; mode: 'entry'|'macro'; filters: SnoogLFilters }
 *      | { type: 'openEntry'; id: string }
 *      | { type: 'openMacro'; packageFile: string; name: string }
 *      | (nav messages via handlePanelNavMessage)
 *   out: { type: 'ready'; }                               (available soon)
 *      | { type: 'results'; results: SnoogLHit[]; kindsByMode: {entry: string[]; macro: string[]} }
 *      | { type: 'error'; message: string }
 *
 * Ranking is delegated to the shared SNoogL scorer: whitespace-delimited
 * tokens are matched independently across namespace tail, labels/tags, and
 * namespace middle segments with soft field weights, then combined with an
 * AND gate and geometric mean. Each hit carries the resulting numeric score.
 */

interface SnoogLFilters {
  /** Restrict to a single kind id (entry_kinds[].id / macro_kinds[].id). */
  kindId?: string;
}

interface SnoogLHitEntry {
  kind: 'entry';
  id: string;
  title: string;
  entryKind: string | null;
  score: number;
}

interface SnoogLHitMacro {
  kind: 'macro';
  id: string;
  packageFile: string;
  packageName: string;
  macroKind: string | null;
  tags: string[];
  score: number;
}

type SnoogLHit = SnoogLHitEntry | SnoogLHitMacro;

export class SnoogLPanel {
  private static instance: SnoogLPanel | null = null;
  private static readonly viewType = 'snlSnoogL';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private queryGeneration = 0;

  public static open(
    extensionUri: vscode.Uri,
    initialMode: 'entry' | 'macro' = 'entry'
  ): void {
    const column = vscode.ViewColumn.Active;
    if (SnoogLPanel.instance) {
      SnoogLPanel.instance.panel.reveal(column);
      // Push mode to already-open panel so header clicks always land on
      // the requested tab regardless of previous state.
      void SnoogLPanel.instance.panel.webview.postMessage({
        type: 'setMode',
        mode: initialMode
      });
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      SnoogLPanel.viewType,
      hostText()('title'),
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );
    SnoogLPanel.instance = new SnoogLPanel(panel, extensionUri, initialMode);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly initialMode: 'entry' | 'macro' = 'entry'
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'snoogl',
      hostText()('title')
    );

    this.panel.webview.onDidReceiveMessage(
      (m) => this.handleMessage(m),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (await handlePanelNavMessage(message, () => this.doQuery({ q: '', mode: 'entry', filters: {} }))) return;
    const msg = message as { type?: string } | undefined;
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'ready':
        void this.panel.webview.postMessage({ type: 'ready' });
        // Push the requested initial mode BEFORE first results so the
        // webview's tab selection reflects the button that opened it.
        void this.panel.webview.postMessage({
          type: 'setMode',
          mode: this.initialMode
        });
        // Kick a blank query so the webview can populate its kind
        // dropdown from the returned `kindsByMode`.
        await this.doQuery({ q: '', mode: this.initialMode, filters: {} });
        return;
      case 'query': {
        const q = typeof (msg as { q?: unknown }).q === 'string' ? (msg as { q: string }).q : '';
        const rawMode = (msg as { mode?: unknown }).mode;
        const mode: 'entry' | 'macro' = rawMode === 'macro' ? 'macro' : 'entry';
        const rawFilters = (msg as { filters?: unknown }).filters;
        const filters: SnoogLFilters = {};
        if (rawFilters && typeof rawFilters === 'object') {
          const kindId = (rawFilters as { kindId?: unknown }).kindId;
          if (typeof kindId === 'string' && kindId) filters.kindId = kindId;
        }
        await this.doQuery({ q, mode, filters });
        return;
      }
      case 'openEntry': {
        const id = (msg as { id?: unknown }).id;
        if (typeof id === 'string' && id.trim()) {
          void vscode.commands.executeCommand('snlDoc.editEntry', id.trim());
        }
        return;
      }
      case 'openMacro': {
        const packageFile = (msg as { packageFile?: unknown }).packageFile;
        const name = (msg as { name?: unknown }).name;
        if (typeof packageFile === 'string' && typeof name === 'string' && packageFile && name) {
          void vscode.commands.executeCommand('snlDoc.editMacro', packageFile, name);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Run a query and push the results. Errors are swallowed into a single
   * `error` message so the webview can show a banner without blowing up.
   * Empty result sets are legitimate — they still send an empty results
   * array so the "0 hits" banner can show.
   */
  private async doQuery(query: {
    q: string;
    mode: 'entry' | 'macro';
    filters: SnoogLFilters;
  }): Promise<void> {
    const generation = ++this.queryGeneration;
    try {
      const root = firstWorkspaceFolder();
      if (!root) {
        if (generation !== this.queryGeneration) return;
        void this.panel.webview.postMessage({
          type: 'error',
          message: hostText()('noWorkspace')
        });
        return;
      }
      // For macro origin (package file + display name), we need the
      // per-package read. Read them concurrently — they are independent
      // files and the serial await was pure latency on every panel open.
      // Cat 2026-07-25: "各个 Panel 开起来都非常慢".
      const [entries, macrosByName, macroPackages] = await Promise.all([
        readEntries(root),
        readAllMacros(root),
        (async (): Promise<SnoogLHitMacro[]> => {
          const [active, packages] = await Promise.all([
            resolveActiveMacroPackages(root).then((names) => new Set(names)),
            readMacroPackages(root)
          ]);
          const loaded = await Promise.all(
            packages
              .filter((summary) => active.has(summary.file.replace(/\.json$/i, '')))
              .map(async (summary) => ({
                bare: summary.file.replace(/\.json$/i, ''),
                read: await readMacroPackage(root, summary.file)
              }))
          );
          const out: SnoogLHitMacro[] = [];
          for (const { bare, read } of loaded) {
            if (read.status === 'error') {
              throw new Error(hostText()('packageReadFailed', { file: bare, error: read.message }));
            }
            if (read.status === 'noFile') continue;
            for (const m of read.macros) {
              if (typeof m.name !== 'string' || !m.name) continue;
              out.push({
                kind: 'macro',
                id: m.name,
                packageFile: bare,
                packageName: read.pkg?.name ?? bare,
                macroKind: typeof m.kind === 'string' && m.kind ? m.kind : null,
                tags: Array.isArray(m.tags) ? m.tags : [],
                score: 0
              });
            }
          }
          return out;
        })()
      ]);
      if (generation !== this.queryGeneration) return;
      const kindsByMode = {
        entry: uniqueSorted(entries.map((e) => e.kind).filter(Boolean) as string[]),
        macro: uniqueSorted(
          Object.values(macrosByName)
            .map((m) => m.kind)
            .filter((k): k is string => typeof k === 'string' && k.length > 0)
        )
      };

      const q = query.q.trim().toLowerCase();
      let results: SnoogLHit[];
      if (query.mode === 'entry') {
        results = rankEntries(entries, q, query.filters);
      } else {
        results = rankMacros(macroPackages, q, query.filters);
      }
      // Cap at 100 — the panel is not built to render more, and shipping
      // huge payloads over postMessage on every keystroke is wasteful.
      results = results.slice(0, 100);

      if (generation !== this.queryGeneration) return;
      void this.panel.webview.postMessage({
        type: 'results',
        query,
        results,
        kindsByMode
      });
    } catch (err) {
      if (generation !== this.queryGeneration) return;
      void this.panel.webview.postMessage({
        type: 'error',
        message: hostText()('searchFailed', { error: err instanceof Error ? err.message : String(err) })
      });
    }
  }

  public dispose(): void {
    SnoogLPanel.instance = null;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try {
        d?.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}

function uniqueSorted(xs: string[]): string[] {
  return Array.from(new Set(xs)).sort((a, b) => a.localeCompare(b));
}

/**
 * Rank entries by q against `id` + `title`. Empty q returns every entry
 * (still filtered) with score = 0 so the list acts as a browsable
 * catalog when the user opens the panel with no query typed.
 */
function rankEntries(
  entries: EntryData[],
  q: string,
  filters: SnoogLFilters
): SnoogLHitEntry[] {
  const hits = entries
    .filter((entry) => !filters.kindId || entry.kind === filters.kindId)
    .map((entry): SnoogLHitEntry => ({
      kind: 'entry',
      id: entry.id ?? '',
      title: entry.title ?? '',
      entryKind: entry.kind ?? null,
      score: 0
    }));
  return rankSnooglDocuments(
    q,
    hits.map((hit) => createSnooglSearchDocument({
      id: hit.id,
      value: hit,
      labels: hit.title ? [hit.title] : []
    }))
  ).map((result) => ({ ...result.value, score: result.score }));
}

function rankMacros(
  macros: SnoogLHitMacro[],
  q: string,
  filters: SnoogLFilters
): SnoogLHitMacro[] {
  const filtered = macros.filter(
    (macro) => !filters.kindId || macro.macroKind === filters.kindId
  );
  return rankSnooglDocuments(
    q,
    filtered.map((macro) => createSnooglSearchDocument({
      id: macro.id,
      value: macro,
      labels: macro.tags
    }))
  ).map((result) => ({ ...result.value, score: result.score }));
}
