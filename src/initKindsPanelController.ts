import * as vscode from 'vscode';
import { bind_preferences_panel_title } from './preferencesHost';
import { createHostTranslator, defineHostMessages } from './hostI18n';
import { read_extension_preferences } from './preferences';

const MESSAGES = defineHostMessages(
  {
    entryTitle: 'SNL Initialize Entry Kinds', macroTitle: 'SNL Initialize Macro Kinds', noWorkspace: '{title} requires an open folder / workspace.', noPreset: 'No preset selected.', applied: { arg: 'count', one: 'Applied preset “{presetId}” — {count} {kind} added.', other: 'Applied preset “{presetId}” — {count} {kind}s added.' }, nonEmpty: '{configKey} already has {count} entries. Presets can only initialize an empty catalog.', initFirst: '.SNL_Doc does not exist yet. Run “SNL: Init” first.', unknownPreset: 'Unknown preset id: {presetId}', emptyPreset: 'Preset “{presetId}” has no kinds and cannot be applied.', failed: '{title} failed: {error}', entryKind: 'entry kind', macroKind: 'macro kind', fulcrumLabel: "Fulcrum's Math Notes", fulcrumDescription: 'Chapter/Section/Subsection scaffolding + 12 Fulcrum-Notes-Typst content kinds (Definition/Axiom/Lemma/Theorem/Corollary/Property/Remark/Example/Counterexample/Construction/Proof/Problem). Each kind seeds a defaultCounterName (slug of its English name).', leanLabel: 'Lean 4 Document', leanDescription: 'Lean source structure covering modules, namespaces, sections, declarations, theorem forms, data/type-class forms, syntax, commands, examples, and documentation.', tsLabel: 'TypeScript Document', tsDescription: 'TypeScript source structure covering modules, namespaces, declarations, callable/member forms, imports, and exports.', pythonLabel: 'Python Document', pythonDescription: 'Python source structure covering packages, modules, classes, callable forms, decorators, typing forms, variables, exceptions, and imports.', basicsLabel: 'SNL-Basics defaults', basicsDescription: "The 5 default macro kinds from SNL-Basics's DEFAULT_KIND_PALETTE (rule / const / bvar / binder / fvar), plus a 'partial' kind for helper subtrees that shouldn't fire hover feedback (e.g. matrix rows).", mathematicsLabel: 'Mathematics', mathematicsDescription: 'A broad mathematical writing set.'
  },
  {
    entryTitle: 'SNL 初始化条目类型', macroTitle: 'SNL 初始化宏类型', noWorkspace: '{title}需要打开文件夹或工作区。', noPreset: '未选择预设。', applied: '已应用预设“{presetId}”——添加了 {count} 个{kind}。', nonEmpty: '{configKey} 已有 {count} 个条目。预设只能初始化空目录。', initFirst: '.SNL_Doc 尚不存在。请先运行“SNL：初始化”。', unknownPreset: '未知预设 ID：{presetId}', emptyPreset: '预设“{presetId}”不含任何类型，无法应用。', failed: '{title}失败：{error}', entryKind: '条目类型', macroKind: '宏类型', fulcrumLabel: 'Fulcrum 数学笔记', fulcrumDescription: '提供章/节/小节层级结构，以及 12 种 Fulcrum-Notes-Typst 内容类型（定义/公理/引理/定理/推论/性质/备注/例子/反例/构造/证明/问题）。每种类型都会设置 defaultCounterName（其英文名称的 slug）。', leanLabel: 'Lean 4 文档', leanDescription: '覆盖模块、命名空间、节、声明、定理形式、数据与类型类形式、语法、命令、示例和文档的 Lean 源码结构。', tsLabel: 'TypeScript 文档', tsDescription: '覆盖模块、命名空间、声明、可调用项与成员、导入和导出的 TypeScript 源码结构。', pythonLabel: 'Python 文档', pythonDescription: '覆盖包、模块、类、可调用形式、装饰器、类型形式、变量、异常和导入的 Python 源码结构。', basicsLabel: 'SNL-Basics 默认类型', basicsDescription: '包含 SNL-Basics DEFAULT_KIND_PALETTE 的 5 种默认宏类型（rule / const / bvar / binder / fvar），以及用于不应触发悬停反馈的辅助子树（例如矩阵行）的 partial 类型。', mathematicsLabel: '数学写作', mathematicsDescription: '适用于广泛数学写作的条目类型集合。'
  }
);
const hostText = () => createHostTranslator(read_extension_preferences().language, MESSAGES);
import {
  applyEntryKindsPreset,
  applyMacroKindsPreset,
  ENTRY_KIND_PRESETS,
  MACRO_KIND_PRESETS,
  readEntryKinds,
  readMacroKinds
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage } from './panelUtil';
import { initKindsPanelDescriptor, type KindsDomain } from './initKindsPanelDescriptor';

const panels = new Map<KindsDomain, InitKindsPanelController>();

type PresetProjectionSource = ReadonlyArray<{
  id: string;
  copyKeys: { label: string; description: string };
  kinds: ReadonlyArray<unknown>;
}>;

type PresetCopyKey = 'fulcrumLabel' | 'fulcrumDescription' | 'leanLabel' | 'leanDescription' |
  'tsLabel' | 'tsDescription' | 'pythonLabel' | 'pythonDescription' | 'basicsLabel' | 'basicsDescription';

export function projectKindPresets(
  domain: KindsDomain,
  language: string,
  source: PresetProjectionSource
): Array<{ id: string; label: string; description: string; count: number }> {
  if (domain !== 'entry' && domain !== 'macro') throw new Error(`Unknown Kind preset domain: ${String(domain)}`);
  const t = createHostTranslator(language, MESSAGES);
  return source.map((preset) => {
    const labelKey = preset.copyKeys.label as PresetCopyKey;
    const descriptionKey = preset.copyKeys.description as PresetCopyKey;
    return {
      id: preset.id,
      label: t(labelKey),
      description: t(descriptionKey),
      count: preset.kinds.length
    };
  });
}

export class InitKindsPanelController {
  static createOrShow(domain: KindsDomain, extensionUri: vscode.Uri): void {
    const current = panels.get(domain);
    if (current) {
      current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const descriptor = initKindsPanelDescriptor(domain);
    const panel = vscode.window.createWebviewPanel(
      descriptor.viewType,
      hostText()(domain === 'entry' ? 'entryTitle' : 'macroTitle'),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );
    bind_preferences_panel_title(panel, () =>
      hostText()(domain === 'entry' ? 'entryTitle' : 'macroTitle'));
    panels.set(domain, new InitKindsPanelController(domain, panel, extensionUri));
  }

  private readonly disposables: vscode.Disposable[] = [];
  private initGeneration = 0;
  private constructor(
    private readonly domain: KindsDomain,
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri
  ) {
    const descriptor = initKindsPanelDescriptor(domain);
    panel.webview.html = buildPanelHtml(extensionUri, panel.webview, descriptor.entry, hostText()(domain === 'entry' ? 'entryTitle' : 'macroTitle'), this.disposables);
    panel.webview.onDidReceiveMessage((message) => this.handleMessage(message), null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushInit(): Promise<void> {
    const generation = ++this.initGeneration;
    try {
      const root = firstWorkspaceFolder();
      const existing = root
        ? this.domain === 'entry'
          ? (await readEntryKinds(root)).length
          : (await readMacroKinds(root)).length
        : 0;
      if (generation !== this.initGeneration) return;
      const source = this.domain === 'entry' ? ENTRY_KIND_PRESETS : MACRO_KIND_PRESETS;
      const presets = projectKindPresets(
        this.domain,
        read_extension_preferences().language,
        source.filter((preset) => preset.kinds.length > 0)
      );
      void this.panel.webview.postMessage({ type: 'init', presets, existing });
    } catch (error) {
      if (generation !== this.initGeneration) return;
      const text = error instanceof Error ? error.message : String(error);
      void this.panel.webview.postMessage({
        type: 'error',
        message: hostText()('failed', {
          title: hostText()(this.domain === 'entry' ? 'entryTitle' : 'macroTitle'),
          error: text
        })
      });
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (await handlePanelNavMessage(message, () => this.pushInit())) return;
    const msg = message as { type?: string; presetId?: unknown } | undefined;
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ready') {
      await this.pushInit();
      return;
    }
    if (msg.type !== 'apply') return;
    const root = firstWorkspaceFolder();
    const descriptor = initKindsPanelDescriptor(this.domain);
    if (!root) {
      const text = hostText()('noWorkspace', { title: hostText()(this.domain === 'entry' ? 'entryTitle' : 'macroTitle') });
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({ type: 'noWorkspace', message: text });
      return;
    }
    const presetId = typeof msg.presetId === 'string' ? msg.presetId : '';
    if (!presetId) {
      void this.panel.webview.postMessage({ type: 'error', message: hostText()('noPreset') });
      return;
    }
    const source = this.domain === 'entry' ? ENTRY_KIND_PRESETS : MACRO_KIND_PRESETS;
    const selectedPreset = source.find((preset) => preset.id === presetId);
    if (!selectedPreset || selectedPreset.kinds.length === 0) {
      void this.panel.webview.postMessage({
        type: 'error',
        message: hostText()(selectedPreset ? 'emptyPreset' : 'unknownPreset', { presetId })
      });
      return;
    }
    try {
      const result = this.domain === 'entry'
        ? await applyEntryKindsPreset(root, presetId)
        : await applyMacroKindsPreset(root, presetId);
      if (result.status === 'applied') {
        const text = hostText()('applied', { presetId, count: result.count, kind: hostText()(this.domain === 'entry' ? 'entryKind' : 'macroKind') });
        vscode.window.showInformationMessage(text);
        void this.panel.webview.postMessage({ type: 'applied', presetId, count: result.count });
      } else if (result.status === 'nonEmpty') {
        const text = hostText()('nonEmpty', { configKey: descriptor.configKey, count: result.existing });
        vscode.window.showWarningMessage(text);
        void this.panel.webview.postMessage({ type: 'nonEmpty', existing: result.existing, message: text });
      } else if (result.status === 'noSnlDoc') {
        const text = hostText()('initFirst');
        vscode.window.showErrorMessage(text);
        void this.panel.webview.postMessage({ type: 'noSnlDoc', message: text });
      } else {
        const text = hostText()('unknownPreset', { presetId: result.presetId });
        vscode.window.showErrorMessage(text);
        void this.panel.webview.postMessage({ type: 'unknownPreset', message: text });
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(hostText()('failed', { title: hostText()(this.domain === 'entry' ? 'entryTitle' : 'macroTitle'), error: text }));
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  private dispose(): void {
    panels.delete(this.domain);
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
