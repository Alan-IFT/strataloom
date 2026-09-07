# 调研 · preference 收敛问题的既有理论与开源实现（ADR 0014 前置）

- 日期：2026-09-07
- 目的：为 [ADR 0014](decisions/0014-preference-exemption-turns-restatement-into-accumulation.md) 的修法评审提供外部依据
- 检索起点：[TeleAI-UAGI/Awesome-Agent-Memory](https://github.com/TeleAI-UAGI/Awesome-Agent-Memory)（README 105KB 全文检索）
- 状态：**调研结论，未实施**

> **口径说明**：本文引用的论文数据来自公开摘要/综述页，**未复现实验**；
> 开源项目的行为以**源码或 issue 原文**为准，凡属产品页宣传措辞一律标注。
> 与 ADR 0010 教训 7 同理：**引证要读原文，不读转述**。

## 一、结论先说

**这个问题在领域内有名字、有实证、也有成熟解法，且——最关键的——
本仓上一轮拟定的「主刀修法」（放宽豁免、允许覆写）已被外部实证证明是有风险的那条路。**

三条可直接采用的结论：

1. **「同义改写 vs 语义冲突」的二分是对的**，Mem0 的四元操作集印证了它，且它比本仓
   现行的二元选项多出的正是我们缺的那个动作。
2. ⛔ **但「覆写旧条目」不是安全的默认**——arXiv 2605.12978 与 Mem0 v3 的**双向**
   实证表明，覆写和不覆写各有其失效模式，**领域至今没有免费的正解**。
3. ✅ **两种失效模式的公共解是 bitemporal supersession**：**逻辑上收敛、物理上保留**。
   这与本仓 schema 已有的 `superseded_by` 完全同构——**我们已经有了这个机制，
   只是 preference 被排除在外**。

## 二、Mem0：四元操作集，正是我们缺的那个动作

[Mem0](https://github.com/mem0ai/mem0)（清单 #2）的 `DEFAULT_UPDATE_MEMORY_PROMPT`
（`mem0/configs/prompts.py:176`，本轮读的是源码不是文档）定义**四个**操作：

```
ADD    — 新信息，落新行
UPDATE — 已有条目的更新/细化      ← 本仓缺的正是这个
DELETE — 已有条目被否定
NONE   — 已存在或无关，不动        ← 注意：不动的是「新事实」，不是「旧条目」
```

**它对「偏好细化」的处置与我们的诉求完全一致**（源码内置示例，`prompts.py:236`）：

```
旧: "I really like cheese pizza"     新事实: "Loves chicken pizza"
⇒  event: UPDATE, text: "Loves cheese and chicken pizza"
    old_memory: "I really like cheese pizza"
```

**对照本仓**：同样的输入，reconcile 只能选 `drop`（丢掉新事实，旧措辞留存）或
`activate`（并列两条）。**Mem0 的 UPDATE 正是 ADR 0014 §三所说「不存在的第三个选项」。**

> **但请注意 `NONE` 的语义**：它是「新事实已被覆盖，不写入」，即**丢弃新的**——
> 与本仓的 `drop` 同形。**所以本仓的两个选项是 Mem0 四个里的两个**，
> 缺的是 UPDATE 与 DELETE。**这不是实现深浅之别，是动作集不完备。**

## 三、⛔ 决定性反证：覆写会把「有用的记忆」改坏

**这一节推翻了本仓上一轮拟定的主刀方向，必须先读。**

### 3.1 论文：[Useful Memories Become Faulty When Continuously Updated by LLMs](https://arxiv.org/abs/2605.12978)（arXiv 2605.12978，2026-05）

该文正在本仓检索的清单中（`README.md:1519`）。核心发现（摘要原文转述）：

- **记忆效用先升后降，甚至跌破「无记忆」基线**——持续 consolidation 是有害的；
- **即使从 ground-truth 解法出发**，GPT-5.4 在一组它**先前无记忆就已解出**的
  ARC-AGI 问题上，**因记忆而失败 54%**；
- 退化被定位在 **consolidation 这一步本身**，而非底层经验：
  **同一批轨迹在不同更新调度下产出质地不同的记忆**；
- **「一串近义重复」会使记忆过拟合到已见实例**——**这正是本仓 preference 的输入形状**；
- 仅保留原始 episode 的对照组，**竞争力不输**给各种 consolidator；
- 结论建议：**把原始 episode 当作一等证据，并显式 gate consolidation，
  而不是每次交互后都触发**。

> 末句尤其贴合本仓：*"reliable agentic memory will require LLMs that can consolidate
> **without overwriting the evidence they depend on**."*

**对本仓的直接含义**：ADR 0014 §八修法 1 若实现为「新条目覆写旧条目」，
**正是该文测出会退化的那个操作**。而本仓 preference 的输入恰恰是**近义重复流**
——论文点名的最坏输入形状。

### 3.2 反向实证：Mem0 v3 退回 ADD-only，随即出现相反的缺陷

Mem0 v3 新增了 `ADDITIVE_EXTRACTION_PROMPT`（`prompts.py:464`），
**明确放弃 UPDATE，只做 ADD + 链接**：

```
"Your sole operation is ADD"
"When a new memory is related to an Existing Memory — same topic, overlapping
 entities, updated/shifted preference … include the Existing Memory's ID in
 the new memory's linked_memory_ids array"
```

即：**用「关联」代替「覆写」**，收敛推迟到读取期。

**然后另一端的缺陷出现了**——[mem0#4956](https://github.com/mem0ai/mem0/issues/4956)
（2026-04-24 提交，**截至本次检索仍 open**）：

> *"the extraction pipeline is single-pass ADD-only — add() no longer emits
> UPDATE / DELETE events. For facts representing a mutable state … contradictory
> memories accumulate over time instead of the newer fact superseding the older one."*
>
> 场景：三个月前「I work at Company A」，今天「I now work at Company B」，
> **两条共存**；检索时因**打分不含 recency**，Company A 仍可能排在前面。

**这与本仓的症状是同一个形状**：只增不减 + 排序不含收敛信号 ⇒ 旧措辞长期占位。

### 3.3 两份材料合起来读，才是真正的结论

```
覆写（UPDATE）  → 2605.12978：记忆被改坏，效用跌破无记忆基线
不覆写（ADD-only）→ mem0#4956：矛盾条目累积，旧事实被检索到
```

⛔ **所以「加上 UPDATE 就好了」是错的，「保持 ADD-only」也是错的。**
**这两条路本仓各走过一半**：我们在 preference 上是 ADD-only（撞上 #4956 的形状），
在其他 kind 上是 UPDATE（尚未测量是否撞上 2605.12978 的形状——**这是一个未知，
不是一个「我们没问题」**）。

> **这一节修正了我上一轮的判断。** ADR 0014 §八写「主刀是放宽豁免」，
> 那时我把风险表述为「模型可能误判冲突」——**外部实证表明风险比这更基本**：
> 即使判断正确，**反复 consolidation 本身**就会劣化记忆。风险不在误判率，在操作语义。

## 四、✅ 公共解：bitemporal supersession——逻辑收敛，物理保留

跳出「覆写 vs 不覆写」的二分，领域给出的第三条路是：
**让新条目在逻辑上取代旧条目，但物理上一行都不删。**

### 4.1 清单中采用该形状的项目

| 项目 | 清单描述（原文） |
|---|---|
| [Zep / Graphiti](https://github.com/getzep/graphiti)（#4） | _Real-time temporal knowledge graphs for AI agents._ |
| [kgai](https://github.com/kgaidev/kgai)（#80） | _immutable knowledge graph of engineering decisions; **superseded decisions and rejected approaches stay queryable**_ |
| [inspeximus](https://github.com/DanceNitra/inspeximus)（#72） | _**keyed supersession**, revert-based correction, signed provenance_ |
| [memgres](https://github.com/mozgsml/memgres)（#82） | _Versioned document memory; **diff-based history, git-blame line attribution**_ |
| [Lians](https://github.com/Lians-ai/Lians)（#68） | _**Bitemporal** agent memory with **deterministic supersession**, point-in-time recall_ |

> ⚠️ **一处出入，如实记录**：Lians 仓库的 GitHub 实际描述是
> *"Evidence-backed proof of done for Claude Code…"*（10 stars，未归档），
> **与清单里的记忆系统措辞不一致**。**故本文不把它当作依据**，仅列出供人工核对。
> 其余项目未逐一验源码，**它们在此仅作为「该形状被广泛采用」的证据，
> 不作为实现细节的依据**。

### 4.2 为什么它同时解掉两端

```
对 2605.12978：旧证据从未被覆写 ⇒ 「without overwriting the evidence」成立
对 mem0#4956 ：读路径只看未被取代的行 ⇒ 矛盾条目不会浮现
```

**代价是读路径必须带一个「有效性」谓词**，而不是无条件读全表。

### 4.3 ⭐ 关键发现：本仓已经实现了这个机制，只是 preference 被排除在外

```sql
-- 本仓 schema 既有字段
status         -- 'active' / 'superseded' / 'archived' / …
superseded_by  -- 指向取代它的那一行
```

`reconcile.ts` 对 `procedure` 的处置**已经就是** bitemporal supersession
（源码注释原文）：

> *superseding a procedure is versioning — the old sequence still describes
> what used to work*

**即：本仓不需要引入新机制，只需要把 preference 纳入既有机制。**
ADR 0014 §二那句 `oldRow.kind !== 'preference'` 就是把它排除在外的那一行。

**这显著改变了修法的风险评估**：

- 原以为要「引入覆写能力」⇒ 撞上 2605.12978；
- **实际是「把既有的非破坏性收敛扩展到一个 kind」** ⇒ 旧行以 `superseded`
  留存、`superseded_by` 可回溯，**证据从未被覆写**。

> ⚠️ **但有一个前提必须先验证，不可假设**：`superseded` 状态在本仓属于
> `EXCLUDED_STATUSES`（`types.ts:165`），**被排除出每一个读取面**。
> 所以它对「注入不再重复」是充分的，**但对「用户能否找回被收敛掉的偏好」是不够的**
> ——`memory_recall` 也读不到它。**若采用此修法，必须同时决定：
> 被 supersede 的 preference 是否需要一条可召回的路径。**
> 这正是 ADR 0014 §八所要求的「不可逆性兜底」，**领域实践给出的答案是
> 「stay queryable」（kgai）/「point-in-time recall」（Lians）——即需要。**

## 五、另一条正交且低风险的路：显式 gate + 读期收敛

2605.12978 的第二条建议是 **"gate consolidation explicitly rather than firing it
after every interaction"**。

本仓现状恰恰是**每次会话都触发** extract → reconcile，实测 **3.11 条 preference/天**
（ADR 0014 §三）。**这本身就是论文点名的「fire after every interaction」。**

与之配套的是 **Mem0 v3 的 `linked_memory_ids` 思路**：写期只做关联，
**把收敛推迟到读期**。映射到本仓即 ADR 0014 §八修法 2「注入端按族去重」：

```
写期：照旧只增（无覆写风险，2605.12978 不适用）
读期：同族只取最新一条进注入包（症状立即消失）
```

**这条路的性质与主修法不同，值得单列**：

- ✅ **不改写任何历史数据**，因此**没有不可逆风险**；
- ✅ 直接命中 ADR 0014 §一的实测症状（前 10 位 9 条同族）；
- ✅ 与 mem0#4956 的教训一致——该 issue 的根因之一正是
  **「打分信号不含 recency」**，而本仓注入排序**恰好已有** `updated_at DESC`，
  缺的只是「同族只取一条」这一步；
- ⚠️ 但它**不减少存储增长**（3.11 条/天照旧），属**止血非治本**。

## 六、对 ADR 0014 修法方向的修正建议

| ADR 0014 §八原案 | 本次调研后的修正 |
|---|---|
| **1. 放宽豁免为「仅冲突时豁免」**（主刀） | ✅ 方向成立（Mem0 四元操作集印证），⛔ **但不可实现为「覆写」**。应实现为 **bitemporal supersession**：复用既有 `superseded_by`，与 `procedure` 同构。**并须同时解决 `superseded` 不可召回的问题**（§4.3）。 |
| **2. 注入端按族去重**（止血） | ✅ **建议提升优先级，作为第一步单独落地**。它零不可逆风险、直接消除实测症状，且被 2605.12978「显式 gate」与 mem0 v3「读期收敛」双重支持。 |
| **3. 调大 `RECONCILE_EXISTING_LIMIT`** | ✅ 维持「非主因」判断（ADR 0014 §四已实测证伪）。 |

> 🆕 **次日复核为「2 优先」补了一条独立证据**（详见 ADR 0014 §一补测）：
> L3 画像回归后，注入包实测只装下 **8 行 repo 行（另 22 行未进模型）**，
> 其中 **7 条是同族 preference**，`procedure`/`fact` **整类清零**。
> **写期修法（1）对已存在的 12 条同族行毫无作用**——它们已经在库里，
> 只有读期收敛（2）能立刻把那 7 个位置还给被清零的 kind。
> **这把「2 先于 1」从偏好升级为必要性**：先止血的那一步，是唯一能改变
> 当前每一轮注入包的那一步。

**建议的落地顺序**（与原案的差异在于**把 2 提到 1 之前**）：

```
第一步：注入端按族去重        ← 无不可逆风险，立即止血，可独立验证
第二步：验证 supersede 的可召回路径   ← 修法 1 的前置条件
第三步：preference 纳入 bitemporal supersession
```

## 七、教训

1. **「加一个缺失的操作」和「这个操作安全」是两个命题。** Mem0 的四元操作集
   证明了前者，2605.12978 与 mem0#4956 证明了后者不成立。**我上一轮只论证了
   前者就把它写成了「主刀」**——与 ADR 0010 教训 6 同型：
   **能找到一个说得通的机制，不等于它就是对的解法。**
2. **一个领域里「两条相反的路各自有公开缺陷」，通常意味着正解在第三个维度上。**
   覆写 ↔ 不覆写的二分僵持了，解法是**把时间轴分开**（逻辑有效性 vs 物理存在性）。
   **当两个选项都被证伪时，应当去找被这个二分隐藏掉的那个假设**——
   此处被隐藏的假设是「收敛必须删除或改写」。
3. **调研的最大收获可能是「我们已经有了」。** 本仓 `superseded_by` +
   `procedure` 的版本化处置，**已经是领域推荐的形状**。
   **在引入新机制之前，先问既有机制为什么没覆盖到这个 case**——
   本例的答案是一行 `kind !== 'preference'`。
4. **引证必须读原文。** 清单对 Lians 的描述与该仓库 GitHub 实际描述不符（§4.1）。
   **若照抄清单，本文就会凭一个不存在的证据支撑结论。**
