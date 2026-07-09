# AST 中心化重构 — 探索存档（2026-07-09）

> **状态：暂缓决策。** 本文档不是一份 spec，也不是一份 plan。它记录 2026-07-09
> cat（Fulcrum）与 Iroha 讨论 "SNL 是否该换成 XML" 时得到的一系列洞察 ——
> 我们最终判断"暂时不上"，但推理过程有独立价值，值得存档以便将来再拾起时
> 不需要重复推演。
>
> **关键结论**（未生效，仅为方案）：如果未来真做，方向不是简单换 markup 语法，
> 而是**把 AST 提到中心**，storage / concrete syntax / renderer / informalization
> 全部退化成 AST 的 derived 变换。

---

## 触发问题

cat 的原话：

> 我感觉 SNL DSL 的设计也许是画蛇添足，如果借助 XML 或者其他 Markup Language
> 语法来构建 SNL Syntax Tree 会不会更好？

## 讨论演化路径

1. Iroha 先给了保守判断 "不换" —— 从字符密度、sigil 表达力、LLM 熟悉度、
   已付出成本四个角度反对。
2. cat 从三个角度翻案（**这三条是本次讨论的核心 forcing function**）。
3. Iroha 认错，进入 "如何换" 的技术讨论 —— XML schema 形状、storage 关系。
4. cat 再 pivot："这些都是搬砖，真正问题是 SNL Syntax Tree 应该是什么" ——
   把讨论拔到 AST 层。
5. 由此推出一套 AST-first 的设计原则，以及一个 unified `ref` constructor 的
   最终形状。
6. cat 决定 **暂缓** —— "太烦了"，工程量与当前收益不匹配。

---

## 一、cat 翻案的三条理由（决定性论点）

Iroha 最初反对换 XML，理由后来被这三条系统性推翻：

### 1. 字符密度不是瓶颈

- 存储代价不敏感；LLM 输出 token 也不敏感 —— 主要 token 消耗在 agent
  framework 调用 + 思考链，不在最终输出。
- XML/HTML/JSX 在 LLM 训练语料里密度远超 SNL 这种 sigil-heavy DSL。closing
  tag 配对反而是 LLM 最熟的操作。
- 相比之下 SNL 的五种特殊形式（`@` / `[…]` / `%…%` / `$…$` / `$$…$$`）对
  LLM 反而需要 few-shot 才能稳。

### 2. 扩展性是关键

- 未来功能：图片、图表、图标、binder 交互升级、隐式参数显示化、类型注解 ——
  每加一个都要给 SNL 塞新 sigil 或位置约定，parser 长成杂技。
- XML attribute 是天然的 metadata 挂载位，**不侵入 tree 结构**。
- 减少对 magic char 的依赖。

### 3. 时间窗

- 现在生产语料还比较少，migration 几百 entry 一个脚本跑完。
- 等 10k+ entry 之后再改就是**项目**级别的迁移。
- 发现扩展性不好会极大限制未来加功能。

**Iroha 承认三条都成立，第一条角度举错了，第二条最漏算，第三条时间窗判断对。**

---

## 二、cat 的关键 pivot：AST 中心化

在 XML schema / storage 关系两个 fork 上纠结时，cat 说：

> 稍等，我们要仔细思考，理一下 SNL 的 Syntax Tree 应该是一个什么东西，它已经
> 变得有些复杂了。我这么理解：我们首先需要定义一个语法树类型 ...
>
> Parser 本质上是一个 `String -> SNL_Expr` 的同步函数
> 渲染器本质上是一个 `SNL_Expr -> Promise ReactElement` 的异步函数
>
> 如果上述接口能够稳定，我们也可以在 Lean 里写一个 `Expr -> SNL_Expr` 函数，
> 这样 AutoInformalization 也就成了。

**这个 pivot 让所有下游选择退化成 derived：**

| 层 | 是什么 |
|---|---|
| **AST（`SnlExpr`）** | 唯一需要冻结的东西 |
| **Storage** | 选一个 encoder（XML/SNL/JSON 都行，随时可换） |
| **输入** | 选一个 decoder（`SNL-text → SnlExpr` 是其中一种 backup） |
| **Renderer** | interpreter `SnlExpr → ReactElement` |
| **Informalization** | `Lean.Expr → SnlExpr` 的一个 projection function |

**冻结 AST 类型本身 → 其他所有改造都是小任务，各自 well-shaped。**

cat 的初版 sketch：

```lean
inductive SNL_Expr
| macro : Name → List SNL_Expr → SNL_Expr
| bvar  : Name → BinderInfo → SNL_Expr
| katex : String → SNL_Expr
| text  : String → SNL_Expr
| image : ImageSrc → SNL_Expr
```

---

## 三、cat 的第二 pivot：`const` / `rule` / `fvar` 的本质

cat 追问：

> 但是你看，`const` 和 `rule` 都是 kind，但它们都通过 macro 实现。`fvar` 也可以是
> macro，说实话 `const` 和 `rule` 的行为应该是完全相同的，唯一的区别是它们属于
> math language 还是 metamath language。`fvar` 和 `const` 几乎也是完全相同的，
> 实现上就完全没有区别。唯一的区别是有没有 src。
>
> 甚至我们还要考虑一个东西有 src 但是我们通过 xml 临时 override 掉它的写法的
> 需求，以及还没有 src 但它应该不是一个 fvar 的情况。

**关键观察**：`const` / `rule` / `fvar` 这些不是 AST 上的 constructor，而是 **同一种
"name application" 节点 + 三种 env lookup 结果**。区别不在 AST 层。

---

## 四、最终 AST 设计（未生效，方案存档）

```lean
inductive SnlExpr
| ref   : Name → RefStyle → List SnlExpr → SnlExpr
| bvar  : Name → SnlExpr
| text  : String → SnlExpr
| katex : KatexMode → String → SnlExpr
| image : ImageSrc → SnlExpr

structure RefStyle where
  variant  : Option Name        -- foo[bar](x) 里的 bar，命名预设
  override : Option RenderRule  -- 这个 occurrence 的 inline 覆盖

inductive KatexMode | inline | display
```

### `ref` 是纯语法的"名字应用"

- AST 不承诺这个 name 是 const / rule / fvar 中的哪种。
- 分类由 env 查询结果决定。

### Env 变成 tri-state

```lean
inductive RefState
| undefined                                          -- 无条目 → fvar 行为
| declared : (kind : Name) → RefState                -- 有条目、无 src → stub
| defined  : (kind : Name) → (src : SrcId) → RefState  -- 完整
```

**`kind` 是 env 上的数据，不是 AST 上的 constructor。** cat 说的"const vs rule
只是 math language 还是 metamath language"就落在 `kind` 字段。

### 两个 corner case 自然落位

**"有 src 但想 xml override 掉写法"**：

```xml
<ref name="Set.union">
  <override>...inline render rule...</override>
  <ref name="A"/>
  <ref name="B"/>
</ref>
```

env 查到 `defined`，但 `RefStyle.override = some inline` 优先生效。**不需要新
constructor**。

**"没 src 但不该当 fvar"**：AST 层根本区分不出 —— 都是 `ref "foo" _ []`。区分
在 env：

- `undefined` → 无条目 → 当 fvar 渲染（斜体裸名）
- `declared` → 有条目、有 kind、无 src → 有 title、能被 xref、但没 render
  template；渲染就用 name 加 stub 标记

**这个 tri-state 顺手支持 "先声明后填充" 的工作流**：撒一堆 stub 条目占坑，
慢慢补 src。

### `bvar` 为什么还留着（不合并进 `ref`）

**唯一理由：renderer 代码路径彻底不同。**

- `ref` path：env lookup → template apply → 递归 render children
- `bvar` path：不查 env，扫 enclosing scope 找 declaration，做 highlight/link

合并成 `ref name attrs {isBinder}` 会强迫 renderer 每次先 branch on boolean
分派到两条完全不共享代码的路径 —— 那 boolean 本身就是 hidden discriminator，
还不如上升到类型层。

**AST 层的 constructor 数量 = renderer 里需要区分的代码路径数量。** 这是本次
讨论确立的分界原则。

---

## 五、AST 分层原则（本次讨论的最大产出）

**AST 只描述语法结构，不描述 name 的含义。** 三层职责分离：

1. **AST 层**：`ref "Set.union" _ [ref "A" _ [], ref "B" _ []]`
   —— 这里有个 name 引用 `Set.union`，带俩子节点。仅此而已。
2. **Env 层**：`Set.union` 是个 defined const，template 长这样。
3. **Render 层**：查 env 拿 template；如果 AST 上有 override 就优先用 override。

推论：

- 加新 macro → 只动 env
- 加新语法结构 → 才动 AST
- 加新渲染优先级 → 只动 render

**判定新东西要不要加 constructor 的清晰标准**：

> 能不能用 env 表达 → env；
> 能不能用 RefStyle 表达 → RefStyle；
> 否则才加 constructor。

---

## 六、当前 SNL 的语义 bug（顺带发现）

在 AST-first 视角下重看现有 parser，暴露一个混淆：

**当前 parser 输出 `{kind: 'binder', name, children}` 这种 record + discriminator
的 JS 表示，把两件事塞在一起了：**

- "这个节点是哪种" —— 应该是 constructor
- "这个 macro 的 slot 里有 binder" —— 应该是 macro-db 元数据

现在 `@foo(x)` 把**整棵子树**打 `kind='binder'` 是把第二件事冒充成第一件事。

**正确形状（未来重构方向）：**

- `@x` → parse 成 `bvar "x"` leaf constructor
- `Set.sep-typed(@x, T, body)` → parse 成
  `ref "Set.sep-typed" _ [bvar "x", ref "T" _ [], body-expr]`
- **谁提供 scope、哪个 slot 是 binder slot** —— 全部由 macro-db 里
  `Set.sep-typed` 的 template 声明
- semantic pass 遍历 tree，遇到 ref 就查 db 拿 binder slot 位置，把 scope
  传给对应子树的 bvar

**这个混淆在当前生产环境不影响使用**（render 结果正确），但它是"AST 语义
承载 macro-db 责任"的具体体现，未来若做重构，这里必须一起清理。

---

## 七、其他 decision points 的临时结论

讨论过程中提到的次级选择（未确认，仅记录当时倾向）：

| # | 问题 | 临时结论 |
|---|---|---|
| Q3 | katex inline vs display 是否分开 | 分开：`KatexMode` 独立 enum |
| Q4 | fvar 要不要独立 constructor | 不要，用 `ref name _ []` + env undefined 表达 |
| Q5 | metadata（`bindRef` 等）是否进 AST | 不进；pass 产出 `SnlExpr × Annotations` pair |
| Q6 | 未来新节点标准 | 见上文分层原则 |
| Q7 | macro-db 是否 AST 化 | 不化；env 是另一层结构 |

---

## 八、Storage / concrete syntax 选择（如果未来做）

**当时讨论的 fork（暂缓，方案存档）：**

### Fork 1: 如果换 XML，schema 形状

- **A.** macro name 直接当 tag name（`<Set.mem>`）—— 动态 macro 无法 XSD
  预写，`.`/`-` 在 tag name 里让外部工具犯病。
- **B.** 单一 `<macro name="…">` 通吃 —— schema 稳但刷屏。
- **C. 混合（推荐）**：macro 走 `<m name="…">`，特殊节点（text/math/bvar/img/
  figure/xref/typeAnnot）走专有 tag。style/implicit/kind/xref 全走 attribute。
  `<m>` 只 1 字符缓解噪音。
- **D.** namespace（`<snl:macro …>`）—— 没 mixed content 场景，无价值。

### Fork 2: SNL vs XML 的存储关系

- **(a) 完全替换（推荐）**：`entries.json` 只有 `content.xml`。SNL 只作为 UI
  里的"快速打字加速器"，权威表示是 XML。single source of truth。
- **(b)** 双存 `content.xml + content.snl`，mtime 新的赢 —— 双写陷阱、diff
  冲突、同步逻辑复杂。
- **(c)** Discriminated union `content: {format, body}` —— 每次读要 dispatch，
  好处不明。

**注**：在 AST 中心化视角下，Fork 1/2 都退化成 "选一个 encoder"。真正需要冻结
的只是 AST 类型；concrete syntax 是 derived。

---

## 九、为什么暂缓

cat 的原话："算了，暂时决定先不上 XML，太烦了。"

工程量评估（未详细展开，但对话里隐含的规模）：

- Parser 重写：SNL-Basics/src/snl-syntax-tree/parser.ts
- 新 AST 类型定义 + JSON encoder
- Renderer 迁移到 `SnlExpr → ReactElement`
- 若加 XML：encoder + decoder + schema doc
- `entries.json` migration 脚本 + 所有现有 entry 迁移
- `snl-lint-*` CLIs 全部升级到新 AST
- SNL-Agent-Toolkit AGENT.md Part A 重写（覆盖当前所有 5-phase 方法论文档）
- extension UI 改造（editor、infoview、CreateEntryApp 等）
- 灰风等 agent worker 的 prompt / 例子全部更新
- macro-db 迁移（若引入 tri-state env）
- 现有仓库里所有已发布 SNL 内容的迁移（数量待统计）

规模估计：15-20+ bite-sized task，跨 3 个仓库（SNL-Basics / SNL-Doc-Extension /
SNL-Agent-Toolkit）。

**当前不换的合理性**：现有系统能用；语料规模不大，随时可迁移；今天推出的
AST-first 框架是**方向储备**，不是紧急动作。等到：

- 加图片/图表/xref 等新功能真的碰到 SNL parser 的天花板；
- 或语料规模已经膨胀到 migration 变项目；
- 或 informalization pipeline 真的开始跑，需要 `Lean.Expr → SnlExpr` 稳定
  接口 ——

**任一条件成立时**，再回到这份存档接续推进。

---

## 十、未来接续入口

若将来要重启此方向，从这几个点接：

1. **重读第五节（AST 分层原则）** —— 这是本次讨论最大产出，任何后续设计
   都不应违反。
2. **确认第四节的 `SnlExpr` 是否仍适用** —— 若期间已加了其他 SNL 语法特性，
   重新评估 5 个 constructor 是否够。
3. **正式敲定 Q1-Q7** —— 本次只做了临时倾向，未 lock。
4. **决定 storage 形态**（Fork 1/2）—— 现在有了 AST 中心化视角，Fork 1
   等价于选 encoder；Fork 2 需要决定 canonical vs derived。
5. **写正式 spec** —— 落 `.hermes/plans/` 或 `docs/snl-ast-spec.md`，把上述
   决定 lock 住，作为所有施工 plan 的 anchor。
6. **拆施工 plan** —— parser 重写 / encoder / renderer 迁移 / migration
   脚本 / linter 升级 / AGENT.md 重写。每个 bite-sized。

---

## 附录：本次讨论催生的一个 skill 候选

**"用 AST 分层原则做 concrete-syntax 无关的语言设计决策"** —— 通用性够高，
可能值得抽成 skill。核心：

> 面对"要不要换 syntax"的问题，先问"什么应该冻结"—— 如果冻结点是 AST
> 而不是 syntax，那么关于 concrete syntax 的所有讨论都可以推迟到 AST 稳定
> 之后作为 encoder 选择处理，不占用主要设计带宽。

（本次未落成 skill，因为只用了一次；若未来出现第二个类似场景再抽。）
