# 当前状态

> 最后更新：2026-08-23 · 4×4 全部到位 · 真实 LLM 冒烟通过 · `/memory` 可见性命令
> **每次工作结束时更新本页**，它是新会话的唯一入口。

## 一句话

插件**可用且已验证**（124 测试全绿，含真平台 e2e 与打包安装契约）。
**4×4 架构（D10）已全部落地**：四层 L0/L1/L2/L3 与四类
Coding/Repo/Personal/Procedure 皆到位。详见
[`design/4x4-memory.md`](design/4x4-memory.md)。

## 下一步

**阶段 4：检索融合**——**采集已就位，但先别动手**。

`recallMissRate` 已从 L0 用一条 SQL 算出（零计数器），随每次维护轮进日志。
但实测表明：一次零命中分不开「库里没有」「有但措辞没对上」「随口一探」三类，
而**只有第二类支持引入 embedding**。故它是**筛查信号，不是判据**——高比率的
意思是「去读转写」。

**开工的正当条件**：比率显著 **且** 抽读 L0 确认存在「未命中 → 改写查询 →
命中同一条」的实例。详见
[`decisions/0005-recall-miss-rate-is-a-screening-signal.md`](decisions/0005-recall-miss-rate-is-a-screening-signal.md)。

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
npm run verify        # tsc + 127 测试
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
