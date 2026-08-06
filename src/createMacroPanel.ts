import * as vscode from 'vscode';
import { bind_preferences_panel_title } from './preferencesHost';
import { createHostTranslator, defineHostMessages } from './hostI18n';
import { read_extension_preferences } from './preferences';

const MESSAGES = defineHostMessages(
  {
    createTitle: 'SNL Create Macro — {file}', editTitle: 'SNL Edit Macro — {name} ({file})', loadFailed: 'Could not load Macro editor data: {error}', loadPackageFailed: 'Could not load Macro Package {file}: {error}', noWorkspace: 'SNL Macro editor requires an open folder / workspace.', noPayload: 'No macro payload was provided.', updated: 'Macro “{name}” in {file}.json updated.', notFound: 'Macro “{name}” no longer exists in {file}.json.', initFirst: '.SNL_Doc does not exist yet. Run “SNL: Init” first.', created: 'Macro “{name}” added to {file}.json.', duplicate: 'Macro “{name}” already exists in this package.', noFile: 'Package {file}.json no longer exists.', editorFailed: 'SNL Macro editor failed: {error}'
  },
  {
    createTitle: 'SNL 创建宏 — {file}', editTitle: 'SNL 编辑宏 — {name}（{file}）', loadFailed: '无法加载宏编辑器数据：{error}', loadPackageFailed: '无法加载宏包 {file}：{error}', noWorkspace: 'SNL 宏编辑器需要打开文件夹或工作区。', noPayload: '未提供宏数据。', updated: '宏“{name}”已在 {file}.json 中更新。', notFound: '宏“{name}”已不在 {file}.json 中。', initFirst: '.SNL_Doc 尚不存在。请先运行“SNL：初始化”。', created: '宏“{name}”已添加到 {file}.json。', duplicate: '宏“{name}”已存在于此包中。', noFile: '包 {file}.json 已不存在。', editorFailed: 'SNL 宏编辑器失败：{error}'
  }
);
const hostText = () => createHostTranslator(read_extension_preferences().language, MESSAGES);
import {
  addMacro,
  entityRevision,
  readEntries,
  readAllMacros,
  readMacroKinds,
  readMacroPackage,
  updateMacro,
  type EntryData,
  type MacroKind,
  type MacroPackageEntry
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage } from './panelUtil';
import type { SnooglSearchCandidate } from './snooglSearch';

/**
 * Compact projection of {@link EntryData} sent to the webview's entry
 * picker. Mirrors the `EntryOption` shape exported from
 * `webview/src/render/EntryRender.tsx` — kept as a plain object literal here
 * to avoid pulling the webview module into the host bundle.
 */
interface EntryOption {
  id: string;
  title: string;
  hasContent: boolean;
}

interface CreateMacroPrefill {
  name?: string;
  template?: string;
  mode?: 'formula_inline' | 'formula_display' | 'text';
  /** Resolve this macro from the target package and clone it into create mode. */
  copyFrom?: string;
}

/** Convert an EntryData record into the picker projection. Empty title is
 *  legal (per snlDoc.ts spec); the picker renders it as "(untitled)". */
function toEntryOption(e: EntryData): EntryOption {
  const content = e.content ?? {};
  const hasContent =
    typeof content.snl === 'string' && content.snl.trim().length > 0;
  return { id: e.id, title: e.title ?? '', hasContent };
}

/** Strip a trailing `.json` (case-insensitive) from a package file argument. */
function stripJsonExt(file: string): string {
  return file.replace(/\.json$/i, '');
}

/**
 * Per-mode-and-identity singleton manager for the SNL Macro editor panel.
 *
 * Two entry points share this class:
 *  - `snlDoc.createMacro`(file)                → create-mode panel keyed by
 *                                                package file (per-file editor).
 *  - `snlDoc.editMacro`(file, macroName)       → edit-mode panel keyed by
 *                                                package file + macro name.
 *
 * Message protocol with the webview (`createMacro.js`):
 *  - in  : `{ type: 'ready' }`
 *        | `{ type: 'create', macro: MacroPackageEntry }`
 *        | `{ type: 'update', macro: MacroPackageEntry }` (name = panel key)
 *  - out : `{ type: 'context', mode, file, packageName, existingNames,
 *            macroKinds, existing? }`
 *        | `{ type: 'created' | 'updated' | 'duplicate' | 'notFound'
 *            | 'invalid' | 'noFile' | 'error' | 'noWorkspace', ... }`
 */
export class CreateMacroPanel {
  private static readonly instances = new Map<string, CreateMacroPanel>();
  /** Copy is an explicit request for a new form; never steal a dirty create draft. */
  private static copySequence = 0;

  private static readonly viewType = 'snlCreateMacro';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  // Mutable: a successful CREATE flips this panel in place to 'edit' mode
  // (cat 2026-07-27) so the user can keep editing what they just made.
  private mode: 'create' | 'edit';
  /** Bare filename (no `.json`) of the target package. */
  private readonly file: string;
  /** Current key in instances; copy-create panels have a unique pre-create key. */
  private instanceKey: string;
  /** Macro name being edited (mode === 'edit' only). */
  // Mutable for the same create->edit flip: it becomes the created name.
  private macroName: string;
  private disposables: vscode.Disposable[] = [];
  private contextGeneration = 0;

  /**
   * Optional prefill (cat 2026-07-12) for CREATE mode only. Passed
   * verbatim to the webview on `context` so the form seeds itself
   * before the user types. `mode` seeds the primary style's mode
   * picker; `template` seeds the KaTeX template field; `name` seeds
   * the name field.
   */
  private prefill: CreateMacroPrefill | null;

  public static createOrShow(
    extensionUri: vscode.Uri,
    file: string,
    prefill?: CreateMacroPrefill | null
  ): void {
    const bare = stripJsonExt(file);
    if (!bare) {
      return;
    }
    CreateMacroPanel.open(extensionUri, 'create', bare, '', prefill ?? null);
  }

  public static editOrShow(
    extensionUri: vscode.Uri,
    file: string,
    macroName: string
  ): void {
    const bare = stripJsonExt(file);
    if (!bare || !macroName) {
      return;
    }
    CreateMacroPanel.open(extensionUri, 'edit', bare, macroName, null);
  }

  private static open(
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    file: string,
    macroName: string,
    prefill: CreateMacroPrefill | null
  ): void {
    const column = vscode.ViewColumn.Active;
    const key =
      mode === 'create' && prefill?.copyFrom
        ? `create:${file}:copy:${++CreateMacroPanel.copySequence}`
        : `${mode}:${file}:${macroName}`;

    const existing = CreateMacroPanel.instances.get(key);
    if (existing) {
      if (prefill) {
        existing.prefill = prefill;
        void existing.pushContext();
      }
      existing.panel.reveal(column);
      return;
    }

    const title = mode === 'edit'
      ? hostText()('editTitle', { name: macroName, file })
      : hostText()('createTitle', { file });

    const panel = vscode.window.createWebviewPanel(
      CreateMacroPanel.viewType,
      title,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );
    const instance = new CreateMacroPanel(
      panel, extensionUri, mode, file, macroName, prefill, key
    );
    bind_preferences_panel_title(panel, () => instance.mode === 'edit'
      ? hostText()('editTitle', { name: instance.macroName, file: instance.file })
      : hostText()('createTitle', { file: instance.file }));

    CreateMacroPanel.instances.set(key, instance);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    file: string,
    macroName: string,
    prefill: CreateMacroPrefill | null,
    instanceKey: string
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.mode = mode;
    this.file = file;
    this.macroName = macroName;
    this.prefill = prefill;
    this.instanceKey = instanceKey;

    const title = mode === 'edit'
      ? hostText()('editTitle', { name: macroName, file })
      : hostText()('createTitle', { file });
    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'createMacro',
      title
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    const root = firstWorkspaceFolder();
    if (root) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const refresh = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          void this.pushContext();
        }, 120);
      };
      this.disposables.push({ dispose: () => { if (timer) clearTimeout(timer); } });
      for (const pattern of [
        '.SNL_Doc/config.json',
        '.SNL_Doc/entries.json',
        '.SNL_Doc/entries/*.json',
        '.SNL_Doc/term_macros/*.json',
        '.SNL_Doc/packages/*.json',
        '.SNL_Doc/macros/*.json'
      ]) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(root, pattern)
        );
        watcher.onDidCreate(refresh, null, this.disposables);
        watcher.onDidChange(refresh, null, this.disposables);
        watcher.onDidDelete(refresh, null, this.disposables);
        this.disposables.push(watcher);
      }
    }

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushContext(): Promise<void> {
    const generation = ++this.contextGeneration;
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({
        type: 'context',
        mode: this.mode,
        file: `${this.file}.json`,
        packageName: this.file,
        existingNames: [],
        macroCandidates: [],
        workspaceMacros: {},
        macroKinds: [],
        existing: null,
        entries: [],
        prefill: this.mode === 'create' ? this.prefill : null
      });
      return;
    }
    // Independent reads — run them concurrently rather than one after
    // another. Cat 2026-07-25: "各个 Panel 开起来都非常慢".
    let contextReads: [
      Awaited<ReturnType<typeof readMacroKinds>>,
      Awaited<ReturnType<typeof readAllMacros>>,
      Awaited<ReturnType<typeof readEntries>>,
      Awaited<ReturnType<typeof readMacroPackage>>
    ];
    try {
      contextReads = await Promise.all([
        readMacroKinds(root),
        readAllMacros(root),
        readEntries(root),
        readMacroPackage(root, this.file)
      ]);
    } catch (error) {
      if (generation !== this.contextGeneration) return;
      void this.panel.webview.postMessage({
        type: 'error',
        message: hostText()('loadFailed', { error: error instanceof Error ? error.message : String(error) })
      });
      return;
    }
    const [macroKinds, allMacros, rawEntries, read] = contextReads;
    if (generation !== this.contextGeneration) return;
    const macroCandidates: SnooglSearchCandidate[] = Object.entries(allMacros)
      .map(([id, macro]) => ({ id, labels: macro.tags ?? [] }))
      .sort((left, right) => left.id.localeCompare(right.id));
    // Shared entry pool for the source.entries picker. Strict entity errors
    // were handled above rather than silently replacing the picker with [].
    const entries: EntryOption[] = rawEntries.map(toEntryOption);
    if (read.status === 'ok') {
      const existing =
        this.mode === 'edit'
          ? read.macros.find((m) => m.name === this.macroName) ?? null
          : null;
      const copySource =
        this.mode === 'create' && this.prefill?.copyFrom
          ? read.macros.find((macro) => macro.name === this.prefill?.copyFrom)
          : undefined;
      const prefill = copySource
        ? { macro: { ...copySource, name: '' } }
        : this.prefill;
      const previewMacros = {
        ...allMacros,
        ...Object.fromEntries(read.macros.map((macro) => [macro.name, macro]))
      };
      void this.panel.webview.postMessage({
        type: 'context',
        mode: this.mode,
        file: `${this.file}.json`,
        packageName: read.pkg.name,
        existingNames: read.macros.map((m) => m.name),
        macroCandidates,
        workspaceMacros: previewMacros,
        macroKinds,
        existing,
        macroRevision: existing ? entityRevision(existing) : undefined,
        entries,
        prefill: this.mode === 'create' ? prefill : null
      });
      return;
    }
    if (read.status === 'error') {
      void this.panel.webview.postMessage({
        type: 'error',
        message: hostText()('loadPackageFailed', { file: JSON.stringify(this.file), error: read.message })
      });
      return;
    }
    // A concurrently removed Package is represented as an empty create context.
    void this.panel.webview.postMessage({
      type: 'context',
      mode: this.mode,
      file: `${this.file}.json`,
      packageName: this.file,
      existingNames: [],
      macroCandidates,
      workspaceMacros: allMacros,
      macroKinds,
      existing: null,
      entries,
      prefill: this.mode === 'create' ? this.prefill : null
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    // Nav messages (back to Dashboard / Infoview) MUST be intercepted
    // before any type-filter early-return below drops them silently.
    // Cat 2026-07-10 caught this on Edit Library; every save-oriented
    // panel had the same shape.
    if (await handlePanelNavMessage(message, () => this.pushContext())) {
      return;
    }
    const msg = message as
      | { type?: string; macro?: MacroPackageEntry; expectedRevision?: string }
      | undefined;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }

    if (msg.type === 'ready') {
      await this.pushContext();
      return;
    }
    if (msg.type === 'createMacroKind') {
      // Cat 2026-07-12: the Kind dropdown grew a "+ New macro kind…" option.
      // Fire the existing command; the user fills in the child panel; a
      // subsequent `refreshKinds` from this webview (see visibilitychange
      // handler) will pull the newly-added kind in.
      await vscode.commands.executeCommand('snlDoc.createMacroKind');
      return;
    }
    if (msg.type === 'refreshKinds') {
      // Cheap targeted refresh (no full pushContext round-trip) so
      // returning focus from the child MacroKind panel picks up new kinds
      // without wiping the user's in-progress form.
      const root = firstWorkspaceFolder();
      const macroKinds = root ? await readMacroKinds(root) : [];
      void this.panel.webview.postMessage({
        type: 'kindsRefresh',
        macroKinds
      });
      return;
    }
    if (msg.type !== 'create' && msg.type !== 'update') {
      return;
    }

    const root = firstWorkspaceFolder();
    if (!root) {
      const text = hostText()('noWorkspace');
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    const macro = msg.macro;
    if (!macro || typeof macro !== 'object') {
      void this.panel.webview.postMessage({
        type: 'invalid',
        reason: hostText()('noPayload')
      });
      return;
    }

    try {
      if (msg.type === 'update' || this.mode === 'edit') {
        // Force the identity — ignore any name in the payload.
        const patched: MacroPackageEntry = { ...macro, name: this.macroName };
        const result = await updateMacro(
          root,
          this.file,
          patched,
          typeof msg.expectedRevision === 'string' ? msg.expectedRevision : undefined
        );
                switch (result.status) {
          case 'updated':
            vscode.window.showInformationMessage(
              hostText()('updated', { name: result.name, file: this.file })
            );
            void this.panel.webview.postMessage({
              type: 'updated',
              name: result.name
            });
            await this.pushContext();
            return;
          case 'notFound': {
            const text = hostText()('notFound', { name: result.id, file: this.file });
            vscode.window.showErrorMessage(text);
            void this.panel.webview.postMessage({
              type: 'notFound',
              name: result.id,
              message: text
            });
            return;
          }
          case 'noSnlDoc': {
            const text = hostText()('initFirst');
            vscode.window.showErrorMessage(text);
            void this.panel.webview.postMessage({
              type: 'noSnlDoc',
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
          case 'error':
            void this.panel.webview.postMessage({
              type: 'error',
              message: result.message
            });
            return;
        }
      }
      // Create path.
      const result = await addMacro(root, this.file, macro);
      switch (result.status) {
        case 'ok':
          vscode.window.showInformationMessage(
            hostText()('created', { name: result.name, file: this.file })
          );
          void this.panel.webview.postMessage({
            type: 'created',
            name: result.name
          });
          // Cat 2026-07-27: flip this panel in place to EDIT mode for the
          // macro we just created — the natural next action is to keep
          // editing the same thing. This also fixes a live bug: the
          // re-pushed context below puts the new name into `existingNames`,
          // and the webview's duplicate check only exempts edit mode, so a
          // create-mode panel would leave Save permanently disabled.
          this.flipToEditMode(result.name);
          // Refresh the editor's existing-names list.
          await this.pushContext();
          return;
        case 'duplicate': {
          const text = hostText()('duplicate', { name: result.name });
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'duplicate',
            name: result.name,
            message: text
          });
          return;
        }
        case 'noFile': {
          const text = hostText()('noFile', { file: this.file });
          vscode.window.showErrorMessage(text);
          void this.panel.webview.postMessage({
            type: 'noFile',
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
        case 'error':
          void this.panel.webview.postMessage({
            type: 'error',
            message: result.message
          });
          return;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(hostText()('editorFailed', { error: text }));
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  /**
   * Turn a CREATE panel into the EDIT panel for `name`, in place.
   *
   * REKEY HAZARD: `instances` is keyed by `${mode}:${file}:${macroName}`.
   * If we mutate `mode`/`macroName` without moving the Map entry, the old
   * `create:<file>:` key leaks forever (dispose() would delete the NEW key
   * only) and `editOrShow()` would miss the live panel and construct a
   * SECOND one. So delete the old key and set the new one atomically here.
   */
  private flipToEditMode(name: string): void {
    if (this.mode !== 'create' || !name) {
      return;
    }
    const oldKey = this.instanceKey;
    this.mode = 'edit';
    this.macroName = name;
    this.prefill = null;
    const newKey = `${this.mode}:${this.file}:${this.macroName}`;
    if (CreateMacroPanel.instances.get(oldKey) === this) {
      CreateMacroPanel.instances.delete(oldKey);
    }
    this.instanceKey = newKey;
    CreateMacroPanel.instances.set(newKey, this);
    this.panel.title = hostText()('editTitle', { name: this.macroName, file: this.file });
  }

  public dispose(): void {
    CreateMacroPanel.instances.delete(this.instanceKey);

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
