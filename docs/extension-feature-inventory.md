# SNL-Doc-Extension 功能列表

来源：`package.json` `contributes.commands` + `webview/src/*.tsx` 全量扫描（15 个 webview，~14 100 行 tsx）。

## 1. Commands 表

| # | Command ID | Palette 标题 | 触发面板 / 动作 | 分类 |
|---|---|---|---|---|
| 1 | `snlDoc.openDashboard` | SNL: Open Dashboard | Dashboard webview | 概览 |
| 2 | `snlDoc.openInfoview` | SNL: Open Infoview | Infoview webview（不定位到具体 entry） | 概览 |
| 3 | `snlDoc.refreshInfoview` | SNL: Refresh Infoview | 强制重刷 Infoview | 概览 |
| 4 | `snlDoc.openEntryInfoview` | SNL: Open Entry Infoview | Infoview webview（定位到指定 entry） | 概览 |
| 5 | `snlDoc.revealEntryPointer` | SNL: Reveal Entry Pointer | 打开 entry.pointer 指向的源码位置 | 概览 |
| 6 | `snlDoc.openMacroPackage` | SNL: Open Macro Package… | Macro Package Panel webview | 概览 |
| 7 | `snlDoc.openInfoviewGraph` | SNL: Open Relationship Graph | Relationship Graph webview（全局） | 关系图 |
| 8 | `snlDoc.openInfoviewGraphForLibrary` | SNL: Open Relationship Graph (Library) | Relationship Graph webview（指定 library） | 关系图 |
| 9 | `snlDoc.openSnoogL` | SNL: Open SNoogL (Search) | SNoogL 搜索 webview | 搜索 |
| 10 | `snlDoc.init` | SNL: Init | 在当前 workspace 初始化 `.SNL_Doc/` 骨架 | 初始化 |
| 11 | `snlDoc.initEntryKinds` | SNL: Initialize Entry Kinds | InitEntryKinds webview（批量首次配置） | 初始化 |
| 12 | `snlDoc.initMacroKinds` | SNL: Initialize Macro Kinds | InitMacroKinds webview（批量首次配置） | 初始化 |
| 13 | `snlDoc.createLibrary` | SNL: Create Library | CreateLibrary webview | 创建 |
| 14 | `snlDoc.createEntryKind` | SNL: Create Entry Kind | CreateEntryKind webview | 创建 |
| 15 | `snlDoc.createMacroKind` | SNL: Create Macro Kind | CreateMacroKind webview | 创建 |
| 16 | `snlDoc.createEntry` | SNL: Create Entry | CreateEntry webview | 创建 |
| 17 | `snlDoc.createMacroPackage` | SNL: Create Macro Package | CreateMacroPackage webview | 创建 |
| 18 | `snlDoc.createMacro` | SNL: Create Macro | CreateMacro webview | 创建 |
| 19 | `snlDoc.createRelationship` | SNL: Create Relationship | CreateRelationship webview | 创建 |
| 20 | `snlDoc.editLibrary` | SNL: Edit Library | CreateLibrary webview（编辑模式） | 编辑 |
| 21 | `snlDoc.editEntryKind` | SNL: Edit Entry Kind | CreateEntryKind webview（编辑模式） | 编辑 |
| 22 | `snlDoc.editMacroKind` | SNL: Edit Macro Kind | CreateMacroKind webview（编辑模式） | 编辑 |
| 23 | `snlDoc.editEntry` | SNL: Edit Entry | CreateEntry webview（编辑模式） | 编辑 |
| 24 | `snlDoc.editMacroPackage` | SNL: Edit Macro Package | CreateMacroPackage webview（编辑模式） | 编辑 |
| 25 | `snlDoc.editMacro` | SNL: Edit Macro | CreateMacro webview（编辑模式） | 编辑 |
| 26 | `snlDoc.editRelationship` | SNL: Edit Relationship | CreateRelationship webview（编辑模式） | 编辑 |
| 27 | `snlDoc.deleteEntry` | SNL: Delete Entry | 删除 entry（弹确认） | 删除 |
| 28 | `snlDoc.deleteEntryKind` | SNL: Delete Entry Kind | 删除 entry kind（弹确认） | 删除 |
| 29 | `snlDoc.deleteMacroKind` | SNL: Delete Macro Kind | 删除 macro kind（弹确认） | 删除 |
| 30 | `snlDoc.deleteLibrary` | SNL: Delete Library | 删除 library（弹确认） | 删除 |
| 31 | `snlDoc.deleteMacroPackage` | SNL: Delete Macro Package | 删除 macro package（弹确认） | 删除 |
| 32 | `snlDoc.deleteRelationship` | SNL: Delete Relationship | 删除 relationship（弹确认） | 删除 |
| 33 | `snlDoc.regenerateDependencies` | SNL: Regenerate Dependency Relationships | 扫全部 entries 重建 `dependency` 关系 | 关系图 |
| 34 | `snlDoc.checkDataVersion` | SNL: Check Data Version | 严格检查 workspace 数据版本与 topology，不写入 | 数据维护 |
| 35 | `snlDoc.repairData` | SNL: Repair / Migrate Data | 执行确认后的相邻 migration chain | 数据维护 |
| 36 | `snlDoc.toggleTrace` | SNL: Toggle Performance Trace | 切换 Panel 性能追踪 | 诊断 |
| 37 | `snlDoc.probeWebviewCost` | SNL: Probe Webview Cost | 探测 Webview 加载成本 | 诊断 |

**分类小计：** 原 33 条功能命令 + 数据维护 2 + 诊断 2。**合计 37。**

（`menus.commandPalette` 通过 `when: "false"` 隐藏 11 条仅供 UI 调用的命令；其余 26 条可从 Palette 触发。）

---

## 2. Panel UI 单元表

> 「（每行一个）」表示该控件在列表 / 树里每条目复制一次。「local state only」= 纯 webview 内 state 变化，无 host 消息。
>
> **核对状态**：所有 `message` 列已与 `src/*.ts` 里的 `case '...'` 分派对齐（`nav.openDashboard` / `nav.openInfoview` 走 `src/panelUtil.ts` 通用 back-nav 路由；其余走各面板自己的 `onDidReceiveMessage`）。EntryInfoview 里的 Related 链接实际用 `openEntryInfoview`，同 Infoview。

### 2.1 Infoview (`App.tsx`)

| Panel | 单元 label/文字 | 类型 | 作用 | 触发的 command / message | 状态/校验 |
|---|---|---|---|---|---|
| Infoview | View Graph | button | 打开池级关系图 | `openInfoviewGraph` | — |
| Infoview | Edit in Dashboard | button | 跳转到 Dashboard 管理界面 | `openDashboard` | — |
| Infoview | Library 卡片 | list-item | 进入该 Library 层级视图 | `selectLibrary {slug}` | （每行一个）无库时不渲染 |
| Infoview | ← Back | button | 从 Library 层返回 Libraries 根 | `ready` | 仅 Library 层显示 |
| Infoview | View Graph（Library 层） | button | 打开该 Library 的关系子图 | `openInfoviewGraphForLibrary {slug}` | — |
| Infoview | Edit this Library | button | 打开该 Library 的编辑器 | `editLibrary {slug}` | — |
| Infoview | ▶/▼ 折叠切换 | button | 折叠/展开该 outline 节点的子条目 | local state only | 仅有子节点时显示 |
| Infoview | Entry 标题 Ctrl+Click | list-item | 打开该 Entry 专属 Infoview 面板 | `openEntryInfoview {entryId}` | 需 Ctrl+点击 |

### 2.2 Dashboard (`DashboardApp.tsx`)

| Panel | 单元 label/文字 | 类型 | 作用 | 触发的 command / message | 状态/校验 |
|---|---|---|---|---|---|
| Dashboard | Run SNL: Init | button | 触发 `.SNL_Doc/` 骨架初始化 | `init` | 仅未初始化状态显示 |
| Dashboard | View Graph | button | 打开池级关系图 | `openInfoviewGraph` | — |
| Dashboard | Open Infoview → | button | 打开 Infoview 阅读面板 | `openInfoview` | — |
| Dashboard | Libraries / Entries / Relationships / SNL Macros / Entry Kinds / Macro Kinds | button（折叠头） | 展开/收起对应板块 | local state only | 默认全部收起 |
| Dashboard | + Create Entry | button | 打开 Create Entry 面板 | `createEntry` | — |
| Dashboard | ⌕ SNoogL: Entry Search | button | 打开 SNoogL 并切至 Entry 模式 | `openSnoogL {mode:'entry'}` | — |
| Dashboard | + Create Macro | button | 选择宏包并打开 Create Macro | `createMacroPickPackage` | — |
| Dashboard | ⌕ SNoogL: Macro Search | button | 打开 SNoogL 并切至 Macro 模式 | `openSnoogL {mode:'macro'}` | — |
| Dashboard | Library 行 | list-item | 打开编辑该 Library | `editLibrary {slug}` | （每行一个） |
| Dashboard | Library 行 ✕ | button | 删除该 Library | `deleteLibrary {slug}` | 二次确认在宿主端 |
| Dashboard | Create Library | button（AddBar） | 打开新建 Library 面板 | `createLibrary` | — |
| Dashboard | Entry 行 | list-item | 打开编辑该 Entry | `editEntry {id}` | （每行一个） |
| Dashboard | Entry 行 ✕ | button | 删除该 Entry | `deleteEntry {id}` | — |
| Dashboard | Create Entry (AddBar) | button | 新建 Entry | `createEntry` | — |
| Dashboard | Relationship 行 | list-item | 打开编辑该 Relationship | `editRelationship {id}` | （每行一个） |
| Dashboard | Relationship 行 ✕ | button | 删除该 Relationship | `deleteRelationship {id}` | — |
| Dashboard | Create Relationship | button（AddBar） | 新建 Relationship | `createRelationship` | — |
| Dashboard | ⚙ Regenerate Dependencies from Macro Sources | button（AddBar） | 从宏 source 重新生成依赖关系 | `regenerateDependencies` | — |
| Dashboard | Macro Package 行 | list-item | 打开宏包面板 | `openMacroPackage {file}` | （每行一个） |
| Dashboard | Macro Package Active 复选框 | checkbox | 切换该宏包激活状态 | `setPackageActive {file, active}` | — |
| Dashboard | Macro Package 行 ✕ | button | 删除宏包 | `deleteMacroPackage {file}` | — |
| Dashboard | Add Package | button（AddBar） | 新建宏包 | `createMacroPackage` | — |
| Dashboard | Entry Kind 行 | list-item | 编辑该 Entry Kind | `editEntryKind {id}` | （每行一个） |
| Dashboard | Entry Kind 行 ✕ | button | 删除该 Entry Kind | `deleteEntryKind {id}` | — |
| Dashboard | Create Entry Kind | button（AddBar） | 新建 Entry Kind | `createEntryKind` | 仅在已有 kinds 时显示 |
| Dashboard | Initialize Entry Kinds | button（AddBar） | 初始化默认 Entry Kinds | `initEntryKinds` | 仅在无 kinds 时显示 |
| Dashboard | Macro Kind 行 | list-item | 编辑该 Macro Kind | `editMacroKind {id}` | （每行一个） |
| Dashboard | Macro Kind 行 ✕ | button | 删除该 Macro Kind | `deleteMacroKind {id}` | — |
| Dashboard | Create Macro Kind | button（AddBar） | 新建 Macro Kind | `createMacroKind` | 仅在已有 kinds 时显示 |
| Dashboard | Initialize Macro Kinds | button（AddBar） | 初始化默认 Macro Kinds | `initMacroKinds` | 仅在无 kinds 时显示 |

### 2.3 PackagePanel (`PackagePanelApp.tsx`)

| Panel | 单元 label/文字 | 类型 | 作用 | 触发的 command / message | 状态/校验 |
|---|---|---|---|---|---|
| PackagePanel | Dashboard（顶部导航） | button | 返回 Dashboard | `nav.openDashboard` | — |
| PackagePanel | Toast × | button | 关闭 toast 提示 | local state only | 仅有 toast 时显示 |
| PackagePanel | Active/Inactive Toggle | button | 切换宏包激活状态 | `setPackageActive {active}` | — |
| PackagePanel | Select / Cancel | button | 进入或退出多选模式 | local state only | — |
| PackagePanel | Edit package | button | 编辑宏包名/描述 | `editMacroPackage` | — |
| PackagePanel | Macro 行 | list-item | 编辑该宏 | `editMacro {name}` | （每行一个） |
| PackagePanel | 行首复选框 | checkbox | 选择/取消选择该宏（批量） | local state only | 仅多选模式 |
| PackagePanel | ▶/▼ 展开样式 | button | 展开/收起该宏的额外样式行 | local state only | 仅有 >1 style 时显示 |
| PackagePanel | Macro Preview | preview | 展示 KaTeX 渲染的宏预览 | 无（纯渲染） | 模板为空显示 — |
| PackagePanel | Src 状态灯 🟢🟡🔴 | preview | 显示宏 source 解析状态 | 无 | 仅显示 |
| PackagePanel | Create Macro | button（AddBar） | 新建宏 | `createMacro` | 非多选模式 |
| PackagePanel | Copy / Move… | button | 打开批量转移模态框 | 打开 TransferModal | 选中为 0 时禁用 |
| PackagePanel | Delete（批量） | button | 批量删除选中宏 | `batchDelete {macroNames}` | 选中为 0 时禁用 |
| PackagePanel | Copy / Move（模态切换） | radio | 选择复制或移动模式 | local state only | — |
| PackagePanel | Destination package | select | 选择目标包（或新建） | local state only | — |
| PackagePanel | New package file name | text-input | 输入新包文件名 | local state only | 必填、正则 `BARE_FILE_RE`（字母数字-_） |
| PackagePanel | Display name | text-input | 新包显示名（可选） | local state only | 可选 |
| PackagePanel | Description | text-input | 新包描述（可选） | local state only | 可选 |
| PackagePanel | Cancel（模态） | button | 关闭模态 | local state only | — |
| PackagePanel | Copy/Move 提交 | button | 提交批量转移 | `batchTransfer {mode,target,…}` | canSubmit 为假时禁用 |

### 2.4 EntryInfoview (`EntryInfoviewApp.tsx`)

| Panel | 单元 label/文字 | 类型 | 作用 | 触发的 command / message | 状态/校验 |
|---|---|---|---|---|---|
| EntryInfoview | ✎ Edit | button | 打开 Edit Entry 面板 | `editEntry {entryId}` | 仅 entry 加载后显示 |
| EntryInfoview | Context 折叠头 | button | 展开/收起 Context 列表 | local state only | — |
| EntryInfoview | Dependencies 折叠头 | button | 展开/收起 Dependencies 列表 | local state only | — |
| EntryInfoview | Related 条目链接 | link/list-item | 打开该关联 Entry 的 Infoview | `openEntryInfoview {entryId}` | （每行一个） |

### 2.5 SNoogL (`SnooglApp.tsx`)

| Panel | 单元 label/文字 | 类型 | 作用 | 触发的 command / message | 状态/校验 |
|---|---|---|---|---|---|
| SnoogL | ← Dashboard | button | 返回 Dashboard | `nav.openDashboard` | — |
| SnoogL | Entry / Macro | tab | 切换搜索目标类型 | local state only（触发 `query`） | — |
| SnoogL | 搜索输入框 | text-input | 输入查询词 | `query {q,mode,filters}`（120ms 防抖） | placeholder 随 mode 变化，Enter 立即提交 |
| SnoogL | Kind 下拉 | select | 按 kind 过滤结果 | 触发 `query` 重发 | 选项随 mode 变化 |
| SnoogL | 结果行 | list-item | 打开命中的 Entry 或 Macro | `openEntry {id}` 或 `openMacro {packageFile,name}` | （每行一个）无结果时显示 No matches |

### 2.6 CreateEntry (`CreateEntryApp.tsx`)

| Panel | 单元 label/文字 | 类型 | 作用 | 触发的 command / message | 状态/校验 |
|---|---|---|---|---|---|
| CreateEntry | Dashboard (← back) | button | 返回 SNL Dashboard 面板 | `nav.openDashboard` | — |
| CreateEntry | View in Infoview | button | 在 Infoview 阅读界面打开当前 entry | `nav.openInfoview {entryId}` | 仅 edit 模式且 id 非空时显示 |
| CreateEntry | Title | text-input | 输入条目标题 | local state only | 必填（trim 后非空） |
| CreateEntry | ID / ID (readonly) | text-input (EntityIdSearchBox) | 输入或选择条目唯一 id | local state only | 必填；create 模式 requireUnique 去重；edit 模式只读 |
| CreateEntry | Regenerate UUID / Use UUID instead | button | 用新的 UUID v4 覆盖 ID | local state only | 仅 create 模式 |
| CreateEntry | Kind | select | 从 config.json#entry_kinds 中选择 kind | local state only | 必填；无 kind 时整表 disabled |
| CreateEntry | Live Preview | preview | KaTeX + EntryRender 实时预览当前草稿 | 无 | — |
| CreateEntry | SNL / Typst / LaTeX / Markdown / Text | tab | 切换正文源码格式 | local state only | 单选，activeFormat |
| CreateEntry | Text Editor / GUI Editor (Inductive) | tab | 切换 SNL 的文本 / 归纳树 编辑模式 | local state only | 仅当 activeFormat=snl |
| CreateEntry | 正文 textarea | textarea | 编辑当前格式的源码 | local state only | — |
| CreateEntry | Inductive 行 name 输入 | text-input | （每行一个）编辑树节点头，识别 `$…$` / `%…%` / `@` / `[style]` 并按 kind 上色 | local state only；识别到定 arity Macro 时自动补齐子节点 | 空占位行序列化前被剥除 |
| CreateEntry | Inductive 行 style 输入 | text-input | （每行一个）指定 macro 的 style tag | local state only | 无匹配 macro 时 disabled |
| CreateEntry | ▶ / ▼ chevron | button | （每行一个）折叠 / 展开子树 | local state only | 仅当有子节点 |
| CreateEntry | ↗ new / ↗ edit | button | （每行一个）跳到 Create/Edit Macro，预填 macro_name/env_mode/style_name | `openMacroEditor` | — |
| CreateEntry | + child | button | （每行一个）在当前节点下追加空子节点 | local state only | hover 显示 |
| CreateEntry | − delete | button | （每行一个）删除该子树 | local state only | 根节点不显示 |
| CreateEntry | Contributor / Pointer | preview | 占位区，尚未实现 | — | — |
| CreateEntry | Create Entry / Update Entry (Creating…/Updating…) | button | 提交 entry 到 host 保存 | `create` / `update`（entry payload） | title/id/kind 非空且非 creating 时才可点 |
| CreateEntry | Cancel / Reset banner | button | create: 清空表单；edit: 只清 status banner | local state only | — |

### 2.7 CreateEntryKind (`CreateEntryKindApp.tsx`)

| Panel | 单元 label/文字 | 类型 | 作用 | 触发的 command / message | 状态/校验 |
|---|---|---|---|---|---|
| CreateEntryKind | Dashboard (← back) | button | 返回 Dashboard | `nav.openDashboard` | — |
| CreateEntryKind | ID (unique) / ID (readonly) | text-input (EntityIdSearchBox) | 输入 entry kind 唯一 id | local state only | 必填；create requireUnique；edit 只读 |
| CreateEntryKind | Name (display) | text-input | 显示名 | local state only | 必填 |
| CreateEntryKind | Stroke / Background | color-picker + text-input | 选或输入描边/背景颜色 | local state only | 非 #rrggbb 时 picker 回退灰 |
| CreateEntryKind | 颜色预览框 | preview | 用当前 stroke+background 展示效果 | local state only | — |
| CreateEntryKind | Numbering DSL | text-input (mono) | 输入编号 DSL 如 `1.1.1` | local state only | 不校验 |
| CreateEntryKind | Style tag | text-input (mono) | 输入 style 标签 | local state only | — |
| CreateEntryKind | Create Entry Kind / Update Entry Kind | button | 提交 entry kind | `create` / `update` | id+name 非空且非 creating |

### 2.8 CreateMacroKind (`CreateMacroKindApp.tsx`)

| Panel | 单元 label/文字 | 类型 | 作用 | 触发的 command / message | 状态/校验 |
|---|---|---|---|---|---|
| CreateMacroKind | Dashboard (← back) | button | 返回 Dashboard | `nav.openDashboard` | — |
| CreateMacroKind | ID (unique) / ID (readonly) | text-input (EntityIdSearchBox) | 输入 macro kind 唯一 id | local state only | 必填；create requireUnique；edit 只读 |
| CreateMacroKind | Name (display) | text-input | 显示名 | local state only | 必填 |
| CreateMacroKind | Description (optional) | text-input | 一句话描述 | local state only | — |
| CreateMacroKind | Stroke / Background | color-picker + text-input | 选或输入描边/背景颜色 | local state only | 非 #rrggbb 时 picker 回退灰 |
| CreateMacroKind | 颜色预览框 | preview | 展示 kind 配色效果 | local state only | — |
| CreateMacroKind | Create Macro Kind / Update Macro Kind | button | 提交 macro kind | `create` / `update` | id+name 非空且非 creating |

### 2.9 CreateMacroPackage (`CreateMacroPackageApp.tsx`)

| Panel | 单元 label/文字 | 类型 | 作用 | 触发的 command / message | 状态/校验 |
|---|---|---|---|---|---|
| CreateMacroPackage | Dashboard (← back) | button | 返回 Dashboard | `nav.openDashboard` | — |
| CreateMacroPackage | File name / File name (readonly) | text-input | Package ID / 文件 stem | local state only；Enter 触发提交 | 必填，正则 `[A-Za-z0-9][A-Za-z0-9._-]*`，且不得以 `.json` 结尾；edit 只读 |
| CreateMacroPackage | Display name | text-input | 包显示名 | local state only；Enter 触发提交 | 必填 |
| CreateMacroPackage | Description (optional) | textarea | 包描述 | local state only | — |
| CreateMacroPackage | Create Package / Update Package | button | `0.0.6` 在 `packages/` 写 manifest（Macro 实体在 `macros/`）；legacy workspace 使用 `term_macros/` | `create` / `update` | fileValid + name 非空 + 非 creating |

### 2.10 CreateRelationship (`CreateRelationshipApp.tsx`)

| Panel | 单元 label/文字 | 类型 | 作用 | 触发的 command / message | 状态/校验 |
|---|---|---|---|---|---|
| CreateRelationship | ← Dashboard | button | 返回 Dashboard | `nav.openDashboard` | — |
| CreateRelationship | ID | text-input (mono) | 关系唯一 id | local state only | 必填；create 时不能与 existingIds 重复；edit 只读 |
| CreateRelationship | From (source entry) | text-input (EntityIdSearchBox) | 选择源 entry id | local state only | requireMatch — 必须解析到 entry 池 |
| CreateRelationship | To (target entry) | text-input (EntityIdSearchBox) | 选择目标 entry id | local state only | requireMatch — 必须解析到 entry 池 |
| CreateRelationship | Label (required) | text-input | 关系文字标签 | local state only | 必填 |
| CreateRelationship | Metadata (raw JSON) | textarea (mono) | 原始 JSON 元数据，空 ⇒ null | local state only | 必须可解析 JSON，否则红框 |
| CreateRelationship | Create Relationship / Save Changes (Saving…) | button | 提交关系 | `create` / `update`（relationship payload） | id+from+to+label 有效且 JSON 合法且非 busy |

### 2.11 InitEntryKinds (`InitEntryKindsApp.tsx`)

| Panel | 单元 label/文字 | 类型 | 作用 | 触发的 command / message | 状态/校验 |
|---|---|---|---|---|---|
| InitEntryKinds | Dashboard | button (nav) | 返回 Dashboard 面板 | `nav.openDashboard` | — |
| InitEntryKinds | Preset | select | 选择预设的 entry-kinds 集合 | local state only | 已有 entry_kinds 时或 applying 时禁用 |
| InitEntryKinds | Apply Preset / Applying… | button | 将所选预设写入 `config.json#entry_kinds` | `apply {presetId}` | catalog 非空 / 未选 / applying 时禁用 |

### 2.12 InitMacroKinds (`InitMacroKindsApp.tsx`)

| Panel | 单元 label/文字 | 类型 | 作用 | 触发的 command / message | 状态/校验 |
|---|---|---|---|---|---|
| InitMacroKinds | Dashboard | button (nav) | 返回 Dashboard 面板 | `nav.openDashboard` | — |
| InitMacroKinds | Preset | select | 选择预设的 macro-kinds 集合 | local state only | 已有 macro_kinds 时或 applying 时禁用 |
| InitMacroKinds | Apply Preset / Applying… | button | 将所选预设写入 `config.json#macro_kinds` | `apply {presetId}` | catalog 非空 / 未选 / applying 时禁用 |

### 2.13 CreateLibrary (`CreateLibraryApp.tsx`)

| Panel | 单元 label/文字 | 类型 | 作用 | 触发的 command / message | 状态/校验 |
|---|---|---|---|---|---|
| CreateLibrary | Dashboard | button (nav) | 返回 Dashboard | `nav.openDashboard` | — |
| CreateLibrary | View in Infoview | button (nav) | 在 Infoview 中打开当前 library | `nav.openInfoview {slug}` | 仅 edit 模式且有 slug |
| CreateLibrary | Slug (readonly) | text-input | 显示不可变的目录名 | local state only | readOnly |
| CreateLibrary | Library title | text-input | 编辑/输入 library 显示标题；Enter 提交 | local state only | trim 后非空才能提交 |
| CreateLibrary | Create Library / Update Title / Creating…/Updating… | button | 创建或更新 library 元数据 | `create` / `update {title}` | title 空或 creating 时禁用 |
| CreateLibrary | + Add root entry | button | 在 outline 根级插入新条目 | 打开 AddNodeForm（local） | — |
| CreateLibrary | ▶ / ▼ | button | 折叠/展开该 outline 节点 | local state only | 无子节点时不显示 |
| CreateLibrary | Entry 标题 | list-item click | 打开对应 entry 的编辑面板 | `openEditEntry {entryId}` | 仅当节点已关联 entry |
| CreateLibrary | entryId 短码 | button | 点击复制 entry.id 到剪贴板 | clipboard.writeText（local） | 无 entry 时不显示 |
| CreateLibrary | + child | button | 在该节点下新增子条目 | 打开 AddNodeForm（local） | — |
| CreateLibrary | + sibling | button | 在该节点后新增兄弟条目 | 打开 AddNodeForm（local） | — |
| CreateLibrary | ←\| | button | Outdent — 提升为父节点的兄弟 | `graphOp {op:'outdent',nodeId}` | 根节点禁用 |
| CreateLibrary | →\| | button | Indent — 变为前一兄弟的子节点 | `graphOp {op:'indent',nodeId}` | 无前兄弟时禁用 |
| CreateLibrary | ↑ | button | 与前一兄弟交换 | `graphOp {op:'moveSibling',direction:'up'}` | — |
| CreateLibrary | ↓ | button | 与后一兄弟交换 | `graphOp {op:'moveSibling',direction:'down'}` | — |
| CreateLibrary | ✕ | button (destructive) | 从 outline 删除该节点（宿主端弹确认） | `graphOp {op:'deleteNode',nodeId}` | — |
| CreateLibrary | Entry id 搜索框 | text-input (autocomplete) | 在 AddNodeForm 内搜索/输入 entry id | local state only | 空/未匹配时按钮切到 Create |
| CreateLibrary | Reference / Create | button | 匹配则关联现有 entry，否则打开 CreateEntry 面板 | `graphOp {op:'addNode',...}` 或 `openCreateEntry` | — |
| CreateLibrary | Cancel | button | 关闭 AddNodeForm | local state only | — |

### 2.14 CreateMacro (`CreateMacroApp.tsx`)

| Panel | 单元 label/文字 | 类型 | 作用 | 触发的 command / message | 状态/校验 |
|---|---|---|---|---|---|
| CreateMacro | Dashboard | button (nav) | 返回 Dashboard | `nav.openDashboard` | — |
| CreateMacro | Name（namespace/name 片段） | text-input（每行一个 chip） | 编辑 macro 名的每个点分片段；Enter/blur 提交 | local state only | edit 模式 readOnly；含 `@#$%\s(){}[]` 或与已有重名报错 |
| CreateMacro | ✎ whole | button | 折叠 chip 视图回单输入框整体编辑 ID | local state only | edit 模式隐藏 |
| CreateMacro | Kind | select | 为 macro 选择 macro kind；含 "+ New macro kind…" 打开创建面板 | `createMacroKind` 或 local | — |
| CreateMacro | Description | text-input | 填写可选描述 | local state only | — |
| CreateMacro | Styles 标签按钮 | tab / button | 切换当前编辑的 style（双击可重命名） | local state only | 唯一 style 时不显示 "−" |
| CreateMacro | ↑ (style) | button | 将该 style 向前移（更接近默认位） | local state only | i=0 时不显示 |
| CreateMacro | − (style) | button | 删除该 style | local state only | 只剩 1 个时隐藏 |
| CreateMacro | + Add style | button | 新增一个 style | local state only | — |
| CreateMacro | Content 标签（katex_template/typst_synthesis/latex_synthesis/text/…） | tab | 切换当前 style 的内容字段 | local state only | KaTeX 模板空时显示 `*` |
| CreateMacro | Mode（inline/block/…） | vertical tab / button | 切换 style 的渲染 mode | `patchStyle {mode}` | — |
| CreateMacro | KaTeX 预览 canvas | preview | 实时渲染当前模板的 SNL 语法树 | 无 | 出错显示 "Preview error: …" |
| CreateMacro | Template (LaTeX) | textarea | 输入 `#0#1…` 占位模板 | local state only | 空时校验 "KaTeX template is required" |
| CreateMacro | Left delimiter / Separator / Right delimiter | text-input | dynamic-arity 下的左/分隔/右分隔符 | local state only | 仅 dynamicArity 时显示 |
| CreateMacro | 其他 content textarea (typst/latex/text) | textarea | 编辑 style 的对应字段 | local state only | — |
| CreateMacro | Synthesis mode (formula/text) | radio | 选择 typst/latex synthesis 模式 | local state only | 仅对应 tab 显示 |
| CreateMacro | Style tags / Macro tags 折叠头 | button | 展开/收起 tags 编辑区 | local state only | — |
| CreateMacro | tag | text-input | 输入 tag（每行一个）；不允许含 `\` | local state only | 含 `\` 边框变红 |
| CreateMacro | − (tag) | button | 删除该 tag | local state only | — |
| CreateMacro | + Add tag | button | 新增 tag | local state only | — |
| CreateMacro | Dynamic Arity | checkbox | 切换动态元数（自动把 template 设为 `#*`） | local state only | — |
| CreateMacro | + Add Arg / − Remove Arg | button | 预览时增/减 variadic 参数槽位 | local state only | 仅 dynamicArity 时；上限 MAX_ARGS |
| CreateMacro | Reset all args | button | 清空所有 preview 参数 | local state only | — |
| CreateMacro | arg N | textarea | 预览时替换 `#N` 的 SNL 源码 | local state only | 解析错时显示 parse error |
| CreateMacro | Render preset | select | block-mode React 渲染器 preset（list/enumerate/table/centered/Custom） | `patchStyle {block_template_name}` | 仅 block mode 显示 |
| CreateMacro | my-renderer-key | text-input | 自定义 renderer key | local state only | 仅 Custom 时显示 |
| CreateMacro | Entries (source) 搜索框 | text-input (autocomplete) | 从 entry pool 选择来源 entry（每行一个） | local state only | 需解析到已存在 entry |
| CreateMacro | − (entry/url) | button | 删除该行 | local state only | — |
| CreateMacro | + Add (entry/url) | button | 新增一行来源 | local state only | — |
| CreateMacro | URLs | text-input | 填写来源 URL（每行一个） | local state only | 非 http 开头显示黄字提示 |
| CreateMacro | Create Macro / Update Macro / Creating…/Updating… | button | 提交创建或更新 macro | `create` / `update {macro}` | 名字空/重复/无效/creating 时禁用 |

### 2.15 SnlGraph — Relationship Graph (`SnlGraphApp.tsx`)

| Panel | 单元 label/文字 | 类型 | 作用 | 触发的 command / message | 状态/校验 |
|---|---|---|---|---|---|
| SnlGraph | ← Infoview | button (nav) | 回到 SNL Infoview | `nav.openInfoview` | — |
| SnlGraph | Graph SVG 画布 | canvas (svg) | 滚轮缩放、拖拽平移图形 | local viewport state | — |
| SnlGraph | 节点（矩形） | canvas node | 悬浮显示 popover；点击选中/取消；Ctrl+Click 打开 Entry Infoview | 选中 local；`openEntryInfoview {entryId}` | — |
| SnlGraph | 边（箭头路径） | canvas edge | 点击进入关系编辑面板 | `editRelationship {id}` | — |
| SnlGraph | ▶/◀ Filters | button | 展开/收起右侧筛选侧栏 | local state only | — |
| SnlGraph | atomic deps only | checkbox | 隐藏非原子（复合）依赖边 | local state only | — |
| SnlGraph | all | button (link) | 显示所有 entry kind | local state only | — |
| SnlGraph | none | button (link) | 隐藏所有 entry kind | local state only | — |
| SnlGraph | (kind 名) | checkbox | 切换该 entry kind 的可见性（每行一个） | local state only | 无 kind 时显示占位提示 |

---

*生成方法：并发扫 15 个 webview.tsx，逐个提取 `<button/input/select/textarea/…>` 并对应 `postMessage({type:...})` 调用。*
