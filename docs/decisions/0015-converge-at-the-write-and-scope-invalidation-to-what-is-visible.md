# 0015 · 三项裁定：收敛在写期、失效按可见性、状态按语义拆分

- 日期：2026-09-07
- 状态：**已裁定，待实施**（本轮只出决策，产品代码零改动）
- 相关：[`0014`](0014-preference-exemption-turns-restatement-into-accumulation.md)（缺陷登记）、
  [`../research-2026-09-07-preference-convergence-prior-art.md`](../research-2026-09-07-preference-convergence-prior-art.md)（外部理论）、
  [`../audit-2026-09-07-derived-replaces-raw.md`](../audit-2026-09-07-derived-replaces-raw.md)（裁定项 C 全文）、
  [`0007`](0007-injection-budget-container-mismatch.md)、[`0010`](0010-attribution-collapses-the-injectable-set.md)、
  D7–D9、§2.3、§3.4、§4.1

> **口径**：全部读数测于 2026-09-07，主库 `5ed2b4d2`（251 条 active raw），
> 跨 9 库处标注。排序/白名单一律 import 生产常量（ADR 0010 教训 7）。
> 四路 agent 独立审计 + 主 agent 逐项复现，**凡主 agent 未能复现的数字一律标注**。

## 零、本轮最重要的事：三条前提被推翻

**裁定之前先记录被证伪的东西，因为它们都是我自己在前两轮写下的。**

| 我先前的陈述 | 实测 | 出处 |
|---|---|---|
| 「L2 于 09-06T23:09 **首次**触发」 | **第 25 次**。`jobs` 表 25 条 done rebuild，最早 08-31T14:55 | A、C 双组独立指出 |
| 「13 条 superseded preference 是**被收敛掉的偏好**」 | **全是从未 active 的 drop 候选**，存活 11–15 秒，用户从未见过。真正「曾 active 被取代」的 preference = **0 条** | B 组，主 agent 复现 |
| 「修 preference 收敛可解决 rollup 只产 3 块」 | **覆盖率 28.6% → 25.0%，不升反降** | C 组自证伪，主 agent 复现 |

> **第 2 条的杀伤力最大**：ADR 0014 §三花整节论证「13 条全是 `superseded_by IS NULL`，
> 说明是 drop 不是替换」——**那节分析是对的，但我据此类比出的「preference 被收敛后
> 查不到」是错的**，因为那 13 条**从来就没被收敛过**。
> **一个正确的观察，被用在了错误的类比上。**

## 一、裁定项 A：收敛发生在哪一层 → **写期（A4）**

### 裁定：删掉 `reconcile.ts:222` 的 `oldRow.kind !== 'preference'`，并把 §3.4 的规则从「按 kind」改写为「按关系」

**这是净删除**：代码 −1 行判断，prompt 规则 5 条 → 4 条。

```
现行（按 kind，每加一个 kind 就要加一条）：
- fact conflicting … => supersede
- procedure that replaces … => supersede (versioning)
- preference conflicting … => activate BOTH stay；never supersede a preference
改为（按关系，新 kind 自动继承）：
- restates or refines an existing memory  => supersede
- CONTRADICTS an existing preference      => activate，两存
- adds nothing new                        => drop
- otherwise useful and new                => activate
```

### 证据

- **结构性零**：跨 9 库 `preference` 55 行 / `superseded_by` 命中 **0**；
  非 preference 571 行 / 命中 **49**。同一 reconcile、同一批写者。
- **A3（依赖 L2）已证伪**：派生层双轴寿命 n=24、min 22s、**median 63s**、
  p75 17545s、**<60s 12/24**，在线率约 47%。双峰——短峰是会话进行中，长峰是无人使用时。
  **L2 只在没人用 agent 的时候存在。**
- **A2（读期去重）否决**：注入路径**没有 query string**（`fts.ts:45` 明写
  "NO query string exists on that path, so no FTS"），A2 必须新造一个相似度机制，
  装在被设计为无检索的路径上；且「什么算同一条记忆」写期已有一个实现（LLM 判定），
  读期会造第二个更弱的（词面），**必然分歧且读期赢**——违反 D7–D9。
- **顺带修一个未报告缺陷**：`coding` 的 supersede 命中 4/136，因为 prompt 里
  只有 fact/procedure 有 supersede 规则。按关系陈述后自动继承——
  `reconcile.ts:177` 注释自己定的标准（"stated so a new kind inherits one rather
  than needing a branch"）终于兑现。

### 外部佐证

四个独立项目收敛到**三分类**，且都把「复述」与「冲突」分开：

| 项目 | 分类 | 出处 |
|---|---|---|
| MemOS | contradictory / **redundant** / independent | `tree_reorganize_prompts.py:200-203` |
| Graphiti | `duplicate_facts` / `contradicted_facts` 双字段 | `prompts/dedupe_edges.py` |
| Memobase | APPEND / UPDATE / **ABORT** | `prompts/utils.py:15-19` |
| Honcho | 知识更新 / 逻辑推论 / 矛盾 | `dreamer/specialists.py:575-588` |

MemOS 对 `redundant` 的定义直击本例（原文）：

> "**redundant**: The two statements describe essentially the same event or
> information with significant overlap in content and details, conveying the same
> core information (**even if worded differently**)."

且它明确了「何时才保留双方」（原文）：

> "If the contradiction is fundamental and cannot be logically resolved, output
> `<answer>No</answer>`."

> ⭐ **本仓的「只有用户能裁决偏好」对应的正是这个 `No` 分支——它是真实存在的
> 设计选项，但只适用于 fundamental 且不可逻辑消解的冲突，不适用于 redundant。**
> **现行豁免把 `No` 分支的适用范围写成了整个 kind。**

### ✅ 前置阻塞项已解除（这是 B 组推翻我的结论）

ADR 0014 §八和调研文档都写「放宽前须先给 supersede 一条可召回路径」。
**实测：那条路径已经存在。**

- `service.ts:901` 的 `sourceOf` 谓词是 **`m.status != 'tombstone'`**，不是
  `EXCLUDED_STATUSES` —— **superseded 行畅通**；
- 全库 superseded/archived **77 条，带 session evidence 的 77 条（100%）**；
- `pruneConversations` 豁免被引用会话，**24 个会话、12787 行 L0 仍在**，不随时间失效。

**arXiv 2605.12978 要求的是「consolidate without overwriting the evidence」**
——本仓行不删（FTS 索引 70/70 保留）、evidence 不覆写、可查询。**要求已满足。**
而「所有历史版本都要出现在检索结果里」不是论文的要求，**恰恰是 mem0#4956
记录的失效模式**（矛盾条目累积、旧事实被检索到）。

## 二、裁定项 B：被 supersede 的 preference 要不要可召回 → **B1（不加机制）+ B4-a（改假注释）+ B4-b（拆状态）**

### B1：不加召回参数

**否决 B2（加 `includeSuperseded` 参数）与 B3（默认可见排最后）**，理由：

- **路径已存在**（见上）。B2/B3 加的是**第二个实现**；
- **B2 服务的用户群实测为空**：B 类（曾 active 被取代）preference = **0 条**；
- **B3 会把 66 条 A 类（从未 active 的 drop 候选）倒给用户**——那不是「找回被
  收敛的偏好」，是把管线中间垃圾当历史展示；实测仅解禁 superseded 后，
  同一 FTS 查询 preference 命中 1 → 4，其中 3 条是同族改写，
  **ADR 0014 的症状原样搬进 recall**。

### B4-a（必做，纯删除）：`types.ts:164` 的注释是假的

注释写「excluded from **every read surface**」，实测 **12 个读取面里它只管 1 个**
（`fts.ts:290` `queryRecallRows`）；其余 8 个的排除是各自 `status='active'` 的副作用，
与该常量无因果；而 `service.source` / `share` / `forget` **根本不看它**。

**变异验证**：把 `'superseded'` 从 `EXCLUDED_STATUSES` 删掉，**310/310 全绿**
（agent 实测并已还原，`git diff --stat packages/` 为空）。
**一个删掉不会变红的常量，其注释却声称管着每一个读取面。**

> 与本仓 v11 「注释声明的不变量，5 个状态只挡住 1 个」**同型**：
> 那次是 5 分之 1 的**状态**，这次是 12 分之 1 的**读取面**。

### B4-b（建议，真正的结构问题）：`superseded` 承担两种不相干语义

```
A 类 superseded_by IS NULL（candidate 被 drop，从未 active，用户从未见过）
     跨 9 库：coding 17 / fact 28 / preference 15 / procedure 6 = 66 条
B 类 superseded_by NOT NULL（曾 active，被新行取代）
     跨 9 库：coding 4 / fact 29 / procedure 13 = 46 条，preference 0
```

A 类存活 11–15 秒即被 `reconcile.ts:157` 的 `drop` 写成 `superseded`。
**任何针对 superseded 的读取面决策，必然同时打到两个不相干的集合**——B3 的失败正源于此。

**外部佐证：两个独立项目在枚举层面就分开了**

- **Honcho**（`crud/document.py:1342`）：`NOT_DUPLICATE / REPLACED_EXISTING / REJECTED`
  三个枚举值 + 两个独立计数器；
- **MemOS**（`item.py:109`）：`activated / resolving / archived / deleted` 四态，
  `resolving` 专指「正在与冲突/重复的新记忆合并中」。

> **合并两种语义的实际代价**：审计时无法区分「系统拒收了 66 条噪声」（健康）
> 与「66 条有效记忆被误替换」（故障）。**ADR 0014 §三整节篇幅、以及本轮
> A/B 类的反复辨析，都是在为这一个状态值没拆开而付的解释成本。**

## 三、裁定项 C：派生层「完全替代」raw → **C5a（失效按可见性）为主，C2 降级可选**

### C1「完全替代」否决

- 跨 9 库 6 个持层库**闲置 383–1212 tok，无一例外**——结构性后果非本库偶然；
- 「替代」的前提是派生层覆盖被替换集，**实测覆盖率 28.6%**（10/35 行进 rollup）。

### ⭐ 真正的根因不是替代，是 **D9 触发器对可见性完全失明**

```sql
-- 生产库实测（sqlite_master 原文）
CREATE TRIGGER invalidate_derived_insert AFTER INSERT ON memories
  WHEN NEW.derived = 0 BEGIN DELETE FROM memories WHERE derived != 0; …
```

**触发器只看 `derived` 一列**，于是：

- **86.1%** 的 active raw 行（216/251）是 `tool-output`/`subagent`，
  **永远进不了注入包、也永远进不了 rollup**，却每次写入都删掉整层；
- **连 `candidate` 行插入也触发**——一条对所有读路径都不可见的中间状态行，
  删掉了整个派生层；
- **连 `drop`（模型判定候选无价值）也杀层**；
- 一次 extract→reconcile 循环**至少触发两次 D9**，针对同一条逻辑记忆；
- 写入型 job 97 次 vs rebuild 25 次，**删除∶重建 ≈ 4∶1**。

> **删除发生在流水线判断出结果之前，与判断结果无关。**

### 外部佐证：业界正在把宽失效改窄，方向与本仓相反

- **Graphiti [#1657](https://github.com/getzep/graphiti/issues/1657)（已关闭，PR #1658 修复）**，
  标题即 "wipes ALL communities, then rebuilds only the selected groups"，
  原文："a scoped rebuild silently **destroys all other groups' communities** …
  **with no error or log line**"。修复方向：`scope remove_communities to the
  group_ids being rebuilt`。
- **Graphiti #1729/#1728**：`only invalidate edges the new edge could plausibly replace`。
- **Graphiti [#1837](https://github.com/getzep/graphiti/issues/1837)（open）**：反方向代价——
  不失效则摘要撒谎。但提问者接受的方案是 **"invalidated until rebuilt"**，
  **不是立即删除**。
- **两组 GitHub 全站检索 TOTAL = 0**：缓存式「写入即失效摘要」在本领域几乎无人采用。
- **Honcho** 的四重防抖（阈值 + 最小间隔 + 在途去重 + 已排程检查）是维持高在线率的现成模式，
  且它**显式排除派生层自身写入**以防反馈循环（原文注释：
  "would inflate the threshold and create a feedback loop"）——
  **与「候选行不应触发失效」原理同构**（但 agent 如实说明：无人讨论过同一命题）。

### C2/C3/C4 的处置

- **C3（条件替代）否决，零产品效果**：L2 只在 `packetOverflows` 为真后存在，
  而 rollup 不改变 raw 集（实测 raw 集 7132 tok ≫ 1300，**触发条件恒为真**），
  所以「raw 装不下」永远成立。
- **C2（混合注入）降为第三、可选**：它不解决饿死，只是「摘要不完备时原文补位」。
  且朴素版实测**把 6 条已被摘要总结掉的同族 preference 塞回包**——
  把 ADR 0014 的缺陷复制到派生分支。C2′（跳过已被 rollup 消费的行）需要
  「这条 raw 被哪次 rollup 消费过」这一**今天不存在的事实**，加列违反 D7–D9、
  读期重算违反 §4.1 毫秒级 SQL，**须单独出方案**。
- **C4（删掉 L2）部分成立，但不执行**：删除 L2 实测行为差异为负（退回 ADR 0014
  前 10 位 9 条同族；4 个超预算库失去唯一收敛机制）。
  ⚠️ **「4 个」是 2026-09-07 上午的读数，当日第 3 轮实测已是 6 个**——
  用生产 `packetOverflows` 复现 6/9。**该数字被 C4 的否决论证直接引用**，
  更正见 §四·十。（`audit-2026-09-07-derived-replaces-raw.md` 两处同样过期，
  按「只增不改」惯例保留原文，以本节为准。）
  **但 C 组撤回了它自己「L2 收敛了那一族」的价值论证**——
  L2 之所以收敛那一族，正是因为**窗口里几乎只有那一族**；
  **它是被 ADR 0014 的问题喂养的，写期收敛落地后这份功劳会消失而复杂度不会。**
  故 **A4 落地后必须重估 C4**。

### 关于 `ROLLUP_TRANSCRIPT_CHARS=6000`：不调

C 组做了证伪：窗口调到 10000 会使 `exchange 13782 > LLM_MAX_TOKENS 12000`，
**直接复现已被修过三次的截断缺陷**。且窗口只占语料 **21.7%**（6000/27617），
`coding` 中位 1087 字符是 `preference` 的 1.8 倍——**这是容量问题不是重复问题**，
调参数治不了。**正解是按 kind 分层取样（C5b）**，但它会发明第二种排序，需正面论证。

> **外部佐证支持分层**：Memobase 先按 topic 分组、**只压缩超限的组**
> （`organize.py:25-33`，`max_profile_subtopics=15`），组间不争抢配额。
> **在该设计下「9 条偏好复述挤掉其他 34 条」结构性不可能发生。**
> Letta 则对装不下的内容留 **lookup hints**（`summarizer_prompt.py:41`）而非静默丢弃。

## 四、最终方案与落地顺序

**一句话：收敛在写期，失效按可见性，状态按语义拆分——三件事各删一处结构，不新增机制。**

```
第 0 步  B4-a  改掉假注释（1 行，零风险）
第 1 步  C5a   D9 失效条件加上可见性判据           ← 独立于 A4，最便宜、收益最大
第 2 步  A4    删 kind 豁免 + prompt 改按关系陈述   ← 主刀
第 3 步  B4-b  拆开 drop 与 supersede 的状态语义    ← A4 前完成更好（B 类将开始增长）
第 4 步  重估 C4 / C5b / C2                        ← 前三步改变了它们的基线
```

**为什么 C5a 在 A4 之前**：它与写期收敛正交、三行 SQL、且**它改变 A4 的验证基线**
——层只活 47% 时间时去测任何注入侧改动，测的是混合物。

**为什么不先做「注入端按族去重」**（推翻调研文档 §六的排序）：
调研文档当时把它排第一，理由是「零不可逆风险、立即止血」。
**本轮实测推翻了那个前提**：注入路径无 query string，A2 需新造相似度机制；
且 880 闲置源于 **rollup 输入被饿死**，注入端在其下游，**改不了「模型只见过 10 行」**。

## 四·五、实施期的三处更正（2026-09-07 晚，方案审查阶段）

**三条都是本文或我自己先前写错的，按仓库惯例原样留档。**

### 更正 1 ⛔ 我的「删掉 `superseded` 仍 310/310 全绿」是**假绿**

本文 §二 B4-a 引用了这条变异实测。**它是错的，已亲自复现推翻**：

```
删 superseded  → tests 310 / pass 309 / fail 1   ✖ replaces supersedes atomically…
删 dormant     → tests 310 / pass 309 / fail 1   ✖ decay: revival happens in the batch…
删 tombstone   → 310/310 全绿
删 archived    → 310/310 全绿
删 candidate   → 310/310 全绿
```

**正确表述**：5 个状态里 **2 个有测试守护、3 个没有**。

**假绿的成因值得单独记**：`'superseded'` 这个字面量在 `types.ts` 里出现两次——
`MEMORY_STATUSES` 联合类型定义、以及 `EXCLUDED_STATUSES` 数组。
一次全文替换会先命中前者，**导致 TS2322 编译失败**，`npm run verify` 在 `tsc`
阶段就退出，测试**根本没跑**，而输出里没有 `fail` 字样。

> **教训（已进 §六）：变异测试必须先确认变异体能编译、且测试真的执行了**
> ——检查 `tests N` 计数与退出码。**「没变红」与「没跑」在输出上长得很像。**

那 3 个没守护的状态并非过滤失效（探针实测：无过滤时 6 种状态全返回，有过滤时只回 active），
而是各自被第二机制遮蔽：`forget` 同事务清空 title/body 使 FTS 无词可匹配；
`archived` 只在 reconcile 对 `procedure` 的 supersede 写入；`candidate` 正常会被立刻转态。
**遮蔽不是规则**——故 B4-a 追加一个表驱动测试，一次钉住 5 个状态。

### 更正 2 🔴 本文 §四给 C5a 写的 SQL 是**错的**

原文写 `WHEN NEW.derived = RAW AND NEW.status = 'active' AND NEW.provenance IN (…)`。
**UPDATE 触发器用单侧会漏 81 类状态转移**（穷举 6×5 有序转移对实测）：

```
                    want   NEW-only   OLD-only   OLD∪NEW
decay 休眠人类记忆   FIRE     MISS       FIRE       FIRE
forget 删除记忆      FIRE     MISS       FIRE       FIRE
reconcile 采纳候选   FIRE     FIRE       MISS       FIRE
decay 唤醒          FIRE     FIRE       MISS       FIRE
```

- **只看 NEW**（我写的）漏掉 `active/human → dormant|tombstone`
  ⇒ **派生层会继续包含用户刚刚 forget 掉的记忆**；
- **只看 OLD** 漏掉 `candidate/human → active/human`
  ⇒ **正是 v5 注释开头描述的那个原始缺陷**，等于把已修的 bug 装回去。

**正解唯一**：`WHEN OLD.derived = RAW AND (inSourceSet(OLD) OR inSourceSet(NEW))`
——只要该行在这次写入的**前后任一侧**属于源集合，源集合就变了。

并且 `INJECTABLE_PROVENANCE` **不得在 schema.ts 里重写第二遍**：触发器 SQL 会被
`CREATE TRIGGER` **固化进每个库的 `sqlite_master`**，那不是普通代码重复，是
**跨越持久化边界**的重复——改 `types.ts` 永远不会改到已有库。须用本文件既有的
`sqlEnum(INJECTABLE_PROVENANCE)` 插值，与 `fts.ts` 的 `INJECTABLE_LIST` 同源。

### 更正 3 ✅ §五那条「未证伪的阻塞项」已证伪，**不构成阻塞**

- **前半句成立**：`queryRecallRows` 确无 `derived` 过滤，实测生产库 **6/6 派生行会被 recall 返回**
  （且派生行 100% 进 FTS 索引：3e857510 6/6、94394b03 4/4、ec2636fc 5/5、edf7a686 4/4）。
- **后半句被证伪**：随机操作序列 **4800 个状态点、0 违例**，不变式为
  「派生行还活着 ⟹ 其构建时源集合与当前源集合逐字节相同」。
  原因是正确收窄后的触发条件与派生层输入谓词**同构**：源集合一变必失效。
  **寿命变长 ≠ 变陈旧**——被放行的 76.3% 写入根本不进入派生层输入。

> **它是一个独立的产品口径问题**（recall 该不该返回 L2/L3、返回时该不该标注来源），
> 单独立项，不阻塞 C5a。

## 四·六、实施结果（2026-09-07，B4-a + C5a 已落地）

**310/310 → 320/320 全绿。** 走完整五步（方案审查 → 执行 → 代码审查 → 返工 → QA → 返工）。

### 落地内容

```
B4-a  types.ts 假注释改为陈述实情 + 表驱动测试一次钉住 5 个状态
C5a   D9 三条触发器加源集合判据；insert 用 NEW、delete 用 OLD、update 用 OLD ∪ NEW
      INJECTABLE 由 sqlEnum(INJECTABLE_PROVENANCE) 插值，不在 schema.ts 重写字面量
      新增 schema v12 迁移（9 个生产库全部 v11，trigger-only，DROP+CREATE 三条）
```

**真实生产库副本实测**（`5ed2b4d2`，只读复制到 /tmp 后迁移）：

```
v11 → v12，295 行数据无损
tool-output 写入 → 派生层存活、store_revision 不动    ← 新行为
human 写入      → 派生层失效、revision +1              ← 原行为保持
真实管线序列：extract 插 candidate/human 不杀层；reconcile 转 active 杀层
             decay active/human→dormant 杀层；active/tool-output→dormant 不杀层
```

### 三次被下游关卡拦下的错误（都是我或上游 agent 犯的）

1. **代码审查抓出注释造假**：实施把 `76.3%` 写进注释，**而该数已被本仓审计附录亲手作废**
   （正确值 62.9%，且 `481 of 630` 全仓无出处、疑为从百分比倒推）；又把主库读数
   `86.1%` 写成 "nine live stores"（跨 9 库真值 **70.9%，4 个库为 0%**）。
   **本轮全部起因就是一条口径夸大的假注释——用新的夸大替换旧的夸大等于自我否定。**
2. **返工推翻了代码审查的处方**：审查说「参数化 D9/C 即可杀死三个变异」，
   实测只杀掉 N2；**D9/C 的 900 对全由 UPDATE 驱动，结构上碰不到 insert/delete 触发器**。
   真正持有覆盖力的是 **D9/A**（唯一对活层同时发 INSERT/UPDATE/DELETE 的用例）。
   参数化 A 之后 N3/N5 才变红。
3. **QA 抓出 C5a 让自己的对外承诺变成假话**：
   `tools.ts` 的 `memory_forget` **description 发给每一个 agent**，写着
   「layer is dropped whenever that repository is written」——v12 后，
   占 86% 的 tool-output 写入**不再掉层**。`service.ts` 抛给用户的错误文案同样。
   **且三条测试断言正在锁死这两句假话**，任何想改对的人都会先撞红。
   > **这句话当时就在主 agent 自己的 system prompt 里。**

### 最终测试形态（可证伪，非假绿）

```
D9/A 不许漏  随机序列，派生行活着 ⟹ 源集合与构建时逐字节相同   ← 参数化 frozen + live
D9/B 不许滥  active+tool-output 写入后派生层必须仍在           ← 参数化 frozen + live
D9/C         穷举 900 个有序转移对，触发 ⟺ inSet(OLD)|inSet(NEW)，171 对   ← 参数化两份
v11→v12      真实迁移，行为改变 + 10 个触发器齐全 + FTS/外键无损
fencing 表   作业层：job 在调用模型前被 revision 栅栏挡下、烧 0 次 LLM
             （stub 被调用即 fail，比计数器更难写成恒真；另有 control 用例防假绿）
```

**A 与 B 必须成对**——已实测：M4（完全不改）下 **A 保持绿、B 变红**。
过度失效的实现永远不会陈旧，所以 A 单独存在时是假绿。

## 四·七、A4 实施结果（2026-09-07）

**320/320 → 324/324 全绿。** 净删 1 行代码，提示词由**按 kind**改为**按关系**陈述。

### 两条把 A4 重新定性的发现（都推翻了立项时的说法）

1. ⛔ **「preference 永不被 supersede」今天就已经是假话。**
   `service.ts` 的 `propose({replaces})` 的 UPDATE 谓词是
   `WHERE id = ? AND status = 'active' AND derived = RAW`——**没有任何 kind 判断**。
   preference 在那条路径上早已可被 supersede。**所谓不变量只是 reconcile 的局部怪癖**，
   A4 是**消除两条写路径的不一致**，不是放宽一条安全规则。
2. ⛔ **kind 对 supersede 从来就没有约束力。** 跨 9 库实测 49 个真实 supersede 指针中
   **4 个跨 kind**（`procedure → coding` ×3、`procedure → fact` ×1），
   而旧提示词的两条 supersede 条款字面上都是同 kind 闭合的
   （"fact conflicting with an older **fact**"、"**procedure** that replaces an older procedure"），
   `coding` 更是**一次都没被提到**。按 provenance 追查，**4 例全部出自 reconcile 管线**
   （`tool-output`/`parent-agent`），无一来自 `propose({replaces})`（那条独占 `principal-explicit`）。
   > **模型早就在按关系判断了，只是规则文本假装它在按 kind 判断。**
   > A4 之后规则说的和模型做的第一次是同一件事。

### 提示词的两个关键设计

- **判据是可满足性**——「能不能**同时遵守**这两条」，而非语义相似度。
  把相似度问题换成行为可满足性问题，可执行得多。
- **平局倒向 `activate`**——代价不对称：把冲突误判成改写 ⇒ 丢失用户意图（严重）；
  反之只多一条冗余（轻微）。

### 安全论证兑现为可证伪断言

本仓 supersede 是 bitemporal：旧行留存、**内容永不覆写**、`superseded_by` 指向新行、
`sourceOf` 谓词 `status != 'tombstone'` 故可召回。这正是 arXiv 2605.12978 的
"consolidate without overwriting the evidence"。**新增用例把它变成断言**：
被 supersede 的 preference 内容**逐字节相同**、evidence 完好、`sourceOf` 仍返回原文。
实测变异 M3（supersede 时覆写 title/body）**仅**被这条杀死。

### 三条新测试与它们各自独占杀死的变异

```
收敛用例（12 轮复述 → active 恒为 1）   杀 M1 撤销 A4、M2 不写指针、M5 反转棘轮
可恢复性用例（内容逐字节未变）          独占杀 M3 覆写内容
跨 kind 用例（fact supersede procedure） 独占杀 N2 三元读错行
既有 ONE-commit 用例（未删除）          独占杀 M4 永远写 superseded
阴性对照（无关 preference 不受影响）     独占杀 N7 过度收敛
```

⚠️ **`oldRow.kind === 'procedure' ? 'archived' : 'superseded'` 读的是旧行**，这是对的：
`archived`（"旧序列仍描述曾经可行的做法"）描述的是**被退休的那一行**，
取代者是什么 kind 不改变该陈述的真假。**零覆盖的是「读哪一行的 kind」这个维度**
——旧用例全是同 kind 配对，两种读法恰好同值，故 N2 曾在 323/323 全绿下存活。

### ⛔ 两处「注释为假」之外的新形态：断言空转

`layers.test.mjs` 那条 `// Different kind ⇒ not offered (a fact never supersedes a preference)`
不仅注释过期，**该断言当时根本测不到 kind 过滤**——它漏了 `scope: 'personal'`，
两行落在不同的库里，所以**把 kind 过滤整个删掉它依然通过**（已实测）。
> **过期注释往往伴生一条失效断言。只审注释不够。**
> 已补一条 store 固定、只有 kind 不同的断言；实测删掉 kind 过滤即变红。

### 明确不做

**不对跨 kind supersede 加任何约束**（代码或提示词）。A4 的全部要点就是删掉一个按 kind
的判断，删完立刻加回另一个按 kind 的判断是自相矛盾；且跨 kind 在生产中已发生 4 次、
**零已知损害**（4 例旧行全部完好 `archived`、指针有效、可召回）。
**给一个没有实证损害的行为新建守卫，就是「为维持重复而新建的机制」。**

### 🟡 如实记录：提示词侧零防护

实测 **M7**（删掉新提示词的整条冲突规则 + 平局条款）→ **323/323 全绿存活**。
全仓唯一的提示词断言 `assert.equal(seen.system, reconcileSystemPrompt())` 是**自比恒真**。
**未为此添加断言**——那会制造一条钉住当前措辞的新负债，与本次要拆的东西同型。
「真冲突会两存」同样无法由单测证明（stub 就是分类器）。
**这一半的正确性目前只由 code review 与生产观测承担，不伪装成别的东西。**
观测手段免费可得：`superseded_by IS NOT NULL AND kind='preference'` 今天恒为 0，
A4 后若异常飙升即为误判信号。

## 四·八、B4-b 被打回，改做 B4-b′（2026-09-07）

**原方案（新增 `rejected` 状态值拆分 `superseded`）经方案审查打回，主 agent 独立复核确认。**

### ⛔ 决定性证据：新增枚举值会造成静默的 schema 分叉

只往 `MEMORY_STATUSES` 加一个 `'rejected'`、其余一字不改，用**真实生产库副本**实测：

```
BUILD_EXIT=0                                          ← tsc 零信号
EXISTING store (5ed2b4d2 副本) uv=12 → INSERT 'rejected': REFUSED: CHECK constraint failed
FRESH store                    uv=12 → INSERT 'rejected': ACCEPTED
```

**同为 v12，新库接受、9 个存量库拒收。** 落地后存量库的 reconcile 一执行 `drop` 就 CHECK 失败，
而 drop 在 `commitClaimedJob` 的单事务里（D6）⇒ **整批候选连坐回滚 → 烧光重试 → dead-letter**。

根因：SQLite 无法扩宽 CHECK，**每次枚举扩展都是一次 `rebuildMemories` 全表重建**，
而 `evidence.memory_id` 是 `ON DELETE CASCADE`。这是本轮第一个要动 `memories` 表本身的改动——
**与 C5a 的 trigger-only 迁移风险等级完全不同，而原方案一个字都没提这件事。**

> **这是 ADR 0015 教训 6 的精确重演**：「凡是会进 `sqlite_master` 的字符串，
> 都必须从唯一常量插值而来……改 `types.ts` 永远改不到已建库，且没有任何编译期信号」。
> 教训 6 讲的是触发器 SQL，**而 CHECK 是同一持久化边界上更硬的一个**——
> 触发器可 `DROP+CREATE`，CHECK 只能整表重建。

**且存量 66 行改写与 schema 迁移绑死**（新状态写不进旧 CHECK），
所以「改写用户真实记忆库」在这里**无法被单独确认**——这一条本身就足以否掉原形态。

### ✅ 一处正面证据：B4-a 的表驱动测试按设计生效了

加入新状态后实测 `tests 324 / pass 321 / fail 3`，其中
`recall exclusion table` 变红并报出 `+ 'recall-rejected'`——**它遍历 `MEMORY_STATUSES` 建行，
新状态自动入表，而 `EXCLUDED_STATUSES` 没跟上 ⇒ 被拒候选会出现在 recall 结果里。**
B4-a 那条测试的注释写的正是「a status added to the enum with no thought given to recall
lands here as a failure instead of passing unnoticed」——**兑现了。**

⚠️ **但没有任何测试抓住 schema 分叉**：`CHECK constraints enforce the domain enums` 只测
「非法值被拒」，**不测「合法值集合等于枚举」**——唯一能抓住它的那个测试恰好不问那个问题。

### 我的三处事实错误（审查指出，已复核证实）

```
①  B 类 kind 分解：我写 {coding:7, fact:30, procedure:13}
    实测 {coding/superseded:7, fact/superseded:30, procedure/archived:12, procedure/superseded:1}
    ⇒ procedure 那 13 条里 12 条是 archived。B 类今天已被部分拆分过
      （reconcile 的 `procedure ? 'archived' : 'superseded'` 早就做了一半）
②  A 类寿命：我写「11–41 秒」
    实测 min 8.0s / p50 20.3s / max 9318.5s，且 12/66 超过 41 秒
    ⇒ 那个区间是单库单 kind（5ed2b4d2 的 13 条 preference）的读数
③  漏记 propose 路径不写 archived（见下）
```

> ⛔ **第 ② 条是 ADR 0014 开篇明令禁止、ADR 0015 §四·六刚抓过一次的同型错误**
> ——**把单库读数当全样本**。同一轮里第二次犯。

### 改做 B4-b′：零迁移，修掉唯一已证实的真实损害

**实测：全仓需要区分 A/B 类的代码位置只有 1 处**——`metrics.ts` 的 `overturnRate`。
它声明的用途是 `continuous trust (real misjudgements)`，实现却把 66 条
「系统正确拒收噪声」（健康信号）计入了「误判」（故障信号）：

```
5ed2b4d2  now=0.232 → fixed=0.102 (rejected=48)
94394b03  now=0.204 → fixed=0.100 (rejected=17)
TOTAL     now=0.179 → fixed=0.086  虚高 2.08×
（口径：由两个大库主导，4 个库为 0——在有实际管线流量的库上虚高约 2.3 倍，流量小的库不显著）
```

**失败方向最坏：系统 drop 掉越多噪声（越健康），这个「误判率」读数越高。**
一个把健康读成故障的指标比没有指标更危险。

> **主 agent 那次误判是这个缺陷的人类版本**：ADR 0015 §零第 2 条登记的
> 「把 13 条 A 类当成被收敛掉的偏好」，和 `overturnRate` 犯的是同一个错误
> ——**一个发生在人脑里，一个固化在代码里，且代码那个至今每周期输出错误的数。**

**B4-b′ 的形态**：一个具名谓词（`status='superseded' AND superseded_by IS NULL`）单点化 +
修 `overturnRate` + 补成对断言（N1 退回旧实现须变红、N2 谓词判反须变红）+
`drop` 语句上方注释说明它不写指针。**零迁移、零新枚举值、不碰 `memories` 表。**

🟡 **诚实的取舍**：这比 CHECK 约束弱——若有人给 drop 写指针，判别力会消失，
只有 N1/N2 会变红而他可以同时改测试。**比现状强，代价是零迁移。**
schema 层强制应单独立项，且届时应**一次把 `superseded`/`archived`/`rejected` 三态关系定清**，
而不是分两次重建表。

### 🟡 顺带登记（本轮不修）：`propose` 与 `reconcile` 对 archived 不一致

`service.ts` 的 `propose({replaces})` **无条件写 `superseded`**，而 `reconcile.ts` 有
`oldRow.kind === 'procedure' ? 'archived' : 'superseded'`。
**「procedure 被取代记为 archived」这条规则今天有两个实现且不一致**——
实测佐证：生产库那 1 条 `procedure/superseded` 的 B 类行 provenance 正是
`principal-explicit`（propose 独占），其余 12 条 procedure B 类都是 `archived`。

### ⚠️ 顺序结论：即便将来要做枚举拆分，也应排在第 5 步之后

v13 全表重建会在 9 个生产库上执行一次 `DROP TABLE memories`，
而**第 5 步「重估 C4/C5b/C2」依赖的正是这些库的历史数据**。
在重估之前动被测对象，与「C5a 必须在 A4 之前因为它改变验证基线」是同一条道理，方向相反。

## 四·九、⛔ 发布断链：前三轮的改动一次都没有跑起来（2026-09-07 第 3 轮发现）

**在执行第 5 步「重估」之前查实的第一件事，推翻了「已发版」这个说法的含义。**

```
9 个生产库全部 user_version = 11        ← C5a 的 v12 迁移从未生效
已安装插件 = v0.4.17（lib 文件日期 9-05），TARGET_USER_VERSION = 11
安装的 reconcile.js 仍含 kind !== 'preference'   ← 即 pre-A4
GitHub latest release = v0.4.17（附件 9-04）
```

**根因**：`INSTALL.md` 的安装源是 **GitHub release 附件**
（`releases/latest/download/strataloom-dsh-memory.tgz`），而我前三轮只做了
**改 `package.json` 版本号 + commit + push**，**从未打 tag、从未创建 release**。
仓库里明明有 `scripts/release.sh`（含 verify、tarball 内容校验、防重发守卫），我没有调用它。

> ⛔ **「Release 0.5.0」这个 commit 的标题是真话，但它让我误以为发布完成了。**
> 改版本号是**声明**，跑 `release.sh` 才是**交付**。
> 这正是本仓反复强调的「装上了 vs 跑起来了」，而这一次**连「装上了」都没有到达**——
> 停在了「提交了」。

**已补救并验证**（不是只看命令成功）：

```
npm_config_cache=/tmp/npmcache bash scripts/release.sh   → RELEASE_EXIT=0
拉回 latest 附件实测：
  released version: 0.5.2
  TARGET_USER_VERSION = 12          ← C5a 在内
  A4 applied (0 = exemption gone): 0 ← A4 在内
```

> **`npm pack` 会撞上 npm 缓存的 root 权限（EACCES）**，用 `npm_config_cache=/tmp/npmcache`
> 绕开——这是本仓已登记过的做法，属沙箱问题不是 npm 问题。

### 对前三轮全部结论的限定

**生产库里的每一条数据都是 pre-C5a、pre-A4 行为的产物。** 因此：

- C5a 的「派生层寿命从 63 秒延长」**尚未在真实数据上发生过一次**；
- A4 的「新措辞取代旧措辞」**一次都没执行过**；
- 任何基于当前生产库的重估，测的都是**旧行为**。

**这不影响那些改动的正确性**（它们各自有测试与真实库副本上的迁移验证），
但它把「收益已经兑现」降级为「收益已经可交付，尚待运行」。

⚠️ **用户仍需执行 `remove` + `add` 重装并重启 harness**，改动才会在他的库上生效。
`INSTALL.md` 明确写了 plain `add` 是 no-op（pnpm 固定已解析的 URL），必须先 remove。

## 四·十、第 5 步：重估 C4/C5b/C2 的结论（2026-09-07 第 3 轮）

**三项在本轮都不应实施。这是第 5 步的完成，不是它的失败。**

> ⚠️ **全部重估基于反事实模拟**，因为生产库仍在 v11（见 §四·九）——
> 一律 import 生产 `lib/` 的函数与常量（`packetOverflows`、`queryInjectableSet`、
> `packetTokens`），不手写等价物（ADR 0010 教训 7）。
> 自校验：`5ed2b4d2` 可注入 35 行 / 7132 tok，与 C 组原始审计逐字节一致。

### C4（删掉 L2）⛔ 否决，且比当时更坚决

当时的理由是「删了会退回 9 条同族」——**那个理由会被 A4 抵消**。
新的理由抵消不掉：

```
A4 反事实（同 kind token-Jaccard 折叠，4 个阈值 × 2 种幸存者选法 = 8 种组合）
仍触发 rollup 的库 = 6/9，与基线完全相同，无一格改变

上界压力测试（远比 A4 激进）
删光全部 preference ⇒ 6 个超预算库里仍有 5 个超预算
  global 8.35× 预算（可注入集 32/34 是 coding）
  5ed2b4d2 5.49×
```

⭐ **判据：A4 消除的是复述，L2 应对的是体量——不是同一个问题。**
最强证据是那 3 个库（`3e857510` / `ec2636fc` / `edf7a686`）**连一个多行族都不存在**，
纯靠体量超预算，L2 对它们的价值与 preference 复述完全无关。

**C5a 还降低了 L2 的单位成本**：C4 的成本论证分母是「47% 在线率」，
而 v12 把在线率抬高后，同样的复杂度摊到更长在线时间上。**两侧同时朝保留倾斜。**

⚠️ **口径更正（影响 C4 论证本身）**：本文与 C 组审计全文引用的「**4 个**超预算库」
**实测已是 6 个**（主 agent 用生产 `packetOverflows` 独立复现 6/9）。数字变大恰好加强结论。

### C5b（rollup 输入按 kind 分层）🟡 确认为主修，但本轮不做

⭐ **决定性发现：A4 完全没有改变 `kinds_seen`。**

```
                        cov%(A4前→后)    kinds_seen(A4前→后)
5ed2b4d2                28.6% → 25.9%     2/4 → 2/4   ← procedure 3 条、fact 1 条依然一条进不去
94394b03                50.0% → 70.6%     2/3 → 2/3
global                  14.7% → 14.7%     1/2 → 1/2   ← 零多行族，A4 对它零影响
跨 9 库总覆盖率          45.6% → 48.6%     几乎没动
```

**A4 没有吃掉 C5b 的收益**——二者修的不是同一件事：A4 减少**族内重复**，
C5b 修**kind 间的窗口争抢**。`global` 是最干净的证据：零多行族、A4 零影响，
而它的 rollup 只见 5/34 行、只见 1 个 kind。

✅ **不必发明第二种排序**：对已排好序的 packet 按 kind 做**稳定分区后轮转**，
每个 kind 内部**逐字保持 SQL `ORDER BY`**，没有任何一对行被重新比较。
新增的是**配额**（一条分配规则），不是排序——与 Memobase 的
「先按 topic 分组、只压缩超限组」同构。实测该形态把 6 个库的 `kinds_seen` 提到满覆盖。
⚠️ 这是设计论证**不是实测**，落地须按本仓判据做变异验证。

### C2（混合注入）⛔ 从「可选」降级为「两种形态均否决」

⛔ **并且 C 组对 C2 缺陷的归因是错的，已实测证伪。**
C 组说朴素 C2「把 6 条**已被摘要总结掉的同族 preference**塞回包」，
把「同族」写成了机制解释。主 agent 独立复现另外 3 个有活派生层的库：

```
3e857510  C2 塞回 3 行，3 行已被 rollup 吃过 = 100%  kinds {coding:3}
ec2636fc  C2 塞回 5 行，5 行已被吃过        = 100%  kinds {coding:5}
edf7a686  C2 塞回 6 行，6 行已被吃过        = 100%  kinds {coding:6}
（A4 前后逐格相同）
```

**塞回的全是 `coding`，一条 preference 都没有。** 真正的成因是结构性的：

```
rollup 输入 = withinTranscriptBudget(queryInjectableSet(...))  → 有序列表的前缀
C2 raw 填充 = withinBudget(queryInjectableSet(...))            → 同一列表的同一端
⇒ 两个读取器从同一个有序列表的同一端取用，重叠是构造上必然的
```

> ⛔ **这是本轮第四次「单库读数当全样本」，而这次它被固化成了因果解释**
> ——比单纯的数字口径错误更危险：**按那个归因设计的 C2′ 会去修「同族」，
> 而真正要修的是「共用一个顺序的同一端」**，A4 之后前者消失、后者仍在。

🟡 **登记 C2″ 候选（未实现未实测）**：既然重叠源于共用同一端，
用 `withinTranscriptBudget` 的**确定性重放**推出前缀边界即可跳过，
无需 C2′ 所需的「被哪次 rollup 消费过」这一存储事实。
⚠️ 源集合可能已变，重放结果未必等于当时的实际消费——**仅登记，不作为建议**。

### 🟡 一个没有任何地方在测的量

**`kinds_seen` 是比 `coverage%` 更好的尺子**：覆盖率在 `5ed2b4d2` 上 A4 后**下降**却是改善
（喂 9 条同族的 28.6%，不如喂 4 个 kind 的 22.9%），在 `global` 上 14.7% 不变
却掩盖了「1/2 个 kind 永远看不见」。**本轮三项的价值判断，有两项靠这个未被记录的量分出**。

### 何时重评 C5b（唯一值得重评的一项）

三个可证伪的触发条件，任一满足即重评：

1. 生产库 `user_version` 达到 12 **且**运行满一个自然周期；
2. `kind='preference' AND superseded_by IS NOT NULL` 由 0 变正
   （**今天跨 9 库实测 = 0**，符合 pre-A4 预期。这是 §四·七 指定的免费观测手段：
   **A4 跑起来后该值应当上升；长期仍为 0 说明 A4 在生产上没有发生**）；
3. 届时重测 `kinds_seen`：若仍是 2/4、1/2，C5b 立即升为主修；
   **若 A4 意外抬高了它，则本节结论需推翻**。

## 四·十一、重启后的实测更正（2026-09-07，v0.5.2 已真正运行）

**用户已重装并重启：9 库全部迁移到 v12、A4 豁免已从安装的构建中移除。**
本节记录随之而来的更正——**头两处是我自己写错的**。

### ⛔ 更正 1：「B4-c 只能摘分母」是错的，且错因值得记

`docs/STATUS.md` 曾写：B4-c 不可照抄 B4-b′，因为「分子的行**物理上已不存在**，只能摘分母」。

**实测证伪**：C5a 生效后派生行**可以同时活着且已被 recall 命中**
（`queryRecallRows` 的谓词只有 `status NOT IN (EXCLUDED_LIST)`，**不过滤 derived**）。
此时分子含派生行、分母不含 ⇒ 算出**大于 1 的「率」**：

```
fixture: 4 raw active（2 条被召回）+ 3 derived active（3 条被召回，v12 才可达）
shipped    = 0.714
denomOnly  = 1.250   ← 我写的处方，结构上不可能的「率」
bothSides  = 0.500   ← 正解，与 B4-b′ 同形
```

> **错因**：那条处方**写在 v11 数据上**——当时派生层在线率接近 0，
> 「分子的行物理上已不存在」当时为真。**C5a 落地后前提失效，而我没回头复审引用它的论证。**
> **这正是本文教训 8 自己写的失败模式**：「改一条规则后，grep 它的名字，逐条读引用它的论证」。
> **我写下了那条教训，然后在同一份文档里违反了它。**

### ⛔ 更正 2：Honcho 三枚举不是持久化状态，§四·八 的引用有误

本文曾把 Honcho 的 `NOT_DUPLICATE`/`REPLACED_EXISTING`/`REJECTED`
列为「在枚举层面就分开了」的业界先例。**回源核实后不成立**：

```
crud/document.py:1342  class SemanticRejectionResult(Enum)   ← 存在
models.py              grep SemanticRejection → 0 处          ← 不是列
函数签名 -> tuple[SemanticRejectionResult, Document | None]
docstring: "Classify a semantic duplicate without writing."
```

**它是分类器的瞬时返回值，不是状态列。** 落到行上时语义被完全抹平——
`REPLACED_EXISTING` 唯一持久动作是盖 `deleted_at`，后台 reconciler 到期物理删除；
全库读侧一律 `deleted_at IS NULL`，**无任何读路径区别对待「被替换」与「被删除」**。
**用它论证 A/B 类拆分属于类比尚可，但不能用作「业界在存储层区分终态」的证据。**

### ✅ 更正 3：`retrievedRate` 的声明用途已被实现取代，而它自己无人消费

```
唯一消费者：runner.ts 的一条 logger.info —— 无阈值、无持久化、无下游判据
声明用途：metrics.ts 写着 "activeCount / retrievedRate → dormant/decay"
实测：decay 已完整落地（9/9 库各 7 次 done），且它不读这个数——
      decay.ts 直接读 usage 逐行字段，其 active 计数自己写着 AND derived = 0
```

⭐ **真正消费该语义的代码早就把口径写对了；写错的只有那条没人读的日志。**

**并且它零守护**——把 `retrievedRate` 换成**常量 1**：
`BUILD_EXIT=0 / TEST_EXIT=0 / tests 325 / pass 325 / fail 0`。
那条 `assert.equal(m.retrievedRate, 1)` 是假绿——fixture 恰好 1/1，
「正确实现」与「恒返回 1」同值。**这是「没变红」的第四种形态**
（前三种：没跑 / 没执行到 / 自比恒真）。

🔴 **还有一个更深的问题，修口径治不了**：`retrieved` 是**自建库以来累计**的，
`active` 是**当下快照**。**一个累计量除以一个瞬时量，本身就不是「率」。**
实测 9/9 库自派生层诞生以来 recall 调用数 = 0——三个库读出的 0.818/0.762/0.800，
**分子来自 8 月、分母来自 9 月**，是两个互不重叠的时间窗被同一个除法凑在一起。

### 🔴 一个今天无防护的真实数值损害（独立于任何裁定，应尽早补）→ ✅ **已补，见 §四·十三**

把 `overturnRate` 的 `archived` 项从分子分母同时删掉：
`BUILD_EXIT=0 / TEST_EXIT=0 / 325 pass` —— **存活**。
生产上这会让 ~~13~~ **12** 条真实 B 类退休从信任指标里消失，而无人察觉。
（**「13」是本节写错的**，正确是 12；更正与理由见 §四·十三。）

### 🟡 口径更正：不是「5 个库有活派生层」，是 6 个；且只有 2 个是 C5a 的功劳

```
3e857510 建于 09-04 | ec2636fc 09-01 | edf7a686 09-01 | global 09-06   ← 早于 v12
5ed2b4d2 建于 09-07T07:40 | 94394b03 09-07T07:41                        ← v12 后
```
前 4 个是**靠闲置活下来的**（`rawWritesSinceLastRebuild = 0`），不是靠 C5a。
**把 6 个活层整体归功于 C5a 会是又一次口径夸大。**

## 四·十二、v12 运行后的四项裁定（2026-09-07，四路 agent 并行审计）

**全部四项：不做。** 每一项的否决理由都比立项时更强，且有三项**推翻了立项时的论证本身**。

### 裁定一：B4-c（`retrievedRate`）→ **删掉这个指标，不要修它**

```
唯一消费者：runner.ts 一条 logger.info —— 无阈值、无持久化、无下游判据
声明用途：metrics.ts 写 "activeCount / retrievedRate → dormant/decay"
实测：decay 已完整落地（9/9 库各 7 次 done），且不读它——
      decay.ts 直接读 usage 逐行字段，其 active 计数自己写着 AND derived = 0
零守护：换成常量 1 → BUILD_EXIT=0 / TEST_EXIT=0 / 325 pass
```

⭐ **真正消费该语义的代码早就把口径写对了；写错的只有那条没人读的日志。**

🔴 **而且修口径治不了它的根本问题**：`retrieved` 是**自建库以来累计**，`active` 是**当下快照**
——**一个累计量除以一个瞬时量，本身就不是「率」**。实测 9/9 库自派生层诞生以来
recall 调用数 = 0，三个库读出的 0.818/0.762/0.800 **分子来自 8 月、分母来自 9 月**。
**修它只会让一个精确的错误看起来更可信。**

> `metrics.ts` 自己写着判据：*"A number nobody acts on would be noise that still costs a query."*
> `decay.ts` 写着：*"an observable that can only report 0 invites the reader to conclude
> something was checked."* **`retrievedRate` 同时满足这两句所禁止的条件。**

**外部佐证**：15 个业界项目中 **14 个不做这个指标**；唯一做的（`lazypower/continuity`）
其指标已被自己的 issue #77 判定为坏的。graphiti 全仓 `access_count|retrieval_count|
hit_count|last_accessed|usage_count` **0 matches**。

### 裁定二：C5b（rollup 按 kind 分层）→ **不上调优先级，先加观测**

⛔ **我基于「闲置 784 tok」提出的推论被实测反转**，三条独立证据：

1. **`kindsFed` 零方差**：5 个库全是 2，而 scenario 产出从 2 到 6。
   **一个零方差的变量在数学上不可能解释另一个变量的变异。**
   真正与产出量单调相关的是 `fedRows`（10→2, 10→3, 13→4, 14→5, 15→6），
   **而 C5b 不增加行数、多数库反而减少** ⇒ 按此关系外推，C5b 会让产出**更少**。
2. **闲置有一半是结构性的**：`ROLLUP_MAX_SCENARIOS 6 × SCENARIO_MAX_TOKENS 188 = 1128`，
   加 L3 画像 171 才是 1300。**repo 库永远拿不到 L3**（画像只在 global 库），
   故 **≥172 tok 闲置是设计使然**。最好的库已达结构上限的 81%。
3. ⭐ **「C5a 让用户看到更少记忆」不成立，内容判读反转**：

```
94394b03  DERIVED 交付 3 条：Issue Remediation Agent Pipeline / Project Audit and
                            Guard-Check Defects / Design Proposals and Decision Records
          RAW 会交付 10 条：前 6 条里 5 条在复述同一条工作流
5ed2b4d2  RAW 8 行里 7 行是同一条 preference 的不同措辞
          （近重复 Jaccard：raw 分支 0.519/0.534，derived 分支最大 0.092）
```

**C5a 让用户看到的是更少的 token、但更多的不同主题。**
v11 那个「8 行进包」的对照组，实际是「同一条偏好念 7 遍」。**摘要在这里不是损失，是去重。**

**真正该做的是先把它变成可测量的量**：全仓没有任何地方在测
「派生层相对 raw 集的主题覆盖率」，所以「摘要是去重还是丢失」只能靠人读标题判断。
**这比 `kinds_seen` 重要，且只加观测、不改行为。**

### 裁定三：`propose`/`reconcile` 的 `archived` 不一致 → **不单独修，归入未来 v13**

**全仓无消费者**：`archived` 与 `superseded` 在所有读路径上行为**逐条相同**
（都被 `EXCLUDED_STATUSES` 排除、都不进包、`sourceOf` 都能召回）。
唯一「分别读取」的 `metrics.ts` **立刻把两者求和**。

⚠️ **但 (a)「让 propose 也写 archived」是最不该选的**：它把一个无消费者的语义断言
**扩大到第二个写入点**，规则仍是两份。实测该方向**零防护**（改了 325/325 全绿）。

**若必须动，选 (b) 删掉三元**——它是唯一减少概念数的方向。但 ADR 0015 已把它
正确归并为「v13 一次把 `superseded`/`archived`/`rejected` 三态定清」的一半，
**现在单独修 = 把一个已被正确归并的议题拆散**。

**外部佐证**：8 个项目横向对比，**主流是合并甚至无状态**（Graphiti 纯时间戳「只记 WHEN
不记 WHY」；Cognee 单一 `valid_to` 显式合并两种语义）。唯一站得住的反例 MemOS，
**靠的是一条本仓没有的读路径**（`get_all` 让 `archived` 可见而 `deleted` 不可见）。

### 裁定四：存量 preference 清理 → **不清理**

⛔ **我上一轮说的收益「3 条 coding 进包、腾出 125 tokens」被实测证伪两处**：

```
5ed2b4d2 RAW 分支  清理前 8 条 / 1226 tok  →  清理后 6 条 / 1273 tok
=> 条目数 -2（减少），token +47（不降反升）
```
**腾出的位置立刻被更长的 coding 行占满。** 正确表述是「换进 2–3 条 coding，
条目数持平或减少、token 持平略升」，**不是腾出预算**。

⭐ **更致命的一条，推翻了整个提问框架**：我问「派生层缺席时清理有没有收益」，
实测答案是——**不存在「等派生层缺席」这回事，因为清理自己制造缺席**：

```
仅 supersede 1 条 human preference：
5ed2b4d2  derived 2→0, revision 718→719   94394b03  derived 3→0, revision 306→307
14 条待清理中，只有 1 条的 provenance 在 D9 源集合之外（可以安静清掉）
```

**「派生层活着 ⇒ raw 行不进包」是读的性质；「清理 raw 行」是写，
而这个写把「派生层活着」这个前提当场消灭。前提在被使用的那一刻就失效了。**

**且代价随 C5a 上升**：v12 前派生层每天被杀 14–24 次，多杀一次无所谓；
现在每天只被杀 2.4–3.6 次且此刻全部活着——**C5a 让派生层变值钱了，
于是破坏它的代价也变大了。**

**其余理由**：7/9 库无同族可清；A4 已封顶 **94–97%** 的新复述（增长动力学已死，
剩下的是静止残余）；判据在 T=0.20↔0.40 间摆动 3 倍，已找到误合真例
（「授权范围」vs「收尾流程」）。

**外部佐证——本裁定有生产先例**：mem0 v0.2.13 changelog 处理的是**同型事故**
（写路径 bug 污染 `preference`），其官方处置原文：

> "Existing memories written by the previous versions are **not rewritten**. If your
> memories contain preferences you never expressed, **delete them**; the plugin will
> not recreate them."

⭐ **cognee 迁移给出了可用判据**：它敢用一条 SQL 无人确认地清理，是因为其「重复」
判据是 `GROUP BY (user_id, session_id, entry_id)` —— **精确主键相等**，且
**清理与 `CREATE UNIQUE INDEX` 原子落地**。
> **当且仅当「重复」能被确定性主键定义时，才可无人确认地批量清理。**
> **本例的「同族」是语义近似，落在这个判据的反面；且结构上不可能有约束阻止
> 下一条近义 preference 写入——cognee 模式里最关键的那一半，本例无法复制。**

**反面实证**：graphiti #1728 人工抽检 4 条误判 3 条（**75%**）且**静默**
（原文 "silently, with no signal that anything was lost"）；
honcho #728 批量重跑 **300→121 且无任何报错**。
穷尽检索：**8 个仓库无一提供存量重跑去重 CLI**；graphiti `backfill`/`dedupe existing` 搜索 **TOTAL=0**。

### 🔴 唯一现在就该做的事（独立于以上四项裁定）→ ✅ **已做完，见 §四·十三**

把 `overturnRate` 的 `archived` 项从分子分母同时删掉：
`BUILD_EXIT=0 / TEST_EXIT=0 / 325 pass` —— **存活**。
生产上这会让 ~~13~~ **12** 条真实 B 类退休从信任指标里消失，而无人察觉。
**这是本轮唯一防护真实数值损害的缺口。**
（**「13」是本节写错的**，正确是 12；更正与理由见 §四·十三。）

### ⚠️ 本轮的纪律事故（如实登记）

1. 一个 agent 的变异实验**污染了真实仓库**（`metrics.ts` 被改一行），
   它按纪律逐步 `git status` 才发现并复原。**根因未能确定。**
   **教训：变异实验即使已复制到 /tmp，仍必须在每步后对真实仓库 `git status`
   ——「我 cd 到 /tmp 了」这个推理不足以保证隔离。**
2. 一个子代理**把调研报告写进了仓库**（`docs/prior-art-memory-backfill.md`），
   派它的 agent 未在 prompt 中禁止写仓库。已保全内容后删除。
3. 一个子代理把 MemOS #1789 的归因说反了（称「批量 UPDATE 被删掉」，
   原文是「移出事务、分块执行」），且**尺度不匹配**：事故阈值 687MB/98000 行，
   本例最大库 18MB/353 行，**小 2 个数量级**。已剔除，不作为裁定依据。
   **这是「真实案例套用到尺度不匹配场景」——本会话反复出现的同型错误。**

## 四·十三、补上 `archived` 的防护（2026-09-07 第 4 轮，五步流程）

**§四·十二 列的「唯一现在就该做的事」已做完。产品逻辑零改动**——一条测试 + 三处注释，仍为 v0.5.2，不发版。

### 做了什么

新测试 `overturnRate counts an archived procedure as an overturn, not as a row that vanished`
（`test/layers.test.mjs`），**与 B4-b′ 那条测试并列而不合并**：那条的 fixture 是 0 archived，
**无论怎么加断言都看不见这一项**，而它的 `0.333` 是被 `metrics.ts` 与 `reconcile.ts` 两处注释
按名字引用的载荷，就地扩宽会同时移动那个数并使两处产品注释变成假话。

fixture 由**两次真实 `runReconcileJob`** 产出（不是手写 INSERT 造被测种群）：

```
阶段一  active=3 / superseded=4 / archived=1 / rejected=3  → 0.4
阶段二  再退休一条 procedure → 4/4/2/3                      → 0.429（上升）
```

**七个竞争公式给出七个互不相同的数**：

```
0.4    正确                                (4+1-3)/(3+4+1-3)
0.25   archived 从分子分母同删  ← 本次要防的那个变异
0.2    archived 只留分母
0.5    archived 只留分子
0.625  旧混同式（不减 rejected）
0.571  谓词判反（superseded_by IS NOT NULL）
0.333  分母把 active 误写成 superseded
```

其中 **6 个已实跑验证变红**（0.625 仅算术）。⭐ **主变异 V1 在改动前跑出的正是未动的基线
`327/320/6`——它此前确实完全不可见**，新测试是唯一能抓住它的东西。

### ⭐ 方案审查捕到一个立项时没看出来的盲点

我最初的 fixture 只放 2 条 drop 候选，于是 `active == superseded == 3`，
**「分母把 `active` 误写成 `superseded`」这个 copy-paste 型变异读出同一个 0.4、不会变红**。
第三条 drop 候选 `c-dup3` 就是为打破这个等值而存在的，测试头注写明了「不要把它简化掉」。

> **这与 B4-b′ 立项时的教训同型**：一个 fixture 上「正确值」与「错误值」偶然相等，
> 就是「没变红」的又一种形态——前四种是**没跑 / 没执行到 / 自比恒真 / 区间断言两边都在带内**。

**性质断言同样有一处隐藏依赖**，已写进注释：第二阶段必须走真实 `runReconcileJob`，
因为 `activate.run` 使 `archived+1` 必然伴随 `active+1`；若改成手写 UPDATE 把一条 active 翻成
archived 而不新增 active 行，**变异下读数也会上升（0.25→0.333），性质断言被满足、判别力归零**。

### 🔴 本轮更正 ADR 自己的一个读数：13 → 12

§四·十二 与 §四·八 前的那节都写「删掉 `archived` 项会让 **13** 条真实 B 类退休消失」。**正确是 12。**

删掉该项丢掉的恰好是 `status='archived'` 的行 —— 实测九库共 **12** 条。
第 13 条是 `propose` 写出的那条 `procedure/superseded`，
**状态是 `superseded`，删掉 archived 项它不受任何影响**。

> ⚠️ **「13」与本 ADR §四·八 更正 ① 直接矛盾**——那条更正的原话正是
> 「把 B 类 `procedure:13` 写成全是 `superseded`，实测 12 条是 `archived`」。
> **一个已被本文件更正过的读数，在本文件另一节里活了下来，还差点被照抄进产品代码。**
> 执行者写的第一版注释就是「13 real retirements」，**主 agent 与代码审查各自独立查出同一处**。

**处置**：代码里**不再独立复述这个数字**，而是锚定到 `metrics.ts` 已有的那次测量
（`38 superseded + 12 archived`），使两处不可能各自漂移。

### ⚠️ 另一处被审查挡下的注释错误：错的枚举比没有枚举更糟

返工前的注释把本机基线的六条平台性失败**枚举成了五条**，
且把 layers 那条清扫钩子的级联来源归给了 symlink（**实际来源是被漏写的 `share projection` 那条**，
而 symlink 那条根本不泄漏 temp root）。**已删掉整份枚举**，改为只声明
「基线含六条平台性失败、与本改动无关、跑一次未改动的套件即可自查」——
那份清单本就是 Windows 特有的，**Linux 读者对着它必然对不上号**。

### 🟡 口径：本机拿不到全绿基线

```
Windows 基线 327/320/6 (+1 skipped)  →  改动后 328/321/6
6 条全是平台性：symlink EPERM / 并发开库 / 不可用库 / share projection / 两条清扫钩子级联
```

所以两处产品注释一律用 **「BASELINE + 2」增量表述**，不写「其余 N 条全绿」——
`reconcile.ts` 原有的「the other 324 green」在本机**无法复现也无法证伪**。
连跑四次无抖动，`layers.test.mjs` 单文件跑亦通过。

### ✅ 本轮纪律：三起事故一起未复发

QA 指出**规程本身有一个会造成破坏的缺陷**：本仓工作区的 index 等于 HEAD（三个文件都是未暂存的 ` M`），
所以变异后用 `git checkout -- <file>` 复原**会连被测改动一起擦掉**，而不只是擦掉变异。
QA 改用逐字节 `cp` 备份 + 全量 sha256 清单校验，9 次复原全部验证 `byte-identical`。
**「用 git 复原」这个直觉在「被测改动本身尚未提交」时是错的。**


## 五、遗留与限定
- 🟡 **C5a 收益无法从历史数据反推**：`memories` 不存历史 status，C 组的近似算出
  105.2% 的荒谬值，**该读数已作废**。其 76.3% → 62.9% 的自我更正同样只是估计。
- 🟡 **本轮所有优化都在一个被归因掏空 86.1% 的集合上进行**（ADR 0010 未修）。
  **不要拿「注入包终于填满了」当作记忆系统健康的证据。**
- 🟡 **存量清理是独立第二件事**：主库 34 条 preference（9 条 active 同族，
  独占 1350 tok，超过整个正文预算）不会被 A4 追溯收敛。
  **会改写用户真实记忆库，须单独出方案并经用户确认**（ADR 0010 §六先例）。
- 🟡 **测试会红**：`reconcile.ts` 的 `kind !== 'preference'` 分支有单测
  （`pipeline.test.mjs` 的 `assert.equal(status('old-pref'), 'active') // both stay`）。
  **它钉的是当前实现形状**，按本仓判据处置——已用两步判据实测闭合：
  **抽掉它杀伤力不下降**（其余变异 N3/N4/N5 照常变红），
  **而装上正当修复时它以红拒绝修复**（A4 应用后该用例 40/41 失败）。
  ⛔ **这里原写「prompt 测试锁定 never supersede a preference」——该句为假，已证伪**：
  删掉整条提示词规则仍 320/320 全绿；唯一的提示词断言
  `assert.equal(seen.system, reconcileSystemPrompt())` 是**自比恒真**。
  **提示词那一半零防护**，详见 ADR 0014 §七的更正。
- ⚠️ **清单勘误（务必记下）**：Awesome-Agent-Memory 第 9 条 Letta 指向的
  `letta-ai/letta` **现仅为落地页**（README 原文："This repository now serves as
  a landing page"），源码在 `letta-ai/letta-code`。且 `MemTensor/MemOS` 与
  `BAI-LAB/MemoryOS` 是**两个不同项目**，勿混淆。
  加上先前发现的 Lians 条目描述不符——**该清单的条目描述不可直接引用，须核对源仓库。**

## 六、教训

1. **一个正确的观察，可以被用在错误的类比上。** ADR 0014 §三正确地论证了
   「13 条全是 `superseded_by IS NULL`」，我却据此类比出「preference 被收敛后
   查不到」——**而那 13 条从来就没被收敛过**。观察为真、推论为假，
   中间隔着一个没有验证的等价假设。
2. **「先修 X 再修 Y」的顺序论证，其前提往往比结论更脆弱。** 调研文档把
   「注入端去重」排第一，论证很完整，但它依赖「读期改动零风险且有效」——
   实测两条都不成立。**顺序结论应当在每次拿到新数据后重排，而不是继承。**
3. **失效条件写在数据的哪一列上，决定了它误伤多少东西。** D9 写在 `derived` 列上，
   于是 86.1% 永不进包的行、以及所有不可见的 candidate 行，都在删这一层。
   **一个触发器的选择性，等于它 WHEN 子句里出现的那些列所携带的全部语义。**
4. **一个删掉不会变红的常量，不要相信它的注释。** `EXCLUDED_STATUSES` 声称
   管着每一个读取面，实测管 1 个，删掉后 310/310 全绿。
   **注释描述的是意图，测试描述的是现实，二者之间没有自动同步。**
5. ⛔ **「没变红」与「没跑」在输出上长得很像。** 我那条「删掉 `superseded`
   仍 310/310 全绿」是假绿——字面量在同文件出现两次，全文替换先命中类型定义，
   `tsc` 阶段就失败，测试根本没执行，而输出里没有 `fail` 字样。
   **变异测试的第一步不是看红绿，是确认变异体编译通过、且 `tests N` 计数真的动了。**
   一个自称做过变异验证的结论，若没有报告计数与退出码，等于没做。
6. **触发器的 SQL 会被固化进每个库，它不是普通代码。** 在 `schema.ts` 里硬编码
   一份 `INJECTABLE_PROVENANCE`，不是「一条规则两个实现」那么简单——它是
   **跨越持久化边界**的重复：改 `types.ts` 永远改不到已建库，且没有任何编译期信号。
   **凡是会进 `sqlite_master` 的字符串，都必须从唯一常量插值而来。**
7. **UPDATE 触发器的 OLD/NEW 是一个双向问题，直觉只会想到一半。** 我写 NEW-only
   时想的是「新写入的行是否值得失效」，完全没想到「**离开**源集合的行同样改变了源集合」
   ——而那一半恰好包含 `forget`。**判据不是「这行现在是什么」，是「它在这次写入
   前后任一侧是否属于源集合」。**
8. ⛔ **一次规则改动，必须回头审计引用该规则的每一条论证。** C5a 改的是触发条件，
   却让 **6 处论证的前提变假**：两条是**对外承诺**（`memory_forget` 的 description
   发给每个 agent、`forget` 抛给用户的错误文案），一条是**可达性论证**
   （`service.ts` 用「这是 raw 写入所以 D9 已清层」推出某分支不可达）。
   **最危险的不是措辞过期，是论证的地基被抽走而结论侥幸不变**——
   下一次重排两条语句，缺陷就静默回来了。
   **判据：改一条规则后，grep 它的名字，逐条读引用它的论证。**
9. ⛔ **测试会为假话背书。** 那两句假承诺各有断言锁死（`/dropped whenever that
   repository is written/`），意味着**任何想改对的人都会先撞红**。
   本仓反复讲「规则写对了 ≠ 规则生效」，这是它的镜像：
   **规则改了、承诺没改，而测试正在保护旧承诺。**
10. **覆盖力要按「它能发出哪种语句」来判断，不是按「它有多严格」。**
   D9/C 有 900 个精确断言，看起来最强，却对 insert/delete 触发器零覆盖——
   因为它的 900 对**全部由 UPDATE 驱动**。而看起来最粗的随机游走 D9/A，
   是唯一同时发 INSERT/UPDATE/DELETE 的用例。
   **一个断言的覆盖面 = 它实际执行的语句种类，与它的精确度无关。**
11. ⛔ **「没变红」的第三种形态：没人在看。** 前两次是**没跑**（变异导致 tsc 失败、
    测试根本没执行）与**没执行到**（随机游走退化，断言对着空集合空转）。
    这次是**断言存在、会跑、永远为真**——`assert.equal(seen.system, reconcileSystemPrompt())`
    把函数和它自己比。**我在两篇 ADR 里据此写过「提示词规则被测试锁定」，是假的。**
12. ⛔ **过期注释往往伴生一条失效断言。** `// a fact never supersedes a preference`
    不仅描述已被推翻的语义，**它所在的那条断言当时也测不到自己声称的东西**
    （漏了 `scope`，两行不在同一个库，删掉 kind 过滤依然通过）。
    **只把注释改准确，会得到「注释正确、断言依然空转」——恰是要根除的那类问题换个形式留下。**
13. **一条规则「有约束力」与「被写下来」是两回事，可以用数据分辨。** 旧提示词的
    kind 措辞被模型越过了 4 次（4/49 ≈ 8%），而 `preference` 那条禁令一次都没被越过
    ——因为**只有它有代码兜底**。**同一份文档里的两条规则，一条是法律一条是建议，
    区别不在措辞而在有没有执行点。**
14. ⛔ **改版本号是声明，跑发布脚本才是交付——而 commit 标题会让人以为两者是一回事。**
    连发三个「Release 0.x.y」commit，`git push` 全部成功，而**用户机器上跑的一直是三个版本之前的构建**：
    安装源是 GitHub release 附件，我从未打 tag、从未 `gh release create`。
    **判据不是「我做了发布这一步吗」，是「拉一次安装 URL 回来，里面有没有这次的改动」。**
    本轮补发后立刻做了这件事（拉回附件、验 `TARGET_USER_VERSION` 与 A4 是否在内），才算完。
15. **「已发版」不等于「已生效」，中间还隔着重装与重启。** 生产库 9 个全部停在 v11，
    意味着前三轮的每一个收益数字，在真实数据上**一次都没有发生过**。
    这不推翻改动的正确性（各有测试与真实库副本的迁移验证），
    但它把「收益已兑现」降级为「收益可交付、尚待运行」——**报告时必须说成后者。**
16. **让审计者去证伪自己的推荐方案，比让他论证它更有价值。** 本轮 C 组自行推翻了
   「写期收敛能修好 rollup 覆盖率」（28.6% → 25.0%）和自己 13.4 个百分点的收益估计，
   A 组和 B 组各推翻了主 agent 的一条前提。**四份报告里最有用的部分，
   全都是「我原来说错了」那几段。**
