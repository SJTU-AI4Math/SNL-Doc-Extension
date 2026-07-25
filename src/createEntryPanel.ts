import * as vscode from 'vscode';
import { toEntryOption } from './entryPoolOption';
import {
  addEntry,
  listEntryKinds,
  readAllMacrosWithOrigin,
  readEntries,
  readMacroPackage,
  readMacroPackages,
  readMacroKinds,
  resolveActiveMacroPackages,
  updateEntry,
  type EntryData
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage,
  installSnlDocWatcher
} from './panelUtil';
import { startTrace, type Trace } from './trace';

/**
 * Rough serialized size of a context payload, for tracing only. The exact
 * number does not matter; the order of magnitude does — this payload is
 * structured-cloned to the webview on every push.
 */
function estimateSize(payload: unknown): string {
  try {
    const bytes = JSON.stringify(payload)?.length ?? 0;
    return bytes > 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
  } catch {
    return 'unknown';
  }
}

/**
 * Per-mode-and-identity singleton manager for the SNL Entry editor panel.
 *
 * Two entry points share this class:
 *  - `snlDoc.createEntry` → create-mode panel (no identity).
 *  - `snlDoc.editEntry`   → edit-mode panel keyed by entry id.
 *
 * Message protocol with the webview (`createEntry.js`):
 *  - in  : `{ type: 'ready' }` (asks for context)
 *        | `{ type: 'create', entry: EntryData }`
 *        | `{ type: 'update', entry: Omit<EntryData,'id'> }` (id is the panel key)
 *  - out : `{ type: 'context', mode, kinds, existing? }`
 *        | `{ type: 'kinds', kinds }` (legacy path kept for `ready` without context)
 *        | `{ type: 'created' | 'updated' | 'duplicate' | 'unknownKind'
 *            | 'notFound' | 'invalid' | 'noSnlDoc' | 'noWorkspace'
 *            | 'error', ... }`
 */
export class CreateEntryPanel {
  /**
   * The one Entry editor panel.
   *
   * Cat 2026-07-25: standing up a webview host costs ~1.09s in VS Code —
   * measured, and almost entirely BEFORE our bundle is even requested
   * (`html-set` → `document-start` = 1090ms; our 803KB bundle only cost
   * 29ms). That cost is unavoidable per panel, so the only way to make
   * switching entries feel fast is to stop creating panels: keep one and
   * retarget it, the way the Infoview already does. Second and later opens
   * skip the whole 1.09s.
   *
   * Trade-off cat accepted: you can no longer have two Entry editors open
   * side by side.
   */
  private static instance: CreateEntryPanel | undefined;

  private static readonly viewType = 'snlCreateEntry';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  /** Mutable: one panel serves every entry, retargeting as you navigate. */
  private mode: 'create' | 'edit';
  private id: string;
  /**
   * Optional seed id for `create` mode — piped through from callers that
   * already know what the entry should be called (e.g. Library outline's
   * Add form, cat 2026-07-15). Consumed once on first `context` push;
   * the webview treats it as a hint that overrides the auto-minted UUID.
   */
  private seedId: string;
  private disposables: vscode.Disposable[] = [];
  /**
   * Trace for the in-flight open, handed down from `open()` so the panel's
   * own stages land on one timeline. Cleared after the first context push.
   */
  private openTrace: Trace | undefined;
  /** Trace still waiting on the webview's own mount/paint marks. */
  private tracePending: Trace | undefined;

  public static createOrShow(
    extensionUri: vscode.Uri,
    seedId?: string
  ): void {
    CreateEntryPanel.open(extensionUri, 'create', '', seedId ?? '');
  }

  public static editOrShow(extensionUri: vscode.Uri, id: string): void {
    if (!id) {
      return;
    }
    CreateEntryPanel.open(extensionUri, 'edit', id, '');
  }

  private static open(
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    id: string,
    seedId: string
  ): void {
    // Cat 2026-07-25: trace the whole open path with ms timings so we can
    // see WHICH stage is slow instead of guessing. Off unless `snlDoc.trace`.
    const trace = startTrace('entryPanel:open', `mode=${mode} id=${id || '-'}`);
    const column = vscode.ViewColumn.Active;

    const existing = CreateEntryPanel.instance;
    if (existing) {
      // Retarget the live panel instead of building a new one — this is the
      // whole point of the singleton: skip the ~1.09s webview stand-up.
      existing.retarget(mode, id, seedId, column, trace);
      return;
    }

    const title =
      mode === 'edit' ? `SNL Edit Entry — ${id}` : 'SNL Create Entry';
    const panel = vscode.window.createWebviewPanel(
      CreateEntryPanel.viewType,
      title,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );
    trace.mark('webview-created');

    CreateEntryPanel.instance = new CreateEntryPanel(
      panel,
      extensionUri,
      mode,
      id,
      seedId,
      trace
    );
  }

  /**
   * Point the live panel at a different entry.
   *
   * The webview keeps running — no reload, no bundle re-parse — so this is
   * the fast path that makes navigating between entries feel instant. The
   * webview is told to reset first so it does not briefly show the previous
   * entry's fields while the new context is read.
   */
  private retarget(
    mode: 'create' | 'edit',
    id: string,
    seedId: string,
    column: vscode.ViewColumn,
    trace: Trace
  ): void {
    const sameTarget = this.mode === mode && this.id === id;
    this.mode = mode;
    this.id = id;
    if (mode === 'create' && seedId) {
      this.seedId = seedId;
    }
    this.panel.title =
      mode === 'edit' ? `SNL Edit Entry — ${id}` : 'SNL Create Entry';
    this.panel.reveal(column);
    if (sameTarget) {
      // Re-opening what is already shown: leave the author's in-progress
      // edits alone. Re-pushing context here would clobber them.
      if (mode === 'create' && seedId) this.applySeedId(seedId);
      trace.mark('reveal-existing');
      return;
    }
    // Different entry: clear the form before the new data lands so no field
    // from the previous entry is ever visible against the new id.
    void this.panel.webview.postMessage({ type: 'retarget', mode, id });
    this.openTrace = trace;
    trace.mark('retarget');
    void this.pushContext();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    id: string,
    seedId: string,
    trace?: Trace
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.mode = mode;
    this.id = id;
    this.seedId = seedId;
    this.openTrace = trace;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'createEntry',
      mode === 'edit' ? `SNL Edit Entry — ${id}` : 'SNL Create Entry'
    );
    // The webview now starts fetching + parsing its bundle on its own clock;
    // `webview:*` marks below come back from inside it.
    trace?.mark('html-set');

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    installSnlDocWatcher(this.disposables, () => this.pushContext());

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushContext(): Promise<void> {
    // Reuse the open trace for the first push; later pushes (watcher-driven
    // refreshes) get their own so a slow refresh is visible too.
    const trace = this.openTrace ?? startTrace('entryPanel:refresh');
    this.openTrace = undefined;
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({ type: 'kinds', kinds: [] });
      return;
    }
    trace.mark('read:start');
    // These four reads are independent, so they run concurrently instead of
    // one-after-another — the serial awaits were pure added latency on every
    // panel open. `readAllMacrosWithOrigin` also replaces a SECOND full walk
    // of every macro package that used to rebuild `macroOrigin` by hand.
    // Cat 2026-07-25: "各个 Panel 开起来都非常慢".
    // Each read is timed individually so a slow one is attributable; they
    // still run concurrently, so the marks show completion order.
    const timed = <T>(name: string, work: Promise<T>): Promise<T> =>
      work.then((value) => {
        trace.mark(`read:${name}`);
        return value;
      });
    const [kinds, macroBundle, macroKinds, allEntriesResult] = await Promise.all([
      timed('entryKinds', listEntryKinds(root)),
      timed('macros', readAllMacrosWithOrigin(root)),
      timed('macroKinds', readMacroKinds(root)),
      timed('entries', readEntries(root).catch((): EntryData[] => []))
    ]);
    const macros = macroBundle.macros;
    const macroOrigin = macroBundle.origin;
    const allEntries: EntryData[] = allEntriesResult;
    let existing: EntryData | null = null;
    if (this.mode === 'edit') {
      existing = allEntries.find((e) => e && e.id === this.id) ?? null;
    }
    trace.mark(
      'read:done',
      `macros=${Object.keys(macros).length} entries=${allEntries.length} ` +
        `kinds=${kinds.length}`
    );
    // Legacy `kinds` payload for backward compat with the current webview code;
    // `context` carries the same info plus mode + existing entry + macros.
    void this.panel.webview.postMessage({ type: 'kinds', kinds });
    const payload = {
      type: 'context',
      mode: this.mode,
      id: this.id || undefined,
      seedId: this.mode === 'create' && this.seedId ? this.seedId : undefined,
      kinds,
      macros,
      macroKinds,
      macroOrigin,
      existing,
      existingIds: allEntries.map(toEntryOption)
    };
    void this.panel.webview.postMessage(payload);
    // Payload size matters: everything here is structured-cloned across the
    // extension/webview boundary, and the macro table dominates it.
    trace.mark('context-posted', `payloadBytes≈${estimateSize(payload)}`);
    this.tracePending = trace;
  }

  /**
   * Push a new seed id into an already-open create panel. Called when
   * `snlDoc.createEntry` is re-invoked with a seed while the panel is
   * still visible from a prior invocation (cat 2026-07-15). Overwrites
   * whatever seed the panel was carrying and re-broadcasts context so
   * the webview picks up the new value without needing a full re-mount.
   */
  private applySeedId(seedId: string): void {
    if (this.mode !== 'create') return;
    this.seedId = seedId;
    void this.pushContext();
  }

  private async handleMessage(message: unknown): Promise<void> {
    // Timing marks reported by the webview itself — mount, first paint —
    // folded into the same timeline as the host stages so the whole open
    // path reads top-to-bottom. Cat 2026-07-25.
    const traceMsg = message as
      | { type?: string; stage?: string; ms?: number }
      | undefined;
    if (traceMsg?.type === 'trace' && typeof traceMsg.stage === 'string') {
      const trace = this.tracePending ?? this.openTrace;
      trace?.mark(
        `webview:${traceMsg.stage}`,
        typeof traceMsg.ms === 'number'
          ? `webviewClock=${traceMsg.ms.toFixed(1)}ms`
          : undefined
      );
      if (traceMsg.stage === 'first-paint') this.tracePending = undefined;
      return;
    }
    // Nav messages (back to Dashboard / Infoview) MUST be intercepted
    // before any type-filter early-return below drops them silently.
    // Cat 2026-07-10 caught this on Edit Library; every save-oriented
    // panel had the same shape.
    if (await handlePanelNavMessage(message, () => this.pushContext())) {
      return;
    }
    const msg = message as
      | { type?: string; entry?: EntryData }
      | undefined;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }

    if (msg.type === 'ready') {
      await this.pushContext();
      return;
    }
    if (msg.type === 'openMacroEditor') {
      const rawName = (msg as { name?: unknown }).name;
      const rawEnv = (msg as { env_mode?: unknown }).env_mode;
      const rawStyle = (msg as { style_name?: unknown }).style_name;
      const name = typeof rawName === 'string' ? rawName.trim() : '';
      const env_mode =
        rawEnv === 'formula_inline' ||
        rawEnv === 'formula_display' ||
        rawEnv === 'text'
          ? rawEnv
          : undefined;
      const style_name =
        typeof rawStyle === 'string' && rawStyle.length > 0 ? rawStyle : undefined;
      // Always allowed — even empty name / env_mode leaves route to
      // Create Macro with a matching prefill. Cat 2026-07-12.
      await this.openMacroEditor({ name, env_mode, style_name });
      return;
    }
    if (msg.type !== 'create' && msg.type !== 'update') {
      return;
    }

    const root = firstWorkspaceFolder();
    if (!root) {
      const text = 'SNL Entry editor requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    const entry = msg.entry;
    if (!entry || typeof entry !== 'object') {
      void this.panel.webview.postMessage({
        type: 'invalid',
        reason: 'no entry payload'
      });
      return;
    }

    try {
      if (msg.type === 'update' || this.mode === 'edit') {
        const result = await updateEntry(root, this.id, {
          kind: entry.kind,
          title: entry.title,
          content: entry.content,
          contribution_info: entry.contribution_info,
          pointer: entry.pointer
        });
                switch (result.status) {
          case 'updated':
            vscode.window.showInformationMessage(
              `Entry "${entry.title}" (${result.id}) updated.`
            );
            await this.panel.webview.postMessage({
              type: 'updated',
              id: result.id
            });
            await this.pushContext();
            return;
          case 'notFound': {
            const text = `Entry "${result.id}" no longer exists.`;
            vscode.window.showErrorMessage(text);
            void this.panel.webview.postMessage({
              type: 'notFound',
              id: result.id,
              message: text
            });
            return;
          }
          case 'unknownKind': {
            const text = `Unknown entry kind: "${result.kind}".`;
            vscode.window.showWarningMessage(text);
            void this.panel.webview.postMessage({
              type: 'unknownKind',
              kind: result.kind,
              message: text
            });
            return;
          }
          case 'invalid':
            void this.panel.webview.postMessage({
              type: 'invalid',
              reason: result.message
            });
            return;
          case 'noSnlDoc': {
            const text =
              '.SNL_Doc does not exist yet. Run "SNL: Init" first.';
            vscode.window.showErrorMessage(text);
            void this.panel.webview.postMessage({
              type: 'noSnlDoc',
              message: text
            });
            return;
          }
          case 'error':
            void this.panel.webview.postMessage({
              type: 'error',
              message: result.message
            });
            return;
        }
      }
      // Create path.
      const result = await addEntry(root, entry);
      switch (result.status) {
        case 'ok':
          vscode.window.showInformationMessage(
            `Entry "${entry.title}" (${result.id}) created.`
          );
          void this.panel.webview.postMessage({
            type: 'created',
            id: result.id
          });
          return;
        case 'duplicate': {
          const text = `Entry id "${result.id}" already exists.`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'duplicate',
            id: result.id,
            message: text
          });
          return;
        }
        case 'unknownKind': {
          const text = `Unknown entry kind: "${result.kind}".`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'unknownKind',
            kind: result.kind,
            message: text
          });
          return;
        }
        case 'invalid':
          void this.panel.webview.postMessage({
            type: 'invalid',
            reason: result.reason
          });
          return;
        case 'noSnlDoc': {
          const text = '.SNL_Doc does not exist yet. Run "SNL: Init" first.';
          vscode.window.showErrorMessage(text);
          void this.panel.webview.postMessage({
            type: 'noSnlDoc',
            message: text
          });
          return;
        }
        case 'error':
          void this.panel.webview.postMessage({
            type: 'error',
            message: result.message
          });
          return;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`SNL Entry editor failed: ${text}`);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  /**
   * Open the Create/Edit Macro panel for a macro referenced from inside
   * the Entry GUI editor. If the name already exists in an active package
   * we go straight to edit; otherwise we pick a target package (single
   * active → auto; multiple → quickpick) and open the create panel with
   * a prefill derived from the row (env_mode → macro mode + template;
   * plain identifier → prefilled name). Cat 2026-07-12: "在每一行边上
   * 加一个入口" + "Edit 跳转应该任何情况下都允许".
   */
  private async openMacroEditor(req: {
    name: string;
    env_mode?: 'formula_inline' | 'formula_display' | 'text';
    style_name?: string;
  }): Promise<void> {
    const root = firstWorkspaceFolder();
    if (!root) {
      vscode.window.showErrorMessage(
        'Cannot open the Macro editor: no workspace / folder is open.'
      );
      return;
    }
    const { name, env_mode } = req;
    // Edit path only when the row IS a plain identifier that already
    // exists in an active package. env_mode leaves and empty names always
    // fall through to Create.
    try {
      if (name && env_mode === undefined) {
        const active = new Set(await resolveActiveMacroPackages(root));
        const packages = await readMacroPackages(root);
        for (const summary of packages) {
          const bare = summary.file.replace(/\.json$/i, '');
          if (!active.has(bare)) continue;
          const read = await readMacroPackage(root, summary.file);
          if (read.status !== 'ok') continue;
          if (read.macros.some((m) => m.name === name)) {
            await vscode.commands.executeCommand(
              'snlDoc.editMacro',
              bare,
              name
            );
            return;
          }
        }
      }
      // Create path: pick a target package. Cat 2026-07-15: always
      // include a "＋ Create new package…" sentinel so the user can spawn
      // a fresh package from this flow without bouncing to the Dashboard
      // and losing the "I was here to add a macro" context. When zero
      // active packages exist we still show the picker with only the
      // sentinel (rather than the old dead-end warning).
      const activeList = Array.from(
        new Set(await resolveActiveMacroPackages(root))
      ).sort((a, b) => a.localeCompare(b));
      const CREATE_NEW_SENTINEL = '__snlDoc.createNewPackage__';
      type PickItem = vscode.QuickPickItem & { pkg: string };
      const items: PickItem[] = activeList.map((bare) => ({
        label: bare,
        description: '.SNL_Doc/term_macros/' + bare + '.json',
        pkg: bare
      }));
      items.push({
        label: '＋ Create new package…',
        description: 'Open the Create Macro Package panel',
        pkg: CREATE_NEW_SENTINEL
      });
      let target: string | undefined;
      if (activeList.length === 1) {
        // One active package + create-new option — still show the picker
        // so the user has the escape hatch (this is a two-item pick, not
        // an auto-accept). Cat 2026-07-15.
        const chosen = await vscode.window.showQuickPick(items, {
          title: name
            ? `Create macro "${name}" — choose target package`
            : 'Create macro — choose target package',
          placeHolder: 'Select an existing package or create a new one'
        });
        target = chosen?.pkg;
      } else {
        const chosen = await vscode.window.showQuickPick(items, {
          title: name
            ? `Create macro "${name}" — choose target package`
            : 'Create macro — choose target package',
          placeHolder:
            activeList.length === 0
              ? 'No active packages yet — create one to hold this macro'
              : 'Select the .SNL_Doc/term_macros/*.json to add it to'
        });
        target = chosen?.pkg;
      }
      if (!target) return;
      if (target === CREATE_NEW_SENTINEL) {
        // Route to the Create Macro Package panel. Once the user saves,
        // they can re-invoke the macro insertion from the Entry editor
        // and their new package will appear in the pick list. We don't
        // try to auto-continue because the two panels are independent
        // singletons and threading a callback through would leak
        // lifecycle across them. Cat 2026-07-15.
        await vscode.commands.executeCommand('snlDoc.createMacroPackage');
        return;
      }
      // Prefill derivation (cat 2026-07-12): env_mode leaves seed the
      // template with the raw payload + the matching macro mode; plain
      // identifiers seed the name field.
      const prefill: {
        name?: string;
        template?: string;
        mode?: 'formula_inline' | 'formula_display' | 'text';
      } = {};
      if (env_mode !== undefined) {
        prefill.mode = env_mode;
        prefill.template = name; // env_mode leaves stash the payload in `name`
      } else if (name) {
        prefill.name = name;
      }
      await vscode.commands.executeCommand(
        'snlDoc.createMacro',
        target,
        prefill
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to open Macro editor: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  public dispose(): void {
    CreateEntryPanel.instance = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
