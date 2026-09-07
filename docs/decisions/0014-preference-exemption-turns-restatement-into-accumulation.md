# 0014 · preference 的「永不 supersede」豁免把「复述」变成了「累积」——注入包前 10 位有 9 条是同一条规则

- 日期：2026-09-07
- 状态：已登记（事实与量化已实测，修法待评审）
- 相关：§3.4（reconcile 按 kind 的决策规则）、§2.3（注入排序）、§3.3（propose 与 `similar`）、
  D7–D9（一条规则两处实现）、
  `src/pipeline/prompts.ts: reconcileSystemPrompt`、`src/pipeline/reconcile.ts`、
  `src/store/fts.ts: queryInjectionRows`、`src/service.ts: propose`、
  [`0010`](0010-attribution-collapses-the-injectable-set.md)、
  [`0007`](0007-injection-budget-container-mismatch.md)

> **数字口径约定**（沿用 ADR 0009／0010 的规矩）：绝对数标注测量时刻与集合；
> 比率写明分子分母；单库读数显式标注，不与全样本混用。
> 本文全部数据测于 **2026-09-07**，覆盖 **8 个 repo 库 + global 库**。
> 排序与白名单**读生产常量**（`PROVENANCE_PRIORITY`、`INJECTABLE_PROVENANCE`），
> 不手写等价物——这是 ADR 0010 教训 7 的直接执行。

## 一、现象：用户在注入包里读到同一条规则的十次改写

用户报告注入上下文「很多信息重复」。实测确认，且比报告更严重——重复项不只是
存在，它们**占据了注入包的最前列**。

**`5ed2b4d2` 库，按生产排序模拟注入包前 20 条**（`provenance` 优先级 DESC → `updated_at` DESC）：

```
 1 preference DUP*  Audit first, then route the task through the 5-step or 3-step …
 2 preference DUP*  Drive each issue through the audit → review → execute (→ code …
 3 preference DUP*  Follow the audit-first, agent-pipeline workflow for handling o…
 4 preference DUP*  Follow the user's audit-first, agent-delegated issue workflow …
 5 preference DUP*  Route each issue through agent-delegated review stages, keepin…
 6 preference DUP*  Audit first, then route work through a 3-step or 5-step agent …
 7 coding           Support multi-git-repo full-stack workspaces where the session…
 8 preference DUP*  Let the agent decide and execute commit, push, and release
 9 preference DUP*  Pick the 3-step or 5-step agent pipeline yourself based on aud…
10 preference DUP*  Follow the user's audit-then-pipeline workflow for change requ…
11–20 全部为 coding / procedure
```

**前 10 位有 9 条是同一条工作流规则的不同措辞。** 双库独立复现，非单库偶然：

```
库            active raw   注入包前 20 中的 preference
5ed2b4d2         222              9 / 20
94394b03         112             10 / 19
```

**伤害不止于冗余**：注入包有固定预算（§4.2），被同义句占满的位置，是真正
不重复的 `coding`/`procedure` 条目**没能进包**的位置。**重复不仅浪费预算，
还系统性地驱逐了不重复的内容。**

### 补测（2026-09-07 次日复核）：L3 画像回归后，症状不是缓解而是加剧

上表模拟的是 global 库**无 L3 画像**时的形态（当时 `derived` 为 0 行）。
次日复核发现**画像已重建**（307 字符，`updated_at` 2026-09-06T17:09），
于是 personal 侧走 derived 分支、只贡献 1 条。**这本应把位置让给 repo 侧。**

**实测相反**——按生产两侧预算重算完整包（`INJECT_BODY_BUDGET_TOKENS=1300`），
并与**本轮真实注入包逐条比对，9 条同序完全吻合**：

```
 1 preference       How to work with this user            ← L3 画像
 2 preference DUP*  Audit first, then route the task …
 3 preference DUP*  Drive each issue through the audit …
 4 preference DUP*  Follow the audit-first, agent-pipeline …
 5 preference DUP*  Follow the user's audit-first, agent-delegated …
 6 preference DUP*  Route each issue through agent-delegated …
 7 preference DUP*  Audit first, then route work through a 3-step …
 8 coding           Support multi-git-repo full-stack workspaces …
 9 preference DUP*  Let the agent decide and execute commit, push …

计价 1221 / 1300 tokens；DUP 占比 7/9
```

⛔ **判别式不是「占了几成」，而是「挤掉了几条」**：该库**可注入行共 30 条**
（`coding` 14 / `preference` 12 / `procedure` 3 / `fact` 1），
**而整个包只装下 8 条 repo 行——另外 22 条一条都没进模型。**

```
被挤掉的：coding 13/14、procedure 3/3、fact 1/1
进包的  ：preference 7 条（全部同族）+ coding 1 条
```

**即：`procedure` 与 `fact` 在本轮注入包中占比为 0。** 前一节说「驱逐了不重复
的内容」是定性描述，**这里给出它的定量形态：一个 kind 被整类清零。**

> **两个次生结论**：
> 1. **L3 画像不是缓解剂**。它省下的 personal 预算被 repo 侧最前列的同族
>    preference **原样吃掉**，净效果是「用一条 307 字符的画像，换掉了原本
>    还能挤进来的 1 条 coding」——**收敛发生在错误的一侧**。
> 2. **`INJECT_TOP_N=20` 在这里从未生效**。真正的约束是 token 预算（8 条即
>    耗尽），所以任何「调大 TOP_N」的设想对本症状**零效果**——与 §四证伪
>    `RECONCILE_EXISTING_LIMIT` 同型：**两个看起来相关的参数，都不是这条路上
>    正在起作用的那把尺子。**

### 第三次复核（2026-09-07 当日稍晚）：L2 首次触发，症状消失——但代价更大

**本轮注入包只有 4 条、0 条同族**，与前两次复核判然不同。查因：
**该库的 L2 rollup 于 `2026-09-06T23:09:10Z` 首次产出 3 条 `derived=2` 的
scenario 行**，`queryInjectionRows` 遂走派生分支，raw 行整体不再进包。

⛔ **不要据此认为缺陷已修复。** 实测四点：

```
L2 派生包    3 条 / 420 tok（预算 1300）→ 闲置 880 tok（68%）
raw 若进包   8 条 / 1226 tok，其中 7 条同族（DUP 7/8）
raw 可注入集 35 行：coding 16 / preference 15 / procedure 3 / fact 1
3 条 scenario 主题：全部关于 preference/fact，coding 与 procedure 无一被表达
```

**双库交叉验证**（`94394b03`）：4 条 scenario / 693 tok，闲置 607 tok，
20 条 raw 行全部被替代。**同一形状，非单库偶然。**

⭐ **这修正了我先前的判断，必须写下来**：**L2 是当前唯一在抑制重复的机制**
——raw 分支 7/8 重复，L2 分支 0/3 重复。前两轮把 L2 当作「与本缺陷无关的层」，
是错的。**但它抑制重复的方式是把 35 条压成 3 条，其中 19 条 coding/procedure
的内容整体消失**，所以症状消失不等于问题解决：**信息从「重复」变成了「缺失」。**

**三个新问题就此浮现，均属本 ADR 未覆盖的范围：**

1. **预算闲置 68%**：L2 自身上限是 `ROLLUP_MAX_SCENARIOS=6 × SCENARIO_MAX_TOKENS=188
   = 1128 tok`，实际只产出 **3 条 / 420 tok（占自身上限 37%）**。
   根因指向 `rollupSystemPrompt` 内两条**互相拉扯**的规则：
   `prefer FEWER, larger ones` 与 `preserve every distinct item whatever its kind`
   ——模型选择了前者，于是「保留每一项」没有兑现。
   **这不是架构问题，是提示词内部的矛盾。**
2. **派生层随时消失**：生产库实测触发器为
   `WHEN NEW.derived = 0 BEGIN DELETE FROM memories WHERE derived != 0`，
   即**任意一次 raw 写入删除整层**。实测 raw 写入间隔 **p50 = 0.0 分钟、
   p90 = 0.7 分钟**（成批写入），该派生层能存活 1.8 小时纯粹因为期间无会话写入。
3. **rollup 空转**：`packetOverflows` 以 **raw 集**计价（实测 **7049 tok** ≫ 1300），
   而 rollup **不改变 raw 集**，故触发条件**恒为真**；`store_revision` 骑在幂等键上，
   每次 revision 都 mint 新 job。实测 `jobs` 表 **rebuild 25 次 / 6.3 天 = 3.9 次/天**，
   **每次一个 LLM 调用**，产出随下一次 raw 写入即被删除。

> **这三点合起来说明：L2 目前处于「反复重建、随即失效、且期间信息量下降」的状态。**
> 它让症状消失，是因为它把整个 raw 集挡在包外——**不是因为它解决了重复。**

## 二、主因：一条豁免规则，把「同义改写」和「冲突偏好」当成了同一件事

§3.4 对 preference 的规定在**两处**实现，措辞一致：

```
prompts.ts  reconcileSystemPrompt()
  "preference conflicting with an existing preference => "activate" BOTH stay
   (the user resolves preferences; never supersede a preference)"

reconcile.ts:222
  oldRow?.status === 'active' && oldRow.kind !== 'preference' && oldRow.derived === LAYER.RAW
```

**这条规则的设计意图是对的**：偏好冲突该由人裁决，代码和模型都不该替用户
决定「你现在到底想要哪个」。ADR 0003 的精神也支持它——语义判断留给模型，
但**冲突的偏好连模型也不该单方面裁决**。

**它错在把两种完全不同的关系合并成了一种：**

| 关系 | 例子 | 正确处置 |
|---|---|---|
| **冲突**的偏好 | 「提交前问我」vs「提交不用问」 | 并存，由用户裁决 ✅ 现行规则对 |
| **同义改写**的偏好 | 本文那 12 条 audit-first 流程 | 应收敛为一条 ❌ 现行规则误伤 |

那 12 条彼此**并不冲突**，它们是同一条规则的十二次复述。规则只认 kind，
不认关系，于是把「复述」也按「冲突」处理了。

### 决定性对照组：preference 是全库唯一从未被替换过的 kind

```
                    行数    superseded_by 已设置
preference           49            0            ← 8 个 repo 库 + global，无一例外
非 preference       539           44
```

**49 条 preference 中，`superseded_by` 命中 0。** 不是「很少」，是**结构性的零**
——代码路径根本不允许它非零。同一个 reconcile、同一批写者，非 preference
能正常收敛，preference 一条也不能。**差别不在内容质量，在那条 kind 判断上。**

## 三、模型确实在去重，但它只能丢新的、留旧的

一个自然的怀疑是「模型没认出重复」。**数据否定了它**：

`5ed2b4d2` 库有 **13 条 preference 处于 `superseded`，且全部 `superseded_by IS NULL`**
——`NULL` 说明它们是被 `drop` 掉的，不是被替换掉的：

```
2026-08-29 human   Run fixes through audit → plan review → execute → code review → QA
2026-08-30 parent  Follow the 5-stage pipeline: audit-decide, plan review, execute, c…
2026-09-01 human   按用户定义的多智能体流程处理问题：先审计决策，再走三步或五步流程
2026-09-03 human   Route each issue through the audit-first agent pipeline the user e…
…共 13 条，全部同族
```

**模型看见了重复，也做了处置**——它 drop 了 13 次。问题在于 §3.4 给它的
两个选项都不对：

- `drop` ⇒ **丢弃的是新条目**，旧措辞原封不动留在库里；
- `activate` ⇒ 并列新增一条。

**没有第三个选项「用新的替换旧的」**，因为那正是被豁免掉的 `supersede`。

于是形成一个棘轮：**早期措辞永远沉淀下来，无法被更好的表述取代**；而每当
某一轮 drop 未命中（措辞差异大、或不在去重窗口内），就新增一条。**只增不减，
且增减都不改善质量。**

实测累积速率（`5ed2b4d2`，2026-08-28 → 09-06，跨 9.3 天）：

```
preference 写入 29 条 ⇒ 3.11 条/天，其中 24 条属同一族
```

## 四、次因：去重窗口只覆盖 13.5% 的库——但它不是主因

`RECONCILE_EXISTING_LIMIT = 30`，而 `5ed2b4d2` 有 222 条 active raw 行：

```
窗口 30 / 222 = 13.5%
```

**但必须如实说明：这一条不是主因，实测证据不支持把它当主因。**

对该库实测那 30 行窗口的实际内容：

```
窗口内 preference        4 条
窗口内同族旧条目         4 条   ← 模型看得见
全库同族条目            24 条
```

**模型看得见同族旧条目，仍然新增了。** 所以窗口大小是**加剧因素**（覆盖率随
库增长单调下降），不是成因。**只调大 `RECONCILE_EXISTING_LIMIT` 修不好这个
缺陷**——这一点必须写下来，因为它是最容易被误选的「显而易见的修法」。

> 条目创建时该库的行数：37 → 81 → 167 → 233 → 294。窗口占比持续下降，
> 所以症状**随时间恶化**，但恶化的是命中率，不是那条豁免规则。

## 五、放大器：注入排序让重复项优先级最高

`fts.ts: queryInjectionRows` 的排序是 `provenance 优先级 DESC → updated_at DESC`，
而 `PROVENANCE_PRIORITY.human = 5` 是最高档。

这条工作流规则**每次都由用户亲口说出** ⇒ 全部记为 `human` ⇒ 全部排在最前。

**三个机制的乘积**才是本文第一节那张表：

```
豁免规则（不收敛） × human 最高优先级（排最前） × 固定预算（挤掉别人）
```

> 与 ADR 0010 教训 1 同型：**三条各自正确的规则，缺陷只存在于它们的乘积里。**
> 排序规则没错（人说的话确实该优先）；豁免规则的意图没错；预算没错。
> **没有任何一方的测试会看到乘积。**

## 六、`similar` 机制为什么没能兜住

§3.3 已经预见过这个问题。`plugin-architecture.md:871` 写着：

> **显式去重/更新**：`propose` 返回 `similar`（同 kind 的近义活跃条目），模型
> 下次保存时用 `replaces` 收敛……（实测：同一偏好存 3 次得 3 份）

**该机制存在且工作正常，但它够不着这条路径**，两个原因：

1. **它是写后提示，不是写前拦截**：`service.ts: propose` 中 `querySimilarRows`
   在 `store.db` 事务**之后**执行——行已经落库，`similar` 只是提示模型
   「下次可以用 `replaces` 收敛」。**那个「下次」需要模型在后续会话中主动
   发起，而没有任何机制保证它会发生。**
2. **自动 extract 路径根本不经过 `propose`**：管线产出的候选走 extract → reconcile，
   `similar`/`replaces` 在那条路上不存在。实测该族 24 条中 `human` 占多数，
   但也有 `parent-agent` 3 条、`tool-output` 4 条来自管线。

**所以现状是：一个正确的收敛机制，装在一条流量较小的路上；流量大的那条路
上装的是一条禁止收敛的豁免。**

## 七、为什么测试全绿

与 ADR 0010 §五同型，且更直接——**测试正在锁定这个行为**：

1. ⛔ **本条为假，已于 2026-09-07 实测证伪，原文保留**：这里原写
   「`prompts.ts` 的规则被提示词测试锁定为『never supersede a preference』」。
   **把整条 preference 规则从提示词里删掉，`npm run verify` 仍 320/320 全绿**
   （编译退出码 0，测试确实执行）。全仓唯一的提示词断言是
   `pipeline.test.mjs` 的 `assert.equal(seen.system, reconcileSystemPrompt())`
   ——**函数和它自己比，恒真**，对内容零约束。
   **提示词那一半处于零防护状态**，不是被锁定。
   > 这是本 ADR 教训 5「没变红与没跑长得很像」的第三个变体：
   > 前两次是**没跑**（编译失败）与**没执行到**（游走退化），
   > 这次是**没人在看**——断言存在、会跑、永远为真。
2. `reconcile.ts` 的 `kind !== 'preference'` 分支确有单元测试覆盖（属实）。
3. **没有任何测试断言「同一条偏好复述 N 次后，库里该有几条」**——两个端点
   各自被覆盖，中间的乘积无人测量。

> **这正是本仓已登记的判据（见记忆库「区分钉住不变量与钉住当前行为」）的
> 适用场景**：那些测试钉的是**当前实现的形状**，不是不变量。修法一旦落地，
> 它们会以「红」的方式拒绝一次正当修复——**应当预期到，并按判据处置。**

## 八、修法方向（未实施，待评审）

> ⛔ **本节已被 2026-09-07 的外部调研部分推翻，读本节前请先读
> [`../research-2026-09-07-preference-convergence-prior-art.md`](../research-2026-09-07-preference-convergence-prior-art.md)。**
> 要点：下述修法 1 的**方向**被 Mem0 的四元操作集印证，但**不可实现为「覆写」**
> ——arXiv 2605.12978 实测「持续 consolidation 会把有用记忆改坏，效用可跌破无记忆
> 基线」，且其最坏输入形状（近义重复流）**正是本缺陷的输入形状**。
> 正解是复用本仓**既有**的 `superseded_by`（与 `procedure` 同构的 bitemporal
> supersession：逻辑收敛、物理保留），**而非引入覆写**。
> 落地顺序也据此调整为 **2 → 1**（止血在前，主刀在后）。

**主刀在 §3.4 的规则语义，不在参数。**

1. **区分「冲突」与「改写」**（主）：preference 的豁免应只覆盖**语义冲突**的
   情形；**语义等价的改写/细化应允许 supersede**（内容取新）。这是一个
   **产品判断**——「什么算冲突」只能由模型判定，代码无从计算（ADR 0003 的
   形状），故修法应落在**提示词的判据**上，`reconcile.ts` 的 `kind` 硬分支
   随之放宽为「模型判定为冲突时才豁免」。
   > ⚠️ **风险须先论证**：放宽后，模型误判「冲突」为「改写」会**丢失用户
   > 真实意图**。这比冗余严重。故需要先设计**不可逆性的兜底**（如 supersede
   > 保留原行且可召回），再谈放宽。
2. **注入端按族去重**（防御纵深）：同 kind + 高相似度只取最新一条，使单一
   主题无法吃满预算。**独立于修法 1**，即使 1 因风险被否决，2 仍能止血。
3. **`RECONCILE_EXISTING_LIMIT` 改为按 kind 分层取样**（次要）：保证同 kind
   的旧条目一定进窗口。**明确不作为主修**——§四已证它不是成因。

**历史数据清理是独立的第二件事**：现有 49 条 preference（含 24 条同族）需要
一次性合并。**清理会改写用户真实记忆库，须单独出方案并经用户确认**，不与
代码修复混为一谈（ADR 0010 §六「回收与代码修复是两件可分开的事」的先例）。

## 九、教训

1. **按类型豁免，会连带豁免掉该类型里本该处理的关系。** 规则只看 kind
   （preference），看不见关系（冲突 / 改写）。**一个按类型写的豁免，其覆盖
   范围永远大于它想保护的那件事**——写豁免时要问的是「我想保护的是哪种
   关系」，而不是「哪种类型」。
2. **「模型没认出重复」是最容易接受、也最容易证伪的解释。** 13 次 drop 的
   实测记录直接推翻了它，并把问题从「模型能力」重新定位到「可选动作集」。
   **当怀疑模型判断力时，先去查它当时有哪些动作可选**——本例中它的判断是
   对的，是选项里没有正确答案。
3. **`superseded_by` 全为 NULL 是一个结构性信号，不是统计噪声。** 49/0 与
   539/44 的对照不可能来自内容差异。**一个字段在整个生产库里从未非空，
   说明写它的代码路径不可达**——这种「整齐」和 ADR 0010 教训 5 的「400 字符
   直角」同型：**分布里的绝对值是代码留下的，不是世界留下的。**
4. **先证伪最显眼的那个修法，再写方案。** 「窗口只有 30，调大就行」是本例
   最直观的修法，也确实是一个真实缺陷。但实测显示窗口里**本来就有** 4 条
   同族条目，于是它被降级为次因。**如果没做这一步实测，本轮会去调一个参数，
   然后发现症状没消失。**
5. **一个正确的机制装在错误的路径上，等于没有。** `similar`/`replaces` 完整
   实现了收敛能力，但它在写后、且只在 `propose` 路径上。**评估一个能力是否
   存在，要问的是「产生问题的那条流量走不走它」。**
