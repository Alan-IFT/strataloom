# 架构图

五张自包含、可交互的图（单文件内联 SVG，深/浅色主题、搜索、聚焦、关系追踪、
导出）。用浏览器直接打开即可。

| 文件 | 类型 | 回答什么问题 |
|---|---|---|
| `strataloom-architecture.html` | architecture | 有哪些部件、边界在哪、谁跟谁说话 |
| `strataloom-pipeline-workflow.html` | workflow | 异步管线怎么走：两个入口、四种 job、三态出口 |
| `strataloom-turn-sequence.html` | sequence | 一个 turn 里注入 → 工具调用 → 采集的时序 |
| `strataloom-dataflow.html` | dataflow | L0→L1→L2→L3 的血缘、失效边、读出口 |
| `strataloom-job-lifecycle.html` | lifecycle | 一个 job 从入队到删除的状态机 |

真相源是同目录的同名 `.json`——**HTML 是产物，不要手改**。

## 更新

```bash
scripts/diagram.sh           # 五张全部校验 + 重新生成
scripts/diagram.sh --watch   # 编辑时自动重建（约 1 秒内响应）
```

`--watch` 监视 `docs/diagrams/*.json` 与 `packages/memory/src/`。
有 `inotifywait` 就用它，没有则退化为轮询——**两条路径都不需要额外安装**。

依赖 [archify](https://github.com/tt-a1i/archify) skill，默认在
`~/.dsh/skills/archify`；装在别处用 `ARCHIFY_HOME` 指定。

## 为什么不从源码自动生成

**没有工具能推断出哪些框重要。** 从 `src/` 自动抽取会得到一张按文件依赖排列
的图——它反映的是模块引用关系，而不是这个系统的设计意图（三条读出口共用一个
渲染器、派生层由触发器失效、管线按 revision 围栏）。那样的图每次改名都会变，
却从没有人真正审阅过它。

所以规约是**手写并像代码一样审阅**的，脚本只保证三件事：

1. HTML 与规约同步；
2. **不合规的规约无法交付**——`deliver` 在 showcase 档下要求 9 项检查全过、
   0 错误 0 警告，任何一项不过就非零退出，旧产物保持不动；
3. **架构图的引用会被核对**——见下节。

「实时」在这里的含义是：**改规约 → 自动重校验 → 自动重出图**。而不是
「有人重命名了一个文件，图就悄悄变成了另一个样子」。

## 引用核验（只有架构图有）

架构图声明了 `meta.repository` 与逐节点的 `sources`（21 处 `文件:行号` 引用），
因此它是用 `--repo-root` 渲染的：archify 会**拿每一条引用去比对本 checkout**，
引用失效就拒绝交付。

这一条正好补上了「手写规约」的那个缺口：**图上的框可以手写，但它声称的代码位置
不能是想象的**。模块被重命名或删除时，在这里就会红，而不是留给某个信任了一个
已不存在的框的读者。

其余四种图不接受 repo evidence（archify 只对 architecture 开放该能力），
所以它们由脚本以不带 `--repo-root` 的方式交付。

## 图里的事实从哪来

节点与连线均来自代码核实，而非印象：

| 图上的元素 | 代码依据 |
|---|---|
| 采集由 turn 结束触发 | `auto-extract.ts` 的 `agent/turn-stopping` 钩子 |
| L0 无条件写入、且不建 FTS | `conversations.ts` 的 `captureTurn`；全库只有 `memories_fts` 一张虚表 |
| 三条读出口共用渲染器 | `render.ts` 的 `renderEntry`（D8），`inject.ts` 再导出 |
| 注入 ≤1400 tok / recall ≤500 tok / 跨仓成员 ≤220 tok | `constants.ts` 的三个预算常量 |
| 注入是工作集 top-N、不逐轮检索 | `fts.ts` 的 `queryInjectableSet`：只有 `ORDER BY 优先级, updated_at`，不接受查询串 |
| 注入优先派生层 | `fts.ts` 的 `queryInjectionRows`：`derived DESC`，为空才回落 raw |
| D9 触发器：raw 写入即删**整个**派生层 | `schema.ts` 的 `invalidate_derived_*` 三个触发器（`derived != 0`） |
| revision 围栏 | `rebuild.ts` 的 `readRevision`，认领后与提交内各查一次 |
| 派生层由 Packet 溢出触发 | `rebuild.ts` 的 `if (!packetOverflows(store)) return false` |
| L2 最多 6 块 / L3 恰好 1 条 | `ROLLUP_MAX_SCENARIOS` / `runPersonaJob` 的 delete-then-insert |
| job 复活只对 failed 生效 | `jobs.ts` 的 `ON CONFLICT(id) DO UPDATE … WHERE jobs.state='failed'` |
| decay 无 LLM | `decay.ts` 全文只有 SQL，不 import `llm-call` |
| 每仓分库 · global 私有库隔离 | `store.ts` 的路径推导 + `schema.ts` 的 `guard_visibility_*` 触发器 |

四种记忆用途（`fact`/`coding`/`preference`/`procedure`）见 `types.ts` 的
`MEMORY_KIND_CRITERIA`——**名字与判据不可分**，缺判据会在加载期抛错。

## 与初始规范的偏差（只有一处，且是显式推翻）

初始 `plugin-architecture.md` **三处否决**过 L2/L3 双派生粒度（§2.2、§12、
§13），理由不是「没必要」，而是**两个粒度的语义差异从未被定义**。

而今天的实现是两层。这不是漂移：
[ADR 0002](../decisions/0002-l2-l3-need-defined-boundaries.md) 先用
**作用域 + 数量 + 失效条件**把边界定死，再写代码，并把 `derived` 从布尔
**加宽**而非新增列（11 处消费者中 10 处问的是 `derived = 0`，加宽后一字不改）。
图上第一张卡片如实记着这段历史，**因为一个被推翻过的决定比一个从未被质疑的
决定更需要写下来**。

其余元素与初始规范逐条一致，包括：单一全局 context 提供方（§4.1）、
两条读出口共用同一句框定头（§4.3，即今天的 D8 唯一渲染器）、
fencing 先于业务写入（§5.2）、`chars/4` 的统一 token 口径（§4.3）、
L0 无条件写入与不建 FTS（§v2.7）。

## 桌面视觉复核状态

五张图都通过了 `deliver` 自带的 **desktop-readability 静态检查**（1440×900 下
投影字号 ≥ 6px、无溢出）。

但 `archify visual-check`（真实 Chrome 截图证据）**在本仓当前的沙箱里跑不起来**：
Chrome 需要 `/dev/shm` 与 `~/.config` 写权限、以及 namespace 权限，均被拒。
因此**没有人做过目视复核，本文也不声称做过**。要取截图证据，请在能启动 Chrome
的环境里跑：

```bash
node ~/.dsh/skills/archify/bin/archify.mjs visual-check docs/diagrams/<name>.html --json
```

`visual-check` 从不修改产物，所以上面的交付回执不受它影响。
