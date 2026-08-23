# StrataLoom 文档地图

**新会话从这里开始。** 读完本页（约 2 分钟）就能知道项目在哪、下一步做什么。

## 每份文档回答一个问题

| 我想知道… | 读这个 | 谁维护 |
|---|---|---|
| **现在进行到哪、下一步做什么** | [`STATUS.md`](STATUS.md) | 每次工作结束时更新 |
| 这个东西为什么是这样设计的 | [`../plugin-architecture.md`](../plugin-architecture.md) | 决策变化时 |
| 4×4 记忆架构的目标形态与差距 | [`design/4x4-memory.md`](design/4x4-memory.md) | 阶段完成时 |
| 某个决定当时是怎么权衡的 | [`decisions/`](decisions/) | 只增不改 |
| 怎么装、怎么用 | [`../README.md`](../README.md) · [`../INSTALL.md`](../INSTALL.md) | 用户可见行为变化时 |
| 代码内部怎么组织的 | [`../packages/memory/README.md`](../packages/memory/README.md) | 不变量/测试变化时 |

**唯一职责原则**：同一事实只在一处陈述，其余地方引用它。本项目已有三次
「一条规则写在两处就漂移」的教训（见 D7–D9），文档同理——发现两处在说同
一件事，删掉一处，不要同步它们。

## 权威顺序

冲突时以此为准，上位者胜：

1. **测试** —— 可执行的事实。测试与文档冲突，先查文档。
2. **`plugin-architecture.md`** —— 规范。
3. 其余文档 —— 派生说明。

规范也会错。v2.7 就更正了 6 处规范失真（如 D4 原写「只有一个写入口」实为
两个）。**发现规范错时改规范，不要把代码改回去**，并在 `decisions/` 记一笔。

## 工作循环

```
开工：读 STATUS.md 的「下一步」
       ↓
干活：改代码 + 测试
       ↓
收工：npm run verify → 提交 → 更新 STATUS.md
       （有架构取舍则补一条 decisions/ADR）
```

**提交信息写「为什么」，不写「改了什么」**——diff 已经说明改了什么。
现有 commit 是范例：先讲缺陷如何被触发、为何这样修、放弃了什么替代方案。

## 目录

```
docs/
├── README.md            # 本页：文档地图
├── STATUS.md            # 当前进度与下一步（最常更新）
├── design/
│   └── 4x4-memory.md    # 4×4 记忆架构：目标形态、差距、分期
└── decisions/           # ADR：一决策一文件，只增不改
    └── NNNN-<slug>.md
```
