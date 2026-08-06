# SNL-Doc-Extension 工作计划

> 本文档整理 SNL 文档系统的设计动机与实施计划。SNL = **Structural Natural Language（结构化自然语言）**。

---

## 不严谨的术语体系

> 自然语言（Natural Language, NL）
> ------
> 【自然语言】泛指任何非形式的语言。

> 专业领域自然语言（Domain NL）/ 概念（Concept）
> ------
> 【专业领域自然语言】是用于记录业领域知识的语言。专业领域自然语言指涉者是【概念】。

> 术语（Term）/ 术语体系（Terminology）
> ------
> 【术语】是在专业领域自然语言中，用于指涉专业领域概念的语言成分。
> 
> 【术语体系】指专业领域中术语的全体，连同全体术语与专业领域概念的指涉关系。

> 冗余（Redundancy）/ 别名（Alias）/ 歧义（Ambiguity）
> ------
> 【冗余】是指在术语体系中，同一个概念被多个术语指涉的现象。
> 
> 对于一个概念，冗余现象出现时，一个概念的一个术语又称为一个【别名】。
> 
> 【歧义】是指在术语体系中，形式上无法（或难以）区分的同一术语指涉多个概念的现象。

> 术语宏（Term Macro）
> ------
> 一个术语的【术语宏】可与有限个结构化自然语言片段组合，给出一个结构化自然语言片段。

> 术语化（Terminologization）
> ------
> 【术语化】是从专业领域自然语言中确立术语并建立术语宏的过程。

> 结构化自然语言（Structured Natural Language, SNL）
> ------
> 一个【结构化自然语言】片段是下列二者之一：
> * 一个自然语言片段；
> * 一个术语宏与有限个结构化自然语言片段的组合。
>
> 不涉及术语宏的结构化自然语言片段视为自然语言片段。
> 不涉及纯自然语言的结构化自然语言片段称为【纯 SNL】，理论上形式语言总是能通过对 AST 节点赋予术语宏来直接生成纯 SNL 文档。
>
> 结构化自然语言（SNL）≠ 受控自然语言（CNL）。后者通常具备可编译性，可直接视为形式语言，本质上是看起来像自然语言的计算机语言；前者本质上是容易被计算机管理的自然语言。
> 纯 SNL ≈ CNL。

> 条目（Entry）
> ------
> 一个【条目】包含以下信息：
> * `UUID`：全局唯一标识符
> * 标题：一个字符串
> * 内容：一个结构化自然语言片段
> * 贡献信息

> 库（Library）
> ------
> 一个【库】包含以下信息：
> 术语宏集
> 关系集，且其中包含至少一个 Hamilton 路径。
> 
> 一个【库】所引用的条目子集 = 关系集中出现的全部条目 UUID。条目本体存放在全局共享的条目池（`entries.json`，位于 `.SNL_Doc/` 顶层），多个库可重复引用同一份条目；库不直接拥有条目，只通过关系集隐式选定子图。

---

## 1. 动机

### 1.1 形式化的真正瓶颈在"规模"，不在"单条"

借助 Agent 书写单条 Lean 代码已是成熟能力，强行抠小规模形式化几乎没有边际价值。真正困难且有价值的是**大规模形式化**：

- 形式化**过程中**：如何对工作进行规划、整理、追踪依赖。
- 形式化**完成后**：如何让他人上手一个"巨大无比、深不可测"的形式化库。

这两件事都指向同一组缺失的基础设施：**良好的 Blueprint 工具 + 良好的文档管理工具**。

### 1.2 需求可泛化到一切专业语言材料

同样的需求适用于：任意代码库、以及非代码的纯专业文档（书籍、论文、规范）。

**代码文档的特殊性**在于：可借助 VS Code 的 LSP 及配套基础设施，通过 Extension 把**文档段落与代码段落双向绑定**。这是本项目的**核心功能之一**。

### 1.3 专业文档的语言特征：术语

专业文档最显著的特征是**大量使用语义狭窄（不可随意解读）的术语**，且术语之间存在**严格的层次依赖与复杂关系**。这正是非专业人士学习、记忆的主要障碍。

### 1.4 SNL 针对术语特征而设计

在**完全兼容旧式自然语言**（文字字符串 + 公式 + 代码块）的前提下，SNL 鼓励对专业语言进行**术语化**（定义见 §0.C）：识别出概念、赋予无歧义的术语、以术语宏反复调用、每个宏绑定一个条目。

**带来的优势：**

1. **思维规训** —— 强制书写者以语义明确的方式记录专业知识，杜绝似是而非的"思维幻觉"残留在文档中。在数学形式化与需求代码化中尤其有效。
   *（元能力备注：这一思想本身也应用于规训本项目的实现过程。）*
2. **去黑箱化管理** —— 让自然语言记录的知识可被计算机管理，支持动态查询与渲染，显著提高读者学习效率。
3. **更好的 UI / MCP** —— 语言数字化后，可开发优于纯文本编辑的人机界面与 MCP（面向 Agent 的接口），反哺人类与 Agent 编写 SNL 的效率。

### 1.5 时机：Agent 让生成成本可承受

过去生成这类高度结构化文档代价过高。现在可借助 Agent 生成，**很可能只需炼一批好的 SKILL.md + 轻量级工作流**即可落地。这是项目得以成立的关键前提。

---

## 2. 三个参考工作（既有资产）

| 仓库 | 定位 | 本次角色 |
|---|---|---|
| **Fulcrum-Notes-Typst** | 猫猫的 SNL 数学笔记（基于 submodule `Fulcrum-Template-Typst`） | 自然数学语言结构化的**蓝本**，非最终形式。提供"分级书写规范"经验（L0 未分块自然语言 → L4 Lean 伪代码）与 `#optionLink` 术语索引、`export.typ` 解循环导入等实践 |
| **Fulcrum-Smarterm** | SNL 经 KaTeX 在 Web 前端渲染数学公式（`OperatorTree` + 模板库 + 占位符替换） | **主要参考**，更成熟、更接近最终形态。前端渲染/交互尽量独立封装于此库；本次**不在此库内处理** SNL 具体前端 |
| **andrea-novel-helper** | VS Code 小说写作扩展：词库/角色库、引用追踪与热力图、关系图谱、内置 MCP HTTP 服务、Copilot Agent Skills | 机制参考。**警告：功能臃肿、直接改大概率是屎山**，只取核心机制不取实现 |

**从 Novel Helper 值得借鉴的核心机制**（与本项目需求对应）：
- 设定集/词库的"包(Package)"组织 + 可视化包管理器 → 对应 SNL 术语库的本地文档化管理
- 引用追踪、角色引用热力图 → 对应术语调用追踪
- 角色关系图谱（力导向/环形/层级布局、悬停高亮邻居、一跳聚焦）→ 对应**术语知识图谱**
- 内置 MCP HTTP server（`127.0.0.1:13306/mcp`，喂 Copilot Agent / Cursor 项目上下文）+ 自动写 `.vscode/mcp.json` → 对应本项目的 MCP 接口
- 异步高亮匹配、文件追踪防抖、路径索引修复 → 大型项目性能/稳定性工程经验

---

## SNL Script 部分工程计划

### 项目结构

```
SNL_Script/
├── demo.tsx
├── data.tsx
├── basics.tsx
└── actions.tsx
```

注：这不是完整项目，这只是最小可运行系统的结构。

### 基础数据接口

* `SNL_Term : Type`，包括术语 UUID 与宏函数。
  
  `SNL_Term_DB : Type`，DB 版本。

* `SNL_SyntaxTree : Type`，包括 SNL 完整语法树结构，其中宏信息完整。

  `SNL_SyntaxTree_Partial : Type`，包括 SNL 完整语法树结构，其中宏信息只包含 UUID。

  `SNL_SyntaxTree_DB : Type`，`Partial` 的 DB 版本。

  注：这里分三档是为了避免 parser 必须完成宏查询才能构建语法树，导致函数必须写成异步。

* `SNL_Entry : Type`

  `SNL_Entry_DB : Type`

* `SNL_Library : Type`

  `SNL_Library_DB : Type`

注：带 `DB` 的是数据库接口，要求：
1. 必须是平坦的，即不能有超过一层的嵌套 Json。
2. 所有数据类型必须是基础类型 (`String`, `Int`, `Float`, `Bool`) 。
3. 每个类型有一个通过相应的 `DB` 类型直接初始化的构造函数。

### 基础函数

* `SNL_term_search : String -> promise<SNL_Term?>`
* 
  根据术语 UUID 在数据库中查找术语宏信息。

* `SNL_parse : String -> SNL_SyntaxTree_Partial?`

  解析 SNL DSL 字符串，返回 SNL 语法树。

* `SNL_STdepartial : SNL_SyntaxTree_Partial -> promise<SNL_SyntaxTree>`

* `SNL_render : SNL_SyntaxTree -> ReactElement`

  将完整的 SNL 语法树渲染为 React 组件。

### 交互系统
  
* 为携带 `\htmlData` 元信息的 $\KaTeX$ 块赋予功能。

  这其中，对于所有交互事件，我们应当提供一个默认函数。同时，这个函数应当被参数化，允许根据使用场景自定义。

  *一个比喻：就像“群结构”将一个具体类型上的二元运算结构中的运算函数“抽象”为了一个待填入的参数，我们应该最终给出抽象结构上的方法，而不依赖具体函数的实现。*
  
  *当然，直接进行抽象的实现可能较为困难，所以也许我们会先实现一版具体路线，然后在把相应的事件函数抽象化为接口。不过 React 中很多事件处理本来就是通过事件函数 + 钩子实现的，所以这一操作可能是自然的。*
  

### Demo

沿用 Fulcrum-Smarterm 的操作方式即可。

## Extension 部分工程计划

### 已实现功能

* 命令 `snlDoc.openInfoview`（标题 `SNL: Open Infoview`）：打开 Infoview webview 占位页（单例 Panel，Beside 列，CSP + nonce 加固，加载 Vite 构建的 `main.js`）。**Infoview = 阅读 SNL 文档的面**。
* 命令 `snlDoc.openDashboard`（标题 `SNL: Open Dashboard`）：打开 Dashboard webview（单例 Panel，Active 列，CSP + nonce 加固，加载 `dashboard.js`）。**Dashboard = 管理 SNL Doc 的面**（与 Infoview 的"读"职能正交）。初始页：若 `.SNL_Doc/` 不存在，渲染"未初始化"提示 + `Run SNL: Init` 按钮；存在时按以下**顺序**显示四块（自上而下：先元数据 → 后内容）：
  * **Entry Kinds**（第 1 块）：表格列出 `config.json#entry_kinds` 的每一项（Preview 色块显示 stroke+background 的完整 frame 预览 / Name / ID / Numbering DSL / Style）。
    * **空**时：section header 右侧按钮变为 `Initialize Entry Kinds`，点击 dispatch `snlDoc.initEntryKinds`（弹 Panel 选 Preset）。
    * **非空**时：section header 右侧按钮变为 `Create Entry Kind`，点击 dispatch `snlDoc.createEntryKind`（弹 Panel 填单条）。
  * **SNL Macros**（第 2 块）：表格列出 `.SNL_Doc/term_macros/*.json` 的每个 package（文件名 + 内含 macro 数）。macro 数走 best-effort 推断（裸 array / `{macros:[…]}` / 顶层 keyed object 去掉 `version|name|description`），schema 未识别时显示 "—"。
  * **Entries**（第 3 块）：section header 左侧为可折叠标题（chevron + 全局共享条目池 `entries.json` 总条目数），右侧恒显示 `Create Entry` 按钮（dispatch `snlDoc.createEntry`，弹 Entry 编辑器 Panel）。默认折叠；展开后预留条目表位置（等 Entry 表视图定稿）。
  * **Libraries**（第 4 块）：表格（Title / Slug / Entries / Relationships）+ `Create Library` 按钮（dispatch `snlDoc.createLibrary`）。Entries 列 = 该库 `relationships.json` 中出现的 distinct 节点 UUID 数；Relationships = 边数。
  Dashboard 注册 `FileSystemWatcher`，监听 `.SNL_Doc/(config|entries).json`、`.SNL_Doc/libraries/*/relationships.json`、`.SNL_Doc/term_macros/*.json` 与 `.SNL_Doc` 目录本身的 create/change/delete，事件触发自动重读 `readOverview` 并 push 给 webview。
* 命令 `snlDoc.init`（标题 `SNL: Init`）：**无 panel**，直接调用 `initSnlDoc` 在当前工作区创建 `.SNL_Doc/` 空骨架（`config.json` 含 `version:'0.0.3'` + `libraries:[]` + `entry_kinds:[]`、顶层共享条目池 `entries.json` 空 array、`term_macros/`、空 `libraries/`），用 toast 反馈结果。`.SNL_Doc/` 已存在则警告并指向 `SNL: Create Library`；未打开工作区则报错。Dashboard 的 `Run SNL: Init` 按钮通过 `vscode.commands.executeCommand('snlDoc.init')` 触发。
* 命令 `snlDoc.createLibrary`（标题 `SNL: Create Library`）：向**已存在**的 `.SNL_Doc/` 添加一个 library，创建 `libraries/<slug>/{relationships.json, documents/{Typst,LaTeX,Markdown}}` 并把 `{slug,title}` append 到 `config.json#libraries`（`entry_kinds` / 其他字段经 `normalizeConfig` 保留 round-trip）。`.SNL_Doc/` 不存在则报错（与 Init 互斥，只在已初始化后工作）；slug 冲突则报错（slug 由 `src/slug.ts` 纯函数从标题派生：中文保留、空白转 `_`、非法字符删除、空串回退 `library_1`）；config.json 损坏会 throw 错误。webview = 标题输入表单（`createLibrary.js`），Enter 触发提交。Dashboard 的 `Create Library` 按钮通过 `vscode.commands.executeCommand('snlDoc.createLibrary')` 触发此命令，复用同一面板。
* 命令 `snlDoc.initEntryKinds`（标题 `SNL: Initialize Entry Kinds`）：向**已存在且 `entry_kinds` 为空**的 `.SNL_Doc/` 从 Preset 一次性写入一组 entry kind。webview = Preset 下拉选择（`initEntryKinds.js`），当前支持 4 个：
  * `Fulcrum's Math Notes`：12 项，从 `Fulcrum-Notes-Typst/.../FulcrumCN.typ` 的 `#let *条目 = entry(...)` 定义提炼（定义/公理/引理/定理/推论/性质/注/例/反例/构造/证明/题目，颜色/编号/style 全套）。
  * `Lean 4 Document` / `TypeScript Document` / `Python Document`：占位（`kinds: []`），后续填充。
  Presets 存于 `src/snlDoc.ts` 的 `ENTRY_KIND_PRESETS`；`applyEntryKindsPreset` 拒绝在 `entry_kinds` 非空时执行（避免误覆盖），拒绝时 webview 给出 warning 提示。
* 命令 `snlDoc.createEntryKind`（标题 `SNL: Create Entry Kind`）：向**已存在**的 `.SNL_Doc/` 追加单条 entry kind。webview = 表单（`createEntryKind.js`）：id（唯一必填）/ name（必填）/ stroke color / background color（两个 color picker + 文本框互通）/ 实时 Preview 框 / numbering DSL 输入 / style tag。`createEntryKind` 拒绝空 id/name 与重复 id，成功后 toast + webview 状态更新。
* 命令 `snlDoc.createEntry`（标题 `SNL: Create Entry`）：向**已存在**的 `.SNL_Doc/` 追加单条 Entry 到全局共享池 `entries.json`。webview = Entry 编辑器 MVP（`createEntry.js`，见下文 **Entry Editor panel plan**）。`addEntry` 校验 id 非空+唯一、`kind` 必须命中现存 `entry_kinds[].id`、title 非空、content 为 object；成功后 toast + webview 状态更新。Dashboard 的 `Create Entry` 按钮通过 `vscode.commands.executeCommand('snlDoc.createEntry')` 触发。
* 文件系统操作集中在 `src/snlDoc.ts`（`initSnlDoc` / `createLibrary` / `readOverview` / `readMacroPackages` / `normalizeConfig` / `normalizeEntryKind` / `readEntryKinds` / `applyEntryKindsPreset` / `createEntryKind` / `listEntryKinds` / `addEntry`，加 `ENTRY_KIND_PRESETS` 常量与 `EntryData` 接口），全部走 `vscode.workspace.fs`，远程/虚拟 FS 兼容；panel 复用 `src/panelUtil.ts`（`buildPanelHtml` 共享 CSP + nonce + 可选 `<entry>.css` link）。webview 多 entry 构建：`main` / `createLibrary` / `dashboard` / `initEntryKinds` / `createEntryKind` / `createEntry` 各自独立自包含 bundle（无 shared/vendor chunk），供经典 `<script>` 加载；只有 `main` pass 清空 outDir，后续 append。**所有 UI 字串使用英文**（本土化留待后续）。

### config.json schema (v0.0.3)

```jsonc
{
  "version": "0.0.3",
  "libraries": [
    { "slug": "<slug>", "title": "<original title>" }
  ],
  "entry_kinds": [
    {
      "id": "<stable id, e.g. 'definition'>",
      "name": "<display name, e.g. '定义' / 'Definition'>",
      "coloring": {
        "stroke": "<any CSS color, e.g. '#009C27'>",
        "background": "<any CSS color, e.g. '#D6FEE0'>"
      },
      "numbering": "<Typst-like DSL, e.g. '1.1.1' | '1' | ''>",
      "style": "<free-form tag, e.g. 'remark' | 'proof' | 'problem' | ''>"
      // additional fields tolerated and preserved across round-trips
    }
  ]
}
```

- `version`: 写入版本号；`readOverview` / `createLibrary` 走 `normalizeConfig` 容忍缺字段（兼容 0.0.1 / 0.0.2 旧 config）。
- `entry_kinds`: Entry 类别目录，单元素描述一种 Entry。Schema 故意宽松，未来添字段（icon / prefix / parent kind / scope）无需 break 旧文件。Dashboard 渲染 Entry Kinds 表 + Initialize/Create 按钮，专业编辑器后续做。
- **v0.0.2 → v0.0.3 迁移**（在 `normalizeEntryKind` 中就地完成，不改写磁盘）：
  * `color: string` → `coloring: { stroke: color, background: color }`（旧单色被同时填给 stroke/background，用户后续可分开）；
  * `numbering: { pattern, start? }` → `numbering: pattern`（`start` 丢弃，改由 DSL 本身承载初值）；
  * 缺 `style` → `style: ""`（默认无 style 变体）。
  磁盘层保持不动，读时统一 shape；用户下次通过任何 write op 时才被落盘转换。

> **Migration notes (v0.0.2 → v0.0.3, BREAKING).** 没有编写任何磁盘迁移脚本——目前没有任何 library 在野外存在。`normalizeEntryKind` 只在读时就地把旧 `color` / `numbering:{pattern,start}` 形状转成新 shape；如果你手上有 v0.0.2 config，最干净的做法是删掉 `entry_kinds` 后用 `SNL: Initialize Entry Kinds` 重新初始化。旧 v0.0.2 形状（`color: string` + `numbering: { pattern, start }`、无 `coloring` / `style`）仅作历史记录保留于此。

#### Numbering DSL（Typst-like）

点号分隔的层级计数器：

- `"1"`       → 单层平坦计数（首值 1）
- `"1.1"`     → 二级 parent.local
- `"1.1.1"`   → 三级 章.节.K
- `"1.1.1.1"` → 四级 章.节.K.j（sub 层级）
- `""`（空） → 不编号

目前 Dashboard 只做展示，实际 counter 引擎会随 Entry 编辑器落地。

### 实装项目时的文件结构

```
.SNL_Doc/
├── config.json
├── entries.json            # 全局共享条目池（所有 library 共用）
├── term_macros/
|   ├── mathlib_basic.json
|   └── custom1.json
└── libraries/
    ├── library_1/
    |   ├── relationships.json   # 隐式选出该库引用的 entries 子集（节点 UUID 即引用）
    |   └── documents/
    |       ├── Typst/
    |       |   ├── Fulcrum-Template-Typst/
    |       |   |   ...
    |       |   └── library_1.typ
    |       ├── LaTeX/
    |       |   ├── Fulcrum-Template-LaTeX/
    |       |   |   ...
    |       |   └── library_1.tex
    |       └── Markdown/
    |           └── library_1.md
    └── library_2/
        ...
```

注：`SNL: Init` 只创建到 `entries.json` + `term_macros/` + 空 `libraries/` 这一层骨架，不创建任何 `library_*`；具体 library 由 `SNL: Create Library` 命令逐个追加。

### Entry schema

全局共享条目池 `.SNL_Doc/entries.json` 是一个 `EntryData[]` 数组。单条 Entry：

```ts
interface EntryData {
  id: string             // UUID v4, unique across entries.json
  kind: string           // MUST match an existing entry_kinds[].id
  title: string          // English only for now; i18n later
  content: {             // At most ONE non-empty in practice, but all optional
    snl?: string         // DSL compilable by SNL_Basics parser
    typst?: string
    latex?: string
    markdown?: string
    text?: string
  }
  contribution_info?: string | null // TEMPORARY: exactly one Contributor string; shape may change
  pointer: unknown            // TODO: schema deferred (binding to code)
}
```

- `addEntry(workspaceRoot, entry)` 追加单条、按 id 去重，校验：id 非空+唯一、`kind` 命中现存 `entry_kinds[].id`、title 非空、`content` 为 object（各格式字段皆可选）。返回 `{status:'ok',id} | {status:'duplicate',id} | {status:'unknownKind',kind} | {status:'invalid',reason} | {status:'noSnlDoc'} | {status:'error',message}`。
- `content` 中的空字符串字段落盘时会被剔除，保持 `entries.json` 精简。
- `contribution_info` 暂时只接受一个 Contributor 字符串（或缺失/`null`，以兼容旧 Entry）；此结构不是稳定 schema，后续可能更改，当前不支持对象或数组。`pointer` 的 schema 尚未定稿。

### Entry Editor panel plan

`snlDoc.createEntry` 弹出的 Entry 编辑器（`createEntry.js` / `CreateEntryApp.tsx`）为 MVP，自上而下 6 块 + 提交栏：

1. **Header row**：Title 文本框（必填）+ ID 文本框（挂载时用 `crypto.randomUUID()` 预填、可编辑、必填校验非空）+ `Regenerate` 小按钮（重新摇一个 UUID v4）。
2. **Kind dropdown**：`<select>` 由 host 的 `{type:'kinds'}` 消息填充，选中项旁显示该 kind 的 stroke+background 色块。无 kind 时（`No entry kinds defined — run Initialize Entry Kinds first`）整个表单禁用。
3. **Live Preview box**：用选中 kind 的 `coloring.stroke`（1px border）+ `coloring.background` 渲染的框，标题行 `<mock-number> <title>`、正文为当前 tab 内容的 `<pre>`（**raw text**，暂不渲染）。mock number 直接把 `numbering` DSL 原样展示为占位（`"1.1.1"` → `"1.1.1"`，`""` → 无编号），真正的 counter 引擎后续接 `SNL_Basics`。
4. **Content tabs**：5 按钮切换 SNL / Typst / LaTeX / Markdown / Text，每个 tab 各自的 `<textarea>`（内容持久在组件 state，切 tab 不丢其它格式）。SNL tab 内二级切换 `Text Editor`（默认，显示 textarea）/ `GUI Editor`（显示 `not implemented yet — Tree View / Line View coming later` 占位）。textarea 字体 `var(--vscode-editor-font-family, monospace)`，并附一行轻提示 `Monaco editor integration planned; for now a plain textarea`。
5. **Contributor section**：`not implemented yet — deferred until schema is defined` 占位框。
6. **Pointer section**：同上占位框。
7. **Submit / Cancel row**：`Create Entry` 主按钮（title + id + kind 全部有效前禁用）+ `Cancel`（重置表单）+ 结果 banner（复用 `CreateLibraryApp` 的 status-line 模式，反馈 created/duplicate/unknownKind/invalid/…）。

MVP 备注：
- Preview 对所有格式一律渲染 **raw text**（暂无 Typst/LaTeX/MD/SNL 真实渲染管线，后续接 `SNL_Basics`）。
- SNL 的 **GUI Editor**（Tree View / Line View）延后，先占位 `not implemented`。
- Contributor / Pointer 编辑器延后，先占位 `not implemented`。

### Fulcrum's Math Notes preset（附录）

`SNL: Initialize Entry Kinds` 的 `Fulcrum's Math Notes` preset 共 12 项，逐条提炼自
`Fulcrum-Notes-Typst/Fulcrum-Template-Typst/FulcrumCN.typ` 的 `#let *条目 = entry(...)` 定义。
颜色 hex 与 style 原样照搬；numbering DSL 按 `count_mode` 翻译：`main`(章.节.K)→`1.1.1`、
`sub`(章.节.K.j)→`1.1.1.1`、`single`(K)→`1`、`none`→`""`。

| id             | name (EN)      | name (CN) | stroke  | background | numbering | style   |
|----------------|----------------|-----------|---------|------------|-----------|---------|
| definition     | Definition     | 定义      | #009C27 | #D6FEE0    | 1.1.1     | full    |
| axiom          | Axiom          | 公理      | #C1C103 | #FFFFAC    | 1         | full    |
| lemma          | Lemma          | 引理      | #005B9C | #DAF0FF    | 1.1.1     | full    |
| theorem        | Theorem        | 定理      | #005B9C | #DAF0FF    | 1.1.1     | full    |
| corollary      | Corollary      | 推论      | #005B9C | #DAF0FF    | 1.1.1.1   | full    |
| property       | Property       | 性质      | #AC00AF | #FFEDFF    | 1.1.1.1   | full    |
| remark         | Remark         | 注        | #E07B00 | #FFEBD2    |           | remark  |
| example        | Example        | 例        | #7700E4 | #EFDFFF    | 1.1.1     | full    |
| counterexample | Counterexample | 反例      | #D20022 | #FFD6DC    | 1.1.1     | full    |
| construction   | Construction   | 构造      | #787878 | #F0F0F0    |           | proof   |
| proof          | Proof          | 证明      | #787878 | #F0F0F0    |           | proof   |
| problem        | Problem        | 题目      | #005B9C | #DAF0FF    | 1         | problem |

> **刻意丢弃的字段。** FulcrumCN 原定义里的 `counter_name` / `count_mode` / `main_state` /
> `sub_parent_state`（用于跨 kind 共享计数器的语义，如"引理/定理/例共用同一个 K 计数"）
> **未**在新 `EntryKind` schema 里表达——当前 `numbering` DSL 只描述层级形状，还不能表达
> 跨 kind 的 counter 绑定。等 numbering DSL 长出这套能力后再回填。
>
> **name 语言说明。** 本仓库当前 preset 落盘用 **英文** display `name`（i18n 尚未落地，
> 先统一用英文）；上表 `name (CN)` 列保留，供 i18n 落地时做中英映射参考。

### 功能块

* UI 系统（主要）
  * 术语宏编辑
  * 术语语法树编辑
  * 术语条目编辑
  * 库管理

  *这几个编辑器的 React 组件部分应该在 SNL Script 中就实现，只是在这里调用。*

* 通过 LSP 及其他 VS Code 自带功能实现 SNL 文档与代码对齐交互。在库中为 Entry 添加绑定的本项目相对路径的代码行数，并尝试制作类 SyncTeX 的对齐功能。

* 库可视化（知识图谱）

* MCP + `Skill.md`
  * SNL 宏书写
  * 文档内容书写
  * 数据查询

### Web 端迁移（前瞻）

阶段二、三的 TypeScript 代码须保证**良好的可维护性与通用性**，以便未来将整套系统从 Extension 搬到 Web 端。这是约束当下代码质量的前瞻性要求

*不 urgent*

---

## 4. 可行性质疑与轻重缓急（彩叶视角）

> 我们很可能无法一上来实现所有功能，以下按"先做/缓做/存疑"分类，并标注风险。

### 4.1 应优先（项目立身之本，风险可控）

- **SNL 数据类型接口奠基**

  基准性工作。接口一旦确定应避免修改，应当尽可能考虑各个功能的需求。后续更改要严肃考虑影响。

  Smarterm

- Alias 不会提供专用系统，通过文件数据库的结构实现相应功能。

- **术语高亮 / 跳转 / 悬停查询**（VS Code 扩展最小可用闭环）。Novel Helper 已证明这类功能在 VS Code 内完全可做。

### 4.2 可缓做（价值高但实现重，建议二期）

- **文档 ↔ 代码 LSP 双向绑定**。这是最大亮点，但也是**工程最重、最易踩坑**的部分：
  - **质疑**：跨文件、跨语言（Lean / 任意代码 ↔ SNL doc）的稳定双向锚点，在文件编辑、行号漂移、重命名后如何保持对齐？Novel Helper 专门做了"路径索引修复 / 行号漂移"才勉强稳住单语言场景。建议先用**显式锚点（如代码注释 ID + 文档引用 ID）**做 MVP，不要一开始就追求 LSP 级自动推断。

  Answer: 一开始先不管，后续我们可能要做一个专门的锚点系统。比如说我们可以借助正则表达式匹配（比如 Lean 里可以通过匹配 `theorem/def/structure/inductive [name] ...` 的 declaration 来锚定 SNL Doc 与代码文件），或者借助 Git 的 worktree 之类的做法，甚至直接提供与 LSP 合作的接口等。

- **知识图谱可视化**。机制成熟（力导向图是现成轮子），但**对大型库的布局性能与可读性**是真问题（数千术语节点的图会变成毛线团）。建议先做"局部一跳/二跳子图"，不做全局大图。

### 4.3 存疑 / 需先验证（不建议过早投入）

- **"只需炼 SKILL.md + 轻量工作流就能自动生成 SNL 文档"** —— 这是核心赌注，但**尚未验证**。
  - **质疑**：Agent 生成术语宏时，最难的不是"写出宏"，而是**保证术语语义一致性与依赖正确性**（同一概念不被重复定义成两个术语、依赖层次不成环、不该术语化的地方不乱套宏）。这需要 Agent 能"读懂全库已有术语再决定如何复用"，本质是个**检索 + 一致性约束**问题，远难于单条 Lean。
  - **建议**：阶段三之前先做一个**最小 spike**——拿 Notes-Typst 里已有的某一章，让 Agent 按现成术语库重写一段，量化"术语复用正确率 / 误术语化率"，再决定 SKILL 路线是否成立。
- **MCP 接口设计** —— 依赖阶段一数据接口定稿，过早设计会反复推翻。建议**严格排在数据模型稳定之后**。
- **专门 UI 制作的范围** —— "可能需要一定量"是个无底洞。建议**先用 VS Code 原生组件（TreeView / Webview 最小化）顶住**，UI 投入留到核心闭环跑通后按实际痛点追加。

### 4.4 一条贯穿始终的元约束

§1.4 提到"用术语化思想规训项目实现本身"——落到实处即：**本项目自身的设计文档（含本 Plan）与代码，也应尽早用 SNL 的术语化方式书写**，作为 dogfooding。既验证工具，又防止我们自己的设计产生"思维幻觉"。

---

## 5. 待定 / 待补充

- [ ] 知识图谱参考仓库（猫猫后续单独提供）
- [ ] SNL 数据模型 schema 草案（条目 / 宏 / 语法树字段定义）
- [ ] 阶段三前的 SKILL 自动生成 spike 设计
- [ ] 与潜在客户沟通后确定的具体开工范围与优先级

---

*草拟：彩叶 🍂 ｜ 待子鱼与客户沟通后细化*

---

## 6. 宏管理 UI 层级（Macro Management UI）

Dashboard 的 **SNL Macros** 侧现已与 Entries/Libraries/EntryKinds 对齐，
形成一条从总览到编辑器的层级流（1 → 2 → 3 → 4）：

1. **Dashboard → SNL Macros section**：列出 `.SNL_Doc/term_macros/*.json`
   宏包文件；底部有一条全宽虚线 `+ Add Package` 大加号条。
2. **点击某一行（package）**：派发 `openMacroPackage`，宿主按文件名打开
   一个 **per-file PackagePanel**（同一文件复用同一面板，不同文件各自成板）。
   PackagePanel 列出该包内的宏（Preview / Name / Description / Arity / Mode），
   末尾有 `+ Create Macro` 大加号条；空包只显示大加号条。
3. **`+ Add Package`**：打开 **CreateMacroPackagePanel** 小表单
   （文件名 `[a-zA-Z0-9_-]+` / 显示名 / 可选描述，附实时
   `will create: .SNL_Doc/term_macros/<file>.json` 预览），提交后写入
   规范化空包并顺带打开其 PackagePanel。
4. **`+ Create Macro`**：打开 **CreateMacroPanel** 完整编辑器——基本字段、
   Source（entries/urls 列表编辑）、Behavior（arity/mode 单选 + 条件字段）、
   7 个内容 Tab，以及核心的 **Live Preview**：把正在编辑的宏注册为
   `_snl_draft`，空参数槽渲染为半透明编号占位盒（`_snl_arg_N` 注入宏 +
   `.snlArgPlaceholder` 样式），非空槽解析为真实 SNL 子树，可 +/− 调整
   变长参数数量并逐一覆写。

**数据形状**：新写入的宏包一律采用规范形状
`{ version, name, description?, macros: { <name>: SnlMacroWithoutName } }`；
旧的三种形状（裸数组 / `{macros:[...]}` / 顶层 keyed）仍可读，由
`readMacroPackage` 归一化为 `SnlMacro[]`。

**安全**：`openMacroPackage` / `createMacro` 命令入口对 `file` 参数强制
`^[a-zA-Z0-9_-]+(\.json)?$` 校验（防路径穿越）；PackagePanel 的
FileSystemWatcher 在底层文件被删除时自动 dispose，避免悬挂面板。

---

## 7. Dashboard 布局与 Edit 面板（2026-07-04）

**Dashboard 顺序（上→下）：** Libraries → Entries → SNL Macros → Entry Kinds
→ Macro Kinds。每个 section 都是可展开的 `CollapsibleSection`，**默认全部
收起**（极简，按需展开）；body 只在 expanded 时才 mount，不为收起状态
支付表格 layout。

**Row click → Edit：** 5 张表 + PackagePanel macro 表都改成 clickable
（通用 `ClickableRow` 组件：`role=button` + `Enter/Space` 键盘触发 + hover
paint）。点击派发 `editXxx` 消息，宿主打开相应 Panel 的 edit 模式。
PackagePanel 顶部另外提供一个 `Edit package` 按钮，编辑该 package 自身的
`name` + `description` 元数据（不改 `file` 名——这是 identity）。

**6 个 update API（`src/snlDoc.ts`）：**
`updateLibrary` / `updateEntryKind` / `updateMacroKind` / `updateEntry` /
`updateMacroPackage` / `updateMacro`。**identity 永远不通过 update 修改**——
`Library.slug`（目录名）/ `EntryKind.id` / `MacroKind.id`（被 entries[]/macros[]
引用）/ `EntryData.id`（被 relationships 引用）/ `MacroPackageFile` 的 file
名 / `MacroPackageEntry.name`（被 SNL 源引用）都是 lookup key。要
"重命名"须先删除再新建。缺失 identity 返回 `notFound`。

**6 个 edit 命令（`src/extension.ts`）：**
`snlDoc.editLibrary` / `editEntryKind` / `editMacroKind` / `editEntry` /
`editMacroPackage` / `editMacro`。全部隐藏于 Command Palette（`when: false`），
只能通过 Dashboard/PackagePanel 的行点击触发（需要 identity 参数）。

**Panel 实例管理：** 6 个 `create*Panel.ts` 从"全局单例"改成
`Map<${mode}:${identity}, Panel>` 键控——同一实体的 create/edit 各自成
一个 window，不同实体的 edit 也各自成 window，不会互抢焦点。

**Webview `${mode}` 状态：** 6 个 `Create*App.tsx` 追加 `mode` state；
`context` 消息带 `mode` + `existing?` 让 app 用 on-disk 状态预填表单；
identity 字段（id / slug / file / macro.name）在 edit 模式下 readonly
（灰色 + `IDs are immutable; delete + recreate to rename` tooltip）；
submit 按钮文案在 Create/Update 之间切换。

**测试**：`npm run smoke` 76/76 通过；`build:webview` 11 bundle 干净。


## 未来功能：SNL text-mode 换行支持（下游 SNL-Basics 改造）

**背景（2026-07-05）：** 悬浮窗内长 text-mode SNL 无法自动换行，会
出现横向 scrollbar（也可能被截断/裁剪，取决于容器 overflow 策略）。
formula-mode 天然不可 wrap（KaTeX 一次性 render 成一个
`display: inline-block; white-space: nowrap` 的原子块，浏览器无 break
opportunity），但 **text-mode 应当可以 wrap**——text 节点的字面文字
只在 template 字符串里，将 template 切分成 (literal | child-slot)
segments 后每个 literal 独立成 `<span>` 就能自然换行。

**为什么值得做：** popover / Infoview 里读较长 text-mode 定义（如
"若 X 是 Set 且 f: X → Y 是……"）时，横向 scrollbar 严重影响阅读；
换行后紧凑舒适。

**改动位置：** SNL-Basics 仓库的 `src/components/SnlSyntaxTreeView.tsx`
的 text-mode render 分支（当前统一走 `<MathSpan>` 一次性 KaTeX 渲染）。
需要：
1. 新增一个 `splitTextTemplate(template): (LiteralSegment | ChildSegment)[]`
   工具函数，把 `'#0 与 #1 相等'` 之类的 template 切成
   `[{child:0}, ' 与 ', {child:1}, ' 相等']`。
2. text-mode render 分支不再一次性丢给 KaTeX，而是 map 切分结果：
   * literal → `<span className="snl-text-literal">{text}</span>`
   * child slot → 递归 `renderNode(child)`（child formula → 走 MathSpan
     一次性 KaTeX；child text → 递归拆）
3. root text 节点上继续挂 `data-name` / `data-kind` 等属性（hover event
   delegation 不受影响）。
4. `.snl-text-literal` CSS 用 Computer Modern（`font-family: 'KaTeX_Main',
   serif`）与 KaTeX 输出的 formula 段保持字体一致。

**权衡（已经与猫猫确认可接受）：**
- text-formula-text 反复嵌套时，最内层的 text 因为是嵌套在 formula 里，
  仍走 KaTeX `\text{...}`（该 formula 子树整体一次 render），字体一致
  自然保持；只在**顶层**的 text/formula 交界处可能有字体细节差异（用
  Computer Modern 兜底）。
- 交互（hover / kind palette / binder scope）本来就绑在 tree-node
  对应的 DOM 元素上，literal 文字不是 tree node 也就没有交互目标，
  拆开不会损失交互。

**estimate：** 200 行 core + 3-4 个 vitest 场景，~2 小时 focused work。
写在下游因为改的是 SNL-Basics，需要在那边走完 `build:lib` 并发一版
npm，主 repo 再 `npm install @sjtu-ai4math/snl-basics@latest`（本地
迭代期可以先 `npm link`）。

**依赖：** 无。可以随时开做。

---

## 8. SNL-Basics 接口盘点 (2026-07-08)

**来源：** SNL-Basics 的 `src/snl-react-view/index.ts` package barrel，对应当前依赖的 `@sjtu-ai4math/snl-basics` 版本（v3 macro / v6 on-disk / v2 library-graph）。
只列消费者面能看到、能覆盖的公开 API；`components/` 内部实现细节按住不表。

### 8.1 数据类型接口

| 类型 | 来源 | 语义 | 备注 |
|---|---|---|---|
| `SnlMacro` | `snl-macro/types.ts` | 单个宏定义。`name / description / source / kind? / dynamic_arity / styles[] / tags?` | v3 (v6 on-disk)。`kind` 缺省 → 节点 `data-kind='fvar'`；`dynamic_arity` 是宏级不可变契约（所有 style 共享） |
| `SnlMacroSource` | 同上 | `{ entries: string[], urls: string[] }` | 解析顺序：`entries[0..]` 第一个可解析的，否则 `urls[0]`，否则 `null`。SNL-Basics 不解释 `entries`，靠 `hooks.resolveSource` |
| `SnlMacroStyle` | 同上 | 单个渲染 style。`tag / mode / template / variadic_left? / variadic_join? / variadic_right? / react_renderer_key? / tags?` | `mode` 4 值：`formula_inline / formula_display / text / block`。`styles[0]` 是隐式默认 |
| `SnlMacroDb` | 同上 | `Record<string, SnlMacro>` | 扁平的 name→macro 映射。宏名字全局唯一 |
| `SnlSyntaxTree` | `snl-syntax-tree/types.ts` | parser 产出的 flat runtime node：`name / style? / envMode? / kind / scope? / mdata: unknown / children[]` | `envMode` 由 `%…% / $…$ / $$…$$` 触发，视为 temp macro 不查 db；`scope='binder'` 由 annotate-bind 标记 |
| `SnlSyntaxTreeParseError` | `snl-react-view/parse` | 抛出的解析错误，携 `.position` (0-based char offset) | agent lint 报告用 `(at N)` 定位 |
| `KindColoring` / `KindPalette` | `snl-react-view/kind-palette` | 每 kind 的颜色配置 / 全表 | 与 `DEFAULT_KIND_PALETTE` merge，consumer 覆盖 |
| `SnlMacroTemplateQuery` | `snl-syntax-tree/query.ts` | `(args: { name, node }) => Promise<string>` | 查询宏名 → KaTeX template。异步以支持懒加载 db |

### 8.2 函数接口 / 顶层导出

| 函数 | 签名 (简) | 用途 |
|---|---|---|
| `parseSnlSyntaxTree(src)` | `(string) => SnlSyntaxTree` | 解析成功；失败 throw `SnlSyntaxTreeParseError` |
| `tryParseSnlSyntaxTree(src)` | `(string) => {ok:true, tree} \| {ok:false, error, position?}` | 不抛异常的版本，agent lint 用这个 |
| `serializeSnlSyntaxTree(tree)` | `(SnlSyntaxTree) => string` | 逆解析：tree → SNL 源码 |
| `annotateBindings(tree)` | `(SnlSyntaxTree) => SnlSyntaxTree` | 就地补 `scope='binder'` + `mdata.bindRef`，view 层依赖这个做 bvar 高亮 |
| `createSnlSyntaxTreeNode(name, opts?)` | `(name, {kind?, mdata?, children?}) => SnlSyntaxTree` | 手写 tree 时的构造 helper |
| `isSnlSyntaxTree(v)` | `(unknown) => boolean` | runtime 类型守卫 |
| `loadSnlMacroDb(url?)` | `(url) => Promise<SnlMacroDb>` | 从 URL 拉 JSON db，带缓存。默认 `/snl-macro-db.json` |
| `setSnlMacroDbCache(db)` | `(SnlMacroDb \| null) => void` | 直接注入内存 db，绕过 fetch |
| `clearSnlMacroDbCache()` | `() => void` | 清缓存 (热更 / 切换 db url) |
| `createDefaultMacroTemplateQuery(url?, opts?)` | `(url, opts?) => SnlMacroTemplateQuery` | 用 URL 建 query，内部 lazy load db |
| `createMacroTemplateQueryFromDb(db)` | `(SnlMacroDb) => SnlMacroTemplateQuery` | 用已 load 好的 db 建 query，无网络无延迟。Extension 走这条 |
| `fillLatexTemplate(tpl, args)` | `(string, {...}) => string` | 低层：把 `#0/#1/#*/\#` 占位符填成 LaTeX。placeholder 缺失时渲染 `\htmlClass{snlMissingArg}{...}` |
| `bundledMacroDb` | `SnlMacroDb` | 内置的核心宏（`\alpha`、`\frac` 等）。Extension 用 mergeMacroDb 把用户宏叠加在上面 |
| `bundledSampleMacroDb` | `SnlMacroDb` | 示例 / 演示用宏 |
| `HTMLDATA_KATEX_DEFAULTS` | `KatexOptions` | KaTeX 默认配置（trust / macros），传给 SnlSyntaxTreeView 的 katexOptions |
| `DEFAULT_KIND_PALETTE` | `KindPalette` | 内置 kind 颜色表 |
| `paletteToCss(palette)` | `(KindPalette) => string` | palette → CSS 字符串，view 层内联注入 |
| `alpha(color, a)` | `(color, number) => string` | 颜色透明度调整 |
| `assertSafeKindName(name)` | `(string) => void` | kind 名字合法性 assert |

### 8.3 组件接口

**`<SnlSyntaxTreeView>`** —— 唯一的对外渲染组件。

`SnlSyntaxTreeViewProps`:

| Prop | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tree` | `SnlSyntaxTree` | ✓ | 已 annotate 的树（自己没 annotateBindings 也能渲染，只是 bvar/binder 高亮不工作） |
| `query` | `SnlMacroTemplateQuery` | ✓ | 宏名→template 解析函数 |
| `macroDb` | `SnlMacroDb` | ✓ | mode dispatch + metadata 查询 |
| `katexOptions` | `KatexOptions` | | 传给 `katex.renderToString`。用 `HTMLDATA_KATEX_DEFAULTS` 作 base |
| `kindPalette` | `KindPalette` | | 与 `DEFAULT_KIND_PALETTE` merge，view 内联 `<style>` 注入 |
| `onResolved` | `(latexSource: string) => void` | | callback：formula root 渲染完 LaTeX 源码回传（用于导出/调试） |
| `hooks` | `SnlRenderHooks` | | 全部 hook 都 optional，与 defaultRenderHooks merge |

### 8.4 可自定义事件 / 钩子 (`SnlRenderHooks`) — 猫猫重点问的

**全部 optional**，与 `defaultRenderHooks` 逐项覆盖。当前一共 **6 个 hook**：

| Hook | 签名 | 时机 | 副作用允许 | 默认 |
|---|---|---|---|---|
| `onHover` | `(event: SnlHoverEvent) => void` | 鼠标进入 / 移动到宏节点上 | fire-and-forget，不 await。宿主用来做 side effect（记日志、跨 window 消息、spawn popover 等） | `undefined`（内部 hover state machine 照跑） |
| `onLeave` | `() => void` | 指针离开渲染容器 | fire-and-forget | `undefined` |
| `resolveMacroInfo` | `(name, macro?) => Promise<SnlMacroInfo>` | hover 开始后短 debounce 触发 | async，可 hit 网络/磁盘 cache；view 保持 `loading:true` 直到 resolve | 读 `macroDb[name].description` |
| `resolveSource` | `(source: SnlMacroSource) => SnlResolvedSource \| null` | 每次 render 都 sync 调用 | **必须 sync**、必须 pure。要异步查请先在 React state/memo 缓存好 | 返回 `null` |
| `renderTooltip` | `(state: SnlTooltipState) => ReactElement \| null` | 每次 hover 状态变化 render 时 | sync React render，pure，无副作用 | 内置 `.snl-hover-tooltip` DOM。返回 `null` 完全禁用 tooltip |
| `highlightStrategy` | `{ computeHighlightSet(target, container, bvarScopeIndex) => SnlHighlightSet }` | 每次 hover 决定 highlight 哪些 DOM | sync | `defaultHighlightStrategy`（单元素高亮 + bvar/binder 全 scope 联动） |
| `renderers` | `Record<string, SnlBlockRenderer>` | block-mode 宏 dispatch key → 组件 | 声明式 | `defaultRenderers` = `{ list, table, centered }`。spread 到 default 上扩展 |

**事件 payload 类型:**

- `SnlHoverEvent`: `{ name, kind, node: SnlSyntaxTree, bindingHint: string, variableRole: 'bvar'|'fvar'|'none', target: HTMLElement, clientX, clientY }`
- `SnlMacroInfo`: `{ description: string, extra?: string }` — tooltip 主体
- `SnlResolvedSource`: `{ kind: 'entry'|'url', ref: string, displayName?, href? }` — cross-link 目标
- `SnlTooltipState`: `{ visible, x, y, name, kind, variableRole, bindingHint, info: SnlMacroInfo|null, loading, source: SnlResolvedSource|null }` — render 时喂给 renderTooltip 的完整状态
- `SnlHighlightSet`: `{ singleHover: HTMLElement|null, bvarScope: HTMLElement[], binderDecl: HTMLElement[] }` — 三桶元素，view 分别打上 `.snl-single-hover / .snl-bvar-scope / .snl-binder-decl`

**Extension 侧现在用了哪些：** 看 `webview/src/render/EntryRender.tsx` L198-277。当前只覆盖了 `resolveSource`（entry 池解析）、`onHover`（spawn popover + 3s freeze timer）、`onLeave`（清 timer）、`renderTooltip: () => null`（禁用内置 tooltip 让 popover 独占）。剩下 `resolveMacroInfo` / `highlightStrategy` / `renderers` 都跑默认。

### 8.5 版本 pin

当前依赖版本见 `npm ls @sjtu-ai4math/snl-basics`。schema 版本：
- `SnlMacro` v3 = **v6 on-disk** (`term_macros/*.json` 的 `version` 字段)
- `SnlSyntaxTree` = flat runtime（未来会切到 discriminated `node-types` union，暂时并存）
- `LibraryGraph` = v2（`label: 'Entry'` / `label: 'branch'`）
