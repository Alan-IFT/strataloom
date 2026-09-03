# 当前状态

> 最后更新：2026-09-03 · **v0.4.14 待发布**：`schema.ts` 的注释写着
> 「任何派生层都是**整层重建，从不逐行老化**」，而触发器只挡了 `dormant`
> **一个**状态。实测 v10 库：`candidate`/`superseded`/`archived`/`tombstone`
> 在派生行上**全部被接受且持久**——**5 个状态只兑现 1 个**，与 v0.4.13
> 「注释写对了原则，实现只兑现一半」同族。修法是把不变量下沉为
> **schema v11 触发器**（`guard_derived_status` ＋ `guard_derived_status_insert`），
> **纯 `DROP/CREATE TRIGGER`，不重建表**（实测：数据/evidence/FTS 三项计数不变）。
> 🟡 **结构性缺口，今日无实例**：9 库 521 条记忆、派生行 16、非 active 派生行 **0**；
> 可持久性已证实，但需**三个并发条件**同时成立（见下）。
> 测试 256 → **265 / 0 fail**。结项 v0.4.4 **待办 5**。
> ⛔ **本轮推翻了选题里的两条前提**（reconcile 今日够不到派生 id、M4 是等价变异），
> 并**发现方案漏了第三条进入路径**（INSERT）。按本仓惯例**保留原判断＋标注证伪**，见下节。
>
> ⚠️ **降级不可逆（沿用 v0.4.9 先例）**：v11 库被装机的 **0.4.13 及更早**
> （`TARGET_USER_VERSION = 10`）打开会抛
> `MigrationError: store version 11 is newer than supported 10 (downgrade refused)`
> （已实测原文如此）。`StoreRegistry` **fail-open 跳过该库并 warn**
> （`openAllKnown` 逐库 try/catch，数据完好、其余库照常）。后果是**该库注入为空**
> 直到装上 0.4.14。**先升级的机器会让仍跑 0.4.13 的机器打不开共享库**——多机环境请一起升。
>
> 🔴 **代码审查打回 5 项、QA 再打回 2 项必修＋1 建议，均已修**（含数条比原缺陷更隐蔽的）：守卫写对了但
> **对存量库可能根本没生效**（审查）、live 的 INSERT 守卫**完全无行为测试**（QA）——
> 详见下文「审查打回」与「QA 打回」两节。
> **每次工作结束时更新本页**，它是新会话的唯一入口。
>
> ⬇️ 以下 v0.4.13 一节及更早各节仍然有效（v10 库不可被 0.4.8 打开的警告同样仍有效）。

## 🆕 v0.4.14：注释声明的不变量，5 个状态只挡住 1 个（**schema 下沉**）

**本轮结项 v0.4.4 待办 5。**

### 判据：注释写的是「整层重建，从不逐行老化」，实现只覆盖 `dormant`

`src/store/schema.ts` v4 的注释：

```
-- Any derived layer is regenerated wholesale, never aged out row by row (v4).
```

而触发器条件是 `new.status = 'dormant'`。对 v10 库逐状态实测（`derived = SCENARIO`）：

| 目标状态 | v10 实测 | v11 实测 |
|---|---|---|
| candidate | **ACCEPTED（持久）** | REFUSED |
| superseded | **ACCEPTED（持久）** | REFUSED |
| dormant | REFUSED | REFUSED |
| archived | **ACCEPTED（持久）** | REFUSED |
| tombstone | **ACCEPTED（持久）** | REFUSED |

**5 个非 active 状态只守住 1 个。** D9 不响——它按 `OLD.derived = RAW` 触发，
而这些行**本来就已是派生行**。

### 为什么必须下沉到 schema，而不是在读路径加过滤

派生分支是 `derived.length > 0 ? derived : queryInjectableSet(...)`——**短路**。
一条非 active 派生行不只是混进注入包，而是**遮蔽整个 raw 集**：

```
HEAD (guard present)   inject = [ 'REAL MEMORY' ]
mutant (guard removed) inject = [ 'SUMMARY' ]
```

沿用待办 p 的既定结论：**读路径过滤只让行「不可见」，不让它「不可达」**
（`queryRecallRows` 只排除 `EXCLUDED_STATUSES`，故 `candidate`/`dormant`
的派生行照样被 `memory_recall` 吐出来）。注入查询上那个 `AND status = 'active'`
**保留**——它是**存量 v10 库**的纵深防御，而 9 个生产库今天**全部是 v10**。

### 做了什么：一个不变量，三个执行点

**「派生行只能是 active」进入该状态有三条路，故是三个执行点而非一个**：

| 路径 | 触发器 | 少了它会怎样（实测） |
|---|---|---|
| `UPDATE OF status` | `guard_derived_status` | 就地老化，即 v4 那条只覆盖 1/5 的路 |
| `UPDATE OF derived` | 同上（列清单含 `derived`） | **静默丢数据**：提升被接受，D9 `invalidate_derived_update` 随即在**同一语句**删掉该行。带 `OF derived` 时是**拒绝且行还在**，不带时是**行没了** |
| `INSERT` | `guard_derived_status_insert` | 直接生出非 active 派生行。**今日无写入方**（`rebuild.ts` 两处 INSERT 都硬编码 `'active'`），但不变量属于**数据**而非**转移**——D9 的教训 |

**整层 DELETE 不受影响**（实测 `changes=2`）：`rebuild.ts` 的 delete-then-insert
照常，即**整层重建合法、逐行老化不可表示**——正是 v4 注释一直宣称的语义。

**迁移 v10 → v11 是纯 `DROP/CREATE TRIGGER`，不调 `rebuildMemories`。**
触发器是 `sqlite_master` 里的独立对象，不像 CHECK 那样烘焙在建表 SQL 里；
而重建表才是昂贵且有风险的那条路（要关外键、有 evidence 级联删除风险、要重灌 FTS）。
实测：迁移后 memories/evidence/FTS 三项计数不变，`foreign_key_check` 为空。

> **`DROP TRIGGER IF EXISTS` 不是防御性写法，是实测出来的必需品。**
> `migrateV10` 走 `rebuildMemories` → `createMemoryTriggers`（**live 定义**），
> 所以**今天新建的库到达 v10 时已经带着新名字**，裸 `DROP guard_derived_dormant`
> 报 `no such trigger`；而上一版发布出去的存量 v10 库带的是**旧名字**。
> 两条到达路径都要能升，故两个名字都 `IF EXISTS` 地 drop。

### 🔴 本轮推翻的前提（保留原判断 ＋ 标注证伪）

本仓惯例是**保留原判断并标注证伪**，不悄悄改掉。选题里有三处与实测不符：

**① 「事实 C：reconcile 的模型能拿到派生 id，因为 `queryRecallRows` 不过滤 `derived`」——❌ 证伪。**
`runReconcileJob` 的 `existing` 集**不是**来自 `queryRecallRows`，而是自
`15b80b7`（v0.4.9）起来自 `queryAllMemories`，后者**明写 `AND derived = LAYER.RAW`**。
实测把一条 raw 行与一条派生行放进同库，模型收到的 `existing` 只有
`["RAW ROW"]`。**即今天模型根本看不到派生 id。** 该写入方仍然加固了，
但理由是「回复里**万一**报了一个派生 id」与「将来有人再放宽那个窗口」，
**不是**「模型今天拿得到」。

**② 「M4（去掉 `OF derived`）可能是等价变异」——❌ 证伪，它可观测且必须挡。**
两向对照实测：带 `OF derived` 时 UPDATE 被**拒绝、行还在**；不带时 UPDATE 被
**接受**，D9 随即在同一语句把行**删掉**。差别不是「挡不挡得住」，而是
**拒绝 vs 静默丢数据**。M4 实测**被 T2 打红**。

**③ 方案漏了第三条进入路径：`INSERT`。** 方案只给了
`BEFORE UPDATE OF status, derived` 一条触发器。实测在只装 UPDATE 守卫的库上
`INSERT (status='superseded', derived=2)` **被接受且持久**（`persistent bad rows = 1`）。
故本轮**增补了 `guard_derived_status_insert`**。M10（只删这条 INSERT 守卫）
实测**被 T2 与两条既有迁移测试打红**——它不是摆设。

### 📌 lead 自陈的 fixture 顺序错误：已独立复现，确认更正成立

lead 原先的复现 fixture 把**摘要建在 `forget` 之前**并声称能复现；这是**错的**，
因为 `forget` 本身是对 raw 行的 UPDATE，满足 D9 `invalidate_derived_update` 的
`OLD.derived = RAW`，**在 forget 那一刻就把派生层删光了**。原始贴出的
`derived rows before: 1` 是在 forget **之前**量的。A/B 对照已确认评审的更正成立。

> **教训（扩写版，本轮再次被它咬到）**：D9 有 **INSERT/UPDATE/DELETE 三个**触发器。
> v0.4.12 记的经验只写了「摘要必须最后插入」——**那只防住 INSERT 一路**。
> 凡 fixture 里在摘要之后还有任何 raw 行的 **UPDATE 或 DELETE**，摘要照样会在
> 断言跑到之前就没了。**本轮写 T4 时正是栽在这条上**：把 `raw-keep` 的 INSERT
> 放在派生行之后，派生层被整删，`after v11 ... 'candidate'` 断言报
> `Missing expected exception`。修法是把**全部 raw 写入排到派生行之前**。
> 判定一个 fixture 是否安全，要问的不是「摘要是不是最后插入的」，而是
> **「摘要之后还有没有任何 raw 行的增/改/删」**。

### 配套判断：`supersedeOld` 加谓词，`propose` 也加，但两者性质不同

**这不是「一条规则两个实现」**：触发器说的是**数据可以处于哪些状态**（不变量，
对一切写入方生效，包括还没写的）；SQL 谓词回答的是**这个写入方该不该去碰这一行**
（资格judgement，`supersedeOld` 本来就已经在问「是不是 active」「是不是 preference」
两个同类问题）。**两者角色不同，且差别可观测**——这正是它挣到位置的地方：

不加谓词时，回复里一个派生 id 会让触发器 ABORT，而 reconcile 的**整批是一个事务**（D6），
于是**整批候选全部回滚**——实测连**决策本身完全正常的 c1** 一起丢，随后 job 烧掉重试
配额走向 dead letter。加了谓词，该决策**降级为普通 activate**，走的是「目标不可被
supersede」**本来就已存在**的那条路。

**崩一个 job 与静默损坏，哪个是我们想要的？** ADR 0006 的既定判例是
**「维护失败不得连坐流水线」**——一个环节坏掉不该带走本来没问题的工作。
一批因为一个坏 id 而整批中止，正是同一个连坐，只不过发生在 job 内部。
故**两者都不选**：靠触发器保证不静默损坏，靠谓词保证不连坐。

`service.ts` 的 `propose({replaces})` 同样加了 `AND derived = LAYER.RAW`，
**但如实登记为等价变异**（见下 M7）：它**今天不可达**，因为 INSERT 先落地且是
raw 写，D9 已把整个派生层删光，UPDATE 无论带不带谓词都匹配 0 行（实测两向皆
`changes = 0`）。之所以还是加——**「今天够不到」在本仓是明确判过不成立的免罪理由**
（待办 p），且这个保证来自 **D9 的语句顺序**而非这个写入方本身，
将来有人调换这两条语句就会把缺陷悄悄交回来。

### 变异矩阵（每条都改产品代码 → 重新 build → 跑**全量**）

最终基线（审查＋QA 修复后）**265 / 0**。变异全部在 `/tmp` 副本上做，还原后复跑确认读数回到基线。
两向读数里的基线数随轮次变化（262 → 263 → 265），已逐条标注。

**口径说明**：`schema.ts` 里同一条触发器有**两份定义**——`createMemoryTriggers`
（**live**，每次表重建都会重装）与 `migrateV11`（**冻结副本**）。凡改触发器的变异，
下表**一律注明改的是哪一份**：只改一份而全绿，说明另一份在替它兜底，
**那是覆盖缺口而不是安全**（M2 与 M4 都栽在这上面）。

| # | 改了什么（改哪份定义） | 读数 | 结果 |
|---|---|---|---|
| M0 | CONTROL（不改） | 263/263/0 | ✅ 全绿 |
| M1 | 删 `queryInjectionRows` 的 `AND status = 'active'` | 262/261/**1** | ☠️ **T1** |
| M2 | 退回只禁 `dormant`（**仅 live**） | 262/261/**1** | ☠️ **「LIVE trigger set」** |
| M2b | 退回只禁 `dormant`（**仅冻结副本**） | 262/259/**3** | ☠️ T2 ＋ 两条迁移测试 |
| M3 | `new.derived = LAYER.SCENARIO`（只挡 L2，**两份**） | 263/262/**1** | ☠️ **T2**（`DERIVED_LAYERS` 循环） |
| M4 | 去掉 `OF derived`（**两份**） | 262/261/**1** | ☠️ **T2**（**非等价变异**，见证伪 ②） |
| **M4-live** | 去掉 `OF derived`（**仅 live**） | **修前 262/262/0 存活** → **修后 263/262/1** | ☠️ **「LIVE trigger set」**（审查发现，见下） |
| M5 | 删 `supersedeOld` 的 `derived === LAYER.RAW` | 263/262/**1** | ☠️ **T5**（评审警告会静默存活的那条，**确认真的红**） |
| M6 | 去掉 `derived != RAW` 条件（误伤 raw 行，**两份**） | 39+ fail，`e2e` 挂死 | ☠️ **T3** ＋ 全域崩塌 |
| M7 | 删 `propose({replaces})` 的 `AND derived = LAYER.RAW` | 262/262/0 | ⚪ **等价变异**（已证行为不可区分） |
| M8 | `new.status` → `old.status`（形状对、意图架空，**两份**） | 100+ fail | ☠️ T2/T1 ＋ 全域 |
| M9 | `new.derived` → `old.derived`（提升路径失守，**两份**） | 85+ fail | ☠️ T2/T1 ＋ 全域 |
| M10 | 删掉 INSERT 执行点（**两份**） | 263/260/**3** | ☠️ **T2** ＋ 两条迁移测试 |
| M11 | `supersedeOld` 的判据改成恒真 `!== undefined` | 262/261/**1** | ☠️ **T5** |
| **X3** | `TARGET_USER_VERSION` 退回 **10**（迁移写好但没库到得了） | **修前 262/262/0 存活** → **修后 263/262/1** | ☠️ **「EXISTING v10 store」**（审查发现，**最严重**） |
| **X1** | reconcile commit 内加 `DELETE FROM memories WHERE derived != RAW` | **修前 262/262/0 存活** → **修后 263/262/1** | ☠️ **「no raw write」**（审查发现） |
| **X2** | 删掉 T5 stub 里的 `insertDerived`（**抽掉 fixture 自身前提**） | **修前全绿** → **修后 263/261/2** | ☠️ T5 ＋「no raw write」（property 3 现在真的在钉） |
| **N19** | live **INSERT** 守卫退回 dormant-only（**仅 live**） | **修前 263/263/0 存活** → **修后 264/263/1** | ☠️ **「LIVE trigger set」**（QA 发现） |
| **N8** | live **INSERT** 守卫 `WHEN` 架空为 `1 = 0`（**名字与计数都不变**） | **修前 264/264/0 存活** → **修后 264/263/1** | ☠️ **「LIVE trigger set」**（QA 发现） |
| N9 | live INSERT 守卫**整条删除**（名字消失） | 263/261/**2** | ☠️ v5→v6 / v6→v7 的**触发器计数**断言（**对照组**：见下） |
| **N4** | `supersedeOld` 判据改成 `!== LAYER.SCENARIO`（放行 L1/L3） | **修前 263/263/0 存活** → **修后 264/263/1** | ☠️ **T5**（QA 发现，fixture 退化第 7 次） |
| **N1** | 两条 live 守卫 `RAISE(ABORT)` → `RAISE(ROLLBACK)`（**仅 live**） | **修前 263/263/0 存活** → **修后 265/264/1** | ☠️ **「ABORT…the live definition」**（QA 建议项，已补测） |
| N1c | 同上，**仅冻结副本** | 265/264/**1** | ☠️ **「ABORT…the v11 migration copy」** |

### 🟠 QA 打回的 2 项必修 ＋ 1 项建议（全部已修）

#### 必修 1：live 的 **INSERT** 守卫**完全没有行为测试**（N8 / N19 双双存活）

**根因是执行点不对称。** live 专测覆盖了 `UPDATE OF status` 与 `UPDATE OF derived`
（两者共用一个列清单），**唯独漏了 INSERT**——而 `guard_derived_status_insert`
是**独立的第二个触发器**。T2 走的是 `migrateV11` 的**冻结副本**，看不见 live 定义。
于是 live 的 INSERT 守卫**没有任何测试**。

复现（只退回 **live** 的 INSERT 守卫，冻结副本不动）：全量 **263 / 263 / 0 全绿**，
而同一构建下真实行为已漏 4/5：

```
{"candidate":"ACCEPTED (BAD)","superseded":"ACCEPTED (BAD)",
 "dormant":"refused","archived":"ACCEPTED (BAD)","tombstone":"ACCEPTED (BAD)"}
persistent bad rows: 4
```

> **教训：现有防线只「数触发器」，不「验行为」。**
> N9（**整条删掉**，名字消失）会被 v5→v6 / v6→v7 的**计数**断言抓到（实测 263/261/2）；
> 但只要**名字还在**、`WHEN` 被架空（`1 = 0` 或退回 dormant-only），
> **计数照样对、全量照样绿**（N8/N19 实测）。
> **N9 与 N8/N19 的这组对照，正是「计数不是行为」的判据。**
> 后果不是理论的：`rebuildMemories` 重装的就是 live 集合，
> **下一次加宽任何 CHECK 的迁移都会把被削弱的 live 定义静默装回去。**

#### 必修 2：T5 的 fixture 只钉住 SCENARIO 一层（N4 存活）——**fixture 退化第 7 次**

`insertDerived` 默认 `layer = LAYER.SCENARIO`，T5 从未传别的层。于是把
`supersedeOld` 的判据改成 `!== LAYER.SCENARIO`（**放行 L1 SUMMARY 与 L3 PERSONA**）
**263 / 263 / 0 全绿存活**。已改为**对 `DERIVED_LAYERS` 循环**（与 T2 同一写法），
每层各开一个干净库。

#### 建议项 3：`RAISE(ABORT)` 的选择无测试（N1 存活）→ **判断是补测，不是登记**

**理由：这不是拼写，是一个被论证过的决定，而论证只写在注释里。**
`reconcile.ts` 花了大段篇幅援引 ADR 0006 论证「一个坏 id 不得连坐整批」，
而那个结论**只在动词是 ABORT 时成立**。实测两者差异（用 `jobs` 表做无关写入，
避开 D9）：

```
RAISE(ABORT   )  COMMIT ok      | the job row survived: true
RAISE(ROLLBACK)  COMMIT FAILED  | the job row survived: false
```

即 ROLLBACK 会**连坐销毁同一事务里的 job 记账写入**——正是 ADR 0006 明令禁止的形态。
「今天到不了」在本仓不是免罪理由（待办 p），且此处**代价极低**，故补测而非登记。

> ⚠️ **补测过程中又踩到同一个坑，记下来**：第一版测试只用 `openRegistry()`
> （当前 target ⇒ **冻结副本**），结果 **N1 仍然存活**（264/264/0）——
> 与 N8/N19 是**同一个 live/冻结不对称**。已改为**对两份定义各跑一遍**
> （`target = 10` 够到 live，默认 target 够到冻结副本），N1 与 N1c 各自被对应那条杀死。
> **判据：凡涉及触发器语义的测试，必须两份定义都跑。**

#### ⚪ 如实登记为等价／准等价，不补测试

| 变异 | 定性 | 判据 |
|---|---|---|
| **N2**（`BEFORE` → `AFTER`） | 准等价 | 多种观测均无法区分。`BEFORE` 是更省的写法（不必先写再撤），保持现状 |
| **N5**（`status='active'` → `status NOT IN (EXCLUDED_LIST)`） | **今天严格等价** | QA **导入生产常量实测**：`MEMORY_STATUSES` 减 `EXCLUDED_STATUSES` 恰为 `["active"]`。**但写死 `'active'` 是更强的写法**——它不随 `EXCLUDED_STATUSES` 变动而漂移，故保持现状 |
| **N10/N11/N14/N15** | 纯拼写等价 | 不可观测的拼写不该钉进测试（本仓判例） |
| **M7** | 等价 | 已证行为不可区分（D9 先删空派生层）；QA 独立复核确认成立 |

### 🔴 代码审查打回的 5 项（全部已修，两向读数见上表）

#### 1（最严重）：守卫写对了，但对**存量库**可能根本没生效——且无测试会发现

变异 X3：把 `TARGET_USER_VERSION` 退回 **10**（迁移写好、注册好，但没有库到得了）。
**修前实测 262 / 262 / 0 全绿存活。**

根因是**两条到达路径只有一条依赖 `migrateV11`**：

| 路径 | 谁装的触发器 | TARGET=10 时 |
|---|---|---|
| **新建库** | `createMemoryTriggers`（live） | `user_version = 10`，**却已带着 v11 守卫** → 老化被拒 → 测试照绿 |
| **存量 v10 库**（9 个生产库全在此列） | 只能靠 `migrateV11` | **守卫根本没装** → 老化被接受 → **缺陷原样敞着** |

原测试用 `migrate(db,'repo')` **新建**库，正好落在**看不见缺陷的那条路径**上。

> **教训：「守卫写对了」与「守卫生效了」是两个命题，测试必须钉后者。**
> 而本仓已经吃过这一记——原测试的注释**逐字预言了这个失败模式**
> （"Leaving TARGET_USER_VERSION at 9 … was measured to keep the entire suite green"），
> 然后**伸手去拿了唯一观测不到它的 fixture**。**注释写对了原则、代码兑现的是另一件事**
> ——与本轮所修的缺陷、与 v0.4.13，是同一个错误的第三次出现。
> **判据：写「迁移是否生效」的测试，fixture 必须是「存量的旧版本库」，不能是新建库。**

修法：改写为 `'an EXISTING v10 store, reopened at the default target, reaches v11 and is constrained'`
——造真实 v10 库（装回 v4 的 `guard_derived_dormant`），**先断言老化在升级前确实被接受**
（前置条件），再用默认 target 重开并断言被拒。

#### 2 与 3：T5 有两处断言是空转的（**保留原错误并标注**）

**② property 3 断言了与自己注释相反的事。** 原代码：

```js
// Property 3: the derived row is REALLY there on the eve of the commit …
const derivedBefore = …
assert.equal(derivedBefore, 0, 'the summary is planted by the llm stub, mid-job')
```

它跑在 `runReconcileJob` **之前**，此时 stub 还没种下那一行——**断言的是「摘要不在」，
而注释宣称「摘要真的在」**。变异 X2（删掉 stub 里的 `insertDerived`，让派生行**从未存在**）
实测：干净代码与叠加 M5 **都全绿**——即**方案评审要求的那道防线并没有建立**
（M5 之所以被杀是因为抛异常，与 property 3 无关）。
修法：把采样点移进 stub **末尾**（commit 前最后一刻，唯一有意义的时刻），断言 `= 1`。

**③ `if (summary !== undefined)` 把两条断言变成死代码。** 干净路径下 `sum-1` 实测就是
`undefined`（被 D9 删了），故那两条断言**一次都没执行过**。变异 X1（在 commit 内加
`DELETE FROM memories WHERE derived != RAW`，即**销毁整个派生层**）**修前全绿存活**。
修法：删掉空壳，改为**正面断言**「派生行已被 D9 retire」并说明原因。

**X1 需要一条新测试，因为原 fixture 在原理上看不见它。** T5 里 `c1` 会被 activate，
那是一次 raw 写，D9 随即整删派生层——**于是「reconcile 没动摘要」与「reconcile 销毁了摘要」
的终态逐字节相同**。可区分的窗口是**整批零 raw 写**的 commit（所有候选都已离开
`candidate`，`activate` 匹配 0 行，D9 不响，派生层活到事务结束）。故新增
`'reconcile: a commit with no raw write leaves the derived layer standing'`。

#### 4：`schema.ts` 注释「three triggers」与实现不符

实测 `guard_derived*` 触发器数 = **2**（前两条路共用一个 `OF status, derived` 列清单）。
三条路确实都封住了，但**三个执行点 ≠ 三个触发器**。已改为
"three EXECUTION POINTS — carried by TWO triggers"，并注明是数出来的。
**本轮的尺子必须量到自己身上。**

#### 5：缺「降级不可逆」警告 → 已按 v0.4.9 先例补在页首

#### 6（建议项）：live 定义专测漏了 promote 路径

审查实测 **M4-live**（只改 live 定义去掉 `OF derived`）**262 / 262 / 0 存活**——
因为该专测只跑 `SET status = ?`，没跑 `SET derived = ?`。**只改一份定义就全绿，
说明另一份在替它兜底**，而 `rebuildMemories` 装的正是 live 那份。已补 promote
路径断言（含「拒绝而非删除」）。同时**变异矩阵已统一注明每条改的是哪份定义**——
原表只有 M2/M2b 作了区分，M4 没有，属口径不一致。

**M7 如实标注为等价变异，不补测试。** 已实测证明其**行为不可区分**而非仅仅未被覆盖：
`propose` 在同一事务里**先 INSERT 一条 raw 行**，D9 `invalidate_derived_insert`
当场删空派生层，随后的 UPDATE 带与不带谓词**都是 `changes = 0`**。
本仓判例是**不可观测的拼写不该钉进测试**——要为它造红，只能去测「D9 的语句顺序」，
那是另一条规则的测试，钉在这里会变成一条**名不副实**的测试。

### 取数陷阱（本轮新增两条）

- **M2 一开始「存活」，不是测试没写对，而是它测不到。** `migrateV11` 跑在**最后**，
  它那份**冻结副本**会覆盖 `createMemoryTriggers` 装的东西，于是 **live 定义对
  其余每一条测试都不可见**——把 live 定义退回旧语义，全量 **262/262 全绿**。
  而 `rebuildMemories` 装的正是 **live 定义**，所以下一次任何加宽 CHECK 的迁移
  都会把当时的 live 定义重新装上：live 定义一旦被削弱，缺陷会在下次重建时**无声复原**。
  故补了一条专测 live 定义的测试，用 `target = 10`（最后一步是重建、且之后无迁移覆盖）够到它。
- **迁移测试的 fixture 必须还原「真实的 v10 库」，而不是 `migrate(db,'repo',10)` 的产物。**
  两者**不是一回事**：后者由今天的 build 装上 live 触发器，**已经带着 v11 的守卫**。
  真实 v10 库是**上一版发布**写的，带的是 v4 那条 `guard_derived_dormant`。
  T4 里显式把旧触发器装回去，否则它测的是一个**从未存在过的库**（前置断言会直接失败——
  实测第一版就是这样红的）。
- **（审查／QA 补充）「只改一份定义就全绿」永远是覆盖缺口的信号，不是安全的证明。**
  本轮**栽了四次**：M2、M4、N8/N19、N1——每次都是只改 live 定义就全绿，冻结副本替它兜底。
  **凡同一规则有两份定义，变异必须分别只改一份**——两份一起改是最弱的变异，
  它连「哪一份在真正生效」都回答不了。本轮变异矩阵已按此口径标注每一条。
  **推论（写测试时用）：凡涉及触发器语义的测试，必须对两份定义各跑一遍**
  （`target = 10` 够到 live，默认 target 够到冻结副本）。补 N1 测试时第一版
  只跑了冻结副本，N1 照样存活——同一个坑当轮踩了第二次。
- **（QA）「数触发器」不是「验行为」。** 把守卫**整条删掉**会被既有的触发器**计数**
  断言抓到（N9：263/261/2），于是很容易误以为这条防线管用；但只要**名字还在**、
  `WHEN` 条件被架空（`1 = 0`、或退回 dormant-only），**计数照样对、全量照样绿**
  （N8/N19：263/263/0，而真实行为已漏 4/5、留下 4 条脏行）。
  **判据：一个只检查「对象存不存在」的断言，永远挡不住「对象还在但不干活」。**
- **判断一条测试是否在钉住某件事，去抽掉它的前提，而不是去看它的断言。**
  T5 的 property 3 断言写得很像回事，注释也说得很确定，但把 fixture 的前提
  （那行 `insertDerived`）整行删掉之后，它**照样全绿**——即它从未钉住任何东西。
  **「抽掉前提仍然绿」是空转断言的判定方法**，比重读断言可靠。

### 本轮登记的待办

| # | 事项 | 现状（实测 2026-09-03） | 处置判据 |
|---|---|---|---|
| 1 | **存量 v10 库里若已有非 active 派生行，v11 迁移不会拒绝也不会清理** | 9 库实测该类行 **0**，故今日无影响 | 迁移是纯触发器 DDL，**不校验存量数据**——与 v10 的做法（`INSERT ... SELECT` 撞 CHECK 则整体回滚）不同。今天两者等价仅因存量为 0。若将来真出现这类行，它会**留在库里**并继续被注入查询过滤掉；要改成迁移期清理，须先想清楚「删一行用户数据」是否该由迁移擅自决定 |
| 2 | **`queryInjectionRows` 的 `AND status = 'active'` 现在是纵深防御，不是唯一防线** | v11 后新库不可能有该类行；但 9 个生产库**全部还在 v10** | **不要因为「schema 已经保证了」就删掉它**——存量库升级前它是唯一防线。等到全部库都到 v11 之后，删它才是安全的，且届时应由**一次实测**（全部库 `user_version = 11`）而非推断来决定 |

---

> 【v0.4.13 发布说明，原文保留】`forget`
> 从不刷新工作区投影——D5 明写要关闭的**四个**读取面里，`（recall/context/派生/
> 投影）`的最后一个**没有任何执行点**。库里 title/body 已清空，同样的字节仍完整
> 躺在 `<workspace>/.repo_memory/memories.md`。修法是**新增一个私有方法
> `refreshProjection`，把投影收敛成唯一写入点**，`share` 与 `forget` 都走它。
> 顺带**收窄 `projection.ts` 零行分支的爆炸半径**（原为递归删整个目录）——
> 经证伪后确认这**修的是 HEAD 上已可触发的既有缺陷**，见下文证伪记录。
> 🟡 **执行点缺失，非正在冒烟的洞**：9 个生产库 `team-shareable AND
> human_confirmed=1` 合计 **0**，本机无任何 `.repo_memory/` 目录。
> 测试 248 → **256 / 0 fail**。**无 schema 改动。**
> **第二轮**：代码审查与 QA 独立打回同一个阻断项（**投影写失败会让 `forget`
> 抛错且不可恢复**——本轮自己引入的回归），并证伪了「零行分支是死分支」这条注释
> 断言。两项均已修：**投影失败的处理收敛为「一条规则一个实现」**
> （`refreshProjection` 内单一 `try/catch`，`forget` 吞、`share` 抛）。
> **每次工作结束时更新本页**，它是新会话的唯一入口。
>
> ⬇️ 以下 v0.4.12 一节及更早各节仍然有效。

## 🆕 v0.4.13：D5 点名的四个读取面，`forget` 只关了三个（**投影面无执行点**）

**本轮不结项任何已登记待办**——选题是逐面实测发现的**未登记**缺口。

### 判据：规范逐字列举了四个面，实测其中一个没有执行点

`plugin-architecture.md:99` 写的是：

```
D5  forget 立即关闭全部读取面（recall/context/派生/投影），
```

逐面实测：

| 面 | 执行点 | 状态 |
|---|---|---|
| recall | 查询谓词 | closed |
| context | 查询谓词 | closed |
| 派生 | schema 触发器（D9） | closed |
| **投影** | **无** | **NOT closed** |

`projectStore` 全仓**唯一**调用点是 `service.share()`（实测
`grep -rn "projectStore(" src/` → 1 处）。故 `service.forget()` 之后：
**库里 title/body 已清空，同样的字节仍完整躺在
`<workspace>/.repo_memory/memories.md`**，而 forget 的 note 对用户宣称
`it will not be recalled, injected, or re-learned`——**一句不实陈述**。

> ⚠️ **严重性照实定级：🟡 执行点缺失，不是正在冒烟的洞。** 实测 9 个生产库
> `team-shareable AND human_confirmed = 1` **合计 0**，本机 `find` 不到任何
> `.repo_memory/` 目录——**即今天无人分享过任何东西**。且存在自愈路径：同仓
> 任意后续 `share` 会整表重投影冲掉陈旧行。**修它是因为 D5 明文列举了这个面、
> 且 note 做了不实陈述——不是因为有数据正在泄漏。**
> （本仓有「待办 q 因严重性论证夸大而作废」的前科，不重蹈。）

### 做了什么：一个执行点 + 三道 guard

`.repo_memory/memories.md` 是 `projectStore` 那条 SELECT 的**物化视图**，
住在库外、任何事务都盖不住的文件系统里。新增私有方法
`MemoryService.refreshProjection(store, agent, create): number`——
**投影的唯一写入点**。三道 guard，任一不满足返回 0：

1. `store !== this.storeFor(agent, false)` → 0
2. `deriveWorkspaceRoot(cwd)` 为 `undefined` → 0
3. `!create && !existsSync(join(workspace, PROJECTION_DIR, PROJECTION_FILE))` → 0

`share` 收敛到它（`create = true`），`forget` **在 `commitL1Mutation` 之后**
调用它（`create = false`）。

**条件 1 为什么写 `=== this.storeFor(agent, false)` 而不是 `store.kind === 'repo'`：
不是因为今天更严——今天两者恒等。** `forget` 的 store 来自
`readableStores(agent, true)`，该函数字面上就是
`[storeFor(agent,…), globalStore(…)]`，穷举 6 种输入两个谓词取值全同。
选它是为了**对齐 `readableStores` 上方那段已有的警告**——那段注释警告未来的
「统一 store 列表」式整理会把读能力变成跨仓写能力。若 group member 真被并入，
member store 的 `kind` **同样是 `'repo'`**，`kind === 'repo'` 会放行一次
**向别人仓库 checkout 的投影写入**，而 `=== storeFor(agent, false)` 不会。

**条件 3 承担的是一个不可解问题。** `deriveRepoIdentity` 按 **remote URL** 哈希，
而投影住在**本地 checkout**，所以**一个 store ↔ N 个 checkout**。实测两个 clone
同一 origin：

```
A {key:'6aaf67f4291534525c3f8df8', source:'remote:example.invalid/team/proj'}
B {key:'6aaf67f4291534525c3f8df8', source:'remote:example.invalid/team/proj'}
same key: true
```

**没有任何 guard 能从 store 反推出「哪个 checkout 持有投影文件」。** 条件 3
不去回答那个无解的全局问题，只回答一个本地永远有确定答案的问题：
*我这里有没有一份归我维护的物化视图*。**`existsSync` 在这里不是把文件变成输入**
（ADR 0001 禁止的是那个）——分支两侧写出的内容完全由库决定，**文件内容对结果零影响**，
只有它的「在不在」在选择「刷新」还是「什么都不做」。

**跨 checkout 陈旧是继承来的局限，不是本轮引入的代价。** 实测**未修改的 HEAD** 上，
从 checkout B 执行 `share`，A 的投影文件一直陈旧：

```
after share#1 in A:  A exists = true  B exists = false
after share#2 in B:  A exists = true  B exists = true
  A has alpha: true | A has gamma: false
=> A is STALE on UNMODIFIED HEAD (missing gamma): true
```

条件 3 使 `forget` 与 `share` 的跨 checkout 行为**首次一致**（都只作用于本
checkout）——**这是收敛，不是新增例外**。

### 另一处必改：`rmSync` 的爆炸半径（~~本方案会第一次激活那条死分支~~ → **修 HEAD 既有缺陷**）

`projection.ts` 在 0 行时执行 `rmSync(dir, {recursive:true, force:true})`。
实测递归删除的后果：

```
before: dir contains [ 'NOTES.md', 'memories.md', 'sub' ]
reproject written = 0 (0 => rmSync branch)
dir still exists: false
NOTES.md survives: false
sub/more.md survives: false      <-- 连子目录树一起删
```

`.repo_memory/` 是**签入版本库的目录**，团队可能在里面放 `NOTES.md`/`README.md`/
子目录。改为：0 行时 `rmSync(path, { force: true })` **只删自己写的那个文件**；
随后 `if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir)`
——目录非空就留着。函数 doc 里那句已经不实的
"Removes the directory when nothing qualifies" 一并更正。

> 🔴 **本轮被代码审查证伪的断言（按本仓惯例保留原判断并标注，不悄悄改掉）。**
> 原文写的是：**「实测该分支在 HEAD 上是死分支」「`share` 结构性走不到它——它先
> `looksSecret` 预扫再提升该行，故 `safe.length >= 1` 恒成立」「本轮的 `forget`
> 是第一个能真正走到 0 行的调用方」**。**这三句都是错的。**
>
> **证伪路径**：推理**跨过了一个 `await`**。`share` 在状态检查与 UPDATE 之间
> `await approval.request(...)`（人类审批，可长达数分钟），而那条 UPDATE 带
> `AND status = 'active'`；`runDecayJob` 挂在 `ctx.interval` 上**并发**跑，会把
> 闲置行置为 `dormant`。**审批窗口内睡着的行永远不会被提升**，于是 `share` 自己
> 就投影出 0 行。我用**生产写者原样调用链**（`enqueueJob`/`claimNextJob`/
> `runDecayJob`，非手写 SQL）在**未修改的 HEAD** 上独立复现：
>
> ```
> decay during approval window: {"slept":61,"revived":0}
> share note: Shared. 0 memory/memories now sit in .repo_memory/memories.md; ...
> >>> zero-row branch reached by share on HEAD: true
> >>> .repo_memory dir survived: false
> >>> checked-in NOTES.md survived: false
> ```
>
> **定性因此改变，且对本轮有利**：递归删除**不是本轮才激活的风险，而是 HEAD 上
> 已经存在、会删掉签入版本库文件的缺陷**。`rmSync` 收窄的价值**比原先宣称的更高**
> ——它**修的是既有缺陷**，而不是「预防本方案自己引入的风险」。
>
> **教训**：判定「死分支」时只检查了调用方的**同步**前后条件，没检查
> **`await` 期间并发写者能否改变那些前条件**。凡是跨 `await` 的
> 「检查—使用」序列，其前条件在恢复执行时都必须重新成立才算数——这与本仓
> `immediateTx` 处理 TOCTOU 是同一族问题，只是那次在事务层、这次在 `await` 层。

### 范围判据是「该能力有没有对投影作出陈述」，**不是**「够不够得着 workspace」

后者会被 `propose({replaces})` **正面驳倒**——它确实够得着。明确不改：

| 不改 | 理由 |
|---|---|
| `propose({replaces})` | **它不对投影作任何陈述**；且刷新会**删掉人类批准过的内容而不发布替代品**——替换行是 `visibility='repo-local', human_confirmed=0`，**结构性不可投影**，重投影后 `written=0`，团队文件里那条被批准过的记忆凭空消失。属产品策略问题，需自己的判据（见待办 M） |
| `runDecayJob`（sleep 与 revive 双向） | **结构性够不到 workspace**：实测 `src/pipeline/*.ts` **8 个文件 `cwd` 出现次数全部为 0**。与 D9 同类、却是唯一无法用同一手法解决的实例——D9 用 schema 触发器解决，而 **SQLite 触发器写不了文件**（见待办 N） |
| `runReconcileJob`（supersede→archived） | 同上 |
| `projectStore` 的 SELECT / 三道闸 / 秘密扫描 | 本轮不触碰 |
| `deriveRepoIdentity` 按 remote 哈希 | §2.1 既定设计，不是本轮缺陷（见待办 O） |

### 测试：新增 4 条，改造 1 条被自己掩盖的既有测试

既有测试 `'an approved share promotes, projects the file, and revoking removes it'`
在 forget 后**自己手动调了一次 `projectStore`** 再断言文件没了，注释写着
"Forgetting the shared memory rewrites the projection away"——**那句话描述的是
测试自己做的事，不是产品做的事**。删掉那两行手动调用后，**HEAD 上该测试立刻转红
（247/1）——这正是找到 D5 投影面缺口的那次测量**。按本仓惯例**保留错误并标注证伪**。

- **T1** `forget` 关闭 D5 点名的投影面：分享 alpha+beta，**只调 `service.forget`，
  全程不碰 `projectStore`**，断言 alpha 字节消失**且 beta 仍在**（证明是*刷新*
  不是*删除*）。**并追加一条回滚断言**：对已 tombstone 的 id 再 forget 一次必须
  被拒且**磁盘一字不变**。
- **T2** 两个 clone 同一 origin。先断言
  `storeFor(pA,false) === storeFor(pB,false)`（把「一个 store ↔ N 个 checkout」
  钉成测试里的显式事实），再在 B 里 forget，断言
  `existsSync(join(B, PROJECTION_DIR)) === false`。
- **T3** forget 一条 personal 记忆（global 库）不得触碰 repo 投影（ADR 0001）。
- **T4** `.repo_memory/` 里先放一个手写 `NOTES.md`，再 forget 最后一条已分享记忆：
  `memories.md` 必须消失，`NOTES.md` 必须存活。

**第二轮新增 3 条**（阻断项 1 与建议项，详见下文「第二轮」小节）：

- **T5** `memories.md` 只读（0o400）时 forget 必须**正常返回**（EACCES 走重写路径）。
- **T6** `memories.md` 是**目录**时 forget 必须**正常返回**（EISDIR 走零行 `rmSync` 路径）。
- **T7** 同样写不下去时 `share` 必须**抛错**（发布语义），且**可重试并真的发布**。
- 另加 **B5 结构测试**：`projectStore` 全 `src/` 只允许**一个调用点**，且必须位于
  `refreshProjection` 内。

### 变异矩阵（第二轮重跑：**16/16 全杀**，另 2 条已证等价故不补测试）

每个变异都改**产品代码**、在 `/tmp` 副本里重新 `npm run build`、跑**全量**。

| 变异 | 改什么 | 结果 | 杀死它的测试 |
|---|---|---|---|
| **M0 CONTROL** | — | ✅ 256/0 | — |
| **M1** | 删掉 forget 里的 `refreshProjection` 调用（＝回到 HEAD） | 🔴 252/4 | T1 + T4 + T5 + 既有那条 |
| **M2** | 删掉 store guard（条件 1） | 🔴 255/1 | **T3 单点** |
| **M3** | 删掉 `existsSync` guard（条件 3） | 🔴 255/1 | **T2 单点** |
| **M4** | forget 传 `create = true` | 🔴 255/1 | **T2 单点** |
| **M5** | 恢复递归 `rmSync(dir,{recursive:true})` | 🔴 255/1 | **T4 单点** |
| **M6** | 零行分支整个变 no-op | 🔴 253/3 | T4 + T5 + 既有那条 |
| **M7** | 刷新提前到 `commitL1Mutation` **之前** | 🔴 252/4 | T1 + T4 + T5 + 既有那条 |
| **M8** 🆕 | **删掉 `refreshProjection` 的 `try/catch`**（＝本轮被打回的回归） | 🔴 253/3 | T5 + T6 + T7 |
| **M9** 🆕 | `share` **也吞掉**写失败（发布不诚实） | 🔴 255/1 | **T7 单点** |
| **M10** 🆕 | 恢复「只保护一半」的局部 catch（原实现） | 🔴 253/3 | T5 + T6 + T7 |
| **M11** 🆕 | **B5**：`share` 退回内联调用 `projectStore` | 🔴 254/2 | **B5** + T7 |
| **M12** 🆕 | **B15**：`written` 硬编码为 `1` | 🔴 255/1 | **T1 单点** |
| **M13** 🆕 | **B4**：忽略 `projectStore` 返回值，`written` 恒 0 | 🔴 255/1 | **T1 单点** |
| **M14** 🆕 | **B2**：guard 3 检查**目录**而非文件 | 🔴 255/1 | **T2 单点** |
| **M15** 🆕 | **B1**：guard 1 换成 `store.kind === 'repo'` | ⚪ 256/0 **等价** | 不补测试（见下） |
| **M16** 🆕 | **B10**：`storeFor(agent, false)` → `true` | ⚪ 256/0 **等价** | 不补测试（见下） |

> **「改哪一行会让它红」**（逐条自查，非推断）：
> T5/T6 钉的是 `service.ts` 里 `refreshProjection` 的那个 `try { … } catch`——
> 删掉它（M8）或换回 `projection.ts` 的半包 catch（M10）立刻红；
> T7 钉的是 `share` 里的 `if (!projection.ok) throw`——删掉即红（M9）；
> B5 钉的是 `projectStore(` 在 `src/` 内的调用点计数与所在方法——
> 任何第二个调用点即红（M11）。

> 🔴 **必须记的一次自查失败：按方案原文写出的 T2 让 M3 与 M4 双双存活（252 全绿）。**
> 原因是**方案给的 fixture 退化**：T2 原设计只分享**一条**记忆，于是 forget 掉它
> 之后**剩余可投影行数为 0**，而**零行分支本来就什么都不写**——一个 guard 被删光的
> 构建照样让 B 保持干净，测试绿得毫无意义。**修法是让 T2 分享两条、只 forget 一条**：
> 有一条幸存行，缺失的 guard 才会真的**在 B 里创建**投影文件。改后 M3/M4 各由 T2 单点杀死。
> **这与 v0.4.12「`LIMIT+1` 因 fixture 恰好卡在边界而存活」是同一种 fixture 退化**——
> 本仓第三次被同一族问题咬中：**一条测试若造不出「差异真的会显形」的那个状态，
> 它钉住的就只是自己的 fixture。**

> **M7 的杀手做过单独隔离验证，不是顺带被杀。** 把 T1 前面的内容断言全部剥掉、
> **只留回滚那两行**重跑 M7，仍然红：
> `AssertionError: a refused forget writes nothing to disk`，
> diff 显示被拒的 forget 把 beta 那行重新写进了文件。**文件系统不在事务里**，
> 「刷新必须严格在 `commitL1Mutation` 之后」这条只能由回滚路径来钉。

### 🔴 第二轮打回（代码审查与 QA 独立指向同一处；按本仓惯例，打回与错误都留档）

#### 阻断项 1：`forget` 因投影写失败而抛错，且不可恢复（**第一轮自己引入的回归**）

第一轮的 `try/catch` **只包住了 `readdirSync`/`rmdirSync`**，而 `rmSync(path)`、
`mkdirSync`、`writeFileSync` **全在保护之外**；而 `refreshProjection` 在
`commitL1Mutation` **之后**调用，于是异常发生时 tombstone 已经落库。独立复现
（`memories.md` 是**目录**时 `rmSync(path,{force:true})` 抛 EISDIR，
`force` 只压 ENOENT，**无需特殊权限**）：

```
forget outcome: THREW: EISDIR: illegal operation on a directory
DB row: {"status":"tombstone","title":"","body":""}
retry outcome: THREW: memory 90b8a707-... is already forgotten
=> SPLIT BRAIN + UNRECOVERABLE
```

死胡同链条：模型被告知失败 → 重试 → 被 `already forgotten` 拒绝 →
**被遗忘的字节永久留在签入文件里，且再无任何路径能触发刷新**——恰好复活本轮
要修的那个洞，还附送一条**不实的失败报告**。已确认 HEAD 不抛错，**确系本轮引入**。

> 💡 **本轮最该记住的教训：注释写对了原则，实现只兑现了一半。**
> `projection.ts` 的注释当时已经写着
> **"a forget must not fail because tidying up did"**——**原则完全正确**，
> 但那个 `try` 只套住了目录清理这一个调用，四个文件系统调用里保护了一个。
> **一句正确的注释会让下一个读者（包括作者自己）以为规则已经生效**，
> 从而比没有注释更危险。**判据：当注释声明了一条不变量，必须去数它覆盖了几个
> 执行点**——这与本仓 D7–D9「一条规则两个实现」是同一族，只是这次的第二个
> 「实现」是**注释本身**。
>
> **修法（收敛为「一条规则一个实现」）**：`projection.ts` 里那个只保护一半的
> 局部 catch **整个收掉**（该函数现在**允许抛**），改由 `refreshProjection`
> 内**单一** `try/catch` 兜住 `projectStore(...)` 整体。

**`share` 的语义单独判定，结论是「不吞」**——它与 `forget` 走同一个方法，但
`share` 是**发布**语义。判据不是「发布比删除重要」，而是
**调用方只有在自己那份持久化工作已经成功时，吞掉错误才算诚实**：

| | `forget` | `share` |
|---|---|---|
| 刷新前已落库的事 | tombstone **已提交**（删除**真的发生了**） | 只改了行的 `visibility`；**文件本身就是交付物** |
| 若抛错 | 为**已完成**的工作报告失败，且重试被 `already forgotten` 拒 → **死胡同** | 可重试 |
| 若吞掉 | 诚实：删除确实生效，投影是滞后的物化视图 | **不诚实**：人类批准了「提交给团队」，却报 "Shared." 而无字节落盘 |
| 恢复路径 | 后续任意 `share`/`forget` 整表重投影自愈 | 实测：行保持 `team-shareable, human_confirmed=1`，**再 `share` 一次即整表重投影**（且**不会重复打扰人类审批**） |

实现上**没有把 catch 复制两遍**：`refreshProjection` 返回
`{ written, ok }`，`forget` **丢弃**返回值，`share` 在 `!ok` 时抛
`MemoryAccessError`。**这个区分刻意不搭在 `create` 上**——`create` 回答的是
「我可不可以创建文件」，`ok` 回答的是「失败要不要上报」，绑在一起会让两个
无关问题互相牵制。三条测试钉住（T5/T6/T7，见矩阵 M8/M9/M10）。

#### 阻断项 2：「零行分支是死分支」被证伪

已在上文 `rmSync` 一节**保留原判断并标注证伪**，此处不重复。三处表述
（`projection.ts` 函数 doc、`service.ts`、本页该小节）均已改为
「**HEAD 上已可触发的缺陷，本轮顺带修掉**」。

#### 绕过变异的处置判据（22 条里有实质意义的 6 条）

| 编号 | 结论 | 判据 |
|---|---|---|
| **B5** 内联 `projectStore` | ✅ **补测试**（结构测试） | 「`refreshProjection` 是投影唯一写入点」是**整个设计的核心不变量**，而它**结构上不可被行为测试观察**——内联版在 happy path 上输出逐字节相同，差异只在 guard 与错误处理，恰恰是未来「这层间接没用」式整理会删掉的东西。故按本包 `guidance.test.mjs` 的既有先例**对 `src/` 断言**。**只断言调用点数量与所在方法，不断言调用行的写法**（第一版断言了整行文本，结果 M12 是被「行文本恰好变了」误杀的，属假阳性，已改） |
| **B10** `storeFor(…, true)` | ❌ **不补测试**，注释声明 | **审查判错了，此项为等价变异**（详见下文「我认为审查判错的地方」） |
| **B1** `store.kind === 'repo'` | ❌ **不补测试**，注释声明 | 注释自己已诚实声明「今天两者恒等」，**恒等的东西不可能有测试能区分**；能区分它的输入（group member 的 store）今天没有任何调用方造得出来。为它写测试等于**把实现拼写钉进测试** |
| **B2** guard 3 检查目录 | ✅ **补测试**（并入 T2） | 实测**非等价且是真实泄漏**：给 checkout B 一个只含团队自有文件（`NOTES.md`）的签入 `.repo_memory/`——这正是新 clone 的常态——目录版会在 B 里**凭空生成 `memories.md`**，把已批准记忆发布进没人要求发布的 checkout。实测 `B got a fabricated memories.md: true`（目录版）vs `false`（文件版） |
| **B4/B15** 返回值被忽略 / `written` 硬编码 | ✅ **补测试**（并入 T1） | `written` 是**对用户的陈述**（"N memory/memories now sit in …"），必须来自投影结果而非「刚刚分享了一条」这个事实。T1 本就连续分享两条，断言 note 依次为 `1` 与 `2`——**单条分享时「写了一行」与「永远说一行」不可区分**，两条才让差异显形（与 T2 的 fixture 退化同一族） |

> 🔴 **第二轮自己又踩了一次「测试没造出差异显形状态」**（本仓第四次）。
> T5 第一版用 `chmodSync(dir, 0o500)` 把**目录**设为只读，结果**所有变异体全部存活**。
> 原因：**POSIX 下目录的写权限管的是「增删目录项」，不管「改写一个已存在的文件」**
> ——实测 `writeFileSync` 写入 0o500 目录里**已存在**的文件**成功**。
> 于是那条测试之所以绿，和「完全没有错误处理的构建」之所以绿是同一个原因：
> **什么都没抛过**。改为 `chmodSync(file, 0o400)`（EACCES）后 M8/M10 立刻被它杀死。
> **判据重申：一条测试必须先证明它设置的障碍真的会挡住东西。**

### 我认为审查判错的地方（按要求直说）

**B10「`storeFor(agent,false)` 改成 `true` 非等价，会凭空创建一个 repo 库」——
这条不成立，它是等价变异。** 审查观察到的「forget 一条 personal 记忆后
`repos/` 从无到有」是真的，但**归因错了**：那个目录**不是 `refreshProjection`
创建的**。`forget` 的**第一行**就是
`this.readableStores(agent, true)`（`true` 是既有代码，不是本轮改的），而
`readableStores` 字面上是 `[storeFor(agent, openIfMissing), globalStore(…)]`
——所以**控制流到达 `refreshProjection` 之前，repo 库就已经被打开了**。实测：

```
repos/ before: false
repos/ after readableStores(agent,true) [forget 第一行]: true
=> repo store 在 refreshProjection 之前就已打开: true
=> storeFor(p,false) === storeFor(p,true): true
```

并且在**未修改的 HEAD** 上跑同一场景，`repos/` 同样从无到有
（`[HEAD] repos/ after forget: ['284aba84…']`）——**这个副作用与本轮改动无关**。
`openIfMissing` 到这一行时**已经无事可做**，两种写法返回**同一个对象**。
故 M16 存活**不是覆盖缺口，而是逻辑必然**，与 B1 同类。保留 `false` 的理由只是
**表达意图**（本方法读取 store，不负责创造 store），已写进注释；**不为它补测试**，
因为那会把一个可证明不可观察的拼写钉死。

> 顺带确认审查的另一条**是对的**：**guard 2 非冗余**。`deriveRepoIdentity` 有
> memo 而 `deriveWorkspaceRoot` 没有，会话中途删除 checkout 即可让两者分叉——
> 实测 identity 仍返回旧值（memo 命中）、workspace 返回 `undefined`。已在
> `refreshProjection` 注释里补了这一行说明。

### 方案评审第一轮自己犯的错（按本仓惯例留档）

**它提出的替代 guard 与它否决的 guard，在 `forget` 的整个定义域上恒等**——
穷举 6 种输入 **6/6 全同**——**却被当成两条不同的规则**。
「换一种拼写」被误认为「换一条规则」，**是 D7–D9 那条失效模式的镜像**。
真正的理由不是「今天更严」（今天不更严），而是「明天 group member 被并入时
只有一种拼写还成立」——这条理由已写进 `refreshProjection` 的注释。

### 取数陷阱（本轮第三次咬人，与 v0.4.11/v0.4.12 同型）

**测试从 `lib/` 导入，而 `npm run verify` 编译 `src/`。** 改了 `src/` 必须
`npm run build` 后测试才看得到。**做变异时 `git checkout` 还原 `src/` 并不还原
`lib/`**——本轮的做法是先 `cp -r src /tmp/srcbak`，每个变异从副本重建 `src/`
再 `npm run build`，收尾时同样从副本还原并重新 build。

> 另一个本轮踩到的坑：`node --test test/` 在本仓不展开（报
> `Cannot find module .../test`），必须用 `npm test`（其脚本是
> `node --test "test/*.test.mjs"`）。变异矩阵若因此「零失败」，那是**没跑测试**，
> 不是**测试全绿**——第一次跑出的 `tests 1 / fail 1` 就是这个。

### 📋 本轮登记的待办（未排期）

| # | 事项 | 现状（本轮实测） | 处置判据 |
|---|---|---|---|
| M | 🟡 **`propose({replaces})` 替换已分享记忆时投影保留旧版** | 替换行是 `visibility='repo-local', human_confirmed=0`，**结构性不可投影**；若顺手刷新，`written=0`，团队文件里那条**人类批准过的**记忆凭空消失，而**没有任何替代品被发布** | 判据**不是**「够不够得着 workspace」（**够得着**——这正是本轮范围判据必须写成「有没有对投影作出陈述」的原因），而是**替换的正确语义是什么**：静默撤回一条人类批准过的分享与投影三道闸的精神冲突，**正确答案可能是提示重新审批**而非自动刷新。属产品策略，需自己的判据 |
| N | 🟡 **decay（双向）/ reconcile（supersede）使投影陈旧，结构性不可修** | 实测 `src/pipeline/*.ts` **8 个文件全文 `cwd` 出现 0 次**——管线**根本够不到 workspace** | **与 D9 同类、却是唯一无法下沉到同一手法的实例**：D9 用 schema 触发器解决，而 **SQLite 触发器写不了文件**。若将来要修，**必须先决定「job 是否有权知道 workspace」**——属架构级问题，不可顺手做 |
| O | 🟢 **跨 checkout 投影陈旧（`forget` 与 `share` 同型）** | **已知局限而非缺陷**：实测未修改的 HEAD 上 `share` 就已如此（见上文 A/B 实测）。任意后续 `share` **自愈** | 修它需要「一个 store 记住 N 个 checkout」的机制，**已评估否决**：最后写者赢 / meta 里的本地路径不可信 / 把读判据升级成写权限来源**违反 D1**。**登记以免后来者误以为是本轮引入的** |

> **上一轮（v0.4.12）的页首摘要，原样保留：** `runReconcileJob` 把**生成的派生层
> 摘要当成「已存下的记忆」**交给模型查重——全仓 8 个消费方里唯一漏掉 `derived`
> 过滤的一处。**会静默且永久地丢掉写入**（模型判 `drop`，摘要随后被 D9 触发器
> 删光），并能造出**两条互相矛盾的 active 行**。修法是**删掉手写 SQL、复用
> `queryAllMemories`**。**这一轮不是行为零变化**：9 个生产库中 5 个窗口改变，
> 但**只有 `5ed2b4d2` 一个库真正跑过这条路径**。测试 245 → **248 / 0 fail**。
> **无 schema 改动。** 这是本页少见的**修数据丢失**而非「行为零变化」的一轮。
>
> 版本序（**取数时刻 2026-09-03 12:03**）：装机 **0.4.11**，插件落盘
> **2026-09-03 09:11:50**，进程启动 **2026-09-03 09:12:05**（PID 1147946）——
> 进程晚于插件，故 **0.4.11 确已在跑**。**v0.4.12 已发布、尚未安装**
> ——即**本轮修复尚未在本机生效**，判据同下节「开工第一件事」。
>
> ⬇️ 以下 v0.4.9 一节及其「降级不可逆」警告仍然有效（v10 库不可被 0.4.8 打开）。

## 🆕 v0.4.12：reconcile 拿「生成的摘要」当「存下来的记忆」去查重（**会静默丢写入**）

**本轮不结项任何已登记待办**——选题是一次审计发现的**未登记**缺口。
与前两轮不同，**这一轮不是行为零变化**：它修的是一条会丢数据的产品缺陷。

### 判据：一条规则全仓写了 8 遍，只有这一处漏了

`pipeline/reconcile.ts` 构造交给模型查重的 `existing` 集时，手写 SQL
**只过滤 `status`、不过滤 `derived`**：

```ts
SELECT id, kind, title, body FROM memories
 WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?
```

**`reconcile.ts` 全文 `derived` 出现 0 次。** 而其余每一个消费方都排除派生行：
`queryInjectableSet`、`queryPersonaSources`、`queryAllMemories`、`projectStore`、
`runDecayJob`、`service.forget`、`service.share`。**8 处中的 7 处遵守，1 处漏掉。**

后果是**生成的 L2 场景块 / L3 画像被当成「已存下的记忆」摆到模型面前**，
而模型对它只能做两种判断，**两种都被污染**：

| 判决 | 实测后果（走真实 `runReconcileJob`） |
|---|---|
| **`drop`** | 摘要本来就是对原记忆的复述——候选看起来像重复。候选被置 `superseded`，而摘要**在下一次 raw 写入时被 D9 触发器删光**。实测：候选自己的措辞（`workspaces`）**在任何 active 行里都不存在了**；decay 只会让情况更糟而非更好——它对 raw 行的 UPDATE 本身就是一次 raw 写入，触发 `invalidate_derived_update`，**摘要与 raw 行一起消失**（实测：decay 前派生行 1 条，一次睡掉 55 条 raw 行的 decay 后 0 条）。**摘要从来不是任何东西的持久载体**——这恰恰是「让候选被判成摘要的重复」会丢写入的原因 |
| **`supersede`** | 决策指向派生 id 时**能通过 `status='active'` 守卫**（派生行确实是 active）。实测 `supersedeOld` 对派生行 **`changes=1`**；而模型真正想替换的 raw 行**仍 `active` 且 `superseded_by = NULL`**。实测终局：**两条互相矛盾的 active `fact` 行**，模型意图被无痕丢弃 |

### 做了什么：删掉 6 行 SQL，复用早已存在的那一个函数

```ts
import { queryAllMemories } from '../store/fts.ts'
const existing = queryAllMemories(store, RECONCILE_EXISTING_LIMIT)
```

**刻意不是「给手写 SQL 补一个 `AND derived = LAYER.RAW`」**：那等于把同一条规则
写第九遍，而**一条规则被写两遍本身就是缺陷**。`queryAllMemories` 选**同样的 4 列**、
用**同样的谓词与排序**，其文档立意（「一个人应该能看到的全部」）正是 reconcile
要查重的那个集合。**实测：在 9 个生产库副本上与「修正后的手写 SQL」逐行全同 9/9。**
顺带删掉了 `as unknown as CandidateRow[]` 强转（`CandidateRow` 因 `fetchCandidate`
仍在用而保留）。

**无循环依赖**：`store/fts.ts` 只引 `store.ts`/`types.ts`/`constants.ts`，
且 `pipeline/rebuild.ts` 早已从 `store/fts.ts` 引入——**先例现成。**

### 变异矩阵：实测值与方案评审的预测**有 4 格不一致**

`/tmp/slaudit` 副本，**每个变异都重新 `tsc` 后跑全量**。R1=提示词不含派生行且
窗口不缩短；R2=被「误判为摘要的重复」的候选必须存活（**耐久态**）；
R3=容器是全体存量集而非可注入子集。

| 变异 | R1 | R2 | R3 | 与评审预测 |
|---|---|---|---|---|
| **CONTROL（修好）** | ✅ | ✅ | ✅ | 一致 |
| **M1** HEAD：无 derived 过滤 | 🔴 | 🔴 | 🔴 | **不一致**（预测 R3 绿） |
| **M2** 错容器 `queryInjectableSet` | ✅ | ✅ | 🔴 | **不一致**（预测 R1 红） |
| **M3** LIMIT → 1 | 🔴 | ✅ | 🔴 | **不一致**（预测 R3 绿） |
| **M4** `existing` 整个置空 | 🔴 | ✅ | 🔴 | **不一致**（预测 R3 绿） |
| **M5** 事后 `.slice(0,5)` | 🔴 | ✅ | ✅ | 一致 |
| **M6′** `queryAllMemories` 自身去掉 `status='active'` | ✅ | ✅ | **🔴** | **不一致**（预测三条全绿＝存活） |

**四点更正，按本仓惯例保留原预测并标注证伪：**

1. **M1 不是「R2 单点覆盖」**：三条测试全红。R2 仍不可删——**它是唯一量到
   耐久后果的那把尺子**，另两条只证明「摘要被摆了出来」，不证明「写入被销毁」。
   注释已按实测改写，**不再宣称单点**。
2. **M2 下 R1 是绿的**：`queryInjectableSet` **同样排除派生行**，所以 R1 的断言
   照样成立。**R3 确是 M2 的唯一杀手**——已标注单点覆盖。
3. **M3/M4 下 R3 也红**：R3 用 `deepEqual` 钉住完整列表，行数变化自然打红。
4. **M6′ 并未存活**：评审称这是「继承来的坑」，实测**被 R3 杀死**——泄漏进窗口的
   是待定的 **`candidate` 行 `c0`**，而 R3 的 `deepEqual` 恰好拒绝它。
   **待办 K 因此按「部分覆盖」登记**（`derived` 那一半仍有存活变异，见待办 K）。

### QA 另造 13 个绕过变异，抓到一处 fixture 退化（已当轮修掉）

QA 不复跑上表，而是自造变异专打「查询形状正确但意图被架空」：事后重新塞回派生行、
`.reverse()`、`>=`、改排序键、事后 `.filter`/`.slice`、换 limit 常量——**大部分被杀**。
**但 `LIMIT + 1` 原本 248 全绿存活**：R1 的 fixture 恰好只造
`RECONCILE_EXISTING_LIMIT` 条合格行，于是**任何超限都返回同样的 30 行**，
测试**只挡得住调小、挡不住调大**。

> **这正是本节自己在 provenance 轴上防住、却在行数轴上漏掉的同一种 fixture 退化。**
> 修法是**多插一行**（`LIMIT + 1` 条 raw），让上限在两个方向都可观测。
> 实测：改动前 `LIMIT+1` **248 全绿**，改动后 **2 条红**；调小（`limit=1`）**仍红**。
> **一条测试若造不出「刚好越界」的那一行，它钉住的就只是自己的 fixture。**

> **fixture 的诚实性就是论证本身**：R3 **必须**包含一条**不可注入**的行
> （`provenance='tool-output'`）。**实测：若三行 provenance 一律 `'human'`，
> M2 存活**——两个容器在那种数据上返回完全相同的结果，测试绿得毫无意义。
> 二者有**两处**差异，R3 一条 `deepEqual` 同时钉住：`tool-output` 不在
> `INJECTABLE_PROVENANCE`（资格），且 `queryInjectableSet` **先按 provenance
> 优先级排序再按时间**（顺序）。

### 更正 lead agent 的三条原始断言（按本仓惯例保留错误并标注证伪）

1. **「重试退避使 rebuild 得以插队」——证伪。** 实测 9 库全部 reconcile job：
   **89/89 全部 `attempts = 1`，历史上零次重试。** 且自然序**结构性地**围栏了
   rebuild：`maintain` 用**抽取前的 revision** 入队 rebuild，故它到货即被围栏；
   替补件拿到**更晚的 `run_after`**，而 `claimNextJob` 按 **`ORDER BY run_after,
   created_at`** 取件，**reconcile 必然先跑**。
   **真正可达的路径是：持有 reconcile 租约的 worker 崩溃**，租约要等
   `LEASE_DURATION_MS`（**实测常量 = 5 分钟**）才过期，这段窗口足够让 rebuild
   越过它。**生产库带有该崩溃签名**（`attempts > 1` 而 `last_error IS NULL`）：
   实测在 `5ed2b4d2` 与 `aafbf0fa` 各 1 条，**但都是 `extract` 而非 `reconcile`**
   ——签名成立，落在 reconcile 上的实例尚未观测到。
2. **「supersede 那一半是良性的」——证伪。** 见上表：`changes=1`，
   终局是**两条矛盾的 active 行**。
3. **lead 的字符占比数字偏差 1–2 个百分点**——本轮改用自测值，见下表。

### 曝光面诚实交代：**9 个库里只有 1 个够得着**

| 库 | HEAD 窗口 | 修复后 | 挤出的派生行 | 挤回的真记忆 | reconcile jobs | 现存派生行 |
|---|---|---|---|---|---|---|
| `5ed2b4d2` | 30 | 30 | **4** | **4** | **53** | 4 |
| `3e857510` | 30 | 27 | 6 | 3 | **0** | 6 |
| `ec2636fc` | 21 | 16 | 5 | 0 | **0** | 5 |
| `edf7a686` | 20 | 16 | 4 | 0 | **0** | 4 |
| `strataloom`(全局) | 22 | 21 | 1 | 0 | **0** | 1 |
| `2631a175` / `7048f15b` / `94394b03` / `aafbf0fa` | 14/20/30/16 | 同左 | 0 | 0 | 0/5/27/4 | **0** |

**5 库窗口改变、4 库逐行全同**（后 4 个根本没有派生行）。
**但「窗口会变」不等于「线上提示词会变」**：`3e857510`/`ec2636fc`/`edf7a686`/
全局库**历史上 reconcile job 数为 0**，从未跑过这条代码路径。
**唯一同时具备「有 reconcile 流量」与「有派生层」的库只有 `5ed2b4d2`**
（53 次 reconcile、14 次 rebuild、4 条现存派生行），它的窗口**仍是满 30 行**
——挤出 4 条摘要、挤回 4 条真记忆。

**且它的派生层大部分时间根本不存在。** 实测（用 `jobs.completed_at` 重建
「rebuild 写入 → 下一次 raw 写入」的存活区间）：

```
rebuild 完成 14 次   派生层存活合计 5.7h
各区间(h): 0.01 0.01 0.02 0.02 0.02 1.85 0.02 0.01 3.68 0.01 0.02 0.01 0.04
```

**5.7h / 58.1h（rebuild 窗口）= 9.8%** ——复现了简报的 9.9%（差 0.1 个点，
四舍五入口径）。**但必须写明分母**：58.1h 是**首末 rebuild 之间**的跨度，
**不是该库的存活期**。以全部 job 跨度 163.9h 为分母是 **3.5%**，
以 raw 写入跨度 246.3h 为分母是 **2.3%**（含派生层的全表跨度是 249.4h，
同样四舍五入到 2.3%——但本节口径是 raw，故取 246.3h）。**换句话说：命中窗口比 9.9% 还要窄。**

> **结论不是「所以不重要」**：命中率低，但**损失是静默且永久的**——用户不会看到
> 任何错误，只会在某天发现某条记忆再也想不起来了。

### 取数陷阱（本轮再次咬人，与 v0.4.11 同型）

`npm run verify` 编译 `src/`，**但测试从 `lib/` 导入**。派生行还有第二个陷阱：
**D9 `invalidate_derived_insert` 触发器会在任何 raw 写入时删光整个派生层**,
所以 fixture 里**摘要必须最后插入**——先插的摘要在测试跑到之前就已经没了。
这同时也正是生产形状：rebuild 总是最后写，因而 `updated_at DESC` 下**排在最前**。

### 📋 本轮登记的待办（未排期）

| # | 事项 | 现状（本轮实测） | 处置判据 |
|---|---|---|---|
| K | 🟡 **`queryAllMemories` 自身的谓词只被**部分**钉住，且钉子全在 reconcile 侧** | `status='active'`：简报预计变异存活（「继承来的空洞」），**实测被 R3 杀死**（泄漏进窗口的是 `candidate` 行）。但 `derived` 那一半**只钉住了一部分**——QA 实测 `derived = LAYER.RAW` 改成 `>=` 被杀，改成 **`!= LAYER.SCENARIO`（放行 L1/L3、只挡 L2）则 248 全绿存活**，因为全部 fixture 只造 `SCENARIO` 层。**本轮不改该函数** | 登记而非修。两点必须写清：（1）**该函数是与 `service.list()` 共用的**，将来为 `list()` 放宽谓词会**静默改变 reconcile 查重的集合**，而 `fts.ts` 自己的测试里**无任何直接守卫**——今天的保护全部来自 reconcile 侧的 R3，R3 一旦被改写或删除，保护随之消失；（2）`!= SCENARIO` 那个变异**今天不可达**（repo 库的 rebuild 只写 `SCENARIO`，`PERSONA` 由 D2 visibility 触发器限死在 global 库，而 reconcile 够不着 global 库），**但它是为下一个派生层准备的陷阱**。**判据是 `fts.ts` 域内是否需要一条本地测试** |
| L | 🟡 **`RECONCILE_EXISTING_LIMIT = 30` 才是 `5ed2b4d2` 上的主要限制** | 该库 **198 条 active raw 行**，HEAD 下窗口里只有 **26 条**真记忆（**13.1%**），修复后 30 条（**15.2%**）。**行数上限的影响远大于派生层泄漏** | **本轮明确不修**：调大 limit 会改变每一次 reconcile 的提示词与成本，属独立选题，需要自己的判据与实测。**登记以免后来者误以为本轮已解决查重覆盖率问题** |

## 🆕 v0.4.11：一条规则被 50 行注释论证，却没有一行测试守着（**行为零变化**）

**本轮不结项任何已登记待办**——选题来自一次「量到最外面那把尺子」的审计，
是**未登记**的缺口。**主 agent 的第一个选题被方案评审打回**（见本节末）。

### 判据：变异存活，且两个变异在生产数据上就能冻结派生层

`packetOverflows` 决定「这个库的 raw 集是否需要摘要」。它必须用
`queryInjectableSet(store, ROLLUP_SOURCE_LIMIT)`（RAW 全集、limit 200），
`runRebuildJob` 的到货复检必须读**同一集合同一 limit**。这条规则上方有 50 行
注释论证，**但没有任何测试钉住它**：

| 变异 | 补测试前 | 生产后果（9 个只读副本实测） |
|---|---|---|
| M1 入队侧容器→`queryInjectionRows` | **239 全绿** | 3 个持有派生层的库 true→false |
| M3 入队侧 limit→`INJECT_TOP_N` | **239 全绿** | 需构造 fixture 才显形 |
| M4 `>` → `>=` | **239 全绿** | 边界 |
| M5 复检侧容器 | **239 全绿** | 入队说有活、到货说无必要 |
| M6 复检侧 limit | **239 全绿** | 同上 |
| M8 纯自指（有层才换容器） | **239 全绿** | 3 库 true→false |
| **M11 折价式自指** | **244 全绿**（连新补的 5 条也杀不掉） | **2/3 库 true→false** |

**M8/M11 是「自指」的两个不同维度**，而原注释只认得一个：

- **M8 选行维度**：有派生层就去读派生层 ⇒ 触发器问的是「摘要自己多大」。
- **M11 定价维度**：容器对、limit 对、两侧一致，但用派生层块数**折价**
  （`raw - blocks*200 > budget`）。**T1–T5 全部碰不到它**，而它在生产库上
  让 `ec2636fc`(1808) 与 `edf7a686`(1916) 当场翻 false、派生层就此冻结。

### 做了什么：6 条测试，一行产品代码都没动

`test/layers.test.mjs` 新增 T1–T6。**变异矩阵（每次都 `npm run build` 后跑全量）**：

| 变异 | T1 | T2 | T3 | T4 | T5 | T6 |
|---|---|---|---|---|---|---|
| M1 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| M3 | 🔴 | ✅ | ✅ | 🔴 | 🔴 | 🔴 |
| M4 | ✅ | ✅ | ✅ | **🔴** | ✅ | ✅ |
| M5 | 🔴 | 🔴 | 🔴 | ✅ | 🔴 | 🔴 |
| M6 | 🔴 | ✅ | ✅ | 🔴 | 🔴 | 🔴 |
| M8 | ✅ | 🔴 | 🔴 | ✅ | ✅ | 🔴 |
| **M11** | ✅ | ✅ | ✅ | ✅ | ✅ | **🔴** |

**M4 与 M11 各自只有一条测试挡着**（T4 / T6），已写进注释标注为单点覆盖。

> **fixture 的选择就是论证本身**：T6 必须用便宜的 70 行 fixture。T2 的
> `overflow` 集定价 4660，要折价到 1300 以下需 **17 块**，而写者上限
> `ROLLUP_MAX_SCENARIOS = 6` ——**T2 无论怎么写都结构性地抓不到 M11**。
> 便宜 fixture 定价 1330 对预算 1300，**一块就够**。

### 三次打回，每次都命中注释而非代码

1. **方案评审打回主 agent 的第一个选题。** 我原本提「派生层重建节律（6h）
   慢于失效节律（秒级）」，评审用实测推翻三条支撑：①「派生层活着的库都是死库」
   **方向反了**（真正的区分变量是 `packetOverflows`：8 个库只有 4 个该有派生层，
   其中 3 个有）；②「10 次真跑 LLM / 2 次被围栏挡」**不可判定**（库里没有
   per-job LLM 记录，我不该报这个数）；③「6h 闸是绑定约束」**证伪**
   （实测入队间隔均值 4.35h，本机频繁重启使 `lastCleanup` 复位）。
   **本轮选题正是评审自己列出的「变异 1」。**
2. **代码审查打回 2 条注释断言**：T4 写 `RED UNDER: M4` 读作穷举，
   而实测 M1/M3 也让它变红（其 27 行 × 50 tok 在 limit 20 下计 1000 ≤ 1300）；
   T1 写 "owns the LIMIT" 而 M3 实测同时打红 T1/T4/T5。**两条都是
   「后来者会当已验证先例引用」的错误断言。**
3. **QA 打回 T2 的全称断言并交出 M11。** T2 原写 "the trigger is NOT
   self-referential … never about the summary's own size"，而 M11 恰恰
   就是「用摘要自己的大小」。**测试的自述鉴别力被高估**——与第 2 条同型。

> **本轮方法论产出**：主 agent 与 QA 各自独立造绕过实现。**M9（两侧同时换成
> 错误 limit，专打 T3 的「一致性」）与 M10（查询正确但事后 `.slice(0,20)`）
> 都被 T1/T4/T5 杀死**，唯独 M11 存活——**说明「一致」与「容器正确」都不蕴含
> 「不自指」，三者是三条独立的规则。**

### 注释更正：原文的因果被实测证伪，按仓库惯例保留并标注

原注释称若改用 `queryInjectionRows`，派生层建成后触发器永远答否、**该库再也
不会重建**。**实测不成立**：D9 触发器在任何 raw 写入上删光派生层并 bump
revision，故「raw 集持续增长」与「派生层存活」**不可同时成立**；4 轮增长周期下
该变异与 HEAD **逐轮完全相同**。

**真实失效路径是维护期**：派生层存活且**无 raw 写入**时，`done` job 行过
`DONE_RETENTION_MS`(7 天) 被 `cleanupJobs` 剪掉、幂等键不再吸收，此时 HEAD
重建而变异冻结。

**并补上原注释完全没提的第二条独立缺陷**：`queryInjectionRows` 无派生层时
退化为 `queryInjectableSet(store, INJECT_TOP_N)`，**limit 200→20**。

> **两个效应的可观测域必须分开写**（本仓「口径混淆型断言」教训）：
> **自指效应今天在生产数据上已可观测**（3 库 true→false）；
> **limit 效应今天不可观测**——三个翻转库在 limit=20 下读数仍是
> 2000/1808/1916，**全部 >1300**，故 limit 单独一个库都翻不动；
> 其中两库只有 16 行，limit 20 根本够不着。执行 agent 一度把 limit 写成那三次
> 翻转的替代解释，**已更正并把该错误保留为教训**。注释里两张表的每个数字
> **都被脚本解析回来与副本实测逐格比对**。

### 行为零变化：量到最外面那把尺子

`git archive HEAD` 编译第二份 lib，**全部 56 个 emit 产物**（`.js` + `.d.ts`）
逐一比对：raw 差异仅 `pipeline/rebuild.js` 与 `types/pipeline/rebuild.d.ts`
（注释随 JSDoc 进 `.d.ts`），**剥离注释后差异为 0**。测试 239 → **245 / 0 fail**。

> ⚠️ **本轮反复咬人的取数陷阱，写在这里**：`npm run verify` 跑 `src/`，
> 但**测试与探针都从 `lib/` 导入**。`git checkout` 还原 `src/` **不还原 `lib/`**，
> 于是变异会残留在编译产物里、后续读数测的是 mutant。评审因此一度得到
> **数学上不可能**的读数（`injectableSet=4660` 却 `overflow=false`）。
> **还原 = `git checkout` + `npm run build`，且做变异请用工作树副本而非 `git checkout`**
> （后者会把待测改动一起还原掉）。

### 📋 本轮登记的待办（未排期）

| # | 事项 | 现状（实测 2026-09-03） | 处置判据 |
|---|---|---|---|
| G | 🟡 **`ROLLUP_SOURCE_LIMIT` 的「数值」未被钉住** | QA 实测：两侧同时 `200→100`，**245 全绿**。70 行 fixture 仅 30 tok 余量（`slice(0,69)=1311` 仍 true） | T1/T5 只证明「比 20 大」，未证明「是 200」。**不修**：钉死数值等于把常量抄进 fixture（本仓待办 l 同型）。**条件**：若将来 `ROLLUP_SOURCE_LIMIT` 参与别的不变量，需重估 |
| H | 🟢 **派生层测试一律只造 1 块，生产上限是 6** | `rollupReply` 默认单块；QA 变异 `derivedCount > 1 ? …` **245 全绿** | 登记而非修：多块 fixture 会让 T2/T6 的定价前置断言变复杂，而 T6 已用「一块就够」的便宜 fixture 覆盖了折价维度 |
| I | 🟡 **`service.test.mjs` 一次文件级偶发失败** | QA 报告 M11 首跑时该文件整体失败、`tests 237`（少 7 条）；单独重跑 8/8 绿，此后 33 次未复现。主 agent 连跑 10 次 layers 全稳（65/65） | 属**进程级**偶发（`--test-isolation=process` 子进程异常），非断言失败。**登记待排查**，判据是能否稳定复现 |
| J | 🟢 **变异验证的工作树污染** | 并发 agent 在同一工作树装变异会互相污染读数，本轮实际发生过一次 | **流程约定**：变异一律在 `/tmp` 副本上做，或串行化；已写进上方取数陷阱 |

## 🆕 v0.4.10：L2 遵守的那条规则，L3 两个执行点都没有（**行为零变化**）

**本轮结项待办 q。但待办 q 的现状栏用错了供给面证据，判据也因此偏了**——
更正见本节末尾与待办 E。

### 判据：一条规范规则在 L3 上没有执行点，且同一谓词被手写了两遍

`plugin-architecture.md` §12 derived 层那一行明写产物「**注入资格随最低来源**」。

- **L2（repo 库场景摘要）遵守它**：入队 `packetOverflows` 与执行 `runRebuildJob`
  **都调 `queryInjectableSet`**，该函数带 `provenance IN (${INJECTABLE_LIST})`。
- **L3（global 库画像）两个执行点都是原样手写 SQL、都无 provenance 过滤**：
  `enqueuePersonaRebuild` 的 `count(*)` 与 `runPersonaJob` 的 `SELECT`。

后果不是「口径不一致」：低信任 raw 行进画像提示词 → 画像以
`provenance='derived'` 落库 → **`queryInjectionRows` 的派生分支优先于 raw 集**
⇒ 被 §2.3 挡在注入外的内容，**换了一身 provenance 后进了注入包**，
且下游再也分辨不出它来自哪里。

| 检验（实测 2026-09-02/03，走生产函数与原样 SQL） | 结果 |
|---|---|
| 往 global 库副本插 `tool-output` / `subagent` 的 d0 行 | **两条都进了画像提示词**（21→23） |
| 同库同时刻 `queryInjectableSet` | 仍 21，**探针 0 条**（raw 路径过滤正常） |
| 裸 `UPDATE ... SET provenance='tool-output' WHERE derived=0 AND status='active'` | `changes=21`，**全部持久** |
| 删掉 `runPersonaJob` 那条 SQL 的 `AND derived = RAW` | **237 全绿**（零覆盖） |

### 两个执行点必须一起改，否则会亲手制造 L2 明令禁止的不一致

`packetOverflows` 的注释早就立了规矩：**入队与执行必须答自同一个集合**，
否则「一个 job 被入队，然后到货时判定无必要，forever」。

只改执行侧会正好造出它：只持有低信任行的 global 库，`count(*)>0` 会入队，
执行时源集为空 → 空提交。而 **`store_revision` 骑在幂等键上**
（`jobId('rebuild', repoKey, expectedRevision)`），每次 revision 变动都是
**新 job id，幂等键什么都吸收不了**。实测 5 次 revision bump：

```
只过滤执行侧 : enqueue 返回 [true ×5]   jobs 表残留 5 行
两处共用定义 : enqueue 返回 [false×5]   jobs 表残留 0 行
```

### 做了什么：新增一个查询，删掉两段手写 SQL

`fts.ts` 新增 `queryPersonaSources`，**复用既有 `INJECTABLE_LIST` 与 `LAYER.RAW`**
（不新增常量、不写任何 provenance 字面量）；`rebuild.ts` 两处各归并为一行调用。
**`rebuild.ts` 的原样手写 SQL 从 2 处归零**，与 L2 形状对齐。

**刻意不复用 `queryInjectableSet`**：它选 `id` 且按 provenance 优先级排序，
复用会**把 row id 写进提示词并重排记忆** ——「披着重构外衣的行为变更」。
**共用的是谓词，那才是必须一致的部分。**

> **这里有一个专为后来者留的陷阱警告**：在**生产 global 库上两种排序完全重合**
> （21 行全 `principal-explicit`，优先级键从不比较任何东西）。**拿生产快照当
> fixture 去"证明"两者可以互换，会得到一个什么都没证明的绿测试。** 真正能区分
> 二者的 fixture 是「每种可注入 provenance 各一行、最旧优先」，实测端到端倒置。

### 行为零变化：量到最外面那把尺子

| 尺子 | 结果 |
|---|---|
| 9 个生产库副本的真实注入包 | **11 个 packet sha256 与 HEAD 全同**（含「无 repo 会话」、双侧 fallback、personal 缺席） |
| 画像提示词 sha256 | 两侧同为 `20aeba1e2c8ea331` |
| L2 侧（8 个 repo 库） | `packetOverflows` / 入队 / jobs / rollup 提示词**逐行 identical** |
| 异常库矩阵 10 种 + v9→v10 迁移库 | **唯二差异都是修复本身**（「仅低信任」库 HEAD 泄漏 4 个标记、本版 0 条） |
| 测试 | 237 → **239 passed / 0 fail** |

> ⚠️ **一个会让人误报"提示词变了"的取数陷阱**：对 `llm.stream` 的**整个 options
> 对象**取 sha **每次都不同**——`createUserMessage` 会盖随机 UUID，**HEAD 自己跑
> 两次都不一样**。必须对 `system + 各 message 的 text` 取 sha，且**先验证 HEAD
> 两次同 sha** 再做对比。

### 两条测试，鉴别力互不重叠（删掉任一条都会让那一侧静默回退）

| 变异 | 变红的测试 |
|---|---|
| 仅回退 `runPersonaJob` | **只**红测试 1（提示词字节） |
| 仅回退 `enqueuePersonaRebuild` | **只**红测试 2（jobs 表后果） |
| 两处全回退（= HEAD） | 两条全红 |

**不是互为独立证据，是「机制 + 后果」的正交对**，已写进测试注释。

### 三次打回，每次抓到的都是注释，不是代码

**代码从第一版起就没被找出产品缺陷**；三轮打回全部命中**注释里的事实断言**。

1. **代码审查打回 2 条被证伪的断言。**
   - `runPersonaJob` 的注释说空集守卫防的是「入队后被 supersede 或 forget」。
     **恰恰是它唯一举不出来的例子**：`invalidate_derived_*` 触发器对**任何** RAW
     行写入都 `store_revision += 1`，而 `runRebuildJob` 首步就是 revision 预检。
     枚举全部 8 条 `UPDATE` + 2 条 `DELETE` 实测：**10/10 全部 `fencedAtPrecheck`**，
     根本走不到那个守卫。**守卫该留，但理由是跨进程窗口**（预检读与源查询是两次
     独立的读，不在同一快照里）。**用错误前提支撑正确结论。**
   - 测试注释称 v10 CHECK「把 `derived` 绑在非 RAW 行上」。**实测
     `derived=0 AND provenance='derived'` 插入 ACCEPTED**——CHECK 是**单向**的，
     `schema.ts` 的 `migrateV10` 自己就写着 "ONE DIRECTION ONLY, deliberately"。
     排除动作是载重的，但**理由错了**，会让后来者引用一条错误的 CHECK 语义。
2. **代码审查第二轮打回一个分母**：注释写「nine live stores (552 rows)」，而
   **9 个真实库是 500 行**；552 来自审查者自己工作目录里的 **11** 个库
   （9 个真实副本 + 2 个临时 fixture，500+27+25=552）。
   **一个正确的库数配了一个含污染的行数**，恰好长得最像真实测量。
   旁证很硬：同仓 `schema.ts` 对同一件事写的是「nine live stores (494 memories)」。
   > **教训**：报「跨全部真实库」的数时，**分母必须排除自己造的 fixture**。
   > 这与本仓「绕过真实写者的测量只验证自己的假设」同型，只是这次污染的是**分母**。
3. **QA 打回口径并抓到 4 种绕过**（见待办 B）。

### 方案评审自己犯了一次，且值得记

评审第一轮判定「入队/执行不对称无害、不必同步改」，依据是三个 tick 后 job 被
幂等键吸收。**它的夹具冻结了 `store_revision`** ——而 revision 正是骑在幂等键上、
**唯一会让该失效发作的变量**。补跑 revision churn 后结论反转（5 次 bump 泄漏 5 行）。

> **教训**：**绕过真实触发条件的测量，同样只验证自己的假设**（ADR 0009 教训 7
> 的又一形态）。这次冻结的不是写者，是**让缺陷显形的那个自变量**。

### ⛔ 待办 q 的严重性论证已作废，原文保留以便复核

待办 q 用 **repo 库**的供给面论证暴露面（「`5ed2b4d2` 库 202 行 d0/tool-output」）。
**但 `runPersonaJob` 只在 global 库运行**（`store.kind === 'global'` 早返回；
用 25 行全 `tool-output` 的 repo 库实测 `personaCalls = 0`），那些行**永远到不了 L3**。

而 global 库的写入方只有两个：`propose(scope:'personal')` **恒写
`principal-explicit`**，与 rebuild 自己写 `derived`；`auto-extract` 走 `storeFor()`
**必为 repo 库**。故**当前 stock 配置下该缺陷不可触发**。

**这不削弱修复**——规范的执行点该在就得在，且它防的是**配置演化**（低信任行一旦
能进 global 库，今天这条路径没有任何东西拦得住，而 §2.3 明说要拦）。
**但必须据实记录**：本仓有「待办描述错误直接生产下一轮错误选题」的前科
（v0.4.8 待办 k）。

### 📋 本轮登记的六项待办（未排期）

| # | 事项 | 现状（实测 2026-09-02/03） | 处置判据 |
|---|---|---|---|
| A | 🟡 **跨进程空集守卫无任何测试** | 删掉 `runPersonaJob` 的 `memories.length === 0` → **239 全绿**，零感知。QA 按「precheck 通过后源集已空」这个**守卫真正面对的分母**实测条件概率 **51.2%/52.8%**（此前记的 0.4% 是「窗口命中率」，**另一个分母**）。**确定性测试已验证可行**：借 `store.test.mjs:592` 的跨进程先例 + store proxy，**12/12 稳定杀死变异，零 flake** | **本轮不修**（HEAD 既有缺口，非本轮引入，本轮是净改善）。**下次触碰 `runPersonaJob` 时必须补**——「难以确定性覆盖」这个免罪理由**已被证伪** |
| B | 🟡 **子串黑名单的局限写得不全** | 保持行集完全正确、只把低信任 body 变形折进已准入行：**字符反转 / base64 / 零宽字符 / 每标记截掉 1 字符**，**四种全部 239 全绿**。主 agent 独立复现了截断那一种 | **不改断言**（改性质断言代价不成比例，本仓待办 c 已裁定「保留黑名单 + 写清局限」）。**注释已补全这四类**——尤其**截断**：它几乎原样保留原文、根本不是"改写"，最容易被误以为已覆盖。**`kind` 通道与 system prompt 通道已被守住**（断言落在完整 options 字节上，各 238/1） |
| C | 🟢 **新增 provenance 在存量库写不进去** | 给 `PROVENANCES` 加 `'plugin-hook'`：推导集自动变宽 ✅、239 全绿 ✅，但**新建库 ACCEPTED / 存量库 REFUSED**——`CHECK` 烘焙在建表 SQL 里，加枚举**不触发任何迁移** | **不修**：这是 `rebuildMemories` 的既有设计（扩枚举 = 一次 rebuild migration）。登记是因为「加一个 provenance 会怎样」的完整答案**缺了这一半**，下次真要加时必须连带写迁移 |
| D | 🟢 **`provenanceFor` 可返回 `'derived'`，v10 CHECK 也放行** | 链路成立：`provenanceFor([human, derived]) → 'derived'`（它取**最低**优先级，而 `derived` 是全场最低 0），`conversations` 的 CHECK **允许**该值，v10 CHECK 也不禁 `derived=0 + prov='derived'` | **不修**：**方向是 fail-closed**（该行不进注入、不进画像，只出现在 recall/list——那两处本就全 provenance 可见），且**可达性 = 0**：`classify()` 值域只有 4 个字面量、全仓无任何 `SET provenance`。**条件**：若 `classify()` 新增分支或出现 provenance 改写路径，**立即升级** |
| E | 🟢 **待办 q 的供给面描述夸大，已更正** | 见上节。L3 只在 global 库跑；生产 global 库实为 `principal-explicit=25, derived=1` | **仅更正记录**，修复保留。防的是配置演化而非正在冒烟的洞 |
| F | 🟡 **被污染的历史画像不会被主动清除** | 若 HEAD 期间写过含低信任内容的画像：修复后 `enqueuePersonaRebuild` 返回 **false**（源集为空）**不重判**，而 `queryInjectionRows` **仍注入它**。清除只发生在任意 RAW 行被写时（D9 触发器 `DELETE derived != RAW`）——实测插一行后画像即消失 | **本轮不修**：结合待办 E，**生产 global 库无低信任行，当前无实际污染**（画像唯一 1 行，源全 `principal-explicit`）。**条件**：若 global 库曾/将持有低信任行，需一次性清除——**纯代码修复对存量无效** |

## 🆕 v0.4.9：两个列陈述同一件事，而只有一个被检查（**行为零变化**）
> **产品行为零变化**——10 组真实注入包逐字节相同。本轮结项的是
> **上一轮登记的待办 p**，但**修法与当时登记的判据相反**（见下节）。
> **本轮含一次 schema migration（v9 → v10），是本页少见的不可逆改动**，
> 回滚代价见下节。**每次工作结束时更新本页**，它是新会话的唯一入口。
>
> 版本序（**取数时刻 2026-09-02 14:05**）：装机版本 **0.4.8**，插件落盘
> **2026-09-02 13:21:50**，进程启动 **2026-09-02 13:21:57**（PID 4087629）——
> 进程晚于插件，故 **0.4.8 确已在跑**。
> **v0.4.9 已发布、尚未安装**，判据同下节。
>
> ⚠️ **本轮是本页第一次发布 schema migration 后的「降级不可逆」**：v10 库被
> 装机的 0.4.8（`TARGET_USER_VERSION = 9`）打开会抛
> `MigrationError: store version 10 is newer than supported 9`，
> `StoreRegistry` **fail-open 跳过该库并 warn**（数据完好、其余库照常）。
> 后果是**该库注入为空**直到装上 0.4.9。**先升级的机器会让仍跑 0.4.8 的
> 机器打不开共享库**——多机环境请一起升。
>
> ⚠️ **本页那条版本判据命令已于早前修正**（见下节「开工第一件事」）：原来用单个
> `extract.js` 的 mtime，而 pnpm 硬链接使未改动文件保留旧 mtime，会给出**相反**的结论。

## 🆕 v0.4.9：两个列陈述同一件事，而只有一个被检查（**行为零变化**）

**本轮结项待办 p，但修法与当时登记的判据相反**——当时登记的判据是
「任何让派生行携带非 `derived` provenance 的改动，必须先在此（读路径）加过滤」，
**方案评审把它推翻了**。

### 判据是「一个持久可达的状态突破了 §2.3」，不是「读路径少了一个 WHERE」

`derived != RAW` 说这行**是**生成产物；`provenance = 'derived'` 说它**来自**
生成器。§2.3 的信任过滤写在**后者**上（`tool-output`/`subagent` 永不默认注入），
而 `queryInjectionRows` 的派生分支按**前者**选行——**只持有其一的行，
骑着 `derived` 列径直穿过过滤器**。

| 检验（实测 2026-09-02，全部走生产函数/生产常量/原样 SQL） | 结果 |
|---|---|
| `UPDATE memories SET provenance='tool-output' WHERE derived != 0`（真实库副本） | `changes=6`，**6 行全部持久** |
| 同上，`store_revision` | **27 → 27，一个触发器都不响**（D9 的条件是 `OLD.derived = RAW`，改已派生行不触发） |
| 同上，随后 `queryInjectionRows` | **返回 6 条 `tool-output` 行** |
| 最外层：真实 `buildContextProvider` 注入包 | 3 entries/297 chars → **5 entries/419 chars**，低信任行**出现在正文里** |
| 对照：同 provenance 放在 `derived = RAW` 层 | 包为 `""`，**0 entries**（raw 路径的过滤正常工作） |

**所以这不是「口径不一致」**：§2.3 是一条安全规则，而它在派生分支上
**没有执行点**，且违规状态**今天就能通过一条裸 UPDATE 持久达成**。

### 主 agent 的选题错误，原样留档

我最初的方案是**在读路径加 `AND provenance = 'derived'`**，并断言「今天不可达
（唯二派生写者都硬编码 `'derived'`）」。**两条都错**：

1. **「不可达」是错的**——我只清点了 INSERT，漏掉了 UPDATE。上表第一行那条裸
   UPDATE 今天就可达且持久；更要紧的是 `reconcile.ts:92-95` 的 `existing`
   查询**无 derived 过滤**，实测在真实库返回 30 行中**含 6 行派生行**，
   把它们的 id 交给模型当 supersede 候选，其 UPDATE 实测打在派生行上
   `changes=1` **ACCEPTED**。**生产 UPDATE 已经在动这些行，只差一列。**
2. **读路径过滤只让行「不可见」，不让它「不可达」**——行照样存在，而
   `queryRecallRows` 按设计接纳全部 provenance，`memory_recall` **照样吐出它**。

> **教训**：清点「某状态可达吗」时，边界不是 INSERT，是**所有能写到这两列的
> 语句**。我按「写者会写什么」推断，却没按「哪些语句能改到它」枚举——
> 这与本仓 ADR 0009 教训 7「绕过真实写者的测量只验证自己的假设」同型，
> 只是这次绕过的是**改写者**而非写者。

### 做了什么：一条 CHECK，读路径一个字没改

schema **v10**：`CHECK (derived IN (0,1,2,3) AND (derived = 0 OR provenance = 'derived'))`。
**`fts.ts` 一字未改**——这正是相对读路径过滤的决定性优势：**读路径不必知道这条
规则**，它现在可以**依赖**数据层保证。先例是 v5 的 `invalidate_derived_*`
（"invalidation is a property of the DATA, not of the writer"）。

**不新增字面量**：`types.ts` 导出 `DERIVED_PROVENANCE`（`PROVENANCES` 的成员本体），
schema 的 CHECK 与 `rebuild.ts` 两处 INSERT **插值同一个符号**。

> **准确表述**：v10 使违规状态**不可表示**，但 `queryInjectionRows` 仍不读
> provenance。**该说「§2.3 的前提现在由数据保证」，不该说「§2.3 在派生分支上
> 有了执行点」**——两者差一个层级，混淆会让下一个人以为读路径已自带过滤。

### 行为零变化：量到最外面那把尺子

QA 用 `git archive HEAD` 编译出**第二份 lib**，两份代码各自加载真实
`buildContextProvider` + 真实 `StoreRegistry` + personal(global)+repo **双 store 装配**，
输入 9 个生产库副本：

| 场景 | 结果 |
|---|---|
| global + 8 个 repo 库逐一配对（8 组） | **8/8 注入包 sha256 逐字节相同** |
| global 走 L1 fallback / 双侧同时 fallback | **2/2 相同** |
| 合计 | **10 组配置全部逐字节一致** |

### migration 的实测代价与失败方式

| | 值（9 个生产库副本，2026-09-02） |
|---|---|
| 迁移结果 | **9/9 到 v10**，耗时 **12.3–124.7ms** |
| 存量违规行 | **0 / 494**（全表，无 status 过滤）——**不拒绝任何已存在的行** |
| 全字段保真 | 9/9 **IDENTICAL**（含 `evidence` 478 条零丢失、`usage`/`jobs`/`conversations`/`meta` 零影响） |
| **`rowid` 是否改变** | **未变**——这是真正的风险点，`memories_fts` 按 rowid 关联，FTS 孤儿行 **0**、MATCH 计数逐词相同 |
| 并发（2/4/8 个**真实独立进程**抢同一库） | 全部成功，**无死锁、无重复迁移**、`memories_rebuilt` 残表 **0** |
| 崩溃注入（12 个 exec 点逐点 SIGKILL） | **无一留下半迁移状态**，随后恢复 **13/13 成功** |
| 有矛盾行时 | 整体**原子回滚**停在 `uv=9`，坏行原样保留（**正确的失败**：库继续按旧 schema 工作并报错，而不是静默丢掉记录违规的那一行） |
| 混合舰队（v9 老进程保持连接，被 v10 迁移到脚下） | 注入行数与 id 序列不变，后续写入正常 |

### 三次打回，每次都值得记

1. **方案评审打回选题**（见上「主agent的选题错误」）。
2. **代码审查打回三条被证伪的注释断言**。最重的一条：`types.ts` 原注释写
   「rename the member and this line stops compiling」——**主 agent 亲手证伪**：
   把 `'derived'` 连同 `DERIVED_PROVENANCE`、`PROVENANCE_PRIORITY` 一起改名
   （即真实重构的做法），`tsc` **exit 0 零报错**，而 `rebuild.ts` 的陈旧字面量
   原样留下 ⇒ schema 要求新名、writer 写旧名，**rebuild 在运行时被 CHECK 拒绝**。
   注释声称防住的失效模式恰恰没防住。**修法不是改注释，是消除那份拷贝**
   （`rebuild.ts` 两处 INSERT 改插值），使那句话成为真话。
   > 另两条：测试注释声称两个 `assert.equal` 是某变异的唯一捕获者（实测删掉后
   > 5 个变异全部仍被杀，真正打红的是 fixture INSERT 自己抛）；以及注释写
   > `TS2322` 而**相近改名时实为 TS2820**（结论成立、错误码不同，主 agent 已改为
   > 两者并列）。**三条都属「写进源码比不写更糟」那一类**。
3. **QA 通过，但抓到一个本轮新引入的探测缺口**（见下，主 agent 已当轮补上）。

### QA 抓到的探测缺口：守卫写对了 ≠ 守卫被守住了

**把 `TARGET_USER_VERSION` 改回 9，`migrateV10` 写好且已注册，套件 236 全绿**
——迁移永不执行、本轮修的缺陷原样敞开，而 CI 报告成功。

**这是本轮新引入的**：同类变异在 HEAD 上是被杀的（v9 有 `cjk` 列这个新表面结构
被既有测试踩到），而 v10 不新增任何表面结构，**没有任何测试凭默认 target 感知到它**。

已补一条测试：用**生产的方式**开库（`migrate(db, 'repo')`，不传 target），断言
**结果**而非版本号。**特意不写** `assert.equal(userVersion(db), TARGET_USER_VERSION)`
——那个比较两侧读同一个符号，**在任何值上都通过，包括 9**。
变异验证：`TARGET_USER_VERSION` 改回 9 → **237 中唯独这条新测试变红**。

> **教训（本仓第 N 次，这次发生在 migration 上）**：「守卫写对了」与
> 「守卫被守住了」之间隔着一次变异验证。而**版本号常量的自反断言是假守卫**
> ——用被测常量去断言被测常量，恒真。

### 本轮登记的待办

| # | 事项 | 现状（实测 2026-09-02，全部走生产函数） | 处置判据 |
|---|---|---|---|
| q | ~~**「注入资格随最低来源」在 L3 画像上没有执行点**~~ → **✅ 已结项**（v0.4.10，见本页顶部），**但本条的严重性论证被证伪** | 实测（当时）：**L2 安全只是巧合**——`rebuild.ts:224` 复用了带 `provenance IN (...)` 的 `queryInjectableSet`，低信任探针 **0/27**；而 **L3 的 `runPersonaJob` 原样 SQL 无任何 provenance 过滤**，`tool-output`/`subagent` 探针 **21→23 全部进了画像提示词**。⛔ 而后半段引的供给面数字（`5ed2b4d2` 202 行、`2631a1750495` 17 行全是 `d0/tool-output`）**张冠李戴**：那些是 **repo 库**，而 `runPersonaJob` **只在 global 库运行**（实测 repo 库 `personaCalls = 0`） | ⛔ **本条现状栏前半为真、后半与判据栏都错，原文保留以便复核**。（1）**暴露面错**：L3 只跑 global 库，而 global 库的写入方只有 `propose(personal)`（恒 `principal-explicit`）与 rebuild（`derived`），`auto-extract` 必走 repo 库 ⇒ **当前 stock 配置下不可触发**；（2）**判据「与待办 n 同族、不可顺手做」错**：真正的修法**不触碰 §2.4 归因**，只是让 L3 两个执行点共用 §2.3 已有的定义，**净删 15 行手写 SQL**；（3）**漏了一半**：入队侧 `enqueuePersonaRebuild` 也是同一条无过滤谓词，只改执行侧会制造 `packetOverflows` 明令禁止的入队/执行不一致

## 🆕 v0.4.8：`LIMIT` 按行数裁，而所有守卫都按 token 定价（**行为零变化**）

**本轮结项待办 k，但结项方式是「证伪它，然后守住让它无害的那个条件」**——
当时登记的判据（「补一条测试断言画像留在包里」）**已被方案评审推翻**。

### 先说结论：待办 k 的原描述是错的，而这条错误描述直接生产了本轮的错误选题

原文写「本轮亲手把 `ORDER BY` 从『展示偏好』升级成了『选择谓词』……**随派生行
增长而兑现**」。**「随派生行增长」不成立**——派生行**涨不上去**：

| 检验（实测 2026-09-02，全部走生产代码/原样 SQL） | 结果 |
|---|---|
| 逐字重放 SCENARIO writer 的 commit body 5 次 | 派生行恒为 **6，不累积**（delete-then-insert + `.slice(ROLLUP_MAX_SCENARIOS)`） |
| 用 PERSONA writer 的**原样 SQL**（硬编码 `'private'`）插进 repo 库 | **被 trigger 拒绝**：`visibility does not match this store kind` |
| 9 个真实库中「同时持有两个派生层」的库数 | **0 / 9** |
| `3e857510` 那 6 行的 `(derived, updated_at)` 去重后 | **1 组**——6 行在两个排序键上**完全并列**，`ORDER BY` 不表达任何偏好 |

即：单库内 `derived` 是**常量列**（global 只出 L3、repo 只出 L2，由早返回 +
visibility trigger 双重保证），可达行数上界 = `ROLLUP_MAX_SCENARIOS + 1 = 7 < 20`。
**`LIMIT` 今天一行都裁不掉，`ORDER BY` today 是一个不比较任何东西的排序键。**

> **主 agent 的取数错误，原样留档**：我最初「证明」repo 库能持有 PERSONA 行，
> 用的是 `visibility='repo-local'` ——而生产 writer **硬编码 `'private'`**。
> 我验证的是 **schema 允许什么**，不是**写者会写什么**。这正是本仓
> 「绕过真实写者的测量只验证自己的假设」（ADR 0009 教训 7）的又一次复现，
> 且发生在一个**专门用来复核别人数字**的审计里。

### 但评审同时找到了真正无人看守的东西：一个**行数**上界

让上述一切成立的不等式 **`ROLLUP_MAX_SCENARIOS + 1 ≤ INJECT_TOP_N`
此前没有任何执行点在守**。控制组实测（主 agent 独立复现）：

| 配置 | 结果 |
|---|---|
| `(ROLLUP_MAX_SCENARIOS, SCENARIO_MAX_TOKENS, ROLLUP_TARGET_CHARS) = (21, 50, 40)`，**去掉新守卫** | **LOADS OK**——既有守卫**一个都不报警** |
| 同上，`worstInjectionPacketTokens()` | **恒为 1361**，纹丝不动 |
| 而此时派生层可发 **22 行**进 **20 行**窗口 | `LIMIT` 开始**静默丢弃**派生行 |
| 同配置，**带新守卫** | **抛错**，点名 22 > 20 |
| 出厂常量 / `INJECT_TOP_N`→6 | **LOADS OK** / **抛错**（7 > 6） |

**判据是「守卫按 token 定价，而 `LIMIT` 按行数裁」**：把每行改便宜是 token
守卫**唯一的杠杆**，而它在行数窗口里**一点空间都买不到**。这是 ADR 0007
「守卫必须建模运行时真正的容器」在**维度**上的复现——容器对了，**量纲错了**。

### 做了什么：一条常量间的不等式

`constants.ts` 新增 **GUARD 3（row count）**，紧挨既有的 GUARD 1（容量）/
GUARD 2（可满足性），原 GUARD 3 顺延为 GUARD 4（连带更正 2 处引用）。
**不新增常量、不写 `7`/`20` 任何字面量**，全部由既有常量推导。
抛错信息直接说明后果：越过此点 `ORDER BY` 会**从展示偏好变成选择谓词**。

**明确不做**：不为 `ORDER BY` 加回归测试。它需要一个**生产结构上构造不出的
fixture**（要同时制造「单库混层」与「>20 行」两个不可达条件），那样的测试
区分的不是好坏实现，而是「我的 fixture」与「生产」。
**控制组（去掉守卫则 22 行静默通过）才是这条守卫的可证伪证据。**

> **教训**：`235 全绿` 对这个 `ORDER BY` 的四种变异全部盲，**但盲不等于缺
> 测试**——它今天不产生任何可观测差异，这是「无行为」的正确表现。
> 把 mutation survival 一律读成「缺测试」，会把不变量测试变成
> mutation score 的军备竞赛。**该补的是让它无害的那个条件的守卫，不是测试。**

## 🆕 v0.4.7：护栏建模的 E 上界，对派生分支从来不成立（**行为零变化**）

**本轮结项待办 j**（＝v0.4.4 待办 4，两处登记的是同一条 LIMIT）。

`queryInjectionRows` 有两个分支：回退分支受 `INJECT_TOP_N`(20) 约束，**派生分支
不受任何行数约束**。而 `recall/inject.ts` 的加载期护栏把最坏条目数 E 建模为
`INJECT_TOP_N × 2 = 40`，注释里明写 "The entry count is therefore
`INJECT_TOP_N * 2`"——**这句话对回退分支为真，对派生分支为假**。

### 判据是「护栏答错了它唯一负责的那道是非题」，不是「数字不好看」

| | 值（实测 2026-09-02） |
|---|---|
| 插 500 条派生行 → `queryInjectionRows` | **返回 500 条**，无任何截断 |
| 单侧可达最大 E = `floor(1300/4)` | **325** → 真包 **1433 tok > 1400**，容器溢出 |
| 通用溢出阈值 | E=196 → 1400（过）/ **E=197 → 1401（抛）** |
| 而护栏 `worstInjectionPacketTokens()` | 上述全部情形**恒报 1361**，不报警 |

**这不是「口径不一致」**：护栏是一个会 `throw` 的机制，它的全部职责就是回答
「注入包会不会超 1400」，而它给的是**假绿**。这正是 ADR 0007「守卫认证了运行时
并不构建的包」与 ADR 0009「量到最外面那把尺子」的同型，**且是本仓第四次**。

### 做了什么：2 行代码

派生分支加 `LIMIT ?` / `.all(INJECT_TOP_N)`。**复用既有常量，不新增常量**——
新增 `INJECT_DERIVED_TOP_N` 会是同一个数字打两遍（D7–D9）。共用之后
`E ≤ INJECT_TOP_N × 2` **对两个分支同时成立**，护栏那句前提第一次为真。

**护栏一个 token 都不用改**，这是本方案相对「改护栏去建模派生上界」的决定性
优势——后者是把病因（读路径信任写路径不变量）固化成设计。四种分支组合实测：

```
derived/derived  derived/fallback  fallback/derived  fallback/fallback
     1361              1361              1361               1361     ← 全部收敛，等于护栏现值
```

代码审查另做 4000 次**随机异构**搜索（每行大小独立随机，专打「同质 fixture 掩盖
最坏形状」）：最坏 1360 ≤ 护栏 1361，**紧界，差 1 tok**。

### 行为零变化：三层逐字节验证，不是「测试全绿」

QA 用 `git archive HEAD` 编译出**第二份 lib**，同进程加载两份代码跑同一批库副本：

| 层 | 结果 |
|---|---|
| `queryInjectionRows` 逐库行载荷 sha256 | **9/9 IDENTICAL** |
| `collectMetrics` **整对象** JSON | **9/9 IDENTICAL** |
| `buildContextProvider` 真实注入包 | **9/9 逐字节相同**（含「无 repo 会话」） |

为此给 8 个真实库各建了配对 remote 的 git 仓库，使 `deriveRepoIdentity` 反推出
一致的 store key（8/8 MATCH），走的是**真实双 store 组装路径**。

**且用真实条目尺寸（620 字符 L2 块）时，即使 100 条派生行 packet 仍逐字节相同**
——token 预算远在 20 行之前就先截断了。行为差异只在人造饱和廉价条目下可观测。

### 附带收益：50k 派生行下内存降 2000 倍

| | before | after |
|---|---|---|
| 返回行数 | 50 000 | **20** |
| 耗时中位数 | 67.6ms | **41.3ms**（−38.9%） |
| heapUsed | 351.04 MB | **0.16 MB**（−99.95%） |

> **但别把内存改善误读成查询已优化**：`EXPLAIN QUERY PLAN` 显示加 LIMIT 后
> **计划完全没变**（仍 `SCAN` + `USE TEMP B-TREE FOR ORDER BY`），省的是物化
> 5 万行到 JS。试加索引实测**反而略慢**，故不加。

### 本轮最重要的方法论产出：那个差点写出来的假测试

方案评审证伪了主 agent 的**散文描述**（数字是对的，形状是错的）：最坏条目**不是**
「1 字符 title + 1 字符 body」。实测——

```
薄条目 `- [fact] x: y`    13 字符，计费 4 tok  → 325 条 = 1189 tok，不溢出
饱和条目 `- [fact] x: yyyy` 16 字符，计费 4 tok  → 325 条 = 1433 tok，溢出
```

因为 `estimateTokens = ceil(len/4)` **逐条丢弃余数**，同样计 4 tok 的条目可以占
13～16 字符。**照散文写 fixture，容器测试会在未修复的 HEAD 上就绿。**
主 agent 已实跑该哨兵确认：薄 fixture + 未修复代码 = 容器测试**变绿**。

> **教训**：一个数字对、但**形状**描述错的规格，会产出一个自称证明了什么、
> 实则什么都没证明的测试。**规格里必须写清对手的形状，不只是它的数值。**

### 两条新测试的鉴别力**相差 15 倍**，别以为有双重保险

QA 逐点二分（每点真实编译并跑完整 235 条）：

| LIMIT 被放松到 | 测试1（行数） | 测试2（容器） |
|---|---|---|
| 21 | 🔴 | ✅ 绿 |
| 197 | 🔴 | ✅ 绿 |
| 308 | 🔴 | ✅ 绿 |
| **309** | 🔴 | 🔴 首次触发 |

**真正守住 LIMIT 的只有测试 1**；名字里写着「§4.2 容器」的测试 2 在 21–308
**全程绿灯**。两条测试是「机制 + 后果」的正交对，**不是互为独立证据**——
删掉测试 1，`LIMIT 300` 可以静默上线。已写进测试注释。

### 两位审查者各自抓到一处**注释事实错误**（已打回执行修正）

**两处都可被一条命令证伪，且都是「写进源码注释比没有更糟」的那类**——
后来者会把它们当已验证的先例引用。

| # | 原文 | 证伪 |
|---|---|---|
| 1 | 「`E = 197` already **passes** 1400」 | E=196 恰好 =1400 **未超**，E=197 才 1401。`passes` 在临界点上有一半概率被读反 → 改 `exceeds` |
| 2 | 「真实库 `3e857510e628` **已携带超出 writer 天花板的派生行**」 | 该库派生行 **6 条 = 天花板 6，并未超**。超的是 **body 字符数**（5/6 超 620）——**是另一个约束** |

第 2 条的危险不只是数字错，而是它把**两个不同口径**（行数天花板 vs body 字符
天花板）混成一条断言：引用它去论证「行数已越界」，会得到一个**用错误前提支撑的
正确结论**，比单纯数字错更难纠。修法选了**删句**而非改数——支撑「读路径不得
假设写路径 ceiling」根本不需要经验样本，schema 事实（`CHECK` 约束的是 `derived`
的**层级取值**，从不约束**行数**）已完备且不可证伪，且不必长期维护会漂移的数字。

> **教训**：「口径混淆型」断言应与普通事实错误**分开标注**。它披着可复核的外衣，
> 而复核者若不追问「主语到底是哪个量」，会确认一个它并没有证明的结论。

### 本轮登记的待办

| # | 事项 | 现状（实测 2026-09-02） | 处置判据 |
|---|---|---|---|
| k | ~~**`ORDER BY derived DESC, updated_at DESC` 零测试覆盖，而本轮改动放大了它的后果**~~ → **✅ 已结项**（v0.4.8，见本页顶部），**但结项方式与本条当时的判据相反** | ~~实测 26 条派生行时 L3 画像直接掉出 20 行窗口~~ | ⛔ **本条当时的现状栏与判据栏都是错的，原文保留以便复核**。（1）「26 条派生行」**任何生产写者都构造不出**：writer 是 delete-then-insert + `.slice(ROLLUP_MAX_SCENARIOS)`，实测重放 5 次恒为 6 行；（2）「随派生行增长而兑现」**不成立**，上界是常量 `ROLLUP_MAX_SCENARIOS + 1 = 7`，不是数据量的函数；（3）单库内 `derived` 是**常量列**（9/9 真实库无一混层），故该 `ORDER BY` 今天**不比较任何一对行**。**真正无人看守的是让它无害的那个不等式**，已改为加载期守卫。**这条错误描述直接生产了下一轮的错误选题**——见本页顶部 |
| l | **测试 helper 的 `kind = 'fact'` 是抄来的结论而非推导** | 三种 kind 变异全绿。实测各 kind 成本：`fact`/`coding` cheapest=4（maxEntries 325）、`preference`/`procedure` cheapest=5（260）——**`fact` 恰好是最坏 kind** | **今天侥幸正确**。但 `recall/inject.ts` 的 `cheapestEntryTokens`/`fillEntry` 是从 `MEMORY_KINDS` **排序推导**最短 kind 的，测试却把结论抄成字面量——`MEMORY_KINDS` 哪天加进更短的 kind，护栏自动跟上，**fixture 不会**。属「同一个数字写两遍」 |
| m | **`SLOW_STATEMENT_MS` 告警被本轮顺带消音** | 50k 派生行时，改动前 **6/7 次**触发 `slow statement inject-top-n`，改动后 **1/7 次** | 「修好了后果、掩盖了原因」的典型形状：派生层从 6 条涨到 5 万条，注入包不变、`injectableTokens` 不变（都截断到 20）、慢查询也不再告警——**该异常变得完全不可观测**。今天无此类库，`activeCount` 仍会涨，故登记不修 |

### 📋 v0.4.8 本轮登记的三项待办（未排期）

**⚠️ 第 n 项是本仓当前最高优先级的产品缺陷，且它比 ADR 0010 当年登记时更严重。**

| # | 事项 | 现状（实测 2026-09-02，全部走生产函数） | 处置判据 |
|---|---|---|---|
| n | 🔴 **ADR 0010 的归因缺陷已恶化，且其「前置阻塞项」已解除** | 按生产常量 `INJECTABLE_PROVENANCE` 复核 8 个 repo 库：**extract 产出可注入 27/317 = 8.5%**，而 **propose 产出 64/64 = 100%**（ADR 0010 当年是 10.9% vs 98.4%）。**三个库可注入数为 0**（dsh_remote_web 0/14、dsh_weir 0/20、singbox-cli 0/16）——这三个仓**每轮注入包都是空的**。L0 供给侧：`tool-output` 占 **72.3%**（6811/9414） | **ADR 0010 §六「下一步」要求的前置条件已满足**：0.3.7 后新写入 **115 条**未截断 evidence（恰好 400 字符的从 242 条降到 **2** 条），分解不再读截断产物。**本轮已按它的要求重做分解**：A 类（引用了高信任行却被降级）**47**、B 类（纯低信任来源）**40**、已可注入 **4**。**即 A 类 47 条是「同时引用了人的原话，仍被打成 tool-output」的**。修法触碰 §2.4 fail-closed 注入安全边界，**必须先实测证明伪造路径已被 JSON 转写堵死**（ADR 0008 的加固），属产品判断 + 安全评审，不可顺手做 |
| o | **`rebuild.ts:248` 的 `store.kind === 'global' ? 'private'` 是死分支** | 同一函数第 214 行已 `if (store.kind === 'global') return runPersonaJob(...)`，故第 248 行处 `kind` **可证明恒为 `'repo'`**。实测改成常量 `'repo-local'` 后 **235 全绿** | **纯清理，收益仅为删掉一个不可达三元**。但它与 v0.4.4 待办 3 记的「`rebuild.ts` 有三处同形状分派，要改就一起改」是同一族——**单改一处会造成方向不一，比现状更糟**。故与待办 3 合并处置，不单独动 |
| p | ~~**`queryInjectionRows` 的派生分支不过滤 `provenance`，回退分支过滤**~~ → **✅ 已结项**（v0.4.9，见本页顶部），**但修法与本条当时的判据相反** | 实测：往派生层插 `provenance='tool-output'` / `'subagent'` 的行，**两条都被注入**；而同样 provenance 的 **raw 行被 `queryInjectableSet` 挡掉** | ⛔ **本条当时的现状栏为真，判据栏与「今天不可达」都是错的，原文保留以便复核**。（1）**「今天不可达」错**：只清点了 INSERT，漏掉 UPDATE——裸 `UPDATE ... SET provenance` 打在已派生行上**今天就持久可达且零触发器响应**，且 `reconcile.ts` 的 supersede UPDATE 已在动派生行；（2）**判据「必须先在此加过滤」错**：读路径过滤只让行**不可见**不让它**不可达**（`queryRecallRows` 按设计接纳全部 provenance，`memory_recall` 照样吐），且对上述 UPDATE 路径**完全无效**。正解是把不变量下沉到数据（schema v10 CHECK），**`fts.ts` 一个字都不用改** |

## 🆕 v0.4.6：注入包的最外层容器此前无人看守（**产品行为零变化**）

**详见 [ADR 0013 §七](decisions/0013-bound-the-write-in-the-unit-the-container-spends.md)。**
本轮结项的是**上一轮登记的待办 d**。

spec §4.2 说的是「头部框定 + 正文 **总 ≤1400**」，而 `INJECT_BODY_BUDGET_TOKENS
= 1300` 只是**正文内部配额**。**1400 这个真实容器此前在代码里不存在**：三条加载期
守卫（容量 / 可满足性 / 外仓下界）算的全是 1300 以内的事，而看起来在守 1400 的
**四处**测试断言全是**裸字面量 + 非最坏 fixture**。

### 判据是「容器溢出而全部断言保持绿色」，不是「数字不好看」

主 agent 的控制实验（协调重调，使既有守卫全部满足）：

| | 值 |
|---|---|
| 变异：`INJECT_BODY_BUDGET_TOKENS` 1300→1400、`PERSONA_TARGET_CHARS` 600→800、`PERSONA_MAX_TOKENS` 171→224 | **三条加载期守卫全部通过** |
| 最坏包实际 | **1405 tok > 1400**，容器已溢出 |
| 测试 | 228 pass / **3 fail，而三条红的没有一条是那四处 `≤1400` 断言** |

三条红分别是 `layers:1470`、`layers:1539` 的 **fixture 前置断言**与 `layers:1901`
的无关拒绝。**那四处 `≤1400` 在容器真实溢出时全绿**——因为它们的 fixture 不是最坏
形状，断言的是今天的数据而非写者的值域。这正是 ADR 0009「量到最外面那把尺子」在
注入侧**从未闭合**的那一半。

### 方案评审打回了第一版，理由值得记：最坏形状被算窄了

初版只给派生形状（1 画像 + 6 简报，E=7）定价 = **1352**。评审证伪：
`buildContextProvider` 对 personal 与 repo **各调用一次** `queryInjectionRows`，
而该函数**无派生行就回退到 `INJECT_TOP_N`(20) 条 raw L1**，**两侧可同时回退**
（D9 触发器使 global 画像实测 41.5% 时间缺席）。故 **E 可达 40，不是 7**。

关键算术：包是 `[header, '', ...lines].join('\n')`，即
`headerLen + 2 + Σ(条目长) + (E−1)` 字符；而 `estimateTokens = ceil(len/4)`
**逐条丢弃各自的余数**，所以紧确界**随条数 E 单调上升**：

```
E=7  (派生)      -> 1352   ← 最便宜的形状，不是最坏
E=40 (双侧回退)  -> 1361   ← 真正的最坏
```

**初版把最省当成了最坏。** 决定性反证：只给派生形状定价时，把
`INJECT_TOP_N` 改成 155，容器真实溢出到 **1401**，而守卫**纹丝不动仍报 1352**
——ADR 0007 那种「守卫认证了运行时并不构建的包」的假绿。

### 做了什么

新增 `INJECT_PACKET_BUDGET_TOKENS = 1400`（§4.2 总容器），护栏放
**`recall/inject.ts`** 而非 `tools.ts`：该文件**已经**导入 `constants.ts`，
故**不新增任何 import 边**、不可能成环；而 `constants.ts` 调 `renderFramed`
会闭合 `render.ts` 专门保持断开的那个 `constants → inject → constants` 环。
`tools.ts` 的先例守的是**它自己渲染的** recall 包——**护栏应挨着它约束的那次
渲染调用**，而注入包是在 `inject.ts` 渲染的。

护栏取**两种形状的 max**，经**真实 `renderFramed`、真实预算、同一个 `withId`
默认值**定价；`cheapestEntryTokens` 由 `renderEntry` + `MEMORY_KINDS` **现算**
（写死 4 就是同一个数typed两遍）。四处裸 `1400` 全部改为导入常量。

| | 值（实测 2026-09-02） |
|---|---|
| 出厂最坏包 | **1361**，余量 **39**（**不是上一版本页写的 48**，已更正） |
| 变异 `INJECT_TOP_N` 20→155 | 加载期抛错 **1401**（阈值精确：154 过 / 155 抛） |
| 变异 `PERSONA_MAX_TOKENS`→250 + 预算→1378（协调重调） | 既有守卫**全部放行**，**唯独新护栏**抛错 1439 |
| 表头加长探针 | +155 字符仍静默 1400、**+160 抛错 1401**——证明护栏**真把 header 计入** |
| 穷举四种分支组合 | max = **1361**（`fallback/fallback`），与护栏读数**逐一相符** |
| 端到端可达性 | 真实 store + 真实 `buildContextProvider` **恰好打满 1361**（40 条目 / 5444 字符）⇒ **紧界而非保守估计** |
| 测试 | 231 → **233 passed / 0 fail** |

### QA 打回一次，抓到的又是**测试盲区**而非产品缺陷

首版护栏本身正确，但 `Math.max` → `Math.min` 变异（**等于删掉 fallback 那一半**，
即评审打回初版的那一半）后：守卫由 1361 降到 **1352，而 233 测试全绿**。
更严重的组合变异（`min` + `INJECT_TOP_N=155`，容器真实溢出 1401）下，唯一变红的
是 **`resilience.test.mjs:302` 这条无关测试**——**护栏自己的回归测试鉴别不出
「只建模便宜形状」的守卫**。

已补一条测试，断言的是**性质而非算术**：`worstInjectionPacketTokens() ≥` 由
**真实 `buildContextProvider`** 驱动两个真实 store 装配出的双回退包的价格。测试里
**不重算** `max(derived, fallback)`、**不写死** token 数——fixture 只负责抵达
fallback 形状，定价交给生产代码。并加了形状前置断言（两侧 `derived` 计数为 0、
各返回满页 `INJECT_TOP_N`、正文预算**一分不剩**、`countEntries === 40`），
**专防「fixture 同质化把性质断言退化成常量断言」**这个本仓已记录过的失效。
现该变异**唯一打红的就是这条新测试**。

> **教训（与 v0.4.4 那条同型，但这次发生在护栏上）**：护栏建模了正确的容器，
> **不等于**有测试能证明它继续建模着那个容器。**「守卫写对了」与「守卫被守住了」
> 之间隔着一次变异验证**，而本轮第一次没做这次验证。

### 本轮登记的两项待办（未排期）

| # | 事项 | 现状（实测 2026-09-02） | 处置判据 |
|---|---|---|---|
| i | **余量 39 tok，与 `FRAMING_HEADER_MIXED` 的成本恰好相等** | 混合抬头比普通抬头贵 **90−51 = 39 tok**，而今天余量正好 **39** | **算术巧合，不是设计**。今天安全**仅因为组内容结构性到不了注入路径**：`queryInjectionRows` 只 SELECT 四列、`MemoryHit` 无 `source` 字段、`inject.ts` 全文不读组声明，故 `renderFramed` 恒选普通抬头。**哪天外仓条目能进注入包，容器会被一次花光到最后一个 token**，且**护栏不会报警**——它建模的正是「没有 `source`」这件事。做该改动的人必须先按 MIXED 重算本护栏 |
| j | ~~**`queryInjectionRows` 的派生分支无 LIMIT，护栏靠写路径而非读路径兜底**~~ → **✅ 已结项**（v0.4.7，见本页顶部，同时了结 v0.4.4 待办 4） | ~~SQL 层塞 150 行实测**会全量返回**~~ | 已按本条当时登记的判据实施（复用 `INJECT_TOP_N`）。**但当时这条把「可达 E 最大 40」当成了现状，那是错的**——40 是护栏**建模**的上界，恰恰不是派生分支**可达**的上界：派生分支不受 `INJECT_TOP_N` 约束，单侧可达 **325**，真包 1433 > 1400。**本条自己就是那个假绿的又一次复现**：它引用护栏的建模值去论证护栏是安全的 |

## 🆕 v0.4.5：派生层写入侧改按渲染后 token 约束（**会改变落库字节**）

**这是一次会移动写入路径的结构改动**（当时登记为「属独立评估」），已实施并
带完整变异验证。详见
[ADR 0013](decisions/0013-bound-the-write-in-the-unit-the-container-spends.md)，
其中同时**更正了 ADR 0007「残余敞口」段写反的因果**（原文按仓库惯例保留）。

### 做了什么

写入侧（`pipeline/rebuild.ts`）此前按**字符数**裁剪
（`slice(0, ROLLUP_TARGET_CHARS)` / `slice(0, PERSONA_TARGET_CHARS)`），
而消费它的容器（`recall/render.ts` 的 `withinBudget`）按**渲染后 token** 计价
——`renderEntry` 把 body 里每个 `\n` 缩进成 `\n␣␣`，每个换行 +2 字符。
**单位错配。** 现两端共用同一把尺子：两个执行点都改用**已有的**
`truncatedToBudget`（不新写截断逻辑 = 不制造规则的第二个实现）。

### 实测数字（2026-09-02，9 个真实库只读查证）

| | 值 |
|---|---|
| 缺陷 A：合规画像被**整条丢弃** | 600 字符 + 21 换行 = **172 tok** > cap **171** → 注入 **0 条**；线上真实画像 163 tok，**余量仅 8 tok** |
| 缺陷 B：ADR 0007 声称「受保护」的 L2 | 画像每次都活着，**先垮的是 L2**：lineLen 30→6/6、10→**5/6**、3→4/6、2→3/6 |
| 新上限（解出，非拍定） | `PERSONA_MAX_TOKENS=171`、`SCENARIO_MAX_TOKENS=188 = floor((1300−171)/6)` |
| 闭合算术 | `171 + 6×188 = 1299 ≤ 1300`，**余 1 tok 是有意为之**；189 → 1305，加载期抛错 |
| 可满足性边界 | 620@1/30=183 ✅、620@1/22=187 ✅ ‖ 640@1/30=189 ❌、620@1/10=204 ❌ |
| `worstForeignRowTokens` 重解 | **217**（旧 212），预算 220，**余量 8 → 3 tok** |
| 测试 | 224 → **231 passed / 0 fail**，`tsc` exit 0 |

### 存量数据：不写迁移脚本

16 条现存派生行（8 个 repo 库 + global 库，2026-09-02）中 3 条超新上限
（226/238/200 tok，全在 `3e857510e628`，且**本来就超今天的 620 字符上限**）。
新约束比旧的**更宽**。

**收敛判据（复核命令口径）**：唯一持有超限行的 `3e857510e628`，其
`packetOverflows(store)` 为 **true**，故下次 rebuild 会 `DELETE` 后重写全部块，
**自然收敛**。写一次性迁移脚本 = 新增一个只跑一次的写者，禁止。

> ⚠️ **本页上一版此处写「9 个库全部为真（1808–26592 tok）」，那个数是错的**，
> 现更正。错因值得记：取数时**手写了一段 SQL** 而没有调用生产的
> `packetOverflows` / `queryInjectableSet`，漏掉了 `provenance IN (…)` 过滤，
> 于是把不可注入的行也计了价。按生产函数复核（2026-09-02，8 个 repo 库）：
> **4/8 为 true**（`3e857510e628` 3007、`5ed2b4d261b2` 3291、`ec2636fc223e` 1808、
> `edf7a6862dde` 1916），其余 4 库为 false（0–1079 tok）。
> **结论不变且更紧**：需要收敛的那个库恰好就在 true 之列。
> 这正是本仓「绕过真实写者/读者的测量只验证自己的假设」（ADR 0009 教训 7）
> 在**文档取数**上的同型复现——复核请用生产函数，不要手写等价 SQL。

### 本轮新登记的八项待办

| # | 事项 | 现状 | 处置判据 |
|---|---|---|---|
| a | **`RECALL_FOREIGN_BUDGET_TOKENS` 余量降至 3 tok** | 最坏可存储 L2 行的 recall 定价由 212 升至 **217**，预算 220 | **不调预算**（守卫仍绿，且它是 `RECALL_PACKET_BUDGET_TOKENS` 的推导项）。但该预算历史上**两次**被**渲染形状**变化顶回来（加 id、加 `(from …)` 标签），3 tok 约等于再来一次的余量。任何加长 `renderEntry` 外壳、或上调 `SCENARIO_MAX_TOKENS` 的改动**必须先复算这个数**；守卫抛错而非告警，会在加载期暴露 |
| b | **`ROLLUP_TARGET_CHARS` 现在只由可满足性守卫看守** | 删掉该守卫后实测：640/700/**900 全部 NO THROW** | 换单位后该常量脱离了容量守卫，而守卫 3 改为对**裁剪后**的行定价，也不再随它变化——**它是唯一的看守人**。`test/pipeline-e2e.test.mjs` 的探针已由 900 改为 **640**：640 是该守卫的**最小触发值**（639→188 通过、640→189 抛错），取边界值比取远值更精确。⚠️ 上一版此处写「900 是无效探针，会被无关守卫接住」——**该理由不成立**，实测今天的代码里 640/700/900 **全部**由守卫 2 抛出并点名 `ROLLUP_TARGET_CHARS`；900 只是更钝（阈值漂移到 900 以下它仍会绿），不是打错靶 |
| d | ~~**inject 侧最外层余量降至 48 tok，未被任何守卫看住**~~ → **✅ 已结项**（v0.4.6，见本页顶部） | ~~最坏合规派生层整串 packet = 1352 tok，而 spec §4.2 的真实容器是 1400，加载期无守卫~~ | 已按本条当时登记的判据实施（新增 `INJECT_PACKET_BUDGET_TOKENS` + `recall/inject.ts` 加载期护栏）。**但当时这条把 1352 当成了最坏值，那是错的**：派生形状（E=7）是**最便宜**的形状，真正的最坏是**两侧同时走 raw L1 回退**（E=40）的 **1361**，故**余量是 39 而非 48**。成因是逐条 `ceil` 的余数损失随条数上升。详见本页顶部 v0.4.6 一节 |
| e | **`worstPersonaTokens()` 已与 `PERSONA_TARGET_CHARS` 解耦** | 今天两者同为 171、运行时钳制逐字节不变。但若将来**下调** `PERSONA_TARGET_CHARS`：旧实现 cap 会跟降（400 → **118**），新实现仍返回 **171**；且守卫 2 在下调方向**不报警**（实测 400/500/550 全部 LOADS OK） | 今天无害，属「下一次调参时会咬人」。后果是 raw fallback 会保留比画像本身更宽的额度（`recall/inject.ts` 用它当 personal 侧 cap）。判据：**调 `PERSONA_TARGET_CHARS` 时必须同时重解 `PERSONA_MAX_TOKENS`**——两者的联系现在只由 `test/pipeline-e2e.test.mjs` 里那条等式断言维持，不由加载期守卫维持（守卫只在上调方向、且仅 172 这一个值之外报警） |
| f | **`TRUNCATION_MARK` 持久化后的下游闭环无人检查（本轮最大遗留风险）** | 标记现在写进 SQLite，而带标记的 body 会作为**下一轮 rollup / persona 的输入回流给模型**（`runPersonaJob` 把 `current?.body` 喂回提示词）。三个已复现的征兆：① 标记**可被伪造**——一条从未被裁剪的 body 只要自己以标记结尾，`endsWith(TRUNCATION_MARK)` 即为真；② 裁剪可产生**半截标记 + 真标记**的尾巴（主 agent 实测：前缀扫描 220 个位置中 **38 个**留下残缺标记；模型回声式 body 可携带 **17 个完整标记 + 1 个残片**，尾部形如 `… […truncated to fit […truncated to fit the memory budget]`）；③ **无任何测试覆盖**「带标记的 body 作为下一轮输入」 | **ADR 0009 教训 7 的形状：新写者的产物成了老读者的输入，中间没人量过。** 处置判据：`endsWith(TRUNCATION_MARK)` **不可用于生产判断**（可伪造）。⚠️ 但 `test/pipeline-e2e.test.mjs` 里那条断言**同时**断言了长度被裁短，**故那条测试的可信度不受影响**——区分「谓词不可用于生产」与「测试不可信」，两者不是一回事。已实测**不会无限累积**：反复重裁同一条 body 稳定在 1 个标记、681 字符（`truncatedToBudget` 先判整体是否合规，合规即原样返回） |
| g | **title 仍留在旧单位（同一缺陷模式的残留半边）** | `parseScenarios` 的 title 仍按**字符**切（`slice(0, ROLLUP_TITLE_TARGET_CHARS)`），而它的换行同样被 `renderEntry` 计价。今天安全**只来自两个常量的比例**、无加载期守卫：主 agent 实测触发 `truncatedToBudget` 返回 `undefined` 需要 **245 个纯换行的 title**（空 body 时 248），而写路径硬切 **60**——**距离仅 4.1 倍** | 今天不可达，但**不是死代码**：`ROLLUP_TITLE_TARGET_CHARS` 或 `SCENARIO_MAX_TOKENS` 任一变动都可能让 `undefined` 分支进入可达区，这正是本轮**显式处理该分支而非断言其不可能**的理由。title 未改单位是**有意**的（它没有自己的预算，且实践中不含换行），已写在 `parseScenarios` 注释里；此处登记是为了让「有意」可被复核 |
| h | **两处单向安全的测试盲区（不必修）** | ① 派生路径 `withId` 传成 `true` → **231 全绿**（实测只多算 **6** 字符而非 36，因为派生路径传 `id: ''`，多的是 `(id ) `）；② L2 定价 `kind` 改写 → **231 全绿**（没有比 `'fact'` 更短的 kind） | 两者都只会让写路径**少存**内容，**绝不会存进超限行**，故是**测试盲区而非产品缺陷**。对照：`renderEntry` 的缩进逻辑变异会打红 5 条，即**定价核心不是盲区**。登记而不修——为这两条加测试需要断言「定价参数恰好是这两个值」，那是把实现细节钉进测试 |
| c | **截断标记的措辞无测试覆盖（已补，但补的是黑名单不是性质）** | 把 `TRUNCATION_MARK` 措辞改回 `recall budget`，**231 全绿** → 已补测试打红。⚠️ 但该测试是**黑名单**：QA 实测改成 **`"context packet budget"`**（同样点名单一容器的错误措辞）**231 仍全绿** | 上一版本页把它写成「按性质断言」，**该描述不准确，现更正**。「措辞是否点名了某个容器」是一个关于英文的判断，**没有可靠的机器判据**——任何谓词都是一张词表假装成性质。本轮已把词表扩到本仓可达的全部容器名（`recall`/`inject`/`injection`/`packet`/`context`），QA 那个反例现在会被打红；但它**仍是黑名单**，挡不住用表外词汇造出的同型错误措辞。测试注释里已写明该局限。**保留黑名单 + 写清局限，好过一个自称性质、实为词表的断言** |

## 🆕 v0.4.4：packet 指标量的是一个运行时不会被注入的集合

**产品行为零变化**（已按编译产物证明：`recall/inject.js`、`render.js`、`fts.js`、
`constants.js` 等产品路径模块**逐字节未变**；`packetOverflows` 的入队决定
**9/9 库与 HEAD 相同**）。本轮只动观测面与它自己说的话。

`metrics.ts` 的 `packetTokens` 声称回答「注入包多大」，却对
`queryInjectableSet`（**raw 集**）计价；而运行时注入走 `queryInjectionRows`
——**有派生行时派生行整体替换 raw 集**，personal 侧另有 `worstPersonaTokens()` 上界。

**判据是「同一个是非题，两个容器答反」**，不是「数字不好看」：

| | 值（实测 2026-09-01，9 库副本） |
|---|---|
| 对 `INJECT_BODY_BUDGET_TOKENS` 结论相反 | **3/9 库**（`3e857510` 2000/1161、`ec2636fc` 1808/914、`global` 5667/88） |
| global 画像在场 / 缺失 | **88 / 166**（漏掉 `withinBudget` 则缺失态报 5667，**34.1×**） |
| 测试 | 221 → **224 passed / 0 fail** |

修法：metrics 按 `store.kind` 分派，**逐字对齐** `recall/inject.ts` 的同两步调用；
`worstPersonaTokens()` **import 调用而非抄数**（一条规则两个执行点）。

**字段改名 `packetTokens` → `injectableTokens`，这是本轮的第二个交付。**
`renderFramed` 作用于**拼接后**的 hits，逐库快照够不着，所以该值**可以超过**
`INJECT_BODY_BUDGET_TOKENS`。这个缺口**先于本轮存在**（实测 HEAD 上
`5ed2b4d2` 同样报 3291，且该库派生行为 0、走的就是旧代码那条回退路径），
本轮**不修实现、改承诺**——ADR 0009 的规矩。字段注释现列明两条局限
（不含跨库竞争、不含 packet 预算裁剪）并说明为什么不在这里施加该预算
（会是选择规则的**第三次**实现；逐库钳制是另一个近似而非更准；且等于
假装本库独占共享容器 = ADR 0007 形状）。

**尺子共用、字段名不共用**：`packetTokens()` 函数仍被 `packetOverflows` 与
metrics 共用，这是 `constants.ts` 明文允许的 "Two containers, one ruler"；
但同名字段在两处指两件事是 ADR 0009 §六(c) 记的那种失效，故改名。

### `packetOverflows` 明确不改，且论证由数据换成了算术

改用 `queryInjectionRows` 会**自指冻结**：实测 9 库中 **2 库**（`3e857510`、
`ec2636fc`）当场由 true 翻 false，即建成派生层后再也不会重建。
**不要用「9 库中几库冻结」当依据**——那个证据会随 rebuild 自愈而失效；
依据是算术：合规派生层按构造装得下预算。

> **⚠️ 但「恒假」是错的措辞，本轮已收窄两次。** 除存量脏行外，**合规但
> 换行密度高的 body 也能突破**：写入侧 `slice` 约束**字符数**，而
> `renderEntry` 把 `\n` 缩进成 `\n␣␣` 后**按渲染计价**。实测 6 块全部
> ≤ `ROLLUP_TARGET_CHARS` 时，行长 ≤6 字符即超预算（最高 1.5×）。
> 该暴露 `constants.ts` 早在 `DERIVED_WORST_LINE_CHARS` 上登记过，
> **本轮是第一次有人拿它去证伪一句注释**。结论不变（仍不改容器），
> 变的是论证的普适性。

### 本轮三次被打回，每次都值得记

1. **头两个选题被方案评审打回**：第一个（`recallMissRate` 分母含 `Error:` 行）
   **是 2026-08-31 已裁定「不修」的事项**——重新发现一个已决策事项，正是
   §「明确决定不做」那节存在的理由；第二个（`retrievedRate` 分母含派生行）
   死于**「修了不改变任何决定」**（两个跨过 `DECAY_MIN_ACTIVE` 闸的库分叉恰为 0）。
   **「口径不一致」本身不是修的理由，「它让人答反一道是非题」才是。**
2. **QA 打回一次，抓到的是测试盲区而非产品缺陷**：初版两条新测试的 fixture
   同质——测试 1 只有 1 条 15 tok 派生行（`15 < 171` 帽，加不加帽都一样）、
   测试 2 的 20 条**每条恰好 112 tok**（`112 ≤ 171 < 224`，使 `withinBudget`
   退化成 `slice(0,1)`）。后果：**「两侧都加帽」这个变异摧毁 8/9 库数值
   （一个归零）而 223 测试全绿**。现 fixture 改为单价跨帽 + 不等长交替，
   并断言存活集**不是前缀**，三个原盲区变异现各自变红。

> **教训**：fixture 的**同质性**会让性质断言退化成常量断言。两边都用生产
> 函数算**不足以**保证鉴别力——还要保证 fixture 上**两个候选实现真的不同**。
> 现测试已把这条写成前置断言。

## 🆕 v0.4.3：L0 的「90 天保留期」是一条从不删除任何行的语句

**详见 [审计留档](audit-2026-09-01-l0-retention.md)。产品行为零变化——本轮
只让文字追上事实，并给一个此前零覆盖的语义补上断言。**

`pruneConversations` **删除量恒为 0**，且**不是「还没到期」**：豁免子句
`session_id NOT IN (被存活记忆引用的会话)` 使保护集**恒等于全集**。
两个反事实对照（逐字节照抄的生产谓词，9 库副本）：

```
把窗口强行开到 now+1d（一切行都「过期」） : 删 0 / 6813 行
只留豁免子句、去掉时间条件               : 删 0 / 6813 行
```

**时间条件贡献 0 次删除，决定一切的是豁免。** 所以「等 2026-11-21 就会开始删」
是错的——届时删除量仍是 0。根因是**粒度错配**：`evidence.ref` 记的是**整个会话**，
而记忆只引用若干 `sourceSeqs` 行，于是**一条记忆永久钉住它所在的整个会话**
（放大 **10.8×**，死重 90.8%）。

| | 值（实测 2026-09-01，9 库副本） |
|---|---|
| 豁免率 | **6813/6813 行 = 100%**，18/18 会话 |
| L0 因 ADR 0012 已不可达 | **70.6%**（引用者都带 excerpt ⇒ `source()` 早退，走不到回退） |
| 体积 | L0 占同项目平台日志解压量 **2.72%**（同范围同单位） |
| 测试 | 219 → **221 passed / 0 fail** |

**裁决：只改文档 + 补测试，不动删除行为。** 三个动机里只有两个成立：

1. **体积无上界** —— **被自己的数据撤销**。2.72%，且平台自身 session 日志
   在本机同样无轮转。ADR 0009 §七「零损害实例」在体积维度**依然成立**。
2. **代码在陈述一件不发生的事** —— 成立 ⇒ **让文字追上事实**。
3. **该语义零测试覆盖** —— 成立 ⇒ **补断言**，而不是删掉未被断言的分支。

> **⛔ 「删掉那个从不生效的时间子句」已明确否决，理由请勿重新发现**：
> 它不是把空转变成空转，而是把「什么都不删」换成
> **「每个维护轮删除一切尚未产出 evidence 的会话」**。`captureTurn` 在回合边界
> **无条件**写 L0，而 evidence 只在 extract 完成后才写；`ENQUEUE_MIN_TURN_TOKENS`
> 以下的回合**永不入队**，零候选提炼也不写 evidence。
> **真实数据里这类回合有 13 个 / 982 行 = 全部 L0 的 14.4%**，(c) 会删掉它们。
> 直接复现：一条 5 秒前捕获的回合，现谓词存活、citation-only 谓词**被删**。
> **且落地时无红灯**——变异实测把年龄条件改成 `OR 1=1`，**219 全绿**。
> 「测试全绿 + 删数据」是本仓明令警惕的组合。ADR 0009 §七 当年已把措辞
> 精确定为「**尚未触发**」而非「从未生效」并预警过这个结论，**这是第二次走到它面前**。

### 本轮真正的收获：失真不是三处，是五处

初稿凭阅读印象列了三处，QA 用 `grep -rn "90 天\|90 days\|L0_RETENTION"` 普查
查出漏掉两处，其中一处**比原三处都严重**：

| 位置 | 性质 |
|---|---|
| **ADR 0005:82** | 称 `recallMissRate` 是「近 90 天窗口」，**实为全历史且单调稀释**——`metrics.ts:77-86` 无时间谓词，且 prune 从不删行。它是 ADR 0005 用来决定**要不要上 embedding** 的那个数 |
| README.md:63 | 用户可见文档称 "pruned after 90 days" |

> **今天语料跨度 8.0 天 < 90 天，两种口径返回同一批行，故该错误在数据上
> 完全不可见**，只能从代码看出来。**看不出来的错误正是最该写下来的那种。**
> 教训：**定义「有几处失真」要用 grep 普查，分母是全仓，不是记得的那几个文件。**

### 本轮四处数字口径错误（全部由评审/QA 查出，已更正并保留原文）

**保留错误原文而非抹去，因为它们比修正后的数字更有信息量：**

| # | 错误 | 性质 |
|---|---|---|
| 1 | 体积对照 4.4% → 3.45% → **2.72%** | **三次同型 zstd/范围/单位事故**，第三次发生在**写下防错清单的同一段里** |
| 2 | 「单条记忆钉住 p50 10,313」 | 印的是 A 口径，标题问的是 B 口径（真值 **274,228**），差 26 倍 |
| 3 | 「82 行全部 principal-explicit」 | 82 含 tombstone，取「全部」则分母是 **80** |
| 4 | 「93 个回合全部无 extract job」 | `LIKE` 转义失效使模式恒不匹配，真值 13/106 |

> **教训 1（比修复本身重要）**：`length(text)` 返回**字符**不是字节，本机
> CJK 语料膨胀 **1.31×**。比率不受影响（分子分母同单位），
> **绝对量与跨系统对照必须换算**。
>
> **教训 2**：一条只靠人记得去执行的检查项，**就是没有实现的检查项**——
> 与「`ROLLUP_TARGET_CHARS` 只存在于提示词里」「extract 那句 no secrets 是
> 请求不是机制」完全同型。写进文档只能提醒，挡不住。
>
> **教训 3**：一个比率算出 **100% 或 0%** 时，**先怀疑谓词，再相信结论**。

### 两条新测试各自钉住一个子句（变异证伪，主 agent 独立复现）

| 变异 | 结果 |
|---|---|
| 年龄条件恒真 `(created_at < ? OR 1=1)` | **仅**「an unexpired, uncited row survives prune」变红（**改动前此变异 219 全绿**） |
| seq 粒度豁免 | **仅**「a cited session keeps EVERY row」变红，而原有 `:106` **保持绿** |
| 删除整条豁免子句 | 原有 `:106` 变红 |

第二行是测试 1 存在意义的**决定性证据**：真正的 seq 粒度实现下，
**既有测试全部绿**，只有新测试能抓到。

## 🆕 v0.4.2：`sourceOf` 返回被引原文，不再返回会话结尾

**详见 [ADR 0012](decisions/0012-the-drill-down-must-answer-the-question-it-asks.md)。**
这条修的是 ADR 0009 登记而当时决定「不修实现」的那个缺陷。

**ADR 0009 测过「投递了几行」，从没测过「投递的内容里有没有被引的那句话」。**
补测后（9 库 `VACUUM INTO` 副本，2026-09-01）：

```
被引段落抵达模型 : 46/672 = 6.8%    对照组（同探针查整个会话 L0 全文）: 672/672 = 100%
按记忆聚合       : 88–96% 的记忆一个被引的字都看不到
```

**对照组是决定性的**：内容确实在库里，确实没被投递。根因**两级**：
`ORDER BY seq DESC LIMIT 34` 取会话**末尾**，而被引的话均匀分布
（p25=0.24 / p50=0.57 / p75=0.80）⇒ 先丢 **90.7%**，token 预算再丢 **34.3%**。
**所以调大 `SOURCE_TURN_LIMIT` 没用**（limit=5000 实测只到 8.5%）——
**锚点就是错的，要换选择规则而不是窗口大小**。

> QA 另发现一个更说明问题的数字：BEFORE 下 **322 条记忆只对应 13 个 packet**，
> 最大一组 **98 条记忆返回逐字节相同的 7.4KB 会话尾巴**。旧 `sourceOf`
> **在语义上根本不是一个按记忆区分的函数**。

**修法：去读那个已经写好的答案。** `evidence.excerpt` 存的正是提炼时实际引用的
原文（规范第 970 行）。`service.source()` 改为引文优先、无引文时回退会话窗口。
**零 schema 变更、零渲染器改动、净删一条规则。**

| | 值（实测） |
|---|---|
| 被引段抵达率 | 6.8% → **100%** |
| mean packet | 8149 → **809** 字符 |
| 回退路径 | 79/79 与改动前**逐字节相同** |
| 测试 | 212 → **219 passed / 0 fail** |

**三个关键决定，都是「不做」赢了：**

1. **不解析 excerpt**。方案初稿要按 `\n---\n` 拆段，被评审按 `extract.ts`
   366–389 行的明文告诫否决（**实测 25/778 段已因分隔符歧义无法归属来源**）。
   评审给的替代是**加 schema 存 seq**；实测选了第三条——**整体逐字节返回、
   根本不解析**：投递率反而 100%，且零 schema。
2. **删除 `EXCERPT_COMPACT_MS` 而非调大**。初稿理由「比 L0 早死 60 天」**是错的**：
   `pruneConversations` 豁免使被引 L0 **永不删除**（实测 6273/6321 = 99.2%），
   **差值是无穷**。对无上界寿命而言，任何有限窗口不是数据丢失就是死代码。
3. **`propose` 补写 excerpt 明确不做**。`captureTurn` 只在 `agent/turn-stopping`
   触发而 propose 在 turn 中途，**当前 turn 的 L0 结构性不存在**（实测 19 条连
   一行早于 propose 的 L0 都没有）。唯一来源 `agent.session.events` 的转写器
   承载 §2.4 fail-closed 归因，二次转写＝在**安全边界**上重复实现。

> **⚠️ 两项改动不可拆。** 只发读路径修复而不删 compaction，**修好的证据会在
> 2026-09-22 起被逐条抹掉，30 天内清空 322/322，而测试全绿**。
> QA 对照实测：旧版 decay 一次跑清空 **55/60** 条，新版清 **0** 条。

### 🔴 本轮修复自己引入过一个更坏的缺陷（已修，值得记）

**代码审查与 QA 独立复现了同一个必修缺陷**，主 agent 亦亲手复现：

```
存储 4165 字符（写者值域内） → renderEntry 把 \n 缩进成 \n␣␣ → 渲染 8236 字符
→ 估价 2059 tok > 预算 1820 → withinBudget 整条跳过 → 模型看到 "No stored memories matched."
```

**记忆存在、证据存在、`source()` 也返回了它，而模型被告知「没有匹配的记忆」。**
原缺陷给**错的上下文**，新缺陷给**主动误导的否定**并**掩盖记忆的存在**。

根因：**写者按存储字符设界、读者按渲染 token 计价，单位不同**。
修法三选一，选了**渲染层可见截断**（(b) 加载期断言单独实施**算术上不可能**
——最坏 4825 字符 → **3226 tok**，是预算的 1.77 倍，会让插件装不上；
(c) 写入侧设界＝**为显示容器永久销毁证据**，D3 的反转，且修不了存量）。

> **守卫自己差点成为恒真守卫**：`!packet.includes(TRUNCATION_MARK)` 在标记为空时
> **恒真通过**（`''.includes('')` 为真），与 `tools.ts` 里 `N·F > N·R` 那个恒假
> 守卫**是同一形状，且写在记录着那个判例的同一个文件里**。已改为先判非空，
> 并把常量标注为 `: string`（字面量类型会让空值比较变成编译错误，守卫就丧失
> 失败能力）。双向实测：还原后 `worstQuotePacketChars = 7484` 正常加载，
> 置空标记则加载期抛错。

**连带**：`sourceOf` 不再复用 `RECALL_NO_MATCH`——那句话在该模式下**永远是
假话**，且 `metrics.ts` 用它统计未命中率，**污染 ADR 0005 用来决定是否上向量
检索的那个数字**。新增 `SOURCE_NOT_SHOWN`，`RECALL_NO_MATCH` **字节一字未动**
（实测不共享前缀，历史序列仍可比）。

### 修复前，216 个测试对三处破坏全部保持绿色

| 变异 | 结果 |
|---|---|
| 读路径 `excerpt.slice(0, 200)` 静默截断 | **216 全绿**（全部 fixture excerpt ≤64 字符，长度维度未覆盖） |
| `tools.ts` 的 `kind: turn.label` 改成硬编码 | **216 全绿** |
| 撤掉渲染层截断（即上面那个缺陷） | **216 全绿**（**没有任何测试让引文穿过 `renderFramed`**） |

根因同一个：**断言停在 `service.source()` 出口**，而缺陷在**之后**的
`renderFramed`。**「量到最外面那把尺子」这条规矩，本轮在同一轮里被违反了三次**
（产品缺陷、新引入缺陷、测试盲区），而 ADR 0009 正是立这条规矩的那篇。
已补工具层长 excerpt 测试，三个变异现各自变红。

### 已登记的取舍（不修）

**引文的信任标注是整条的，不是逐段的**：实测 **127/322 = 39.4%** 的引文条目
`title` 低于其所含某些段落的真实信任，同一行里 `[user]` 前缀与 `tool-output`
标签互相矛盾。**方向是 fail-closed（over-trust = 0），不是安全漏洞**；唯一
改法是按 `\n---\n` 切分，已否决。属**标注伪影，非信任失效**。

## ⚠️ 开工第一件事：确认「跑着的」是哪个版本（一条命令）

**不要问「重启了吗」，要问「进程比插件新吗」。** 这两个问题的答案会不一样：
2026-08-31 就发生过一次——harness 确实重启了（22:46:35），但插件是重启**之后**
才装的（22:51:41），于是跑着的仍是上一个版本，而"已重启"读起来完全正常。

```bash
P=~/.dsh/profiles/web/node_modules/@strataloom/dsh-memory
node -p "require('$P/package.json').version"                    # 装机版本
find $P/lib -type f -printf '%T+\n' | sort -r | head -1         # 插件落盘时刻
ps -eo pid,lstart,cmd | grep "[d]sh web"                        # 进程启动时刻
```

**判据：进程启动时刻必须晚于插件落盘时刻。** 早于它，跑的就是旧代码，
此时任何「新数据没出现」都只说明没生效，不构成对修复的证伪。

> **⚠️ 2026-09-01 修正：原来这一行写的是 `stat -c '%y' $P/lib/pipeline/extract.js`，
> 它会给出错误答案。** pnpm 从内容寻址的 store **硬链接**文件（实测
> `%h` = 2 links），于是**内容未变的文件保留旧 mtime**。装完 0.4.2 后实测：
>
> ```
> lib/pipeline/extract.js   2026-08-31 22:51:41   ← 0.4.2 没改这个文件，mtime 停在 0.4.1
> lib/service.js            2026-09-01 17:03:28   ← 真正的落盘时刻
> ```
>
> 按旧命令读，会得出「插件比进程老 ⇒ 新代码已在跑」这个**恰好相反**的结论。
> 判据必须取 `lib/` 下的**最新** mtime，而不是某个固定文件——**任何单文件探针
> 都会在「这一版没改到它」时失效**。这与本页反复强调的
> 「`dsh plugin add` 返回成功 ≠ 装上了」同型：**探针必须依赖它声称要检测的那件事**。

> **`dsh plugin add` 返回成功不等于装上了。** 判据是 `pnpm-lock.yaml` 的
> mtime 是否跟着更新——沙箱不可写 `~/.dsh/profiles/` 时，pnpm 会打印
> `[EACCES]` 却**仍返回 exit 0**，历史上被误读成缓存问题（见文末「环境备忘」）。
> 装完再 `grep` 一次装机代码里的关键字节，比对版本号更可靠。

## 🆕 v0.4.0：跨仓库记忆组（`.strataloom-group.json`）

全栈项目把前后端作为**独立 git 仓**并列检出在控制平面仓工作树内，而会话在
控制平面根启动。实测 3 个 FullStack 会话**全部**同时改了两个子仓，却谁的记忆
都看不到；改名（Ops→FullStack）还分裂出一个**本机已无 checkout** 的 33 条库。

**作用域从「推断」改为「声明」**：仓库根放 `.strataloom-group.json`。
**读跨组，写不跨组**——`forget` 钉死 `readableStores()`（forget 是写，且
recall 会把 id 交给模型，否则跨仓读会变成跨仓破坏）。

三条不可动的边界，各有实测支撑：

| 边界 | 理由（实测） |
|---|---|
| **注入不参与** | 合并需 4104 tok，而预算 1300 的 ADR 0007 不变量只剩 31 tok 富余；且该路径无查询串，相关性算不诚实 |
| **排序位置式**（本仓→成员书写序） | FTS5 `rank` 是负 BM25，IDF 取自各库自己的 N/df ⇒ 词越属于某库、在该库 rank 越差。实测反转 **85.2%**（265/311），另手工复核 6/6 |
| **审批是承重闸** | `archived: true` 是**人的断言**，代码无法证明「本机某处没有该 checkout」 |

**本轮四个「绿灯没抓到」的教训**（详见 [ADR 0011](decisions/0011-repo-groups-are-declared-read-scope.md)）：

1. 首个守卫代数上恒假——`500+N·200 > 500·(N+1)` 化简为 `200>500`，N 被约掉，
   它给 `GROUP_MAX_MEMBERS=100000` 放行。新守卫经真实渲染器对平台 pruner 的
   8192 字符定价，**6 过 / 7 抛**。
2. 每库预算之外 `tools.ts` 还有第二把 500 的尺子，本仓 20 行时外仓交付 **0**。
   改两级容器后，外仓交付在本仓 2..30 行区间恒为 **12**。
3. 审批语称「绝不写入」，而 `touchUsage` 确实写外仓 `usage`；`decay` 又把
   `usage.last_hit_at` 变成 `memories.status` ⇒ **本仓的纯读改了外仓的权威字段**
   （实测 4 行免于休眠）。改为外仓不 touch，**那句话才成为真话**。
4. recall 抬头写「in this repository」，而 2792 个查询里 **1508 个（54.0%）**
   结果 100% 来自外仓。改为外仓条目带 `(from <repo>)` + 第二个抬头，
   **无外仓条目时逐字节不变**（注入包因此不受影响）。

> **教训同型**：4 条里有 3 条是「代码与它自己承诺的话不一致」，而前四轮
> 纯读代码都没发现——抓到它们的是**真实数据的端到端回放**。

### ✅ v0.4.0 已在真实会话中验收（2026-09-01 11:16，非模块驱动）

会话 `session-92258e76` 日志原文：`approval/asked`（`toolName:"memory_group"`）
→ `approval/decided`（`allowed-once`）→ 召回结果含
`(from remote:github.com/Alan-IFT/NFBY_CMS_Backend)` 标注；模型调 `memory_recall`
4 次并引用了该条经验。同会话内**两个抬头并存**：recall 用混合抬头、注入包用
**未改动的** `FRAMING_HEADER`。三个成员库 mtime 停在 `08-31 22:46:32`，会话在
`09-01 11:16`——**读了、零字节写入**。

> **一次验证方法的失误值得记**：首次验证问「后端权限模型是怎么做的？」，agent
> 调了 80 次 `bash`/`read`/`grep`、**0 次 `memory_recall`**，闸自然没触发。
> 组的闸挂在工具上，**agent 能绕开这个工具**。换成代码里查不到答案的问题
> （「strict xfail 踩过什么坑」，本仓命中 0、Backend 命中 2）才跑到被测代码上。
> **验证问题必须让被测路径成为唯一出路**，否则测的是 agent 的选路偏好。

## 🆕 v0.4.1：引导段不再第三次渲染 kind 判据

**真问题不是「245 超了 150」，是一条规则在模型上下文渲染了三遍**——
`memory_recall.kind` 与 `memory_propose.kind` 的 schema 各一份，引导段又一份。
这是 **D7–D9「一条规则写两处」第一次出现在提示词而非代码里**。

| | 值 |
|---|---|
| 引导段 | 245 tok → **153 tok**（删掉重复的 kinds，静态文案一字未动） |
| 上限 | `GUIDANCE_BUDGET_TOKENS = 160`，`tools.ts` 加载期强制 |
| 守卫实测 | 160 过 / 150 抛（真实值 153）/ 100000 使用例变红 |

**`≤150 tok` 那句散文已作废**：它出自首次提交、无测量依据，且同日那次
`e799a19`（*"Derive restated limits from their constants"*）系统性清理同类问题时
**独独跳过它**——它从来就不被当作要执行的常量。150 现在也**装不下**正确文案（153）。
规范 §7 改为指向常量，不再复述数字。

**守卫绑渲染后文本而非字面量**，所以将来新增 kind 无法从远处撑大引导段。

**真实会话前后对照**（数 `request/header`，即模型真正收到的上下文）：

| 请求时刻 | kind 判据渲染 | 版本 |
|---|---|---|
| 23:32:08 | 3 次 | 0.3.7/0.4.0 |
| 09:41:01 | 3 次 | 0.4.0 |
| **11:54:31** | **2 次** | **0.4.1** |

> **口径陷阱**：同一份日志用 `grep -c` 直接数是 **27 次**，因为把「会话自己在讨论
> 这件事」（assistant 消息、grep 命令本身）算了进去。**只有 `request/header`
> 才是模型上下文**。观测行为会污染被观测量——分母与容器必须写明。

## 🔴 最高优先级（新登记）：管线产出的记忆 89.1% 永不进入注入包

**详见 [ADR 0010](decisions/0010-attribution-collapses-the-injectable-set.md)。**
这里只留指针与判据，绝对数在 ADR 里带测量时刻。

写侧 `provenanceFor` 取被引来源的**最低信任**，而 L0 里 `tool-output` 是绝对
多数，于是任何引用过工具行的候选（哪怕同时引用了人的原话）都被打成
`tool-output`；读侧 §2.3 又规定 `tool-output`/`subagent` 永不默认注入。
**两条规则各自正确，缺陷只存在于它们的乘积里。**

全库实测（7 个 repo 库，2026-08-31）：管线产出可注入 **26/238 = 10.9%**，
而同一过滤器下 `propose` 产出是 **60/61 = 98.4%**——**9 倍差距的对照组**
排除了「提炼质量不高」这个解释。按 0.3.6 重启切分：**13.3% → 3.4%**
（ADR 0008 让工具行进 L0，加剧了它）。

**它同时解释了两个活跃库派生层为空**：`packetOverflows` 用可注入集计价，
`5ed2b4d2` 105 条记忆只按 6 条算 = 1118 tok < 1300 → 永不入队 rebuild。
**不是管线坏了，是分母被掏空了**——查到「L2 为 0」时不要再去查 rebuild 代码。

> **⛔ 初稿那个 `A=78 / B=126 / C=8` 的分解已作废**：它从 `evidence.excerpt`
> 反解，而当时 **90.5%（218/241）的 excerpt 被截断在 400 字符**，读到的是
> 截断产物。「C 类 8 条」尤其是假象——8/8 恰好 400 字符。**主结论不受影响**
> （由对照组独立支撑），**垮的是修法依据**。详见 ADR 0010 §四。

### ✅ 本轮已修：excerpt 的每事件配额 + `sourceSeqs` 上界

**先修使分解不可信的那件事，归因原样不动。** 根因是 D7–D9「一条规则两处
实现」的**第四个实例**：`EXTRACT_EVENT_EXCERPT_CHARS` 的语义是**每事件**上限，
`renderTranscript` 一直这样用，写 evidence 时却施加于 join 后的**整串**。

一并修掉被它意外掩盖的独立缺陷：`sourceSeqs` 无长度上界，使
`worstExtractReplyChars()` 守卫**在假设一个从未被强制的界**——破裂点实测
`N=11`（`5300+6717=12017 > 12000`，余量仅 18）。**不新增常量**：复用
`WORST_SOURCE_SEQS`，把它从守卫的假设变成写者的强制。

`npm run verify` **176 passed / 0 fail**（171 基线 + 5 新测试）。三方独立验证：
方案评审、代码审查、QA 各自做了证伪实验，均确认还原任一修复即变红。

#### ✅ v0.3.7 已生效（**装机产物经真实写者驱动验证**，2026-08-31 23:10 重启）

版本序确认：插件落盘 **22:51:41**，进程启动 **23:10:03** —— 进程晚于插件，
0.3.7 确已加载。（此前 22:46:35 那次重启早于落盘，跑的仍是 0.3.6。）

**验收方式：直接驱动装机的那份 `lib/`**，而不是仓库里的构建产物——两者是
不同的字节，只有前者能回答「跑着的系统行为如何」。用真实 `runExtractJob`
（非手写 INSERT）喂入三个各 3000 字符的来源（user / assistant / tool）：

```
装机 0.3.7 产出 : 总长 1247   段数 3   每段引文 401 (400 + 省略号)
旧写者对照      : 总长  400   段数 1   （后两段被整串截断切掉）
```

**对照组是决定性的**：同一批来源、同一个夹具，差异只可能来自版本。

1. ✅ 不再恰好 400 字符（实测 1247）
2. ✅ 每段引文各自受限 ≤ 401，而非多段共享 400
3. ✅ 段数 ≤ `WORST_SOURCE_SEQS`（3 ≤ 10）

> **仍需在生产库复验一次**：上述是在临时库上驱动装机代码，证明的是**装机代码
> 的行为**。生产库里第一条**重启后新写入**的多段 evidence 出现后，应再核一次
> 长度分布——判据同上。查到「还没有」时结论是**「还没跑到」**（extract 在
> `agent/turn-stopping` 触发，需真实 turn 结束），不是「没生效」。
>
> 重启时刻基线（用于切分新旧）：**evidence 非空 271 条，其中 ≥400 字符
> 244 条 = 90.0%，多段 162 条** —— 全部为旧写者产物。

**下一步**：A/B 分解须用**修复后新写入**的 evidence 重新采集，历史 218 条仍是
截断产物；再评审归因修法（触碰 §2.4 fail-closed，须先实测证明伪造路径已被
JSON 转写堵死）。

## 🟢 验收：判据 1、2 **已满足**，判据 3 待那三个仓库被打开

harness 已于 **2026-08-30 20:50:41** 重启（PID 3419287，晚于 0.3.6 落盘的
17:47:56），装机代码已确认为 0.3.6：`EXTRACT_TRANSCRIPT_CHARS = 5300`、
`SOURCE_TURN_LIMIT = 34`、`PERSONA_TARGET_CHARS = 600`。

**判据 1（采集侧）已由真实数据满足**，判据 2、3 需要维护轮先跑出派生层
——采集在 `agent/turn-stopping` 触发，派生层重建在周期性维护轮
（`CLEANUP_INTERVAL_MS` = 6 小时）。**「刚重启所以还没有」与「重启了但没生效」
在数据上可分，下面给出基线，下次开工按它对照，不要凭印象下结论**（上一轮
正是在这里误判过）。

**重启时刻的基线**（2026-08-30 20:50）：

```
L0 总行 3528   tool-call 0   tool 结果 2349   孤儿率 100%
global L3 画像 body = 677 字符（旧代码产物，>600）
L2 场景块：3e857510 6 块 / ec2636fc 5 块 / edf7a686 6 块，共 15/17 块超 620
最新 L0：5ed2b4d2 turn 37 @ 2026-08-30 20:18:50
```

**验收判据**（查到「无新数据」时结论是「还没跑」，不是「没生效」）：

1. ✅ **已满足**：**新写入**的 L0 出现 `tool-call:` 行。重启后写入的工具行
   **45 results / 45 calls**，且**逐工具精确配对**：

   ```
   bash 39/39   read 2/2   edit 2/2   memory_propose 1/1   ask_user_question 1/1
   ```

   即采集侧的 0.3.6 **确已在运行**，不只是装上了。

   > **读数陷阱：`results` 与 `calls` 不相等时，先查是不是零参数工具。**
   > 例如实测过一个批次是 `29 results, 27 calls`，逐工具拆开后差额全部来自
   > `list_agents`（2 结果 / 0 请求），其余 `bash 22/22`、`subagent 2/2`、
   > `send_message 1/1`、`memory_recall 1/1`、`memory_propose 1/1` 全部配平。
   >
   > 成因确定且**非本次回归**：`list_agents`/`get_goal`/`job_list` 这类零参数
   > 工具的 `arguments` 是空串，摘要后文本为空，被 `transcript.ts` 里**早已存在**
   > 的空文本过滤（`entry.text.trim() !== ''`）丢弃。ADR 0008 已登记为「残留
   > 1.2% 孤儿」并写明不要当 bug 查。
   >
   > 判定方法（一条 SQL）：按 `label` 分组比对该批次的 `tool:X` 与
   > `tool-call:X`。**若差额集中在零参数工具，采集正常；若出现在带参数的
   > 工具上，那才是真问题。**
2. ✅ **已满足**：那条 677 字符的画像已被重写。实测 **298 字符**
   （`2026-08-31 04:15:28`，`rebuild rev=19 done`）——旧代码切 `BODY_MAX_CHARS`
   = 2000，新代码切 `PERSONA_TARGET_CHARS = 600`，**677 不可能出自新代码，
   298 也不可能出自旧代码**，故这一条同时证明派生层已由 0.3.6 产出。

   > 中途出现过一次容易误判的读数：22:15 的 `rebuild done` 之后画像仍不存在。
   > 那**不是缺陷**，是 revision 围栏的正常行为——job 排队时 rev=18，执行时
   > `store_revision` 已是 19，于是按 `rebuild.ts` 的前置检查直接结清、不烧
   > token。而每写一条 personal 记忆触发器就 +1，**持续写入期间画像必然建不
   > 起来**，停写后的下一轮维护才会成功（本次即 04:15 那轮）。
3. ⏳ **仍待触发**：**新产生**的 L2 场景块 body ≤ `ROLLUP_TARGET_CHARS = 620`。
   现存 17 块均为旧代码产出。实测 **3 个 repo 库满足 `packetOverflows`**
   （`3e857510e628` 3007 tok、`edf7a6862dde` 1916 tok、`ec2636fc223e` 1808 tok，
   阈值 1300），会在维护轮触发 rebuild——**但维护轮只遍历「已打开」的库**
   （`runner.ts` 走 `stores.all()`，而它返回的是本进程 registry 里已 open 的
   store）。所以这三个库要等各自仓库下一次真正开会话，判据 3 才可能被求值。

   > 三个库分别是 `NFBY_CMS_Ops` / `NFBY_CMS_Frontend` / `NFBY_CMS_Backend`
   > （由各库 `meta.repo_source` 读出），2026-08-31 时均已 5.9 天无活动，
   > 其中 Ops 仓不在本机。**这一条无法从 strataloom 仓内触发**：`storeFor`
   > 用的是 `agent.session.header.cwd`（会话头部，不是进程 cwd），在 shell 里
   > `cd` 过去不会改变会话归属。等到那几个项目下次开工时自然满足即可，
   > **不要为验证它新建机制**。

**在判据 3 满足之前，L2 侧的「XX 已修复」只对代码成立，对运行中的系统
不成立。**

### 更正：「产出记忆零引用 `tool-call:` 行」这条结论是错的

上一轮记下过一条结论——新提炼出的记忆**没有一条**引用 `tool-call:` 行，
因而「行进了库但没进提炼窗口/引文」。**该结论已被实测推翻。**

按重启时刻切分，重启后新增 11 条带 session 证据的记忆（`global` 1 条、
`5ed2b4d261b2` 10 条），扫描其 `evidence.excerpt`：**3/10 条已引用
`tool-call:` 行**（`tool-call:bash` ×2、`tool-call:ask_user_question` ×1）。

**且这 3 处引用都是合理的**——它们记录的是**工作流事实**（「用哪条查询确认了
哪个状态」「问过什么澄清问题」），不是把某条命令本身当经验存下来：

```
[tool-call:bash] {"command":"<1160 chars>","description":"Check which stores will trigger rebuild"}
[tool-call:bash] {"command":"<912 chars>","description":"Check what new code has actually produced"}
[tool-call:ask_user_question] {"questions":"<573 chars>"}
```

这正是 M2 的 `<N chars>` 摘要在起作用：长值被记为长度占位，留下的是
`description` 这类有信息量的字段。

**风险等级可下调，但仍属「待观察」而非「已排除」**：样本只有 10 条、且全部
来自同一个库的同一段工作。下次开工仍应复查一次——判据是**引用是否记录了
工作流事实**，不是引用率高低。

> 上一轮那条结论错在**样本取早了**：它只看了当时已有的 5 条，而记忆是随
> extract 逐轮产生的。**「我查的时候还没有」不等于「不会有」**——与本页顶部
> 反复强调的「刚重启所以还没有 ≠ 重启了但没生效」是同一个错误形状。
> 该结论曾以记忆形式留在 `5ed2b4d261b2`
> （id `6219053d-5fa2-4e53-b734-81c612707bf3`）。**2026-08-31 复查：该条
> `status` 已是 `superseded`（更新于 2026-08-30 14:10:38），即 reconcile 已
> 自行取代它，无需人工干预。**（此处原写「尚未更正，见文末『未完成』」，
> 而全文并无该节——悬空引用一并删除。）

## ✅ 已提交并发布（v0.3.6，待重启生效）：L0 现在记录 agent 做了什么

**详见 [ADR 0008](decisions/0008-l0-records-what-tools-said-not-what-the-agent-did.md)
的「修复实施」一节。**

`collectTurnEvents` 曾把 `tool/call` 事件整类 `continue` 丢弃，导致 L0 里
**每一条工具结果都是没有请求的孤儿**。现在 `tool/call` 以独立 label
`tool-call:<name>` 采集，参数经**结构化摘要**（短值原样、长值记为
`<N chars>`）后入库，provenance 按 §2.4 fail-closed 固定为 `tool-output`。

本机全部真实 session 重放（只读，48 个 strataloom session；session 数随本机
新会话增长，脚本枚举全部日志、不做筛选）：

```
配置                              kept  asst  call   res
BASELINE seq+break 6000 不采      2704   837     0  1636
P3       seq+SKIP  5300 elide120  3021   635  1133  1036

事件总数 +11.7%    L0 字节 +8.3%    孤儿率 100.0% → 1.2%
```

> **`res`/`asst` 两列的降幅容易读反**：不是这两类被削弱，而是同一预算里
> 新增了 1133 条此前根本不存在的**工具调用**行，把其余各类一并摊薄；
> 同时转写上限经三次复核由 7000 降到 **5300**（见下），窗口本身也变窄了。
> 换来的是「agent 做了什么」这一整类材料从零到有。同理，「高信任%」的
> 下降也是分母变了（新增行按 §2.4 必然是 `tool-output`），不是质量退步。
>
> **代价随复核而变大，这条轨迹本身是结论**：初稿 +43.5%/−5.5%（脚手架估
> 60）、构造计价后 +34.6%/−10.9%、再修正 seq 宽度与转义类别后
> +11.7%/−24.1%。**三次全部同向**——估出来的数会系统性偏向对自己有利的
> 一侧。收益在最保守口径下依然成立。

八项要点里**有两项是「不做」**，理由已写进 ADR，以免被重新提出：

- **M1 不采 assistant 的 tool_use 块**——实测 13715 对与 `tool/call` 事件
  逐字节全等，采它等于同一事实的第二处实现；且被丢弃的 assistant 事件
  **携带 0 个文本字符**（详见 ADR「更正二」：此前「`parent-agent` 供给腰斩」
  的说法**是错的**，已改写——那个 52.6% 是按条数算的，按内容算是 0%）。
- **M8 选择策略保持「按 seq 顺序」**——判据是**模型实际引用了什么**，直接从
  `evidence.excerpt` 逐段还原（167 条记忆 / 295 个被引段）：**55.9% 的被引段
  来自工具结果**（按首段 59.3%，四个库分别 52/57/59/65%）。把被引行放回重放，
  seq 顺序留存 90%，trust-first 只留 66%——它不是「提纯」，是把模型真正用过的
  材料删掉四分之一。它还把 §2.4 的**安全**分级挪用为**信息价值**分级。

另有三项结构性收获：

- `EXTRACT_TRANSCRIPT_CHARS` 由 6000（初始提交 `37c73f5` 写死、从未论证）
  改为 **5300**，且现在是**算出来的**：extract 的输入此前**根本不在**
  `worstExchangeChars` 断言里，这是一个真实的守卫覆盖漏洞。补上后最坏回复
  由「构造最坏候选交给 `JSON.stringify` 计价」得出 **6682**，上限 5318。
  该数被**下调三次**（7100 → 6558 → 5318），每次都是因为真的去量了一个
  此前只是「看起来合理」的假设：脚手架 60、seq 四位（实测 74.8% 已超四位、
  最大 126635）、转义按引号 +1 计价（控制字符是 **+5**）。**5300 低于原始的
  6000，这是真实代价**——但一个会让预算变小的诚实上界，仍优于一个会让
  provider 截断回复的宽松上界。
- `SOURCE_TURN_LIMIT` 由 20 改为 **34**：`sourceOf` 按**行数**计预算，而本轮
  把 L0 行密度抬高了 67.7%，同样 20 行买到的真实对话少了 34.7%，且**不报告
  任何异常**。34 = 20 × (249.1/148.6)，重放独立验证盈亏平衡在 32–33 之间。
  （`extract` 按字符计预算，所以它自己重新平衡了——**换了容器就得换尺子**。）
- `renderTranscript` 的 `break` 改 `skip`：extract 是全仓最后一个与
  `recall/render.ts: withinBudget` 规则不一致的预算点。

**业界对照**：[TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory/tree/feat/server_team)
的 `import_opik.py:352-358` 差异恰好就在我们丢弃的那一行；它同样强制
`truncate`、并用 `drop_orphan_tool_results()` 把「结果必须有对应请求」当作
不变量。hermes（无 L0 层）与 memorax（逻辑在闭源服务端）**不可比**。

## ⛔ 阶段 4（检索融合）门禁：两半都不成立，保持关闭

ADR 0005 的开工条件是「比率显著 **且** 抽读 L0 确认存在改写后命中的实例」。
本轮查明**两半都还不成立**（详见 ADR 0008）：

- **比率那一半已被自己的修复作废**：按 v9（CJK bigram）切分，v9 之前
  302 次调用 / 40% 未命中，**占样本 99%**；v9 之后仅 **4 次调用**。
  `STATUS.md` 早就写明 v9 前的数据混入分词损耗不可用于该判断。
- **另一半其实可求值**：查询串在平台 session 日志的 `tool/call.data.arguments`
  里，按 `callId` 配对后 135 次调用全部可配对。但 `conversations.ts` 声明
  L0 存在正是为了**不依赖**平台日志，故该路径只能用于一次性调研，
  **不得固化为常设诊断依赖**。

## 三项待修缺口（ADR 0008 登记，未排期；第 1 项已于本轮修复）

| # | 缺口 | 证据 |
|---|---|---|
| 2 | `recallMissRate` 分母含 `Error:` 行 | 修正后 `edf7a686` 由 29% 变 **71%** |
| 3 | 历史比率未按 v9 切分/作废 | v9 前样本占 99% |
| 4 | `memory_recall.query` 无长度上限 | 实测均值 9.2 字符；schema 无 `maxLength`，`execute` 不截断 |

修复 `tool/call` 采集后新登记的**既有**小缺口（本轮不混修）：零参数工具
（`list_agents`/`get_goal`/`job_list`）的 `arguments` 是空字符串，摘要后文本为空，
被既有的「文本为空则丢弃」过滤掉——这是修复后残留 1.2% 孤儿的**全部**成因
（另含跨 turn `callId` 无法解析的 `tool:unknown`）。属既有行为，非本次回归。

另有两项**既存**缺陷，独立登记不混修：L0 无凭据扫描（`captureTurn` 路径零扫描，
extract 提示词那句 "no secrets" 是给模型的请求而非机制）；`conversations`
无体积上界（`pruneConversations` 只按时间删）——后者的实测状态见
[ADR 0009 §七](decisions/0009-measure-at-the-outermost-ruler.md)。

## 📋 v0.4.4 遗留的五项待办（本轮登记，未排期）

**全部由代码审查与 QA 查出，均属既有缺口、非本轮引入，故不混修。**
**第 2 项已于 2026-09-02 结项，见本页顶部 v0.4.5 一节。**

| # | 事项 | 现状（实测 2026-09-01） | 处置判据 |
|---|---|---|---|
| 1 | **`injectableTokens` 仍不等于真实投递量** | `renderFramed` 作用于**拼接后**的 hits，逐库快照够不着；实测 `5ed2b4d2` 报 3291、repo 独走过预算后仅 1214 | **已改承诺而非实现**（ADR 0009 规矩），字段注释列明两条局限。要真正回答「投递了多少」，唯一诚实的位置是 `buildContextProvider` 里那行**已存在**的 `dropped` 日志，不是逐库快照。**不要用逐库外套 `withinBudget` 去补**——那是选择规则的第三次实现 |
| 2 | ~~**合规派生层可因换行密度突破预算**~~ → **✅ 已结项**（v0.4.5，见本页顶部） | ~~6 块全部 ≤ `ROLLUP_TARGET_CHARS` 时，行长 ≤6 字符即 >1300（最高 1.5×），运行时静默丢块~~ | 已按本条当时登记的判据实施（约束单位由字符改为渲染后 token）。**但当时这条只登记了 `parseScenarios` 一个执行点，实际是两个**：`parsePersona` 同型，且后果更重——画像是**整条丢弃**而非逐块掉。详见 [ADR 0013](decisions/0013-bound-the-write-in-the-unit-the-container-spends.md) |
| 3 | **`store.kind` 三元分派是 fail-open** | QA 实测：`kind` 为 `undefined`/`null`/`'GLOBAL'`/`''` 时一律走**不加帽**分支，画像缺失态误差 34.1× | 今由 `StoreKind = 'repo' \| 'global'` 封闭联合兜住。**注意 `rebuild.ts` 有三处既有的同形状分派**，要改就四处一起改；单改一处会造成「同一个二元分派四个执行点方向不一」，比现状更糟 |
| 4 | ~~**`queryInjectionRows` 的派生扫描无 LIMIT**~~ → **✅ 已结项**（v0.4.7，见本页顶部，与待办 j 是同一条 LIMIT） | ~~QA 实测 50k 派生行 → 192ms、物化 30MB~~ | 已加 `LIMIT INJECT_TOP_N`。50k 行实测由 67.6ms/351MB 降至 **41.3ms/0.16MB**，`PRAGMA temp_store = MEMORY` 不再是读路径硬依赖。**但当时只登记了性能与 temp_store，漏掉了真正严重的那一半**：该扫描同时能让注入包**溢出 §4.2 容器而护栏不报警**。⚠️ 查询计划**未改善**（仍 `SCAN` + `USE TEMP B-TREE`），省的是物化到 JS，别误读 |
| 5 | ~~**派生查询的 `status='active'` 过滤零覆盖**~~ → **✅ 已结项**（v0.4.14，见本页顶部） | ~~QA 变异实测：去掉该过滤 **224/224 全绿**~~（v0.4.13 上复测仍 **256/0 全绿**，零覆盖持续到本轮） | 已补覆盖（T1），**但修法比本条当时登记的判据更进一步**：本条只说「过滤零覆盖」，实测发现该过滤守的是一个**短路分支**——一条非 active 派生行不只是混进注入包，而是**遮蔽整个 raw 集**。故除补测试外，把不变量下沉为 schema v11 触发器（读路径过滤只让行「不可见」不让它「不可达」——沿用待办 p 的既定结论）。本条「今日不可达系数据巧合」的判断**经复测成立**：9 库 521 条记忆、派生行 16、非 active 派生行 **0** |

## 📋 v0.4.3 遗留的五项待办（未排期）

**本轮明确没做的事，列在这里而不是只留在审计文档里。** 前两项由 QA 查出。

| # | 事项 | 现状（实测 2026-09-01） | 处置判据 |
|---|---|---|---|
| 1 | **`recallMissRate` 的口径需要决定** | ADR 0005 的措辞已更正为「全历史」，但**数字本身仍是全历史且单调稀释**：早期未命中永久留在分母 | **重估 embedding 之前必须先解决**：或给 `metrics.ts` 加时间窗，或明确接受全历史口径并在解读时扣除。**本轮刻意不改 `metrics.ts`**——动它会移动 ADR 0005 赖以决策的那个数，属独立评估 |
| 2 | **删除「量」无回归哨兵** | 两条新测试钉的是「不该删的不删」，**没有任何测试会在删除量由 0 变非 0 时报警** | 若 `evidence.ref` 改为 seq 粒度（ADR 0012 反复绕回的方向），L0 会**静默开始删除而测试全绿**。已在 `pruneConversations` 注释写明：做该改动的人**必须先量删除量**再发 |
| 3 | **`e.kind = 'session'` 过滤零覆盖** | QA 变异实测：去掉该过滤 **48/48 全绿** | 今日不可达仅因 `evidence` 全部是 `session` 类型、无跨类型 ref 与 session_id 碰撞——**这是数据巧合而非机制保证**。属既有缺口，非本轮引入 |
| 4 | **样本仅来自单一开发者 8 天语料** | 18 个会话 **100%** 被引用 | 「豁免集恒等于全集」在**普通用户**语料（大量闲聊、少量记忆）下未必成立，彼时年龄子句**可能真的开始删除**。本轮全部结论的样本无法预测该场景。ADR 0009 教训 5「单库采样产生 7 倍偏差」同型 |
| 5 | **90 天后的真实行为从未观测** | 全部结论基于 `now+200d` 模拟与反事实 SQL | **2026-11-21** 是时间条件首次可能满足之日（最早 L0 行 2026-08-23 + 90 天）。届时应实测复核一次首次真实 prune |

> **观察（不打回，登记）**：`tsc` 未配 `removeComments`，故本轮**纯注释改动
> 仍改变了 `lib/` 的字节**（`conversations.js` 3099 → 4764 B）。行为等价已由
> 「剥离注释后 sha256 相同」单独证明。**「纯注释不影响产物」这句话对本项目
> 不成立**——`files` 字段发布 `lib/**/*.js`，注释随包分发。

## 📋 v0.4.2 遗留的六项待办（ADR 0012 §六/§七 登记，未排期）

**本轮明确没做的事，列在这里而不是只留在 ADR 里**，以免下次靠翻 ADR 才发现。
前两项有**已知触发条件**，其余四项是「有理由暂不动」。

| # | 事项 | 现状（实测，2026-09-01） | 处置判据 |
|---|---|---|---|
| 1 | **`propose` 不写 excerpt** | 79/401 = **19.7%** 的证据行 excerpt 为 NULL，**全部**是 `principal-explicit`——即**用户亲手存的记忆恰恰是查不到引文的那一类** | **明确不做**（ADR 0012 §七）：`captureTurn` 只在 `agent/turn-stopping` 触发而 propose 在 turn 中途，当前 turn 的 L0 **结构性不存在**；唯一来源的转写器承载 §2.4 fail-closed 归因，二次转写＝在安全边界上重复实现。**由回退标注承担诚实性** |
| 2 | **跨库 + 引文组合无真实数据覆盖** | global 库现有 **0 条**带 excerpt 的证据行（personal 记忆全部由用户手动 propose 写入） | 一旦 personal 记忆开始由 extract 写入，该路径**首次**被走到。届时先复核 `source()` 的早退分支（找到 excerpt 即 return，不再跨库找 L0） |
| 3 | **`conversations.label` 无 `CHECK` 约束** | 绕过 `classify` 直写 DB 可同时伪造裸 `quote` 标签与 `human` 信任级 | 需本地文件写权限，**非本轮引入**；但本轮**提高了该字段的价值**（它现在承载「这是引文」的审计断言）。加约束是一次 schema migration，应独立评估 |
| 4 | **有引文时取不到周边会话上下文** | excerpt 最短实测 25 字符，而其会话有 674 行 L0 | 真实取舍。修法（引文＋窗口一起返回）会让预算模型从「一条 hit」变回「多条竞争」，**把刚修掉的悬崖以另一种形态请回来**。应先决定产品语义 |
| 5 | **`renderEntry` 只缩进 `\n`，不处理孤立 `\r`** | 实测真实数据 **lone CR = 0**（CRLF 6 条） | 既有问题。改它会移动**每一个** injection packet 的字节并触及加载期预算断言，收益为零 |
| 6 | **`forget()` 清 excerpt 已成不可达死代码** | tombstone 是终态，`source()` 已过滤；实测 2 条 tombstone 记忆的 excerpt 均已为 NULL | **保留**：它是 D5 的**字节级执行点**（被遗忘的字节不再留在库里），与 `source()` 的谓词过滤**互为纵深**。已补注释说明语义变化 |

## 📋 明确决定「不做」的三项（2026-09-01 审计；复议需新证据）

登记它们是为了**不被反复重新发现**。三项都经过审计并给出了不做的理由——
不是遗漏，是决策。**要推翻其中任何一条，请带上使理由失效的新证据。**

| # | 事项 | 现状（实测） | 为什么不做 |
|---|---|---|---|
| A | 孤儿库 `NFBY_CMS_Ops` 的 27 条**读得到、删不掉** | 27 条 active raw、全部可注入、最后更新 2026-08-28，**不再增长** | `forget` 只作用于会话所在仓，而该仓本机已无 checkout。用跨库写权限去补偿，等于**拿权限模型缺口换一个数据清理问题**。彻底了结的正解是一次性数据迁移并入 FullStack 库，属另一类风险，需单独走流程。拒绝信息对此**明说**（用例 6b 锁住） |
| B | **每次重启 dsh 都要重新审批**组 | 授权是进程内 `Set`，键 `(会话仓 source, members 指纹)`，磁盘无任何授权文件 | 这是**有意付出的代价**：信任决定若落在攻击者写得到的地方就不再是信任决定。它与「声明不热重载」同源——持久化会在审批与生效之间开 TOCTOU 窗口。详见 [ADR 0011 §八](decisions/0011-repo-groups-are-declared-read-scope.md) |
| C | 审批策略 `never` 时组功能**整体不可用** | `decide()` 直接返回 `rejected`（`dsh-user-approval/lib/index.js:188`），组退化为只读本仓 | 审批是本功能**唯一的承重闸**（`archived` 谓词验证不了它声称的东西）。「策略为 never 时自动放行」等于让**关掉安全提示的动作**去授予它本该守住的权限。宁可不可用。排障判据：日志 `rejected` = 策略问题，`unavailable` = 服务缺失。详见 [ADR 0011 §3.3](decisions/0011-repo-groups-are-declared-read-scope.md) |

## 🔬 观察中（需样本积累，勿凭单次会话下结论）

**v0.4.2 的引文路径在重启后是否真的跑到？** 装机产物已按字节核验，但**进程早于
插件**（见本页顶部），所以运行时尚未验证。判据：重启后调一次
`memory_recall(sourceOf: <某条带 excerpt 的记忆 id>)`，看返回是否为
**单条 `- [quote] (id seq -1) …`**。查到「还是老样子」时先核版本序，
**不要当作修复失效**。

**存量引文有 75.8% 是被旧写者截断过的**（244/322 长度恰好 400 字符，
p50=400 / p90=761 / max=1787）。这是 ADR 0010 已修的 join-then-truncate 写者
留下的历史数据，**读路径补不回**。所以「兑现率 100%」只保证**存了什么就投递
什么**，不保证存的那份完整——用 `sourceOf` 审计**旧**记忆时会看到当年就被截断
的那份。会随新记忆写入自然稀释，**判据是新写入 evidence 的长度分布是否离开 400**。

**裁剪引导段后，模型能否仅凭两处 schema 正确选 kind？** v0.4.1 只验证了
**渲染次数与 token**（3→2、245→153 tok），**未验证选择行为**。引导段现在仍说
"Scope is separate from kind" 却不再解释 kind 是什么——判断是「schema 里紧接着
就有全文」，但这是推断，不是实测。

判据：观察后续 `memory_propose` 的 kind 是否仍选得准，尤其 `fact` 与 `coding`
的边界（二者最易混淆，判据是「换个仓库还成立吗」）。**一次会话说明不了问题**
——本仓已有「零 occurrence 最受样本量影响」的教训（见 §L0 引用那条）。
首查点写在 `GUIDANCE_SECTION` 上方注释。

## ✅ 已修（v0.4.2）：`sourceOf` 的兑现率 —— 兼 ADR 0009 两处数字作废

**详见 [ADR 0009](decisions/0009-measure-at-the-outermost-ruler.md)**（含被否决的
三条路径及其算术、以及七条教训）**与 [ADR 0012](decisions/0012-the-drill-down-must-answer-the-question-it-asks.md)**（本轮修法）。

一句话：`memory_recall(sourceOf:)` 承诺「核对原话」，但读路径上两把尺子串联，
**外侧的 token 预算先截断**，使 `SOURCE_TURN_LIMIT` 成为不绑定的惰性常量——
它从 20 调到 5000，用户可见内容近乎不变。ADR 0008 那次 20→34 的修复因此是
**有成本、无收益**（无效取回率 88.7%→94.0%）。

**ADR 0009 §五那三个前置必改项，本轮的处置各不相同**（详见 ADR 0012）：
重定 `EXCERPT_COMPACT_MS` → **改为直接删除**；保留 L0 回退并区分引文与会话
片段 → **已实现**；`propose` 补写 excerpt → **明确不做，已登记结构性依据**。

> **⛔ ADR 0009 的两处数字已作废，读该文时请一并读这里：**
> 1. **§一的路径图与 §三的「2.1%–4.3%」量的是一把已不存在的尺子**。
>    `4d3ada3`（仓库组）把 `sourceOf` 的渲染预算从 `RECALL_RESULT_BUDGET_TOKENS`
>    (500) 提到 `RECALL_PACKET_BUDGET_TOKENS`（现 **1820**），晚于 ADR 0009 定稿。
>    按真实预算重测的抵达率见本页顶部 v0.4.2 一节。
> 2. **`constants.ts` 那段注释里的 1700 与 7429 也已过时**（实为 1820 与
>    **7939**）——测试用 `worstRecallPacketChars()` 动态断言，**所以测试全绿而
>    三处注释都在撒谎**。已改为指向函数、不复述数字。

> 该 ADR 的初稿经**六路独立复核**后重写：核心结论全部被证实，但初稿有六处
> 数字错误，其中三处是「把子集当全集」、两处是「纠正口径错误时又犯了口径
> 错误」。**教训 5/6/7 就是这次复核的直接产物**，值得先读。

## ✅ 已修复并发布：L2 场景块进注入包从 0/6 恢复到 6/6（v0.3.5）

详见 [ADR 0007](decisions/0007-injection-budget-container-mismatch.md)。
**两个独立缺陷同一轮修完**——只修一半会退化（只修 A 会让 `3e857510e628`
从 6/6 退到 5/6，只修 B 则画像缺失期仍是 0/6）。

- **缺陷 A（读路径，间歇性）**：`INJECT_BODY_BUDGET_TOKENS = 1300` 是被 global 与
  repo 争抢的共享容器，而 `queryInjectionRows` 在无派生行时回退到最多 20 条 L1
  原子——**只限行数不限体积**。D9 触发器在任何 personal raw 写入时删除 L3 画像，
  实测 32.2 小时窗口内画像**存在 58.5%、缺失 41.5%**；缺失期间 global 库回退取
  8 行合计 **2348 tok**（理论最坏 20×554 = 11080 tok），超过整个预算，
  repo 侧派生层一块进不来。
  修法：personal 侧在与 repo 拼接**之前**按 `worstPersonaTokens()` 裁剪，
  复用同一个 `withinBudget` 选择器（不新写第二套裁剪逻辑，D8）。
- **缺陷 B（写路径，常驻）**：`ROLLUP_TARGET_CHARS` 此前只存在于提示词字符串里，
  写路径切的是 `BODY_MAX_CHARS`(2000)。全部 17 个现存 L2 块**无一例外**生成于强制
  之前，最长 1820ch。修法：`parseScenarios`/`parsePersona` 按 target 强制裁剪。

**统一的不变量**（两个执行点共用同一实现）：

```
worstPersona + ROLLUP_MAX_SCENARIOS × worstScenario ≤ INJECT_BODY_BUDGET_TOKENS
     171     +          6           ×      183      = 1269 ≤ 1300   富余 31
```

**真实库验收**（判据是行为差异，不是测试数）：

```
repo          画像在场(58.5%)   画像缺失(41.5%)
3e857510e628   5/6 → 6/6         0/6 → 6/6
ec2636fc223e   5/5 → 5/5         0/5 → 5/5
edf7a6862dde   3/6 → 6/6         0/6 → 6/6
```

**守卫的换行盲区一并修掉**（教训 1 的第三个实例）：`renderEntry` 把 body 的 `\n`
缩进成 `\n␣␣`，而守卫用单行合成 body 定价，密度 33/千字即超预算却仍报绿灯。
现按 `DERIVED_WORST_LINE_CHARS = 30` 定价。**单位是「每换行字符数」，不是「平均行长」**
（二者差一个 `+1`）：真实库最密行是 33.75 字符/换行，派生行最密是 83.75，故 30 更严。
**这直接关系正确性**：真实 L3 画像含 4 个换行、成本 168 tok，若上界按单行取 161，
**会把画像本身挤出注入包**。代价是 `ROLLUP_TARGET_CHARS` 650 → **620**
（650 在换行定价下是 1317 > 1300）——**常量跟随不变量，而非把不变量修剪成迁就常量**。
残余敞口已声明：**每换行字符数 < 22** 的 body（逐词换行的紧凑列表）仍会超出定价；
届时先落空的是 L3 画像而非 L2 场景块——repo 侧派生层仍是 6/6，即本轮修复的目标不受影响。

**业界对照**：[hermes-agent](https://github.com/NousResearch/hermes-agent) 用
**两份独立预算**（`memory_char_limit` 2200 / `user_char_limit` 1375），按 target
选择，且**在写入时拒绝超限**而非注入时静默丢弃，单条 entry 另有上限。
memorax-code 的预算逻辑在闭源服务端，不可比。

**方法论教训**（比修复本身重要，完整六条见 ADR 0007）：
1. 守卫必须建模**运行时真正的容器**，且**覆盖的维度要与它保护的量同维**
   ——容器错了一次，维度又错了一次；
2. 名字叫 target 的常量可能只是**提示词里的一句请求**——动它前先找写路径；
3. **单库采样产生 7 倍偏差**，而**间歇性敞口**会让单次采样自相矛盾：
   采样要跨库，也要跨时间。

## 维护失败不再连坐任务流水线（v0.3.5 已上线，schema 不变）

`runner.ts` 的 `run()` 把 `maintain()` 与 job 认领放在**同一个 try 块**里，于是
一次维护失败会**取消该库整轮流水线**。实测：让 `collectMetrics` 抛异常
（`DROP TABLE usage`），同库一个 pending extract job 的 `attempts` 停在 **0**
——一个周期性杂务坏掉，该库当轮**一个任务都没跑**。

**改动只有三处，`maintain` 内部五步的顺序与语义、`lastCleanup` 语义、`tx.ts` 的重试参数均未动**：

- **拆成两个 try 块**：维护失败只 `warn`，随后照常 peek / claim / run。
- **`collectMetrics` 那一行单独包 try**：纯观测不该有能力停掉被观测的系统。
  它只读、不写，且在争用下正常返回，故**零冻结代价**。它的**主要理由是 logger
  exporter 抛异常**（由部署注入、不在本仓库内、无法审计，故不该有一票否决权），
  这条路径与哪张表无关；对**坏数据**它的适用面则很窄——逐表实测后只有 `usage`
  成立（详见下方 S2）。
- **维护若因 BUSY 失败，本轮跳过该库的认领**（`if (isBusy(error)) continue`）——
  这是审查打回的 B1，见下节。

**「给每一步都加防护」已否决，且有实测数字**——这条直觉很有吸引力，没有数字
它一定会被重新提出，故连同算术一并写进 [ADR 0006](decisions/0006-maintenance-failure-must-not-halt-the-pipeline.md)：

- 真实触发条件是 **`SQLITE_BUSY`**（多进程指向同一仓库，本项目自己把它列为
  ordinary case），打击的是**写**步骤，读步骤在争用下正常返回；
- `tx.ts` 的 `sleepSync` 用 `Atomics.wait`，busy-retry 是**同步阻塞、冻结整个
  事件循环**：单个写步骤最坏 `2000 × (3+1) = 8 秒`；
- 逐步 try/catch ⇒ 三个写步骤各撞一次 = **24 秒**。**实测 8426ms → 25530ms**。

所以「首个抛出即中止」**在争用下恰好是提前退出，是特性不是缺陷**——锁还被别人
握着，第二、三步只会更慢地再输一次同样的竞争。

**另外否决**（理由见 ADR）：不改 `lastCleanup` 语义、不加每库时间戳（存内存则
重启即丢；存 `meta` 则「为记录写失败而必须写库」自相矛盾）；不新增持久化的
维护失败记录——后果已在数据里可查（decay job 的 id 含日期，当日无该行即当日
维护未完成；`pendingJobs`/`oldestPendingJobAgeMs` 也会漂移），新增列会是同一
事实的第二处实现（D7–D9 的老教训）。

### B1（审查打回，已修）：拆 try 块引入的双倍冻结

上面那套 8s vs 24s 的算术**本身没错，但它没有扫到 `claimNextJob`**。该函数
（`jobs.ts:121`）走 `store.tx()` → `immediateTx`，**自己就是一个写事务，拥有一份
完整的 busy 重试预算**，而它站在 `maintain` 之外，所以清点「几个写步骤」时被漏掉。

- 拆 try 块**之前**：`maintain` 抛出 → 整个认领块被跳过 → 只花一次 8s。
- 拆 try 块**之后**：维护失败被吞 → 控制流**必然**走到 `claimNextJob` → 在同一把
  仍被别人握着的锁上再输一次同样的竞争 → **再冻 8s**。

实测（真实 `StoreRegistry` + 同款跨进程锁 + 预置一个可认领 job）：
**16936ms ≈ 2.12 × 单次预算，且 `attempts` 仍为 0**——付出双倍冻结，任务依然没被认领。
这正违反本 ADR 自己立的规则（「第二、三步只会更慢地再输一次同样的竞争」）。

**修法**：catch 里加 `if (isBusy(error)) continue`。`isBusy` 由 `tx.ts` 的模块私有
函数改为**导出**（全仓唯一的 BUSY 判据，`errcode & 0xff === 5`，覆盖 261/517 扩展码）
——是**复用**既有判据，不是新写一套；另写一套就是同一规则的第二处实现（D7–D9 老教训）。
**只跳过 BUSY**：BUSY 是唯一「已证明下一步必然失败且昂贵」的失败；坏数据/投毒导致的
维护失败不持有锁，认领照常进行——(f) 要打断的连坐保持被打断。修后同一测试 **8434ms**。

**教训**：清点「这一 tick 还会花掉几份 busy 预算」时，边界不是 try 块，而是控制流
还会碰到多少个写事务。

### S2：(c) 的适用面（逐表实测，措辞已收窄）

| DROP 的表 | collectMetrics | 后续四步 | (c) 的作用 |
|---|---|---|---|
| `usage` | 抛→被吞 | **全部成功** | 真正**吸收**，整轮维护救回 |
| `conversations` | 抛→被吞 | `pruneConversations` 抛 | 只是推迟一步 |
| `memories` | 抛→被吞 | `enqueueRebuildIfOverflowing` 抛 | 只是推迟一步 |
| `jobs` | 抛→被吞 | `cleanupJobs` 抛 | 只是推迟一步 |

`usage` 是**唯一只被观测读取、维护写步骤都不碰**的表，故对坏数据而言 (c) 只在这一张
表上真正成立。原先注释写「两条真正可达的尾部路径」、ADR 写「覆盖投毒或畸形数据」
**说得过宽**，已收窄。(c) 的原则性理由——**观测不得停掉被观测的系统**——不变。

**四条新测试，逐条先证伪再信任**（都经真实 `tick()` 驱动，`maintain` 保持不导出）：

| 测试 | 还原的修复 | 证伪结果 |
|---|---|---|
| 维护失败不连坐流水线 | 合回一个 try 块 | 失败（`attempts` 为 0） |
| 观测不能停掉被观测系统 | 拆掉 metrics 的 try | 失败（cleanup 与 decay 入队都没发生） |
| 争用只花一次预算（**无**可认领 job） | 加逐步 try/catch | 失败（25530ms vs 8000ms 预算） |
| 争用只花一次预算（**有**可认领 job） | 去掉 `if (isBusy(error)) continue` | 失败（16936ms，且 `attempts` 仍为 0） |

后两条用子进程持真实写锁计墙钟，**专为防止日后有人「顺手补全防护」**而存在。
第三条显式断言 `count(*) FROM jobs == 0`，**故意**把认领排除在测量外，因此对 B1
天然免疫——第四条正是为补这个盲区而加。墙钟断言在此可靠：被测的是 `Atomics.wait`
的定时器时长，不是 CPU 工作量（第三条连跑 5 次 8576/8512/8557/8554/8578ms，阈值
16000ms，余量 1.87 倍，波动 ±0.4%），**不要改成非墙钟断言**。

**测试一的破坏方式**从 `DROP TABLE usage` 改为 `DROP TABLE conversations`：前者在 (c)
存在后已被完整吸收，`maintain` 根本不再抛出，测试即使不拆 try 块也会变绿——测不到 (f)。
改用写步骤（`pruneConversations`）上的破坏点，两个破坏装置才各自隔离**一个**修复。

**顺带**：`DECAY_INTERVAL_MS` 全仓无读取点（`src/`/`test/`/`docs/` 均无，
`lib/` 是编译产物），已删除。decay 的每日一次由幂等键
`jobId('decay', repoKey, <日期>)` 实现，该常量是「同一规则的第二处陈述」。

`npm run verify` **157 passed**（基线 153 + 4）。ADR 0006 已改为中文并对齐
`日期`/`状态`/`相关` 字段（同目录 0001–0005 全为中文，第六篇用英文是新引入的不一致）。

## v0.3.4 上线验收（2026-08-29 11:20 重启后）

三处修复均已装载并生效，8 库 `user_version` 全为 9，重启后**新增 failed job 为 0**。

- **subagent 归因**：已安装代码确为按 `source.kind` 判定，旧的 `plugin+relay`
  死分支已不存在；活体喂入两种 source 形状，label 得到 `subagent:<id前8位>`、
  provenance 得到 `subagent`，未知 kind 仍 fail closed 到 `tool-output`。
  库中 10 行历史物证（`label='context'` 且内容含 `Background subagent`）
  **保持原样未回填**——回填会伪造历史。
- **extract JSON 化**：对 22 个真实 turn 重放，全部产出合法 JSON 且
  `length ≤ 6000`（最大 5972）；伪造攻击实测**无法制造出额外 events 条目**，
  攻击文本只能作为字符串值存活。
- **死信治理**：global 那条 revision=3 的不可达 rebuild **已被 cleanup 删除**
  （此前存在 5 天）；`5ed2b4d2` 的 extract 死信（turn 9，永久放弃的工作，
  唯一物证）**正确保留**；8 库 `store_revision` 均为规范十进制串。

**待观察的天然验证点**：`5ed2b4d2` 有一条 `turn=20` 的 pending extract，
`attempts=4/5`，失败原因正是 `model reply is not valid JSON`——**距死信仅剩
一次**。它是 0.3.3 时期积累的（既有问题），而下次重试会走 v2 提示词 +
JSON 渲染 + 宽容解析（`promptVersion` 只写不读，故重试自动用当前实现），
三处修复恰好都作用在它失败的那条路径上。**它转为 `done` 还是死信，是本次
升级最直接的实战证据**，值得下次开工时先查一眼。

## 重启后的真实结果（已验收）

迁移全部生效（8 库 v7→v9）。逐条对照预期：

- **L3 画像已真实生成**：global 得到 1 条 `derived=3`，内容做到了设计要求的
  **外推**（概括出「先排除便宜原因再上昂贵机制」这类可迁移判断，而非罗列
  偏好），`visibility=private` 正确，永不投影；
- **中文检索生效**：`取舍`（2 字词）命中 3 条、`工程取舍` 命中 2 条——修复前
  这两个都是 0 命中；
- **死信复活生效**：Ops 的 rebuild 由 `failed` 复活并重新执行；
- **不可达死信自行消失**：global 那行 revision 3 的旧 rebuild 死信，现由
  `cleanupJobs` 直接删除（store 已到 11），不再需要诊断工具替它解释。

**并且它暴露了下一个真实缺陷**（见下节）。这正是 `jobs.last_error` 的价值：
第一次让失败原因**自己说话**，而不是靠事后推断。

## rollup 的输入无界（第六轮修复，v0.3.2）

Ops 的 rollup 复活后仍失败，`last_error` 直接给出原因：
`stream finished as max-tokens`——**上限已提到 8000 仍不够**。

核算真实数据后，根因不是调参：**派生层由「注入集溢出 1300 token」触发，而由此
构建的提示词没有任何上限**——溢出越多，请求越大，无界增长。实测该库 27 条
记忆生成 12574 字符提示词（4769 汉字，≈6.7k token），加上邀请的 ~5.9k 输出，
任何合理上限都装不下。

`extract` 一直有 `EXTRACT_TRANSCRIPT_CHARS` 限制输入，**`rollup` 从来没有**。
补上这个缺失的孪生边界（`ROLLUP_TRANSCRIPT_CHARS = 6000`），按 packet 既有
顺序（provenance → 新近）截断，故留下的正是本就会被优先注入的那些，**不新增
第二套排序**。实测输入从 ~7018 token 降到 ~3561。

**同时补全不变量**：原守卫只保证「上限 ≥ 输出」，但 `maxTokens` 是否含输入
取决于 provider——这不可见，也不该赌。现改为保证「上限 ≥ 最坏输入 + 最坏
输出」，两侧均按 CJK 定价。该守卫当场证明 8000 装不下（需 11940），**由它算出
正确值**而非再拍一个数，故上限定为 12000。

> 若只再提上限而不限输入，就是同一根因的第三次绕行。**边界补在输入侧**，
> 上限只是随之而来的算术结果。

**结果（第二次重启后已验收）**：Ops 得到 **6 条 L2 场景块**，rollup 死信消失。

## extract 把「没什么可记」当成了故障（v0.3.3）

第二次重启后出现一条**新的、不同模式**的死信：strataloom 自身库的 `extract`
六次尝试后死信，`last_error` 写着 `model reply is not valid JSON`。

数据立刻否定了「系统性故障」：**只有 turn=9 失败，同一路由同一模型的前后
turn（8、10、11、12、13）全部一次成功**。turn 9 的内容是一整轮 shell/read
工具输出——即**确实没什么值得长期记住的东西**。

根因不是尺寸（extract 的输入本就有 6000 字符上限，输出上限也充足），而是
**把语义答案误判为技术故障**：提示词明写「没有可记的就返回
`{"candidates":[]}`」，而多数轮次本就没有可记的；模型改用自然语言回答
「这轮没有可复用的教训」时，被送进严格 JSON 解析器 → 判为畸形 → 重试。
**重试一个语义判断，是拿同一段文本再问一遍同一个问题，永远不可能成功**，
只会烧满 6 次尝试。

修法（只改 extract 的语义层，不放宽通用解析器）：回复为空或**根本不含 `{`**
时读作「空结果」并正常结案；**只要含对象就仍走严格解析**，故真正畸形的回复
照旧失败重试。`rollup`/`persona` 完全保持严格路径——对它们而言，无法解析就
意味着工作没做成。

> 通用原则：**重试只对瞬态故障有意义**。确定性的语义答复重试多少次都一样，
> 把它计入 attempts 只是在消耗死信额度并掩盖真实信号。

**那条 extract 死信要留满 30 天，它是本 bug 的最后物证**（区别于上面被删的
rebuild）。实测：该库 turn 2..17 全部 `done`，唯独 turn 9 `failed`；extract 的
id 是 `hash(kind, repoKey, sessionId, turn)`，**turn 不会重来**，所以没有任何
后继会替它把这轮做掉——它不是「被取代」，是**一次永久放弃的提炼**。丢的只是
那次提炼，turn 9 的 33 行 L0 转写仍在库里。63ba102 修的是不再产生新的这类
死信，但已经发生的那次不可恢复；把它当垃圾提前删掉，是抹掉损失而不是修复它，
所以 `FAILED_RETENTION_MS`（30 天）对它照旧适用。

验收命令（仓库根目录下运行）：

```bash
node scripts/inspect.mjs --days 3650
```

> `inspect.mjs` 现在**只列事实**：每条 failed job 带 kind、attempts、age、
> `last_error`，不再判断「这条还会不会重跑」。那个判断的真相源在 `jobId()` 的
> 构成与各 kind 的触发条件里（都在 `packages/memory/src/`），诊断工具重新推导
> 它就是一条规则两处实现——何况只有 `rebuild` 的 id 含 revision，用
> `payload.expectedRevision` 去问其余三类，问的是一个它们根本没有的字段。
>
> 唯一能由**数据本身**判定的不可达性已下沉到 `cleanupJobs`：failed 的
> `rebuild` 若 `expectedRevision` 不等于当前 `store_revision`，其 id 再也算不
> 出来（`jobId('rebuild', repoKey, expectedRevision)`），而后继 rebuild 会重做
> 全量画像——**与年龄无关，直接删除**。这不是新规则，是把 `runRebuildJob` 已有
> 的 fencing 判据搬到数据生命周期上：同一条规则，一处定义，两个生效时机。
>
> 把规则搬到数据侧，代价是**两侧必须对同一状态给出同一答案**。第一版没做到：
> `store_revision` 只由 memories 的 invalidate 触发器写入，尚无 raw memory 的
> 库根本没有这一行；`readRevision()` 把缺行读作 **0**，SQL 子查询却给 **NULL**，
> 而 `NULL IS NOT <任何值>` 恒真 → 新库上**可达**的 `expectedRevision=0` rebuild
> 被无条件删除。后果不止丢一行：删后同 id 走 INSERT 而非复活，`attempts` 归零，
> `MAX_CLAIMS` 毒丸防御被静默绕过，确定性失败的 rebuild 每 6 小时重置一次重试
> 预算、永远烧 LLM 且永不死信——与本文「重试只对瞬态故障有意义」直接冲突。
> 现以 `COALESCE(..., 0)` 与 `readRevision()` 对齐。同批加 `json_valid(payload)`：
> `json_extract` 遇非 JSON 会抛，三条 DELETE 同事务，而 `maintain()` 无内层
> catch——一行坏数据会让该 store 的 cleanup + prune + decay 入队 + rebuild 触发
> 整轮失效。维护路径上的语句不得有能力停掉维护本身。

### 两条死信是**两个不同的原因**（第三轮查清，推翻了第二轮的「都是路由」）

第二轮我按 `jobs.payload` 里固化的路由，判断两次失败都源于路由失效。**按
成败分布统计后这个结论不成立**——按路由分组，`claude/claude-opus-5` 是
12 成 1 败，`copilot/claude-sonnet-5` 是 6 成 1 败：两条路由本身都好好的。
换个维度分组，信号才出现——**按 job kind**：

| kind | done | failed |
|---|---|---|
| extract / reconcile / decay | 68 | **0** |
| **rebuild** | 2 | **2** |

失败只发生在 `rebuild`，且跨两条不同路由。再比对四次 rebuild 的输入规模：
两次成功各 16 行（≈7.8k 字符），唯一失败的 L2 是 **27 行 / 12.5k 字符、
其中 4769 个汉字**。

**根因（已修）**：rollup 提示词最多邀请 `6 × (60+900+30) = 5940` 字符；中文
约 1 字 1 token，即 ~5940 token，而 `LLM_MAX_TOKENS` 当时是 **4000**。回复被
截断，而截断的 JSON 不是「短一点的答案」，是**无法解析的答案**，于是 5 连败。

**更深的缺陷在守卫本身**：加载期断言按 `chars/4 × 2` 给最坏回复定价 = 2970，
顺利通过——可它自己的注释就写着「CJK 约 1 字 1 token」。这个 ×2 看着像余量，
实则仍**低估真实最坏情况一倍**，于是放行了一个过小的上限。现改为**按 1 字
1 token 诚实定价**（不再用 ×2 的手工余量），并把上限提到 8000。已加回归测试
锁定这条规则本身而非当时的数字；实测把上限调回 4000，该测试立即失败。

> `estimateTokens` 仍保持 `chars/4`：它服务的是注入预算，那里高估 CJK 会把
> 本可放下的记忆挤掉——两个口径服务两个相反的失败方向，不该统一。

**global（L3）是另一回事，且已排除上限因素**（第四轮补证）：

- 用 `git log -S` 查明上限变更史——`1_000 → 4_000` 提交于 2026-08-23 11:16 UTC，
  且 **v0.1.0（14:40 UTC 发布）就已带 4000**，而 L3 job 运行于 21:23 UTC。
  故它当时跑的就是 4000，不是更早的 1000；
- 按 CJK 诚实定价，L3 的输入仅 **771 字符**、邀请的输出仅 **660 字符**，
  距 4000 极远。**上限被彻底排除**；
- 且用已安装版驱动真实 global 库副本已跑通（job `done`、恰好 1 条画像行、
  `last_error` 为空）。

即：L2 与 L3 的失败**互相独立**，L2 已修，L3 的真实原因只能由重启后的
`last_error` 给出——这正是 v8 存在的意义。

**仍未修、故意留着的一处**：`llm-call.ts` 承诺「登出的固化 provider 不应 5 连败
进 dead-letter」，但它只在**当前默认路由与固化路由不同**时才回落一次。真正的
判据应是「这个 provider 现在还存在吗」。数据显示它不是这两次失败的原因，故
**不为它新增机制**——等真实证据。

## 一句话

插件**可用且已验证**（153 测试全绿，含真平台 e2e 与打包安装契约）。
**4×4 架构（D10）已全部落地**，且这次由**真实数据**证实而非仅由测试断言：
两个仓库各有 5–6 个真实 L2 场景块。详见
[`design/4x4-memory.md`](design/4x4-memory.md)。

## 本轮修复：真实数据暴露的三处设计缺陷

积累数据后复盘，共同教训是**机制正确 ≠ 产品有效**——测试全绿的同时，
L3 画像已经连续五天不可用而无人知晓。

1. **dead-letter 等于永久否决**（最严重）。job id 是确定性的，失败行被同 id
   的重新入队 `ON CONFLICT DO NOTHING` 吸收。实测：global 画像 job 在
   revision 3 死信后，跨 5 个维护轮从未重建，而同期 decay 一直在跑。
   修法在**唯一入队点**：failed 行遇新触发即复活（pending/running/done 照旧
   吸收）。不为 L3 加特判，故 Ops 仓卡住的 L2 rebuild 被同一处修好。
2. **失败不可归因**。原因只存在于会轮转的日志里，等有人来查时已消失。
   现记于 `jobs.last_error`（v8），写在唯一失败出口故覆盖所有 job kind，
   `inspect.mjs` 直接显示；截断且不含 prompt/回复，不泄漏记忆内容。
3. **中文按整段匹配**（v9）。默认分词器对标点之间的 CJK 只产出**一个 token**，
   查询须等于整段才命中，任何自然改写都落空。

   先试 `trigram`，**被实测否决**：它修好中文却让 `CI`/`Go`/`L3`/`v9` 这类
   <3 字符标识符从能搜变成搜不到（本语料有 163 个），还会让 `cat` 命中
   `concatenate`。参照业界演进（[hermes-agent 先 trigram+LIKE 回退、后改
   CJK bigram 索引](https://github.com/NousResearch/hermes-agent/pull/65544)；
   [sqlite-better-trigram](https://github.com/streetwriters/sqlite-better-trigram)
   需编译 C 扩展，违反本项目零依赖约束），最终采用 **CJK bigram 索引**：
   保留 `unicode61`（英文与既有语义原样不动），把 CJK 的重叠二元组写进索引的
   `cjk` 列。真实记忆验收：`分词器` 0→2、`工程取舍` 0→3、`真相源` 0→3、
   `连续词组` 0→2，**`取舍`（2 字词，trigram 做不到）2→3**，而 `L3`/`v9`/
   `dead-letter` 保持命中。仍是**一条 FTS 查询、一个 `rank`**，不新增检索规则。

   bigram 规则用 SQL 写在**唯一的同步触发器**里，故 propose/extract/两处
   rebuild 四个写入口自动继承；写侧（schema）与读侧（fts.ts）由测试锁定一致。

   这也是 ADR 0005 的**便宜那一半**：改写即中的未命中，先是分词问题，然后才
   轮到 embedding——代价是一次索引重建，不是模型依赖。

顺带修正的隐患：迁移期间 `temp_store` 固定为 MEMORY。`DROP TABLE` 会让
SQLite 去找**临时文件**，位置取决于环境；v9 曾因此在沙箱报 "unable to open
database file"。迁移只应依赖它拿到的那个库。

## 下一步

**阶段 4：检索融合**——**采集已就位，但先别动手**。

`recallMissRate` 已从 L0 用一条 SQL 算出（零计数器），随每次维护轮进日志。
但实测表明：一次零命中分不开「库里没有」「有但措辞没对上」「随口一探」三类，
而**只有第二类支持引入 embedding**。故它是**筛查信号，不是判据**——高比率的
意思是「去读转写」。

**开工的正当条件**：比率显著 **且** 抽读 L0 确认存在「未命中 → 改写查询 →
命中同一条」的实例。详见
[`decisions/0005-recall-miss-rate-is-a-screening-signal.md`](decisions/0005-recall-miss-rate-is-a-screening-signal.md)。

> **2026-08-28 校准**：上述 B 类（有但措辞没对上）在中文里**先是分词问题**。
> 已按 v9 用 CJK bigram 索引消除这层损耗并在真实记忆上验证，代价是一次索引
> 重建而非 embedding 依赖。因此重估 embedding 前，应先用**现在的**索引重新
> 采集——v9 之前的未命中率混入了分词损耗，不能直接用于该判断。

**看架构**：`docs/diagrams/strataloom-architecture.html`（自包含单文件，
浏览器直接打开；深浅主题、搜索、聚焦、关系追踪、三个预设视角）。真相源是
同目录的 `.json`，**HTML 是产物不要手改**；改完跑 `scripts/diagram.sh`
（或 `--watch` 边改边重建）。它**不从源码自动抽取**，理由与用法见
[`docs/diagrams/README.md`](diagrams/README.md)。

**查看数据**（无需 sqlite3，无需新增存储）：

```bash
node scripts/inspect.mjs            # 各库摘要 + 按周未命中率趋势
node scripts/inspect.mjs --misses   # 每次未命中前后的对话
```

趋势是从 L0 的时间戳**回溯算出**的（一条 GROUP BY），所以没有时序表——
周期性 metrics 日志会被轮转清掉，而 L0 本来就为溯源而保留。

`tool rows` 那一行报的是**最后一个含工具结果的批次**，不是窗口内的比率：

```
   tool rows  last turn 5d ago : 119 results,   0 calls     ← 最近一次采集由旧代码完成
   tool rows  last turn 0h ago :  10 results,  10 calls     ← 由 0.3.6 完成
```

**为什么是「最后一个批次」而不是比率**：配对性是 **turn 的属性**且在 turn 内
同质（实测全 8 库：完全孤儿 66 个 turn、完全配对 2 个、**混合 0 个**），所以
最后一个批次就足以判定「最近一次采集由哪个版本完成」。比率反而做不到——窗口
跨越重启就会把重启前的 100% 与重启后的 0% 平均成一个既非历史也非现在的数
（曾实测打印出 `91% orphaned`）。该行**不读 `--days`**，因此也不会被
`--days 0`（窗口坍缩为零宽度）弄消失。`global` 库没有任何含工具结果的批次，
查询自然返回空，**不打印这一行**。

在此之前，插件功能已完整（4×4 全部到位 + 真实 LLM 冒烟通过），可以先投入使用
积累真实数据。

## 已完成

### 基础能力（`37c73f5` … `1cb779b`）
三工具（recall/propose/forget）、分库隔离、原子迁移、注入、
extract→reconcile 管线、decay、rollup、投影审批、打包安装。

### 注入面加固（`b6727d8`）
存储内容抵达模型的三条读出口各有一处「内容不再是内容」的漏洞：
packet 曾作为 prompt 文本投递（含 `{{…}}` 的普通记忆会**永久瘫痪 agent**）、
正文换行可越出条目伪造顶层指令、`memory_propose` 手工拼接绕过全部三道规则。
现统一为「变量值投递 + 唯一渲染器」。

### 派生失效下沉（`90f142d`，schema v5）
失效原挂在工具写入口，而管线走另一个入口 ⇒ reconcile/decay 后
**过期摘要遮蔽新事实且不自愈**。现由三个 SQL 触发器按数据承担。

### 同类清扫与规范同步（`e799a19`）
token 口径、长度上限的重复陈述改为从常量派生；更正 6 处规范失真。

### `/memory` 命令（记忆可见性）
插件会**静默学习**，用户却无从知道它记了什么——`memory_recall` 回答「有没有 X」，
而这里的问题是「你都记了什么」。做成**命令而非 UI 面板**：`CommandInvocation`
携带 exact agent，故与工具共用同一套 D1 判定，**零新增权限面**；面板则需要一个
不经 agent 的读 API，那正是 D1 所禁止的。列表是读（任何会话可用），forget 仍受
principal 校验。

面板暂缓：命令已覆盖「一览 + 遗忘」两个核心缺口，面板唯一多出的是「常驻可见」，
其价值需用几天后再判断（否则是为未验证需求造前端构建链路）。

### 召回未命中率采集（阶段 4 前置）
`recallMissRate` 由 L0 一条 SQL 算出，**未新增计数器或列**——recall 工具的输出
本就被 L0 记录。同时把「它不能决定什么」写进了产出它的代码注释：三类未命中
混在一个数里，只有一类支持向量检索。指标依赖工具渲染的 `RECALL_NO_MATCH`
字符串，已提为共享常量并有回归测试（改措辞会让指标永远统计到 0）。

### 真实 LLM 端到端冒烟（deepseek-v4-flash）
四条管线各发真实请求，7/7 通过。**抓到一个真实缺陷**：`finish.kind ===
'max-tokens'` 原本落入「完成」分支，于是**截断的回复被当作完整结果**送进
解析器，报成「not valid JSON」——错误的诊断，且重试会重发同样超限的请求。
实测 5 次里 3 次截断（中文一字≈1 token，chars/4 低估）。修法两处：非 `stop`
的 finish 一律失败；`LLM_MAX_TOKENS` 由 1000 提到 4000，并加载期断言「上限必须
容得下提示词所要的最坏回复」。fixture adapter 永远返回 `stop`，故此前无从发现。

### 4×4 阶段 3：L3 Core/Persona（无需改 schema）
复用 `rebuild` job 按 `store.kind` 分派，**未加 job kind、未加列、未加阈值**。
触发条件是「画像缺失或模型判定过时」——`keep` 判定不写库，既保证不抖动，也让
D9 删除画像变得无害（下轮写回同一份）。详见 ADR 0004。

### 4×4 阶段 2：L2 Scenario（schema v7）
`derived` 由布尔加宽为层级（`LAYER`），**未加列未加表**；rebuild 改为产出多个
场景块。两处触发器由 `= 1` 改为 `!= RAW`，否则场景块会在原始集变化后残留。
v6/v7 的建表逻辑收敛为唯一的 `rebuildMemories`（调用方只传改动的那一列）。
注入**刻意不挑「当前场景」**——该路径无查询串，靠 cwd 猜测等于新增一条与
recall 竞争的弱检索规则；实测预算内可容纳 5 块而上限 6，问题基本不存在。

### 4×4 阶段 1：Coding Memory（schema v6）
第四类 Memory 到位。kind 与判据合为一处定义，故新增 kind 时判据是必填项；
迁移重建 `memories` 表时**关闭外键**——否则 `ON DELETE CASCADE` 会删光全部
证据行（实测），触发器由唯一定义重建。澄清询问复用平台既有能力，未建机制。

## 已知差距

4×4 的差距、影响与分期**只在设计文档里列一份**：
[`design/4x4-memory.md`](design/4x4-memory.md) §1/§2/§5。在这里复述一遍，
就是本项目吃过三次亏的「同一事实写在两处」。

设计文档未覆盖的一项：**管线尚未经真实 LLM 验证**——extract/reconcile/rollup
全部跑在 fixture adapter 上。需要真实模型凭据，待定。

## 环境备忘

```bash
cd packages/memory
npm run verify        # tsc + 176 测试（2026-08-31 实测全绿）
```

- Node ≥ 22（用 `node:sqlite`）。
- 本机 `npm`/`pnpm` 缓存有权限问题（沙箱不可写 `~/.npm`），需
  `npm_config_cache=/tmp/npmcache` 之类重定向；不是代码或用户机器的问题。
- 测试自身干净退出（已修复过一次遗漏 dispose 的泄漏），不需要
  `--test-force-exit`——如果需要它才能退出，说明某处忘了 dispose。
- **升级装不上时先读 stderr，别先怪缓存**（2026-08-29 更正）。此处原写
  「pnpm 把 resolution 钉在锁文件里，`add` 只是无害地重跑一遍，实际文件不变」
  ——**该叙述已被证伪**。两种真实失败都不是「无害」：
  - **写不进去**：agent 的文件沙箱只允许写工作区，而 profile 在
    `~/.dsh/profiles/` 之外。`pnpm` 打印 `[EACCES] ... open '.../_tmp_xxx'`
    后**仍返回 exit 0**，`dsh plugin` 又吞掉细节，于是「命令看似成功、版本
    没变」被误读成缓存问题。判据：`pnpm-lock.yaml` 的 mtime 停在上次成功
    安装那一刻，说明历次 remove/add/prune/`--force` **从未写盘**。
  - **内容对不上**：稳定资产名使 URL 不变而字节改变，锁文件钉的是**旧字节
    的哈希**。在可写环境里 pnpm 以 `ERR_PNPM_TARBALL_INTEGRITY` **非零退出
    拒绝安装**（按供应链风险处理），而非静默复用；此时 `remove` 再 `add`
    确实有效（已在纯净副本上复现）。

  排查顺序：贴 stderr 原文 → 比对三处版本（锁文件的 `version:`、
  `node_modules/<pkg>/package.json`、release 资产内的 `package.json`）→ 用
  `touch` 探针确认目录可写。**「实测」二字要能指出命令与原文输出**；上面那条
  错误结论正是只看退出码与最终版本号得出的。
- 全量测试约 1.6 秒；跑单文件时加 `--test-force-exit`（有常驻 interval）。
- 数据位置：`~/.dsh/strataloom/`（`global.sqlite` + `repos/<key>/`）。
