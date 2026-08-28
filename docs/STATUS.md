# 当前状态

> 最后更新：2026-08-28 · 按真实运行数据修了三处设计缺陷（v0.3.0 / schema v9）
> **每次工作结束时更新本页**，它是新会话的唯一入口。

## ⚠️ 待办：重启 harness 才会生效

v0.3.0 已发布并装入 `web` profile（已核对装的确是 0.3.0 且含 v9 代码），但
**当前 harness 进程仍加载着旧代码**，故线上库仍停在 `user_version = 7`。
迁移只在 store 首次打开时执行——**重启 harness** 后自动完成，无需手工改库。

重启后用一条命令验收：

```bash
node scripts/inspect.mjs --days 3650
```

预期：两条 `stuck` 消失；`global` 出现 1 条 derived（L3 画像）、`3e857510`
出现 derived（L2 场景块）；中文检索可用（试 `memory_recall` 查「取舍」）。

**已在真实数据的副本上用「已安装的 0.3.0」预演过**，不是推断：8 个库全部
v7→v9 且零条未索引；`3e857510` 的死信 `failed→pending` 原地复活（revision 未
变，id 相同）；global 因 revision 已从 3 前进到 8，会入队一个**全新** job，
旧死信自然作废——即 L3 有两条恢复路径，而 Ops 的 L2 正是靠本轮修复才动得了。

若 L3 再次失败，`inspect.mjs` 这次会直接打印原因（v8 的 `jobs.last_error`），
不再是 `cause not recorded`。

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

**global（L3）是另一回事**：画像最坏回复仅 660 字符，离上限很远，故与本缺陷
无关；且用已安装的 0.3.0 驱动真实 global 库副本已跑通（job `done`、恰好 1 条
画像行、`last_error` 为空）。它的真实原因仍待重启后由 `last_error` 给出。

**仍未修、故意留着的一处**：`llm-call.ts` 承诺「登出的固化 provider 不应 5 连败
进 dead-letter」，但它只在**当前默认路由与固化路由不同**时才回落一次。真正的
判据应是「这个 provider 现在还存在吗」。数据显示它不是这两次失败的原因，故
**不为它新增机制**——等真实证据。

## 一句话

插件**可用且已验证**（133 测试全绿，含真平台 e2e 与打包安装契约）。
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

**查看数据**（无需 sqlite3，无需新增存储）：

```bash
node scripts/inspect.mjs            # 各库摘要 + 按周未命中率趋势
node scripts/inspect.mjs --misses   # 每次未命中前后的对话
```

趋势是从 L0 的时间戳**回溯算出**的（一条 GROUP BY），所以没有时序表——
周期性 metrics 日志会被轮转清掉，而 L0 本来就为溯源而保留。

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
npm run verify        # tsc + 133 测试
```

- Node ≥ 22（用 `node:sqlite`）。
- 本机 `npm`/`pnpm` 缓存有权限问题（沙箱不可写 `~/.npm`），需
  `npm_config_cache=/tmp/npmcache` 之类重定向；不是代码或用户机器的问题。
- 测试自身干净退出（已修复过一次遗漏 dispose 的泄漏），不需要
  `--test-force-exit`——如果需要它才能退出，说明某处忘了 dispose。
- **pnpm 更新陷阱**：稳定安装 URL（`releases/latest/download/...`）能保证
  服务端「这个 URL 永远指向最新版」，但 pnpm 把 URL 依赖的 resolution
  **钉在锁文件里**，同一 specifier 不会触发重新拉取——`add` 甚至
  `update --force` 都只是无害地重跑一遍，实际文件不变。唯一可靠的更新
  路径是先 `remove` 再 `add`（已写进 `INSTALL.md`）。这是实测发现的，不是
  猜测：一次真实发布因此让已安装的 profile 停留在旧版本却报告成功。
- 全量测试约 1.6 秒；跑单文件时加 `--test-force-exit`（有常驻 interval）。
- 数据位置：`~/.dsh/strataloom/`（`global.sqlite` + `repos/<key>/`）。
