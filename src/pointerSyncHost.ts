import * as vscode from 'vscode';
import * as path from 'node:path';
import { firstWorkspaceFolder } from './panelUtil';
import { createHostTranslator, defineHostMessages } from './hostI18n';
import { read_extension_preferences } from './preferences';
import { onPointerEntriesWritten, PointerIndexCoordinator } from './pointerSyncHostState';
import { comparePointerIdentity } from './pointerSync/scope';

export interface PointerCandidate {
  entryId: string;
  title?: string;
  package?: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  priority?: number;
  distance: number;
}
export interface PointerQueryResult { complete: boolean; candidates: PointerCandidate[] }
export interface PointerSummary { files: number; pointers: number; unresolved: number; details: string[] }
/** Small adapter so host routing is tested independently of filesystem mechanics. */
export interface PointerHostDriver<Index> {
  build(root: vscode.Uri, previous?: Index): Promise<Index>;
  publish(root: vscode.Uri, index: Index): Promise<void>;
  query(root: vscode.Uri, index: Index, file: string, line: number, text: string, column?: number): Promise<PointerQueryResult>;
  files(index: Index): string[];
  summary(index: Index): PointerSummary;
}
const MESSAGES = defineHostMessages({
  unsupported: 'Pointer navigation requires a file in the first SNL workspace folder. Other roots/providers are not supported yet.',
  maintenance: 'SNL Pointer maintenance',
  progress: 'Resolving source pointers and rebuilding syncSNL.json…',
  done: 'Pointer index: {pointers} pointers in {files} files; {unresolved} unresolved.',
  details: 'Show details',
  error: 'Pointer index is unavailable; retry Pointer maintenance. {error}',
  savedError: 'The Entry was saved, but its Pointer index could not be updated. Retry Pointer maintenance. {error}',
  noMatch: 'No Entry matches the Pointer ranges in this file.',
  incomplete: 'Some pointers could not be resolved. Results are incomplete; use Pointer maintenance for details.',
}, {
  unsupported: 'Pointer 导航需要第一个 SNL 工作区中的代码文件；暂不支持其他根目录或文件提供者。',
  maintenance: 'SNL Pointer 维护',
  progress: '正在解析源码指针并重建 syncSNL.json…',
  done: 'Pointer 索引：{files} 个文件，{pointers} 条指针，{unresolved} 条未解析。',
  details: '查看详情',
  error: 'Pointer 索引不可用，请重新执行 Pointer 维护。{error}',
  savedError: 'Entry 已保存，但 Pointer 索引更新失败，请重新执行 Pointer 维护。{error}',
  noMatch: '当前文件的 Pointer 匹配范围内未找到条目。',
  incomplete: '部分 Pointer 无法解析，结果不完整；请在 Pointer 维护中查看详情。',
});
const text = () => createHostTranslator(read_extension_preferences().language, MESSAGES);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function installPointerSyncHost<Index>(context: vscode.ExtensionContext, driver: PointerHostDriver<Index>): void {
  let root: vscode.Uri | undefined;
  let state: PointerIndexCoordinator<Index> | undefined;
  let rootResources: vscode.Disposable[] = [];
  let sourceWatchers: vscode.Disposable[] = [];
  let files = new Set<string>();
  let watchSignature = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestId = 0;
  let disposed = false;
  let output: vscode.OutputChannel | undefined;
  let lastError = '';
  // Keep ordering across root lifetimes too (A → B → A); a disposed state's I/O may still finish.
  const publicationTails = new Map<string, Promise<void>>();
  const relative = (uri: vscode.Uri): string | undefined => {
    if (!root || uri.scheme !== 'file') return undefined;
    const rel = path.relative(root.fsPath, uri.fsPath).replace(/\\/g, '/');
    return !rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) ? undefined : rel;
  };
  const report = (error: unknown, saved = false, explicit = false) => {
    if (disposed) return;
    const message = text()(saved ? 'savedError' : 'error', { error: errorText(error) });
    // Deduplicate background refresh failures, never a user-requested retry.
    if (!explicit && message === lastError) return;
    lastError = message;
    void vscode.window.showWarningMessage(message);
  };
  const cancelTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    state?.invalidate(); requestId++;
    cancelTimer();
    timer = setTimeout(() => { timer = undefined; void state?.ensure().catch(error => report(error)); }, 150);
  };
  const bindSources = (index: Index) => {
    const next = driver.files(index);
    files = new Set(next);
    const directories = [...new Set(next.map(file => path.posix.dirname(file)))].sort();
    const signature = JSON.stringify(directories);
    if (signature === watchSignature || !root) return;
    sourceWatchers.forEach(d => d.dispose()); sourceWatchers = []; watchSignature = signature;
    // One shallow watcher per referenced directory, not per Entry or whole repository.
    for (const directory of directories) {
      const base = directory === '.' ? root : vscode.Uri.joinPath(root, directory);
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, '*'));
      const changed = (uri: vscode.Uri) => { const file = relative(uri); if (file && files.has(file)) schedule(); };
      watcher.onDidCreate(changed, undefined, sourceWatchers);
      watcher.onDidChange(changed, undefined, sourceWatchers);
      watcher.onDidDelete(changed, undefined, sourceWatchers);
      sourceWatchers.push(watcher);
    }
  };
  const bindRoot = () => {
    const next = firstWorkspaceFolder();
    if (root?.toString() === next?.toString()) return;
    state?.dispose(); cancelTimer(); requestId++;
    rootResources.forEach(d => d.dispose()); sourceWatchers.forEach(d => d.dispose());
    rootResources = []; sourceWatchers = []; files = new Set(); watchSignature = '';
    root = next?.scheme === 'file' ? next : undefined; state = undefined;
    if (!root) return;
    const capturedRoot = root;
    state = new PointerIndexCoordinator({
      build: previous => driver.build(capturedRoot, previous),
      publish: async index => {
        const key = capturedRoot.toString();
        const previous = publicationTails.get(key) ?? Promise.resolve();
        const publication = previous.catch(() => undefined).then(async () => {
          if (state !== capturedState || disposed) throw new Error('Pointer publication superseded');
          await driver.publish(capturedRoot, index);
        });
        publicationTails.set(key, publication);
        try { await publication; }
        finally { if (publicationTails.get(key) === publication) publicationTails.delete(key); }
        if (state !== capturedState || disposed) return;
        bindSources(index); lastError = '';
      },
    });
    const capturedState = state;
    rootResources.push(onPointerEntriesWritten(root.toString(), async () => {
      capturedState.invalidate(); requestId++; cancelTimer();
      await capturedState.ensure();
    }, error => { if (state === capturedState) report(error, true); }));
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '.SNL_Doc/**'));
    const changed = (uri: vscode.Uri) => {
      const rel = relative(uri);
      if (rel && /^\.SNL_Doc\/(config\.json|entries\.json|entries\/[^/]+\.json|packages\/[^/]+\.json)$/.test(rel)) schedule();
    };
    watcher.onDidCreate(changed, undefined, rootResources);
    watcher.onDidChange(changed, undefined, rootResources);
    watcher.onDidDelete(changed, undefined, rootResources);
    rootResources.push(watcher);
    // Activation after init/command is allowed without .SNL_Doc; don't create it here.
    void vscode.workspace.fs.stat(vscode.Uri.joinPath(root, '.SNL_Doc/config.json')).then(
      () => { if (state === capturedState && !disposed) void capturedState.ensure().catch(error => { if (state === capturedState) report(error); }); },
      () => undefined,
    );
  };
  bindRoot();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(bindRoot));
  context.subscriptions.push(vscode.window.onDidChangeWindowState(event => { if (event.focused) schedule(); }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
    const file = relative(document.uri); if (file && files.has(file)) schedule();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('snlDoc.maintainPointers', async () => {
    bindRoot();
    if (!root || !state) { void vscode.window.showWarningMessage(text()('unsupported')); return; }
    const target = state;
    requestId++; target.invalidate(); cancelTimer();
    try {
      const index = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: text()('maintenance') }, async progress => {
        progress.report({ message: text()('progress') });
        return target.ensure();
      });
      if (disposed || target !== state) return;
      const summary = driver.summary(index);
      output ??= vscode.window.createOutputChannel(text()('maintenance'));
      output.clear(); output.appendLine(text()('done', summary));
      summary.details.forEach(line => output!.appendLine(line));
      const action = await vscode.window.showInformationMessage(text()('done', summary), text()('details'));
      if (action === text()('details')) output.show(true);
      return { files: summary.files, pointers: summary.pointers, unresolved: summary.unresolved };
    } catch (error) { if (target === state) report(error, false, true); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('snlDoc.revealNearestEntry', async () => {
    bindRoot();
    const editor = vscode.window.activeTextEditor;
    const file = editor && relative(editor.document.uri);
    if (!editor || !file || !root || !state) { void vscode.window.showWarningMessage(text()('unsupported')); return; }
    const owner = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (owner && owner.uri.toString() !== root.toString()) { void vscode.window.showWarningMessage(text()('unsupported')); return; }
    const document = editor.document;
    const version = document.version;
    const position = editor.selection.active;
    const thisRequest = ++requestId;
    const current = () => !disposed && thisRequest === requestId && !document.isClosed && document.version === version &&
      vscode.window.activeTextEditor === editor && editor.selection.active.isEqual(position);
    try {
      const targetRoot = root;
      const index = await state.ensure();
      if (!current()) return;
      const result = await driver.query(targetRoot, index, file, position.line + 1, document.getText(), position.character + 1);
      if (!current()) return;
      if (!result.candidates.length) {
        void vscode.window.showInformationMessage(text()(result.complete ? 'noMatch' : 'incomplete'));
        return;
      }
      // Query already selected the best priority/span. Break known ties only;
      // opening an incomplete result does not assert that it is unique or complete.
      const candidate = [...result.candidates].sort(comparePointerIdentity)[0];
      if (!current()) return;
      await vscode.commands.executeCommand('snlDoc.openEntryInfoview', candidate.entryId, undefined, candidate.package);
      return candidate.entryId;
    } catch (error) { if (current()) report(error, false, true); }
  }));
  context.subscriptions.push({ dispose() {
    disposed = true; requestId++; state?.dispose(); cancelTimer();
    rootResources.forEach(d => d.dispose()); sourceWatchers.forEach(d => d.dispose()); output?.dispose();
  } });
}
