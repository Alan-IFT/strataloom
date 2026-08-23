# 当前状态

> 最后更新：2026-08-23 · 对应提交 `e799a19`
> **每次工作结束时更新本页**，它是新会话的唯一入口。

## 一句话

插件**可用且已验证**（114 测试全绿，含真平台 e2e 与打包安装契约），
但只实现了 4×4 架构的一部分：**L0/L1 完整，L2/L3 合并为一个摘要层；
四类 Memory 中 Coding Memory 缺失**。差距与分期见
[`design/4x4-memory.md`](design/4x4-memory.md)。

## 下一步

**阶段 1：Coding Memory**（边界最清晰、风险最低，先做）
详见设计文档的「分期」一节。开工前先读该文档的「不变量」与「验收」两节。

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
