# 当前状态

> 最后更新：2026-08-23 · 阶段 3 完成（4×4 全部到位）
> **每次工作结束时更新本页**，它是新会话的唯一入口。

## 一句话

插件**可用且已验证**（122 测试全绿，含真平台 e2e 与打包安装契约）。
**4×4 架构（D10）已全部落地**：四层 L0/L1/L2/L3 与四类
Coding/Repo/Personal/Procedure 皆到位。详见
[`design/4x4-memory.md`](design/4x4-memory.md)。

## 下一步

**阶段 4：检索融合**——但它**有前置条件**，不应直接开工：设计文档写明需先用
§9 metrics 采集「召回未命中率」，**有数据再决定**是否值得引入 embedding 依赖
（向量索引在规范中长期处于拒绝清单）。

在此之前更有价值的是：**用真实 LLM 端到端冒烟**。整条管线（extract /
reconcile / rollup / persona）至今只跑过 fixture adapter，这是唯一尚未被真实
环境验证的一环，需要真实模型凭据。

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
npm run verify        # tsc + 114 测试
```

- Node ≥ 22（用 `node:sqlite`）。
- 本机 `npm` 缓存有权限问题，`npx tsc` 会失败；测试可直接
  `node --test --test-force-exit "test/*.test.mjs"`。
- 全量测试约 1.6 秒；跑单文件时加 `--test-force-exit`（有常驻 interval）。
- 数据位置：`~/.dsh/strataloom/`（`global.sqlite` + `repos/<key>/`）。
