# 裁定项 C 审计 · 派生层「完全替代」raw 是否正确

- 日期：2026-09-07
- 状态：审计结论（未实施）
- 相关：`src/store/fts.ts: queryInjectionRows`、`src/recall/inject.ts: buildContextProvider`、
  `src/pipeline/rebuild.ts: packetOverflows`、`src/store/schema.ts: invalidate_derived_*`、
  ADR [`0007`](decisions/0007-injection-budget-container-mismatch.md)、
  [`0010`](decisions/0010-attribution-collapses-the-injectable-set.md)、
  [`0014`](decisions/0014-preference-exemption-turns-restatement-into-accumulation.md)

> 口径：全部读数测于 2026-09-07T01:01Z，覆盖 8 个 repo 库 + global 库。
> 排序、白名单、计价一律 **import 生产常量与生产函数**（`lib/` 编译产物），
> 不手写等价物——ADR 0010 教训 7。写操作只在 scratch 副本上做，已删除。
>
> ⛔ **本文已按裁定项 A 的新事实修订，见文末[附录 A](#附录-a按裁定项-a-新事实的修订)。**
> 修订包含**对本文自身两处读数的更正**（寿命轴、C5a 收益）与**一处对新事实的反驳**。
> 正文保留原样不删（本仓惯例），冲突之处以附录 A 为准。

## 结论（一句话）

**「完全替代」不是这里的主要缺陷，它是一个更深缺陷的显影**——L2 的输入被
`ROLLUP_TRANSCRIPT_CHARS` 截到只剩 28.6%（10/35 行，且 9 条是同一族 preference），
输出因此只覆盖被 ADR 0014 指认的那一族重复；而 D9 触发器对 provenance 完全失明，
**62.5% 的层是被永不进包、永不进 rollup 的 `tool-output` 行删掉的**，使 L2 实测存活率仅
47.7%——**推荐 C2（混合注入）作为止血，并追加一条 C5（D9 按可注入性触发 + rollup 输入按 kind 分层）作为主刀，C4「删掉 L2」被数据否决但它提的问题是对的**。

## 实测证据（命令 + 原文输出）

复核脚本置于 `.audit-c/`（一次性工具，未提交），全部以
`new DatabaseSync(path, { readOnly: true })` 打开**只读副本**。

### 1. 复核你的数字：全部属实，但「首次触发」一项是错的

```
$ node .audit-c/price.mjs .audit-c/db.sqlite

CONSTANTS  INJECT_BODY_BUDGET_TOKENS=1300  INJECT_TOP_N=20  ROLLUP_SOURCE_LIMIT=200
           ROLLUP_MAX_SCENARIOS=6  worstPersonaTokens=171

=== queryInjectionRows (what injection ACTUALLY carries today) ===
rows: 3   packetTokens: 420
   178 tok  [fact] Audit-First Agent Pipeline for Open Issues
    93 tok  [fact] Commit, Push and Release Authority
   149 tok  [fact] Repo Scoping in Multi-Git Full-Stack Workspaces
rendered packet: 471 tokens, 3 entries, body-cost 420, IDLE BUDGET 880

=== queryInjectableSet(INJECT_TOP_N=20) — the fallback branch, NOT taken today ===
withinBudget(1300) keeps 8 rows, cost 1226 tok

=== packetOverflows container: queryInjectableSet(ROLLUP_SOURCE_LIMIT=200) ===
rows: 35  packetTokens: 7132  > 1300 ? true
by kind: {"preference":15,"coding":16,"procedure":3,"fact":1}
```

| 你的主张 | 复核结果 |
|---|---|
| 派生层 3 行，注入包 420 tokens | ✅ 精确 |
| 浪费 880 tokens，68% 闲置 | ✅ 精确（880/1300 = 67.7%） |
| 35 条可注入 raw（coding 16/preference 15/procedure 3/fact 1） | ✅ 逐项精确 |
| raw 分支 1300 tokens 装 8 行（1226 tokens） | ✅ 精确 |
| **2026-09-06T23:09 L2「首次触发」** | ❌ **是第 25 次**，见下 |

**唯一需要更正的是「首次」。** `jobs` 表里 `kind='rebuild'` 且 `state='done'`
的行有 **25 条**，最早一条完成于 2026-08-31T14:55Z：

```
$ node .audit-c/d9.mjs .audit-c/db.sqlite   （节选）

=== L2 layer LIFETIME: each committed rebuild vs. the next RAW write (D9 kill) ===
rebuild done               next raw write             lifetime
2026-08-31T14:55:25.136Z   2026-08-31T14:56:12.958Z   0.8 min
2026-08-31T15:15:51.658Z   2026-08-31T15:16:40.790Z   0.8 min
2026-09-01T01:36:55.465Z   2026-09-01T01:38:11.175Z   1.3 min
...
2026-09-06T21:12:00.058Z   2026-09-06T21:14:02.579Z   2.0 min
2026-09-06T23:09:10.112Z   (none yet)                 112.5 min  <- ALIVE NOW

killed layers n=24  min=0.7  p50=2.0  p90=676.3  max=1002.1 minutes
under 60 min: 14/24
```

这个更正**改变结论方向**：你看到的不是一个新生的层第一次亮相，而是一个
**已经生死 25 轮的层**当前恰好活着。「880 tokens 闲置」不是新现象，是常态的一次采样。
——ADR 0007 教训 5「间歇性敞口会让单次采样自相矛盾」在此重演。

### 2. 派生层内容 vs. 它替换掉的 raw：信息量确实减少了，但方式和你想的不同

```
$ node .audit-c/content.mjs .audit-c/db.sqlite   （节选标题）

########## THE 3 DERIVED ROWS ##########
[fact] Audit-First Agent Pipeline for Open Issues
[fact] Commit, Push and Release Authority
[fact] Repo Scoping in Multi-Git Full-Stack Workspaces

########## THE 8 RAW ROWS THE FALLBACK WOULD KEEP ##########
[preference] Run repo problem-fixing as an audit-first multi-agent pipeline …
[preference] Audit first, then route the task through the 5-step or 3-step …
[preference] Drive each issue through the audit → review → execute …
[preference] Follow the audit-first, agent-pipeline workflow …
[preference] Follow the user's audit-first, agent-delegated issue workflow …
[preference] Route each issue through agent-delegated review stages …
[preference] Audit first, then route work through a 3-step or 5-step agent …
[coding] Support multi-git-repo full-stack workspaces where the session …
```

⛔ **这一比对推翻了「3 条摘要 vs 8 条原文，信息量减少」的简单读法。**

那 8 条 raw 里有 **7 条是 ADR 0014 指认的同一族 audit-first 工作流复述**，
第 8 条是 `Support multi-git-repo full-stack workspaces`。而 3 条派生行：

- 第 1 条 = 那 7 条 preference 的**正确合并**；
- 第 3 条 = 第 8 条 coding 的**改写**（内容逐句对应）；
- 第 2 条 = commit/push/release 授权（来自第 9 条被预算挤掉的 preference）。

**即：L2 在这一轮做对了它该做的事**——它把 ADR 0014 的重复族压成一条，还多救回一条
被预算挤掉的规则。3 条 420 tokens 承载的**独立信息**不少于 8 条 1226 tokens。

**真正的损失不在这 8 条里，而在从未参与的那 25 条里。**

### 3. 根因：rollup 的输入被截掉 71.4%，而截掉的正是不重复的部分

`rebuild.ts: withinTranscriptBudget` 用 `ROLLUP_TRANSCRIPT_CHARS = 6000` 按
**packet 顺序**（provenance 优先级 → recency）截断输入：

```
$ node .audit-c/rollupinput.mjs .audit-c/db.sqlite

ROLLUP_TRANSCRIPT_CHARS = 6000
sources available : 35 rows  {"preference":15,"coding":16,"procedure":3,"fact":1}
actually FED to LLM: 10 rows  {"preference":9,"coding":1}
NEVER SEEN by rollup: 25 rows  {"preference":6,"coding":15,"procedure":3,"fact":1}

--- rows the rollup NEVER SAW ---
12 coding     证明守卫承重时，先排除「变异体被运行时/库自己顺带杀掉」
13 coding     Judge a proposed guard by which mutant it kills …
14 coding     负控制的每一步都必须实测「它单独能杀掉哪个变异」…
15 coding     node:test 的 after() 钩子跑在所有 test 之后 …
16 coding     测「每跑泄漏多少」时，必须跑全量套件 …
17 procedure  发版判据：先证明 tarball 字节会变，再谈版本号
18 procedure  发版时用 npm_config_cache=/tmp/npmcache 绕开 npm 的 EACCES
19 coding     验证 schema 守卫时必须区分「新建库」与「存量库」两条路径
20 procedure  变异验证时 lib/ 不随 git checkout 还原 …
…共 25 条
```

**喂给模型的 10 行里有 9 行是同一族 preference。** 于是 rollup 只可能产出
「工作流」主题的摘要——**它没有能力覆盖 coding/procedure，因为它从未见过它们**。

这就是 ADR 0014 §五「三个机制的乘积」的第四个乘数：

```
豁免规则（preference 不收敛）
  × human 最高优先级（同族排最前）
  × ROLLUP_TRANSCRIPT_CHARS 按同一顺序截断（同族吃光 rollup 输入）
  × 派生层完全替代 raw（同族摘要顶替全部 35 行）
```

**「完全替代」是这条链的最后一环，不是第一环。** 它把上游的偏斜从「浪费预算」
放大成「整类清零」：`coding 15/16、procedure 3/3、fact 1/1` 既不在 rollup 输入里，
也不在注入包里——**在两条路上同时消失**。

跨库复核（避免单库偏差，ADR 0007 教训 3）：

```
$ node .audit-c/coverage.mjs

ROLLUP_TRANSCRIPT_CHARS=6000 — how much of the injectable set the rollup EVER SEES
store      injbl   fed  unseen  coverage
2631a175       0     0       0       n/a
3e857510      27    15      12     55.6%
5ed2b4d2      35    10      25     28.6%
7048f15b       0     0       0       n/a
94394b03      20    10      10     50.0%
aafbf0fa       1     1       0    100.0%
ec2636fc      16    14       2     87.5%
edf7a686      16    13       3     81.3%
global.s      34     5      29     14.7%
```

**本库 28.6% 是全部 repo 库里最差的**，且 global 库 14.7% 更差——覆盖率**随库增长单调下降**，
与 ADR 0014 §四 `RECONCILE_EXISTING_LIMIT` 的形状完全同型。

## L2 触发条件与稳定性分析

### 3.1 `packetOverflows` 用哪个集合计价

```ts
// rebuild.ts:208
export const packetOverflows = (store: OpenStore): boolean =>
  packetTokens(queryInjectableSet(store, ROLLUP_SOURCE_LIMIT)) > INJECT_BODY_BUDGET_TOKENS
```

计价集合是 **`queryInjectableSet`（可注入 raw 集，limit 200）**，实测
`35 行 / 7132 tok > 1300` ⇒ true。

**ADR 0010 §七的担忧在本库已经不成立，但原因不是它被修了。** ADR 0010（2026-08-31）
记的是「105 条记忆只按 6 条计价，永远不溢出」。今天该库 `active raw = 251`，
可注入 35 条计价 7132 tok，**远超阈值**——触发器现在**照常工作**。

变化来自供给侧而非代码：`principal-explicit` 从当时的个位数涨到 14，`human` 11、
`parent-agent` 10，合计 35。**归因缺陷（212/251 = 84.5% 是 tool-output）依然存在**，
只是分子已经大到能越过阈值。**这不是修复，是缺陷被增长掩盖了**——
它对 C4 的评估很关键：L2 的触发依赖一个仍然被掏空 84.5% 的集合。

```
$ node .audit-c/price.mjs .audit-c/db.sqlite   （节选）
=== TOTAL active raw (all provenances) for contrast ===
rows: 251  packetTokens: 38045
```

**分母的真相**：真正的「记忆是不是太多」应该看 38045 tok，触发器看到的是 7132。

### 3.2 D9 触发器：派生行会被下一次 raw 写入删除吗？——会，且删它的多数是永不进包的行

`schema.ts:237-245`：

```sql
CREATE TRIGGER invalidate_derived_insert AFTER INSERT ON memories
  WHEN NEW.derived = 0 BEGIN
    DELETE FROM memories WHERE derived != 0;
    INSERT INTO meta (k,v) VALUES ('store_revision','1')
      ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER)+1 AS TEXT);
  END;
-- 同形的 _update（WHEN OLD.derived = 0）与 _delete
```

**触发条件只看 `derived` 列，完全不看 `provenance`。** 在 scratch 副本上实测：

```
$ node .audit-c/d9test.mjs .audit-c/scratch.sqlite

BEFORE            : derived=3  store_revision=675
AFTER 1 tool-output raw INSERT: derived=0  store_revision=676

=> a row that can NEVER be injected (provenance tool-output is excluded by
   INJECTABLE_PROVENANCE) and can NEVER enter a rollup (queryInjectableSet filters it)
   nevertheless DELETES the entire derived layer.
```

**一条既进不了注入包、也进不了 rollup 输入的 `tool-output` 行，摧毁了整个派生层。**
这不是理论可能，它是主导路径：

```
$ node .audit-c/killer.mjs .audit-c/db.sqlite   （节选）

=== WHO KILLS THE LAYER ===
{ "tool-output": 15, "principal-explicit": 5, "human": 3, "parent-agent": 1 }

killed by a row that is NOT EVEN INJECTABLE: 15 / 24 = 62.5%
```

```
$ node .audit-c/waste.mjs .audit-c/db.sqlite

layers killed by a NON-injectable row : 15 (62.5%)  median life 1.3 min
layers killed by an injectable row    : 9 (37.5%)   median life 170.1 min

layers dead within 5 minutes of being written: 14 / 24 = 58.3%
  of those, killed by a NON-injectable row: 11
```

**中位寿命 1.3 分钟 vs 170.1 分钟，相差 130 倍。** 被非可注入行杀死的层，
**58.3% 活不过 5 分钟**——一次 LLM rollup 调用（约 6000 字符输入）的产物，
经常在写入后一两分钟内被一条模型永远看不到的行删除。

### 3.3 你问的「现在还在不在？中间有没有 raw 写入？」

```
$ node .audit-c/d9.mjs .audit-c/db.sqlite   （节选）

NOW = 2026-09-07T01:01:38.607Z
derived layer born : 2026-09-06T23:09:10.113Z
derived layer age  : 1.87 hours
RAW rows written since derived layer born: 0  ==> layer survived
```

**还在。中间没有任何 raw 写入**——这正是它还活着的唯一原因。
最近一次 raw 写入是 2026-09-06T21:17:39Z，早于 rollup 完成时刻 23:09:10。

### 3.4 稳定性的量化结论

```
$ node .audit-c/uptime.mjs .audit-c/db.sqlite

observation window : 2026-08-31T14:55 .. 2026-09-07T01:01  (6.42 days)
L2 layer PRESENT   : 73.4 hours  = 47.6% of the window
L2 layer ABSENT    : 80.7 hours  = 52.4% of the window
rebuild commits    : 25   (killed by a raw write: 24)
```

**L2 实测存活 47.6%，缺席 52.4%。** 与 ADR 0007 记录的 L3 画像（58.5% / 41.5%）同型，
且**更差**。跨库：

```
$ node .audit-c/survey2.mjs

store     kind     actv  injbl  raw200  ovf  L2  C1ent  C1tok  idle  C2ent  C2tok  idle  rawOnly   L2up%
2631a175  repo       14      0       0   no   0      0      0  1300      0      0  1300        0     n/a
3e857510  repo       27     27    3007  YES   6      6    917   383      9   1260    40       12   100.0
5ed2b4d2  repo      251     35    7132  YES   3      3    420   880      9   1287    13        8    47.6
7048f15b  repo       20      0       0   no   0      0      0  1300      0      0  1300        0     n/a
94394b03  repo      114     20    2252  YES   4      4    693   607      9   1296     4       10    53.3
aafbf0fa  repo       16      1     127   no   0      1    127  1173      2    254  1046        1     n/a
ec2636fc  repo       16     16    1808  YES   5      5    666   634     10   1214    86       11   100.0
edf7a686  repo       16     16    1916  YES   4      4    587   713     10   1267    33       11   100.0
global.s  global     34     34   10849  YES   1      1     88  1212      6   1295     5        4    84.5
```

⛔ **`idle` 列是本次审计最强的证据：持有派生层的 6 个库，闲置预算 383–1212 tokens，
无一例外。** 这不是本库的偶然，是**「完全替代」的结构性后果**——
派生层按设计就比它替换的集合小，而替代是无条件的，于是**省下来的预算没有任何消费者**。

反事实（D9 若只对可注入行触发）：

```
$ node .audit-c/counterfactual.mjs .audit-c/db.sqlite

L2 uptime, TODAY  (D9 fires on ANY raw write)        : 47.7%
L2 uptime, if D9 fired only on INJECTABLE raw writes : 76.3%

raw writes total=330  non-injectable=278  84.2%
```

**存活率 47.7% → 76.3%，仅靠让触发器看一眼 provenance。**

## 各方案优缺点

### C1 维持现状（派生层完全替代 raw）

- ✅ 语义最简单，一条规则一个实现；`packetOverflows` 的自引用问题被结构性避免
  （`rebuild.ts` 注释里 T1..T5 测试锁定的正是这一点，不可轻动）
- ✅ 派生行进包数不受 raw 挤压，L2 的产出必然被看到
- ❌ **实测 6/6 个持有派生层的库全部闲置 383–1212 tokens**，无一例外
- ❌ 与上游 `ROLLUP_TRANSCRIPT_CHARS` 截断相乘后，**整类 kind 清零**
  （本库 coding 15/16、procedure 3/3、fact 1/1 两条路上同时消失）
- ❌ 「替代」的正当性前提是「派生层覆盖了它替换的集合」，**该前提实测不成立**（覆盖 28.6%）

### C2 混合注入（先派生行，剩余预算填 raw）

```
$ node .audit-c/e2e.mjs   （生产 buildContextProvider 的完整两侧合成）

END-TO-END packet (global capped at worstPersonaTokens=171, then repo), live data
repo       C1ent  C1body  C1idle  C2ent  C2body  C2idle  +entries
2631a175       1      88    1212      1      88    1212        +0
3e857510       7    1005     295      9    1253      47        +2
5ed2b4d2       4     508     792      9    1215      85        +5
7048f15b       1      88    1212      1      88    1212        +0
94394b03       5     781     519      8    1287      13        +3
aafbf0fa       2     215    1085      3     342     958        +1
ec2636fc       6     754     546     11    1292       8        +5
edf7a686       5     675     625     10    1230      70        +5
```

- ✅ **实测在 6 个库上净增 1–5 条进包**，闲置从 295–1085 降到 8–85
- ✅ 不动 `packetOverflows` 的容器 ⇒ **T1..T5 全部不受影响**，
  ADR 0010 §七的自引用陷阱不被触碰
- ✅ 加载期守卫**实测仍绿**（见下），无需改常量
- ❌ **不修根因**：rollup 仍只看得见 28.6% 的输入，L2 仍 47.6% 时间不存在。
  这是止血，不是主刀
- ❌ 引入「摘要与它的原文同时进包」的冗余。朴素实现实测确有此形态：

```
$ node .audit-c/sim.mjs   （节选）
===== C2-naive: derived first, then raw in priority order =====
entries 9   spent 1287 / 1300 tok   IDLE 13
kinds: {"fact":3,"preference":6}
```

**9 条里有 3 条摘要 + 6 条被那 3 条摘要总结掉的同族 preference——冗余度反而更高。**
朴素 C2 把 ADR 0014 的重复问题原样搬进注入包。

**修正实现（C2′，按「不重复 rollup 已消费的行」填充）实测更优：**

```
===== C2-skip-summarized: derived first, then raw NOT fed to the rollup =====
entries 7   spent 1295 / 1300 tok   IDLE 5
kinds: {"fact":3,"preference":1,"coding":2,"procedure":1}
```

**7 条覆盖 4 个 kind，procedure 与 coding 重新进包**——这正是 ADR 0014 §一
「一个 kind 被整类清零」的解药。**但它需要持久化「哪些行被 rollup 消费过」，
而 `memories` 表今天不存这个事实**（见「风险与前置条件」）。

### C3 条件替代（raw 装得下就用 raw）

- ✅ 逻辑上最诚实：摘要只在必要时出现
- ❌ **在本仓是空操作**。`packetOverflows` 的触发条件就是
  `packetTokens(queryInjectableSet(200)) > 1300`，而 L2 只在触发后才存在
  ⇒ **「派生层存在」蕴含「raw 装不下」**，条件恒真
- ❌ 若把条件改成「20 行窗口装不下」，实测 6 个持层库中
  `rawOnly` 列为 8/10/11/11/12/4 行，**全部超预算** ⇒ 仍然恒真
- ⛔ **这是 ADR 0007 教训 4 的形状：一个改动，零产品效果。** 不推荐。

### C4 重新审视 L2 是否该存在

**你的质疑方向是对的，而且比你提的更尖锐**：一个 47.6% 时间不存在、
62.5% 由永不进包的行删除、中位寿命 1.3 分钟的层，配着
rollup job + prompts + D9 触发器 + guard + 双分支查询 + T1..T5 测试的复杂度。

**但数据否决「删掉它」**，理由是可证伪的：

1. **本库的 3 条派生行，内容上确实优于它替换的 7 条同族 preference。**
   删掉 L2，注入包立刻退回 ADR 0014 §一那张表——前 10 位 9 条同族复述。
   **L2 是目前唯一实际收敛了那一族的机制**（ADR 0014 的修法 1、2 都还没实施）。
2. **删掉 L2 会让 `aafbf0fa` 之外的大库彻底失去收敛手段**：
   `3e857510` 27 条 3007 tok、`ec2636fc` 16 条 1808 tok、`edf7a686` 16 条 1916 tok，
   全部超预算，raw 分支下 `withinBudget` 会静默丢弃 30–60% 的行——
   **「没有人决定丢哪一条」正是 §12 引入 L2 的原始理由**，那个理由今天仍然成立。
3. **「少就是多」在这里指向的不是删层，而是删规则。** L2 的复杂度里，
   真正无收益的是**「无条件替代」这一条规则**和**「D9 对 provenance 失明」这一条规则**。
   删掉这两条规则，L2 的其余部分（job、prompt、写路径裁剪）都在做实事。

**C4 的正确形态不是「L2 能不能不存在」，而是「L2 的哪一部分能不存在」。** 答案：
`queryInjectionRows` 的**短路三元运算符**能不存在，`invalidate_derived_*` 的
**无条件性**能不存在。

### C5（本审计提出）：D9 按可注入性触发 + rollup 输入按 kind 分层

两条独立修改，各自可单独上线：

**C5a — D9 只对「可能改变 rollup 输入」的写入触发。**
今天的触发器条件是 `NEW.derived = RAW`；改为
`NEW.derived = RAW AND NEW.provenance IN (INJECTABLE_PROVENANCE)`。
依据：rollup 的输入是 `queryInjectableSet`，**一条非可注入行在数学上不可能
改变 rollup 的输入或输出**，所以让它使层失效是纯粹的浪费。
实测收益 **47.7% → 76.3% 存活率**，且 84.2% 的 raw 写入不再触发无谓的 revision bump。

**C5b — `withinTranscriptBudget` 改为按 kind 分层取样。**
今天它按 packet 顺序线性截断，于是 human 优先级最高的同族 preference
吃光 6000 字符预算。改为每个 kind 保证最低配额后再按顺序填充。
依据：本库 rollup 输入 9/10 是同一族，**coding 15 条、procedure 3 条全部未参与**。
这与 ADR 0014 §八修法 3 是**同一条规则的同一个执行点**——那份 ADR 把它
写在 `RECONCILE_EXISTING_LIMIT` 上，这里是 `ROLLUP_TRANSCRIPT_CHARS` 上的同一形状。

**C5 修的是「L2 为什么产出偏斜、为什么活不久」，C2 修的是「产出之后预算怎么花」。
两者正交，不互相替代。**

## 推荐方案与理由

**推荐 C5a + C2′，按此顺序；C5b 次轮；C1 否决；C3 否决（零效果）；C4 部分采纳。**

### 顺序理由：先让层活下来，再谈怎么花预算

ADR 0007 教训 6「修复必须成对时，任何一半单独上线都会退化」在这里**反向适用**：
C2 与 C5a 是**可分离**的，且分离有严格好处——

- **先做 C5a**：它是三行 SQL 的触发器条件收紧，风险最低，收益最大
  （存活率 47.7% → 76.3%），**且它改变 C2 的评估基线**。今天 52.4% 的时间
  根本没有派生层可言，C2 在那段时间里等价于 C1 的 fallback 分支——
  **在层只活一半时间的前提下测量「混合注入的收益」，测的是一个混合物。**
- **再做 C2′**：此时派生层稳定存在，`idle` 才是一个持续可观测的量，
  混合注入的收益才可归因。

### 为什么是 C2′ 而不是朴素 C2

朴素 C2 实测把 6 条被摘要总结掉的同族 preference 塞回包里
（9 条中 6 条冗余），**它把 ADR 0014 的缺陷从 raw 分支复制到了派生分支**。
C2′ 只填充 rollup 未消费的行，实测 7 条覆盖 4 个 kind。

### 为什么不推荐 C4（删除 L2）

因为**判据是「改动前后真实数据上的行为差异」**（ADR 0007 教训 4），而删除 L2 的
行为差异实测为负：注入包退回 ADR 0014 §一记录的「前 10 位 9 条同族」形态，
且 4 个超预算库失去唯一的收敛机制。**「少就是多」要求先问能不能不存在——
问了，数据说不能；但同一个原则接着指出，L2 里有两条规则能不存在（C5a、无条件替代），
那才是本轮该删的东西。**

### 向后兼容与迁移成本

| 项 | C5a | C2′ | C5b |
|---|---|---|---|
| schema 版本 | **需要 v12**（触发器重建） | 不需要 | 不需要 |
| 存量库 | 迁移时重建 3 个触发器；**存量派生行不受影响** | 无 | 无 |
| 加载期守卫 | 不受影响 | **实测仍绿**，见下 | 不受影响 |
| `packetOverflows` 容器 | 不变 ⇒ T1..T5 不受影响 | 不变 ⇒ T1..T5 不受影响 | 不变 |
| 需改的测试 | D9 的 provenance 无关性断言 | `queryInjectionRows` 的替代语义断言 | rollup 输入顺序断言 |

**C2′ 对加载期守卫的影响已实测**（这是 ADR 0007「守卫必须建模运行时真正的容器」
要求的那一步）：

```
$ node .audit-c/guard.mjs

cheapestEntryTokens = 4   INJECT_PACKET_BUDGET_TOKENS = 1400
SHIPPED worstInjectionPacketTokens() = 1361   margin = 39

C1 fallback shape: E=40 -> 1361 tok
C2 ceiling shape : E=80 (cap 80) -> 1371 tok  fits
  E= 40 -> 1361 tok  ok
  E= 80 -> 1371 tok  ok
  E=160 -> 1391 tok  ok
  E=200 -> 1401 tok  THROWS
```

C2 把每侧的条目上界从 `INJECT_TOP_N` 抬到 `INJECT_TOP_N * 2`（派生 + raw），
整包 `E ≤ 80`，实测 **1371 ≤ 1400，守卫仍绿，余量 39 → 29**。
**但 `E=200` 即 THROWS，余量只剩 29** ⇒ 必须同步更新
`worstPacketTokens` 的 `fallbackHits` 构造，让守卫**按新的 E 上界定价**，
否则它会以旧前提报绿灯——**那正是 `queryInjectionRows` 注释里
「derived branch used to be unbounded」记录过的同一个假绿灯**。

## 风险与前置条件

1. ⛔ **C2′ 需要一个今天不存在的事实：「这条 raw 行被哪次 rollup 消费过」。**
   `memories` 表没有这个列，`jobs.payload` 只存 `expectedRevision`/`provider`/`model`。
   可选实现：(a) 新增 `rolled_up_at` 列——但这是**第二处记录同一事实**，
   与 D7–D9 相悖；(b) 注入时重算 `withinTranscriptBudget(queryInjectableSet(200))`
   ——**零新增状态，但把一段写路径逻辑搬到了毫秒级读路径上**，
   违反 §4.1「一条毫秒级 SQL」。**两者都有代价，此项须先出方案再实施**，
   不要在本轮顺手做掉。**如果 (a)(b) 都不可接受，退回朴素 C2 并接受冗余，
   收益从「+4 个 kind」降为「+2~5 条同族」——那个折扣要明说，不能含糊。**

2. **C5a 会削弱 D9 的一条真实保证。** 今天的 D9 保证「任何 raw 变化 ⇒ 层失效」，
   这是 ADR 0007 依赖过的性质。收紧后，一条 `tool-output` 行的写入不再使层失效——
   **该行确实不影响 rollup 输入，但它会影响 `memory_recall` 的结果**
   （召回路径对所有 provenance 开放）。需确认：**派生层从不参与召回**
   （`queryRecallRows` 无 `derived` 过滤，会命中派生行）——
   **这一点我未实测，是 C5a 的前置阻塞项**，必须先证伪「召回会读到一个
   与 raw 已不一致的派生行」。

3. **本审计的所有 uptime 数字有一个上界性质。** 反事实 76.3% 假设
   「层被杀后在下一次 rebuild commit 时立刻回来」，而 rebuild 只在 6 小时维护
   周期入队 ⇒ **真实重建延迟更长，76.3% 是乐观上界**。杀死时刻是精确的，
   恢复时刻不是。

4. **单库偏差已控制但未消除。** `idle` 结论覆盖全部 6 个持层库（一致），
   rollup 覆盖率结论覆盖 7 个非空库（28.6%–100%，方差大）。
   **`aafbf0fa` 只有 1 条可注入行，`2631a175`/`7048f15b` 为 0**——
   这三个库对任何方案都无差别，不应计入收益统计。

5. **ADR 0010 的归因缺陷仍未修，且它是 L2 一切偏斜的上游。**
   本库 251 条 active raw 中 212 条（84.5%）是 `tool-output`，
   在 rollup 输入和注入包里都不存在。**C2/C5 都不触碰这一点**——
   它们是在一个被掏空 84.5% 的集合上做优化。**这必须写下来**，
   否则下一轮会有人拿「注入包终于填满了」当作记忆系统健康的证据。

6. **测试会红，且应当预期。** `inject.test.mjs` 与 `layers.test.mjs` 中
   锁定「派生行完全替代」语义的断言会失败。按仓库既有判据
   （ADR 0014 §七「区分钉住不变量与钉住当前行为」）处置：
   那些断言钉的是**当前实现的形状**，不是不变量。

---

# 附录 A：按裁定项 A 新事实的修订

- 日期：2026-09-07（同日复核）
- 触发：裁定项 A 审计给出两条新事实（rollup 输入被饿死；L2 双峰寿命 + reconcile 清零）

> **本附录做三件事**：(1) 更正本文自身的两处读数；(2) 反驳新事实里的一处归因；
> (3) 在新前提下重新裁定 C2/C3/C4 并回答三个问题。

## A.0 先更正我自己：本文正文有两处读数不够严谨

**更正 1：寿命应取 `created_at ∪ updated_at` 双轴，正文只取了单轴。**
新事实指出 INSERT 与 UPDATE 都触发 D9，这是对的，我正文的 `d9.mjs` 只用了
`max(created_at, updated_at)` 的单值，会漏掉「同一行先 INSERT 后 UPDATE」的第一次触发。
按双轴重算：

```
$ node .audit-c/lifetime2.mjs .audit-c/db.sqlite

TWO-AXIS lifetime  n=24  min=22s  p25=38s  median=63s  p75=17545s  max=60114s
under 60s: 12/24   under 5min: 14/24

bimodality check (sorted seconds):
22  26  29  30  35  38  38  44  49  52  52  55  63  146  1.9h  2.8h  3.1h
3.7h  4.9h  5.2h  10.2h  11.3h  11.4h  16.7h
```

**与新事实给出的 n=24 / min=22s / p25=38s / median=63s / p75=17545s / under-60s 12/24
逐项吻合。双峰形态也确认**：13 个样本 ≤63 秒，随后直接跳到 1.9 小时，中间是空的。
**我正文写的「中位寿命 1.3 分钟 vs 170.1 分钟」在方向上对，但那是单轴读数，
双轴的正确中位是 63 秒。以本附录为准。**

**更正 2（更重要）：C5a 的收益被我高估了。**
正文写「47.7% → 76.3%」，那是单轴。双轴重算：

```
$ node .audit-c/recon.mjs .audit-c/db.sqlite   （节选）

=== C5a counterfactual, TWO-AXIS (corrected) ===
today (D9 on ANY raw write)              : 47.6%
if D9 fired only on INJECTABLE raw writes: 62.9%
   (my previous ONE-AXIS estimate said 76.3% — see report correction)
```

**76.3% → 62.9%，我高估了 13.4 个百分点。** 跨库复核后 C5a 的收益更弱：

```
$ node .audit-c/c5a2.mjs

store       today   C5a:inj
3e857510   100.0%    100.0%
5ed2b4d2    46.3%     61.5%
94394b03    23.8%     23.8%
ec2636fc   100.0%    100.0%
edf7a686   100.0%    100.0%
global.s    70.4%     70.4%
```

**6 个库里 C5a 只改善 1 个。** 其余 5 个纹丝不动——它们的层要么本就 100%，
要么（`94394b03` 23.8%）由可注入行杀死，C5a 够不着。
**C5a 从「收益最大的一步」降级为「只对一个库有效的局部优化」。**

> 这正是 ADR 0007 教训 3 的形状，而我在正文里引用了那条教训却仍然踩了它：
> **我用一个库的反事实推断了一个全局收益。**

## A.1 反驳：`reconcile` 并非「派生层必死」的成因，但真相比新事实更糟

新事实称 `reconcile.ts:233` 的 `activate.run()` 无条件执行 ⇒ 每跑一次 reconcile 派生层必死。
**结论（层会死）对，归因（activate 是凶手）不准确。** 实测：

```
$ node .audit-c/recon.mjs .audit-c/db.sqlite   （节选）

=== killer event: INSERT vs UPDATE ===
{ "INSERT / NOT-injectable": 10, "INSERT / injectable": 14 }

=== Does an UPDATE-shaped kill coincide with a reconcile job commit? ===
reconcile jobs done: 48
kills within 120s of a reconcile commit: 21 / 24 = 87.5%
```

**24 次杀死全部是 INSERT 形态，没有一次是 UPDATE 形态**——但 87.5% 发生在
reconcile 提交前后 120 秒内。两个事实并存，只有一种解释：**杀死层的是 extract 写入
`candidate` 行的那次 INSERT，它发生在 reconcile 之前**；等 `activate` 跑到时，
层早已不存在，所以它的 UPDATE 从来没有机会成为「凶手」。

在 scratch 副本上逐步验证：

```
$ node .audit-c/pipekill.mjs .audit-c/s2.sqlite

start: {"d":3,"r":"675"}

--- STEP 1: extract INSERTs a CANDIDATE row (status=candidate, derived=RAW) ---
after candidate INSERT: {"d":0,"r":"676"}  <== D9 fired on a row that is NOT EVEN ACTIVE
replanted layer     : {"d":1,"r":"676"}

--- STEP 2: reconcile activate.run() flips candidate -> active (UPDATE) ---
after activate UPDATE : {"d":0,"r":"677"}  <== D9 fired AGAIN, same logical memory

--- STEP 3: reconcile DROP path (candidate -> superseded) on a second row ---
after DROP UPDATE     : {"d":0,"r":"679"}  <== even DISCARDING a candidate kills the layer
```

⛔ **三个发现，都比新事实的版本更严重：**

1. **D9 在 `candidate` 行插入时就触发。** 一个 `status='candidate'` 的行
   **在任何读路径上都不存在**——`queryInjectableSet`、`queryAllMemories`、
   `queryInjectionRows` 全都过滤 `status='active'`。**一条对所有读者都不可见的行，
   删除了整个派生层。**
2. **一次 extract→reconcile 循环至少触发两次 D9**（INSERT 一次、UPDATE 一次），
   而这两次针对的是**同一条逻辑记忆**。
3. **连 `drop`（模型判定候选无价值）也会杀层。** 流水线决定「这条不值得记」，
   代价是删掉整个摘要层。

**所以新事实说的「产生重复的流水线，同时也是删除补救层的流水线」——这句话是对的，
且比它自己以为的更强：删除发生在流水线判断出结果之前，与判断结果无关。**

这也解释了 A.0 里 C5a 收益为何被高估：`candidate` 行的 provenance 继承自
extract 的 `provenanceFor`，**可以是 `human`**（实测 killer 里 `human` 8 次），
于是 C5a 的 provenance 过滤拦不住它。

**⇒ C5a 必须修正为 C5a′：D9 的触发条件应同时要求「可注入 provenance」与
「该写入实际改变了可注入集」。** 最小实现是加 `status` 条件——
`candidate`/`superseded`/`tombstone` 的写入不应使层失效，因为
**rollup 的输入集按定义看不见它们**。这不是新规则，这是让 D9 与
`queryInjectableSet` 的谓词**成为同一个谓词**——正是 D7–D9「一条规则一个实现」。

> 我未能给出 C5a′ 的可信收益数字：`memories` 只存当前 `status`，
> 无法复原「写入当时是什么状态」。我尝试过用当前 status 近似，得到
> `5ed2b4d2` 105.2% 这种大于 100% 的荒谬值（`c5a2.mjs` 第三列），
> **该列已作废，不要引用**。**C5a′ 的收益必须用构造 fixture 实测，不能从历史数据反推。**

## A.2 回答问题 1：新前提下 C2/C3/C4 是否还成立

### C2：**成立性下降但未被证伪；它的角色从「止血」降为「兜底」**

新事实的论证是：闲置 880 的成因是 rollup 只见 10 行 ⇒ C2 是下游补丁。
**前半句我完全同意并已独立复现（正文 §2 的 `rollupinput.mjs` 与新事实逐项一致）。
但「所以 C2 是打补丁」这个推论，只在「上游可修」时才成立。** 见 A.3：上游**不可**
通过调窗口修好。

更关键的是一个新事实没有覆盖的场景：**L2 有 47.6% 的时间根本不存在。**
在那 52.4% 的时间里，注入包走的是 raw fallback 分支，**C2 与 C1 完全等价**。
所以 C2 真正影响的只有「层活着的那 47.6%」，而它在那段时间里做的事——
把 880 tokens 用于装载 rollup 从未见过的 coding/procedure——
**恰好是修复「模型只见过 10 行」这一后果的唯一读路径手段。**

**重新定位**：C2 不解决「rollup 输入被饿死」，它解决**「饿死的后果不必传导到模型」**。
上游 25 条从未进摘要的行，C2′ 让其中 4 条直接以原文进包（正文实测
`C2-skip-summarized` 7 条覆盖 4 个 kind）。**这不是打补丁，这是承认
「摘要不完备时，原文应当补位」**——而完备性实测只有 28.6%。

**但优先级下调**：C2 需要「哪些行被 rollup 消费过」这个今天不存在的事实
（正文风险 1），成本高而收益只在半数时间生效。**改为第三优先。**

### C3：**依然被证伪，且新事实使它更不成立**

正文已证 C3 恒真（L2 存在 ⇒ raw 装不下）。新事实不改变这一点，反而加强：
既然 rollup 只见 10/35 行，那么「raw 装不下」不仅恒真，而且**差距在扩大**
（35 行 7132 tok vs 预算 1300）。**C3 维持否决。**

### C4：**从「否决」上调为「部分成立」——新事实实质性削弱了 L2 的价值论证**

正文否决 C4 的理由是「L2 是目前唯一实际收敛了 audit-first 族的机制」。
**新事实揭示这个收敛是偶然的副产品**：L2 之所以收敛了那一族，
**正是因为窗口里除了那一族几乎没有别的东西**。它不是在「选择性地收敛重复」，
它是在「总结它碰巧看到的东西」，而它看到的碰巧全是重复。

**换言之：L2 看起来在解决 ADR 0014 的问题，其实是被 ADR 0014 的问题喂养的。**
一旦写期收敛落地（ADR 0014 修法 1/2），那一族塌缩成 1 条，
**L2 的这份「功劳」随之消失**——而它的复杂度不会。

我在正文里把「L2 收敛了那一族」当作它的价值证据，**这个论证在新前提下不再成立，
我撤回它**。C4 剩余的反对理由只有一条，但仍然有效：4 个超预算库
（`3e857510` 3007 / `ec2636fc` 1808 / `edf7a686` 1916 / `5ed2b4d2` 7132 tok）
在没有 L2 时会由 `withinBudget` 静默丢弃 30–60% 的行，**「没有人决定丢哪一条」
仍然是真实损害**。所以 **C4 不能立即执行，但应当被正式列为「写期收敛落地后重新评估」的候选**。

## A.3 回答问题 3：窗口该不该调？——**不该，且这是本轮最关键的证伪**

「少就是多」要求先证伪最显眼的修法（ADR 0014 教训 4）。最显眼的修法是
「`ROLLUP_TRANSCRIPT_CHARS` 从 6000 调大」。**实测证伪：**

```
$ node .audit-c/window.mjs .audit-c/db.sqlite

=== Raising ROLLUP_TRANSCRIPT_CHARS: what the rollup would SEE (5ed2b4d2) ===
   cap  rows  pref  cod  proc  fact  inputChars  exchange  vs12000
  6000    10     9    1     0     0        5708      9968       ok
  8000    12    10    2     0     0        7181     11441       ok
 10000    14    10    4     0     0        9522     13782     OVER
 12000    15    10    5     0     0       10678     14938     OVER
 16000    20    10    7     3     0       15308     19568     OVER
 20000    23    10   10     3     0       19669     23929     OVER
   ALL    35    15   16     3     1       27617     31877     OVER

invited reply = ROLLUP_MAX_SCENARIOS*(30+60+620) = 4260 chars
LLM_MAX_TOKENS = 12000
=> to let the rollup SEE all 35 rows the exchange must reach 31877, i.e. 2.66x over the cap.
```

⛔ **三条独立理由，任何一条都足以否决调参：**

1. **8000 就是天花板。** `LLM_MAX_TOKENS = 12000` 已被 `constants.ts` 用
   「最坏交换」反解锁定（该文件记录了它从 4000→8000→12000 的三次上调史，
   每次都因回复被截断而 dead-letter）。窗口调到 10000 即
   `exchange 13782 > 12000`，**直接复现那个已被修过三次的截断缺陷**。
   要看全 35 行需要 2.66 倍的 LLM_MAX_TOKENS。
2. **即使放开窗口，`procedure` 要到 16000 才进得来，`fact` 永远进不来**
   （只有 `ALL` 那一行才有 fact=1）。**调参改变不了「按 provenance 排序 ⇒
   同族先入」这个顺序缺陷**，它只是把截断点往后挪。
3. **就算全部看见，`ROLLUP_MAX_SCENARIOS = 6` 卡住输出**：35 行、4 个 kind
   要压进 6 个 block。**输入端的修补撞上输出端的另一个常量。**

> 这与 ADR 0007 第 2 轮「收窄 `ROLLUP_TARGET_CHARS` 即可」被全仓 grep 推翻、
> ADR 0014 §四「调大 `RECONCILE_EXISTING_LIMIT`」被实测降级为次因，**是同一个形状的第三次出现**：
> **一个看起来正相关的参数，不是这条路上正在起作用的那把尺子。**

### 但根因也不是「窗口」，而是排序——且**写期收敛单独也修不好它**

我原以为写期收敛能让窗口够用。**实测否定了我自己的假设：**

```
$ node .audit-c/converge.mjs .audit-c/db.sqlite

BASELINE   fed 10/35  {"preference":9,"coding":1}
audit-first family: 13 rows, 7308 chars

AFTER write-time convergence (family collapsed to 1, NO constant changed):
  injectable set  35 -> 23 rows
  rollup SEES     10 -> 6 rows   {"preference":1,"coding":5}
  coverage        28.6% -> 26.1%
```

**收敛后覆盖率不升反降（28.6% → 26.1%）。** 原因：

```
$ node .audit-c/why.mjs .audit-c/db.sqlite

row SIZE by kind (title+body chars):
  preference  n=15  min=315  median= 596  max= 746  total= 8148
  coding      n=16  min=355  median=1087  max=1911  total=16510
  procedure   n= 3  min=618  median= 805  max=1029  total= 2452
  fact        n= 1  min=507  median= 507  max= 507  total=  507

WHOLE injectable set: 35 rows, 27617 chars. Window CAP=6000 = 21.7% of the corpus.
```

**排在后面的 coding 行中位 1087 字符，是 preference（596）的 1.8 倍。**
腾出的 7308 字符只够装下 6 条 coding。**覆盖率的分母是语料总量 27617 字符，
而窗口只有它的 21.7%——这是一个容量问题，不是一个重复问题。**

**⇒ 正解既不是调窗口，也不是只做写期收敛，而是让窗口按 kind 分层取样（我正文的 C5b）。**
它不改任何常量、不动 `LLM_MAX_TOKENS`，只改**分配规则**：
保证每个 kind 有最低配额后再按优先级填充。**这是「一条规则一个实现」的正向应用——
`withinTranscriptBudget` 今天实现的是「按优先级填」，而它需要实现的是
「代表性采样」，因为它的下游（rollup）要写的是覆盖全库的场景块，不是最高优先级的摘要。**

**C5b 从「次轮」升为主修。**

## A.4 回答问题 2：L2 承担的是容量职责还是正确性职责

**容量职责。证据有三：**

1. **它的开关条件是容量**：`packetOverflows` 比较的是 tokens 与预算，
   与内容质量、重复度无关。
2. **它的失效条件与内容无关**：D9 在**任何** raw 写入时删除它，
   包括永不可见的 `candidate` 行（A.1 实测）。一个承担正确性职责的层
   不会被一条不可见的行推翻。
3. **它的产出上限是容量参数**：`ROLLUP_MAX_SCENARIOS = 6`。

**所以你的推论我完全同意，并且愿意把它写成一条判据：**

> **L2 是容量层，不是去重层。期待它解决重复，等于用一个 47.6% 时间在线、
> 由不可见行随时清零的机制，去承担一个必须始终成立的不变量。**

这也解释了 ADR 0014 §一那个「L3 画像不是缓解剂」的观察——**同型**：
派生层（L2/L3）都被期待过去缓解一个写期缺陷，两次都没兑现。

**⇒ 是的，这支持「先修写期收敛，L2 维持现状」。** 但需两条限定：

- **「L2 维持现状」≠「L2 不动」**。A.1 揭示的 D9 缺陷（`candidate` 行杀层、
  一次循环触发两次）是**独立于写期收敛的正确性缺陷**，应当修，
  且它便宜（触发器谓词）。
- **写期收敛落地后，必须重测 L2 的价值**（A.2 的 C4 部分）。届时它若仍
  47.6% 在线且产出可被 C2′ 替代，「删除优于完善」就该被认真执行。

## A.5 修订后的推荐

**顺序变更：C5b（主修）→ C5a′（正确性）→ 写期收敛（ADR 0014 修法）→ 重估 C4 → C2′（可选）**

| 方案 | 正文结论 | 修订后 | 变更理由 |
|---|---|---|---|
| C5b（窗口按 kind 分层） | 次轮 | **主修** | 实测证明窗口是容量瓶颈（21.7%），调参和写期收敛单独都修不好 |
| C5a（D9 按 provenance） | 首选，+28.6pt | **C5a′，收益 +15.3pt 且只影响 1/6 库** | 双轴更正 + `candidate` 行发现 |
| C2′（混合注入） | 第二 | **第三，可选** | 上游修复后闲置会自然下降；成本高、只在 47.6% 时间生效 |
| C3 | 否决 | 否决 | 不变 |
| C4（删除 L2） | 否决 | **部分成立，写期收敛后重估** | 撤回「L2 收敛了那一族」这一价值论证 |
| 调 `ROLLUP_TRANSCRIPT_CHARS` | 未评估 | **明确否决** | 8000 即天花板；10000 复现已修三次的截断缺陷 |

## A.6 本附录新增的前置阻塞项

1. **C5a′ 的收益无法从历史数据反推**（`memories` 不存历史 status），
   必须构造 fixture 实测。`c5a2.mjs` 第三列（出现 105.2%）已作废。
2. **C5b 会改变 rollup 的输入顺序**，而 `rebuild.ts` 注释明确记载
   「rows arrive in packet order … the truncation follows the ordering that
   already exists rather than inventing a second one」。**分层取样正是在发明第二种顺序**——
   这是一个需要在 ADR 里正面论证的设计变更，不能当作 bugfix 静默落地。
3. **A.1 的三个 D9 发现应单独成 ADR**：它们是正确性缺陷，
   与本文的预算议题（C 项）是两件事，混在一轮里会重演 ADR 0007
   「一轮改动同时动读路径语义与持久化」的教训。
