import * as vscode from 'vscode';
import { InfoviewPanel } from './infoviewPanel';
import { CreateLibraryPanel } from './createLibraryPanel';
import { DashboardPanel } from './dashboardPanel';
import { isTraceEnabled, refreshTraceEnabled, setTraceEnabled, startTrace, traceChannel } from './trace';
import { registerWebviewCostProbe } from './webviewCostProbe';
import { InitEntryKindsPanel } from './initEntryKindsPanel';
import { CreateEntryKindPanel } from './createEntryKindPanel';
import { InitMacroKindsPanel } from './initMacroKindsPanel';
import { CreateMacroKindPanel } from './createMacroKindPanel';
import { CreateEntryPanel } from './createEntryPanel';
import { CreateMacroPackagePanel } from './createMacroPackagePanel';
import { PackagePanel } from './packagePanel';
import { CreateMacroPanel } from './createMacroPanel';
import { CreateRelationshipPanel } from './createRelationshipPanel';
import { GraphPanel } from './graphPanel';
import { SnoogLPanel } from './snooglPanel';
import { initSnlDoc } from './snlDoc';
import * as snlDoc from './snlDoc';
import { firstWorkspaceFolder } from './panelUtil';
import { initialize_preferences_host } from './preferencesHost';
import { installSnlDocContextKey } from './snlDocContext';

// TODO: import SNL_render from snl-script lib

/** Regex for safe bare package filenames (path-traversal guard). */
const MACRO_FILE_RE = /^[a-zA-Z0-9_-]+(\.json)?$/;

/**
 * Sanitize a command-arg prefill payload for the Create Macro panel.
 * Command callers can hand us anything; we defensively narrow to the
 * subset CreateMacroPanel understands. Returns `null` on nothing usable.
 */
function sanitizeCreateMacroPrefill(
  value: unknown
): {
  name?: string;
  template?: string;
  mode?: 'formula_inline' | 'formula_display' | 'text';
  copyFrom?: string;
} | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  const out: {
    name?: string;
    template?: string;
    mode?: 'formula_inline' | 'formula_display' | 'text';
    copyFrom?: string;
  } = {};
  if (typeof p.name === 'string' && p.name.length > 0) out.name = p.name;
  if (typeof p.template === 'string' && p.template.length > 0) out.template = p.template;
  if (p.mode === 'formula_inline' || p.mode === 'formula_display' || p.mode === 'text') {
    out.mode = p.mode;
  }
  if (typeof p.copyFrom === 'string' && p.copyFrom.trim()) {
    out.copyFrom = p.copyFrom.trim();
  }
  if (
    out.name === undefined &&
    out.template === undefined &&
    out.mode === undefined &&
    out.copyFrom === undefined
  ) {
    return null;
  }
  return out;
}

/**
 * Run `SNL: Init` directly — no webview, no extra UI step.
 *
 * Init is a one-shot scaffold action with no parameters, so opening a panel
 * just to host a single button was friction with zero payoff. We instead
 * call {@link initSnlDoc} synchronously from the command handler and report
 * via toast notifications.
 *
 * Status mapping (see {@link initSnlDoc}):
 *  - `created` → information toast
 *  - `exists`  → warning toast directing to `SNL: Create Library`
 *  - thrown   → error toast with the underlying message
 */
async function runInit(): Promise<void> {
  const workspaceRoot = firstWorkspaceFolder();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage(
      'SNL Init requires an open folder / workspace.'
    );
    return;
  }
  try {
    const result = await initSnlDoc(workspaceRoot);
    if (result.status === 'exists') {
      vscode.window.showWarningMessage(
        '.SNL_Doc already exists — use "SNL: Create Library" to add libraries.'
      );
      return;
    }
    vscode.window.showInformationMessage(
      'SNL Doc skeleton initialized. Use "SNL: Create Library" to add your first library.'
    );
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`SNL Init failed: ${text}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // Cat 2026-07-25: panel opens are "sometimes fast, sometimes slow". One
  // candidate is that the FIRST open of a session also pays for extension
  // activation (module loading, command registration). Stamp it so that
  // shows up on the same timeline instead of being invisible.
  refreshTraceEnabled();
  const activation = startTrace('extension:activate');
  initialize_preferences_host(context);
  // Drives the `when` clause of the editor-title 🐱 Dashboard button.
  installSnlDocContextKey(context.subscriptions);
  const openInfoview = vscode.commands.registerCommand(
    'snlDoc.openInfoview',
    (initialLibrarySlug?: unknown) => {
      const slug =
        typeof initialLibrarySlug === 'string' && initialLibrarySlug.trim()
          ? initialLibrarySlug.trim()
          : undefined;
      InfoviewPanel.createOrShow(context.extensionUri, slug);
    }
  );

  // No palette entry (see package.json `when: false`): invoked via
  // executeCommand('snlDoc.openEntryInfoview', entryId) from a Ctrl+click on
  // an EntryRender title or a hover popover.
  const openEntryInfoview = vscode.commands.registerCommand(
    'snlDoc.openEntryInfoview',
    (entryId?: unknown) => {
      if (typeof entryId !== 'string' || !entryId.trim()) {
        return;
      }
      InfoviewPanel.createOrShowForEntry(context.extensionUri, entryId.trim());
    }
  );

  // Manual refresh — force every open Infoview panel (browser + per-entry)
  // to re-fetch its data from disk. The auto-refresh watcher covers the
  // usual write paths (Dashboard save, .SNL_Doc/* edits) but doesn't catch
  // out-of-band writes like `git pull` or external scripts that mutate
  // `.SNL_Doc/`. Cat 2026-07-09.
  const refreshInfoview = vscode.commands.registerCommand(
    'snlDoc.refreshInfoview',
    () => {
      void InfoviewPanel.refreshAll();
    }
  );

  // Reveal a pointer bound to an entry (cat 2026-07-11). Invoked from
  // EntryRender's pointer-jump button via postMessage → the panel's
  // handleMessage → executeCommand('snlDoc.revealEntryPointer', entryId).
  // Resolves the pointer fresh each time (source-of-truth: fs + latest
  // entries.json), so a fixed pointer picks up file edits without a
  // panel reload. On failure, surfaces the diagnostic as an error toast.
  const revealEntryPointer = vscode.commands.registerCommand(
    'snlDoc.revealEntryPointer',
    async (entryId?: unknown) => {
      if (typeof entryId !== 'string' || !entryId.trim()) return;
      const root = firstWorkspaceFolder();
      if (!root) {
        void vscode.window.showErrorMessage(
          'Pointer cannot be resolved: no workspace folder is open.'
        );
        return;
      }
      const trimmed = entryId.trim();
      let entries: snlDoc.EntryData[];
      try {
        entries = await snlDoc.readEntries(root);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to load entries: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
      const entry = entries.find((e) => e.id === trimmed);
      if (!entry) {
        void vscode.window.showErrorMessage(
          `Entry not found: ${trimmed}`
        );
        return;
      }
      const { normalizeEntryPointer, resolveEntryPointer, revealResolvedPointer, describeResolutionFailure } =
        await import('./pointer');
      const pointer = normalizeEntryPointer(entry.pointer);
      if (!pointer) {
        void vscode.window.showErrorMessage(
          `Entry ${trimmed} has no valid pointer.`
        );
        return;
      }
      const resolved = await resolveEntryPointer(root, pointer);
      if (resolved.status !== 'ok') {
        void vscode.window.showErrorMessage(describeResolutionFailure(resolved));
        return;
      }
      try {
        await revealResolvedPointer(resolved);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to open file: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  // Delete commands (cat 2026-07-09). Each one: confirm with the user
  // (with reference count from the backend), call the backend, close any
  // matching open editor panel so a re-open doesn't resurrect stale
  // state. The backends themselves report dangling references but don't
  // block — the UX decision "block on refs?" lives here in each command
  // so the different entity types can have different policies.
  const deleteEntry = vscode.commands.registerCommand(
    'snlDoc.deleteEntry',
    async (entryId?: unknown) => {
      const id = typeof entryId === 'string' ? entryId.trim() : '';
      if (!id) return;
      const root = firstWorkspaceFolder();
      if (!root) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Delete entry "${id}"?`,
        { modal: true, detail: 'This removes the entry from the shared pool. Library outlines and macro sources that reference this id will render as "unresolved" but keep working.' },
        'Delete'
      );
      if (confirmed !== 'Delete') return;
      const res = await snlDoc.deleteEntry(root, id);
      if (res.status !== 'ok') {
        void vscode.window.showErrorMessage(
          `Delete entry failed: ${'message' in res ? res.message : res.status}`
        );
        return;
      }
      const refCount =
        res.references.libraryNodes.length +
        res.references.macroSources.length +
        res.references.relationships.length;
      const noun = refCount === 1 ? '1 reference' : `${refCount} references`;
      void vscode.window.showInformationMessage(
        refCount > 0
          ? `Deleted entry "${id}". ${noun} left dangling (library outlines / macro sources / relationships).`
          : `Deleted entry "${id}".`
      );
    }
  );

  const deleteEntryKind = vscode.commands.registerCommand(
    'snlDoc.deleteEntryKind',
    async (kindId?: unknown) => {
      const id = typeof kindId === 'string' ? kindId.trim() : '';
      if (!id) return;
      const root = firstWorkspaceFolder();
      if (!root) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Delete entry kind "${id}"?`,
        { modal: true, detail: 'Entries that use this kind will keep working but render as "unknown kind" until their kind field is updated.' },
        'Delete'
      );
      if (confirmed !== 'Delete') return;
      const res = await snlDoc.deleteEntryKind(root, id);
      if (res.status !== 'ok') {
        void vscode.window.showErrorMessage(
          `Delete entry kind failed: ${'message' in res ? res.message : res.status}`
        );
        return;
      }
      const n = res.references.entries.length;
      void vscode.window.showInformationMessage(
        n > 0
          ? `Deleted entry kind "${id}". ${n} entr${n === 1 ? 'y' : 'ies'} now reference an unknown kind.`
          : `Deleted entry kind "${id}".`
      );
    }
  );

  const deleteMacroKind = vscode.commands.registerCommand(
    'snlDoc.deleteMacroKind',
    async (kindId?: unknown) => {
      const id = typeof kindId === 'string' ? kindId.trim() : '';
      if (!id) return;
      const root = firstWorkspaceFolder();
      if (!root) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Delete macro kind "${id}"?`,
        { modal: true, detail: 'Macros that use this kind will render with the fallback badge color until re-classified.' },
        'Delete'
      );
      if (confirmed !== 'Delete') return;
      const res = await snlDoc.deleteMacroKind(root, id);
      if (res.status !== 'ok') {
        void vscode.window.showErrorMessage(
          `Delete macro kind failed: ${'message' in res ? res.message : res.status}`
        );
        return;
      }
      const n = res.references.length;
      void vscode.window.showInformationMessage(
        n > 0
          ? `Deleted macro kind "${id}". ${n} macro${n === 1 ? '' : 's'} now reference an unknown kind.`
          : `Deleted macro kind "${id}".`
      );
    }
  );

  const deleteLibrary = vscode.commands.registerCommand(
    'snlDoc.deleteLibrary',
    async (slug?: unknown) => {
      const librarySlug = typeof slug === 'string' ? slug.trim() : '';
      if (!librarySlug) return;
      const root = firstWorkspaceFolder();
      if (!root) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Delete library "${librarySlug}"?`,
        { modal: true, detail: 'The library directory (meta.json + graph.json) moves to the OS trash. Entries referenced by the library remain in the shared pool.' },
        'Delete'
      );
      if (confirmed !== 'Delete') return;
      const res = await snlDoc.deleteLibrary(root, librarySlug);
      if (res.status !== 'ok') {
        void vscode.window.showErrorMessage(
          `Delete library failed: ${'message' in res ? res.message : res.status}`
        );
        return;
      }
      void vscode.window.showInformationMessage(
        `Deleted library "${librarySlug}". Underlying entries were NOT touched.`
      );
    }
  );

  const deleteMacroPackage = vscode.commands.registerCommand(
    'snlDoc.deleteMacroPackage',
    async (file?: unknown) => {
      const raw = typeof file === 'string' ? file.trim() : '';
      if (!raw) return;
      const root = firstWorkspaceFolder();
      if (!root) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Delete macro package "${raw}"?`,
        { modal: true, detail: 'The package file is removed and the package is dropped from active_macro_packages. Macros defined only in this package become unresolved until re-added elsewhere.' },
        'Delete'
      );
      if (confirmed !== 'Delete') return;
      const res = await snlDoc.deleteMacroPackage(root, raw);
      if (res.status === 'ok') {
        void vscode.window.showInformationMessage(`Deleted macro package "${res.file}".`);
      } else if (res.status === 'noFile') {
        void vscode.window.showWarningMessage(`Macro package "${raw}" not found.`);
      } else {
        void vscode.window.showErrorMessage(`Delete macro package failed: ${res.message}`);
      }
    }
  );

  const init = vscode.commands.registerCommand('snlDoc.init', runInit);

  const createLibrary = vscode.commands.registerCommand(
    'snlDoc.createLibrary',
    () => {
      CreateLibraryPanel.createOrShow(context.extensionUri);
    }
  );

  // Edit by slug. Slug validation is intentionally light — we trust it
  // because it comes either from the Dashboard's overview (i.e. from disk)
  // or from the user's own config. The panel re-verifies existence when
  // reading context.
  const editLibrary = vscode.commands.registerCommand(
    'snlDoc.editLibrary',
    (slug?: unknown) => {
      if (typeof slug !== 'string' || !slug.trim()) {
        return;
      }
      CreateLibraryPanel.editOrShow(context.extensionUri, slug.trim());
    }
  );

  const openDashboard = vscode.commands.registerCommand(
    'snlDoc.openDashboard',
    () => {
      DashboardPanel.createOrShow(context.extensionUri);
    }
  );

  // Panel timing diagnostics (cat 2026-07-25). Off by default; the command
  // flips it for the session so you can capture one open without editing
  // settings, and the config change listener keeps the two in sync.
  refreshTraceEnabled();
  const toggleTrace = vscode.commands.registerCommand(
    'snlDoc.toggleTrace',
    () => {
      const now = setTraceEnabled(!isTraceEnabled());
      void vscode.window.showInformationMessage(
        now
          ? 'SNL panel timing trace ON — open a panel, then check the "SNL Trace" output channel.'
          : 'SNL panel timing trace OFF.'
      );
    }
  );
  const traceConfigWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('snlDoc.trace')) refreshTraceEnabled();
  });

  // Cat 2026-07-26: settles per-window-boot vs per-panel for the ~1.09s that
  // every panel pays before our code runs. Reports into the same "SNL Trace"
  // channel. See webviewCostProbe.ts for why guessing was not an option.
  const probeChannel =
    traceChannel() ?? vscode.window.createOutputChannel('SNL Trace');
  const probeWebviewCost = registerWebviewCostProbe(probeChannel);

  const initEntryKinds = vscode.commands.registerCommand(
    'snlDoc.initEntryKinds',
    () => {
      InitEntryKindsPanel.createOrShow(context.extensionUri);
    }
  );

  const createEntryKind = vscode.commands.registerCommand(
    'snlDoc.createEntryKind',
    () => {
      CreateEntryKindPanel.createOrShow(context.extensionUri);
    }
  );

  const editEntryKind = vscode.commands.registerCommand(
    'snlDoc.editEntryKind',
    (id?: unknown) => {
      if (typeof id !== 'string' || !id.trim()) {
        return;
      }
      CreateEntryKindPanel.editOrShow(context.extensionUri, id.trim());
    }
  );

  const initMacroKinds = vscode.commands.registerCommand(
    'snlDoc.initMacroKinds',
    () => {
      InitMacroKindsPanel.createOrShow(context.extensionUri);
    }
  );

  const createMacroKind = vscode.commands.registerCommand(
    'snlDoc.createMacroKind',
    () => {
      CreateMacroKindPanel.createOrShow(context.extensionUri);
    }
  );

  const editMacroKind = vscode.commands.registerCommand(
    'snlDoc.editMacroKind',
    (id?: unknown) => {
      if (typeof id !== 'string' || !id.trim()) {
        return;
      }
      CreateMacroKindPanel.editOrShow(context.extensionUri, id.trim());
    }
  );

  const createEntry = vscode.commands.registerCommand(
    'snlDoc.createEntry',
    (seedId?: unknown) => {
      // Cat 2026-07-15: optional `seedId` from callers that already know
      // the intended entry id (e.g. Library outline's Add form when the
      // user typed an id that doesn't exist yet). CreateEntryPanel uses
      // it to prefill the id field instead of minting a fresh UUID.
      const seed =
        typeof seedId === 'string' && seedId.trim() ? seedId.trim() : undefined;
      CreateEntryPanel.createOrShow(context.extensionUri, seed);
    }
  );

  const editEntry = vscode.commands.registerCommand(
    'snlDoc.editEntry',
    (id?: unknown) => {
      if (typeof id !== 'string' || !id.trim()) {
        return;
      }
      CreateEntryPanel.editOrShow(context.extensionUri, id.trim());
    }
  );

  const createMacroPackage = vscode.commands.registerCommand(
    'snlDoc.createMacroPackage',
    () => {
      CreateMacroPackagePanel.createOrShow(context.extensionUri);
    }
  );

  const editMacroPackage = vscode.commands.registerCommand(
    'snlDoc.editMacroPackage',
    (file?: unknown) => {
      if (typeof file !== 'string' || !MACRO_FILE_RE.test(file)) {
        return;
      }
      CreateMacroPackagePanel.editOrShow(context.extensionUri, file);
    }
  );

  // No palette entry (see package.json `when: false`): invoked via
  // executeCommand('snlDoc.openMacroPackage', file) from the Dashboard row
  // click and from CreateMacroPackagePanel after a successful create.
  const openMacroPackage = vscode.commands.registerCommand(
    'snlDoc.openMacroPackage',
    (file?: unknown) => {
      if (typeof file !== 'string') {
        return;
      }
      if (!MACRO_FILE_RE.test(file)) {
        vscode.window.showErrorMessage(
          `Refusing to open macro package with unsafe name: "${file}".`
        );
        return;
      }
      PackagePanel.createOrShow(context.extensionUri, file);
    }
  );

  // No palette entry: invoked via executeCommand('snlDoc.createMacro', file, prefill?)
  // from a PackagePanel's "+ Create Macro" bar or the Entry GUI editor's
  // per-row "↗ new" button (cat 2026-07-12; prefill carries env_mode-→
  // mode + template, or a bare name).
  const createMacro = vscode.commands.registerCommand(
    'snlDoc.createMacro',
    (file?: unknown, prefill?: unknown) => {
      if (typeof file !== 'string') {
        return;
      }
      if (!MACRO_FILE_RE.test(file)) {
        vscode.window.showErrorMessage(
          `Refusing to create a macro in package with unsafe name: "${file}".`
        );
        return;
      }
      CreateMacroPanel.createOrShow(
        context.extensionUri,
        file,
        sanitizeCreateMacroPrefill(prefill)
      );
    }
  );

  // No palette entry: invoked via executeCommand('snlDoc.editMacro', file, macroName)
  // from a PackagePanel's clickable macro row.
  const editMacro = vscode.commands.registerCommand(
    'snlDoc.editMacro',
    (file?: unknown, macroName?: unknown) => {
      if (typeof file !== 'string' || typeof macroName !== 'string') {
        return;
      }
      if (!MACRO_FILE_RE.test(file)) {
        vscode.window.showErrorMessage(
          `Refusing to edit a macro in package with unsafe name: "${file}".`
        );
        return;
      }
      if (!macroName.trim()) {
        return;
      }
      CreateMacroPanel.editOrShow(context.extensionUri, file, macroName.trim());
    }
  );

  // Relationship editor commands (cat 2026-07-10). Create/edit route to
  // the shared CreateRelationshipPanel; delete goes through the same
  // modal-confirm dance as other entities.
  const createRelationship = vscode.commands.registerCommand(
    'snlDoc.createRelationship',
    () => {
      CreateRelationshipPanel.createOrShow(context.extensionUri);
    }
  );

  const editRelationship = vscode.commands.registerCommand(
    'snlDoc.editRelationship',
    (id?: unknown) => {
      if (typeof id !== 'string' || !id.trim()) return;
      CreateRelationshipPanel.editOrShow(context.extensionUri, id.trim());
    }
  );

  const deleteRelationship = vscode.commands.registerCommand(
    'snlDoc.deleteRelationship',
    async (relId?: unknown) => {
      const id = typeof relId === 'string' ? relId.trim() : '';
      if (!id) return;
      const root = firstWorkspaceFolder();
      if (!root) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Delete relationship "${id}"?`,
        {
          modal: true,
          detail:
            'The edge is removed from the pool-wide relationship graph. Endpoint entries are NOT touched.'
        },
        'Delete'
      );
      if (confirmed !== 'Delete') return;
      const res = await snlDoc.deleteRelationship(root, id);
      if (res.status !== 'ok') {
        void vscode.window.showErrorMessage(
          `Delete relationship failed: ${'message' in res ? res.message : res.status}`
        );
        return;
      }
      void vscode.window.showInformationMessage(`Deleted relationship "${id}".`);
    }
  );

  // Graph viewer commands (cat 2026-07-10 Phase 2). Pool-wide entry
  // point (palette) + per-library entry point (from Infoview library
  // page). Both open the same GraphPanel class with different scopes.
  const openInfoviewGraph = vscode.commands.registerCommand(
    'snlDoc.openInfoviewGraph',
    () => {
      GraphPanel.openPool(context.extensionUri);
    }
  );

  const openInfoviewGraphForLibrary = vscode.commands.registerCommand(
    'snlDoc.openInfoviewGraphForLibrary',
    (slug?: unknown) => {
      if (typeof slug !== 'string' || !slug.trim()) return;
      GraphPanel.openForLibrary(context.extensionUri, slug.trim());
    }
  );

  // Auto-generate dependency relationships from macro-source scanning
  // (cat 2026-07-10 §3). Two entry points:
  //   - pool-wide  (Dashboard button, palette command)
  //   - per-entry  (invoked from Entry editor after a save — future)
  const regenerateDependencies = vscode.commands.registerCommand(
    'snlDoc.regenerateDependencies',
    async (scopeArg?: unknown) => {
      const root = firstWorkspaceFolder();
      if (!root) {
        vscode.window.showErrorMessage(
          'SNL: Regenerate Dependencies requires an open folder.'
        );
        return;
      }
      // scopeArg shape: undefined → pool-wide; { entryIds: string[] } → subset.
      let scope: { entryIds: Set<string> | null } = { entryIds: null };
      if (
        scopeArg &&
        typeof scopeArg === 'object' &&
        Array.isArray((scopeArg as { entryIds?: unknown }).entryIds)
      ) {
        const arr = (scopeArg as { entryIds: string[] }).entryIds.filter(
          (x) => typeof x === 'string' && x.trim()
        );
        scope = { entryIds: new Set(arr) };
      }
      const scopeLabel =
        scope.entryIds === null
          ? 'the whole entry pool'
          : `${scope.entryIds.size} entr${scope.entryIds.size === 1 ? 'y' : 'ies'}`;
      const confirmed = await vscode.window.showWarningMessage(
        `Regenerate dependency relationships for ${scopeLabel}?`,
        {
          modal: true,
          detail:
            'Scans each entry\'s SNL content for macro uses, resolves each macro\'s source.entries[] and emits a "depends" edge per (entry, source) pair.\n\n' +
            'User-authored relationships (label ≠ "depends" or missing generator tag) are preserved. Auto rows outside the scope are also preserved. Atomicity (metadata.isAtomic) is recomputed globally over the merged depends-graph.'
        },
        'Regenerate'
      );
      if (confirmed !== 'Regenerate') return;
      const res = await snlDoc.regenerateDependencyRelationships(root, scope);
      if (res.status !== 'ok') {
        vscode.window.showErrorMessage(
          `Regenerate dependencies failed: ${'message' in res ? res.message : res.status}`
        );
        return;
      }
      const r = res.report;
      vscode.window.showInformationMessage(
        `Dependencies regenerated. +${r.added} / ~${r.updated} / −${r.removed}. ` +
          `${r.totalDepends} "depends" edges, ${r.totalUsesContext} "uses_context" edges ` +
          `(${r.atomicCount} atomic total). ` +
          `${r.preservedUser} user-authored rows preserved.`
      );
    }
  );

  const openSnoogL = vscode.commands.registerCommand(
    'snlDoc.openSnoogL',
    (initialMode?: unknown) => {
      const mode =
        initialMode === 'macro' || initialMode === 'entry'
          ? (initialMode as 'entry' | 'macro')
          : 'entry';
      SnoogLPanel.open(context.extensionUri, mode);
    }
  );

  // Cat 2026-07-13: Dashboard's SNL Macros header wants a "+ Create
  // Macro" button in the collapsed-row header, but Create Macro requires
  // a target package file. Show a QuickPick over the ACTIVE macro
  // packages first, then delegate to snlDoc.createMacro with the pick.
  const createMacroPickPackage = vscode.commands.registerCommand(
    'snlDoc.createMacroPickPackage',
    async () => {
      const rootUri = (() => {
        const folders = vscode.workspace.workspaceFolders;
        return folders && folders.length > 0 ? folders[0].uri : undefined;
      })();
      if (!rootUri) {
        void vscode.window.showErrorMessage(
          'Open a folder / workspace before creating a macro.'
        );
        return;
      }
      let packages: { file: string }[];
      try {
        const { readMacroPackages, resolveActiveMacroPackages } = await import(
          './snlDoc'
        );
        const active = new Set(await resolveActiveMacroPackages(rootUri));
        const all = await readMacroPackages(rootUri);
        packages = all
          // `active` holds BARE names; `p.file` carries `.json`, so comparing
          // them directly never matched and this list was always empty.
          .filter((p) => active.has(p.file.replace(/\.json$/i, '')))
          .map((p) => ({ file: p.file }));
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to list macro packages: ${(err as Error).message}`
        );
        return;
      }
      if (packages.length === 0) {
        void vscode.window.showInformationMessage(
          'No active macro packages. Create one first from the Dashboard.'
        );
        return;
      }
      let file: string;
      if (packages.length === 1) {
        file = packages[0].file;
      } else {
        const pick = await vscode.window.showQuickPick(
          packages.map((p) => ({ label: p.file, file: p.file })),
          { placeHolder: 'Select package for the new macro' }
        );
        if (!pick) return;
        file = pick.file;
      }
      await vscode.commands.executeCommand('snlDoc.createMacro', file);
    }
  );

  context.subscriptions.push(
    openInfoview,
    openEntryInfoview,
    refreshInfoview,
    revealEntryPointer,
    deleteEntry,
    deleteEntryKind,
    deleteMacroKind,
    deleteLibrary,
    deleteMacroPackage,
    init,
    createLibrary,
    editLibrary,
    openDashboard,
    toggleTrace,
    traceConfigWatcher,
    probeWebviewCost,
    initEntryKinds,
    createEntryKind,
    editEntryKind,
    initMacroKinds,
    createMacroKind,
    editMacroKind,
    createEntry,
    editEntry,
    createMacroPackage,
    editMacroPackage,
    openMacroPackage,
    createMacro,
    editMacro,
    createRelationship,
    editRelationship,
    deleteRelationship,
    openInfoviewGraph,
    openInfoviewGraphForLibrary,
    regenerateDependencies,
    openSnoogL,
    createMacroPickPackage
  );
  activation.mark('done');
}

export function deactivate(): void {
  // no-op
}
