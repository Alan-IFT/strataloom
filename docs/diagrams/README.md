# 架构图

`strataloom-architecture.html` 是一份自包含、可交互的架构图（单文件 728 KB，
内联 SVG，深/浅色主题、搜索、聚焦、关系追踪、导出）。用浏览器直接打开即可。

真相源是同目录的 `strataloom-architecture.json`——**HTML 是产物，不要手改**。

## 更新

```bash
scripts/diagram.sh           # 校验 + 重新生成
scripts/diagram.sh --watch   # 编辑时自动重建（约 1 秒内响应）
```

`--watch` 监视 `strataloom-architecture.json` 与 `packages/memory/src/`。
有 `inotifywait` 就用它，没有则退化为轮询——**两条路径都不需要额外安装**。

依赖 [archify](https://github.com/tt-a1i/archify) skill，默认在
`~/.dsh/skills/archify`；装在别处用 `ARCHIFY_HOME` 指定。

## 为什么不从源码自动生成

**没有工具能推断出哪些框重要。** 从 `src/` 自动抽取会得到一张按文件依赖排列
的图——它反映的是模块引用关系，而不是这个系统的设计意图（三条读出口共用一个
渲染器、派生层由触发器失效、管线按 revision 围栏）。那样的图每次改名都会变，
却从没有人真正审阅过它。

所以规约是**手写并像代码一样审阅**的，脚本只保证两件事：

1. HTML 与规约同步；
2. **不合规的规约无法交付**——`deliver` 在 showcase 档下要求 9 项检查全过、
   0 错误 0 警告，任何一项不过就非零退出，旧产物保持不动。

「实时」在这里的含义是：**改规约 → 自动重校验 → 自动重出图**。而不是
「有人重命名了一个文件，图就悄悄变成了另一个样子」。

## 图里的事实从哪来

节点与连线均来自代码核实，而非印象：

| 图上的元素 | 代码依据 |
|---|---|
| 采集由 turn 结束触发 | `auto-extract.ts` 的 `agent/turn-stopping` 钩子 |
| 三条读出口共用渲染器 | `tools.ts` 的唯一 render 回调 + `inject.ts`（D8） |
| 注入 ≤1400 tok / recall ≤500 tok | `constants.ts` 的两个预算常量 |
| D9 触发器：raw 写入即删派生层 | `schema.ts` 的 `invalidate_derived_*` 三个触发器 |
| revision 围栏 | `rebuild.ts` 的 `readRevision` 前置检查 |
| L2 ≤620 / L3 ≤600 | `ROLLUP_TARGET_CHARS` / `PERSONA_TARGET_CHARS` |

第三张卡片列的三条「已登记未修」缺口出自
[ADR 0009](../decisions/0009-measure-at-the-outermost-ruler.md)。
