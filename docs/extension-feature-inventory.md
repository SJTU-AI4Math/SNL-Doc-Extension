# SNL-Doc-Extension 功能列表

来源：`package.json` `contributes.commands` (32 项)。全部命令 ID 前缀 `snlDoc.`，Command Palette 标题前缀 `SNL: `。

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

**分类小计：** 概览 6，关系图 3，搜索 1，初始化 3，创建 7，编辑 7，删除 6。**合计 33。**

（Command Palette 里对某些 edit/delete 加了 `when` 过滤，实际暴露 11 条；其余通过 Dashboard / Infoview 按钮触发。）

---

## 2. Panel UI 单元表（待补）

> ⏳ 15 个 webview 面板（14100 行 tsx）。等猫猫定完列名后一次扫。
