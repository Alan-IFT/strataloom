# 0008 · L0 记录了「工具说了什么」，没记录「agent 做了什么」

- 日期：2026-08-30
- 状态：**已确诊，未修复**（本文记录缺口、业界对照与被否决的方案；修法待下一轮）
- 相关：§2.4（provenance 映射）、§5.1（extract 输入）、`src/transcript.ts`、
  `src/pipeline/extract.ts`、[`0005`](0005-recall-miss-rate-is-a-screening-signal.md)、
  [`0007`](0007-injection-budget-container-mismatch.md)

## 起因：一条走错方向的调研

本轮原本要推进**阶段 4（检索融合）**。ADR 0005 规定的开工条件是「比率显著
**且** 抽读 L0 确认存在『未命中 → 改写查询 → 命中同一条』的实例」。

我先断言「查询串从未被采集，故该判据用现有数据永远无法求值」，并据此提议
往 L0 增采 `memory_recall` 的查询串。**该断言是错的，方案已作废。** 记在这里，
因为它错的方式比它本身更值得留存。

**纠正一：判据是可求值的。** 查询串完整存在于平台 session 日志的
`tool/call.data.arguments`。实测（`session-0e8da469`）：

```
memory_recall tool/call 事件数: 41
  arguments: {"query":"仓库根就是应用根","kind":"fact","sourceOf":""}
  arguments: {"query":"测试数量棘轮","kind":"fact","sourceOf":""}
```

按 `callId` 配对 `tool/call` 与 `tool/result` 后，**135 次调用全部配对成功**，
MISS→改写→HIT 的实例可以直接跑出来。我只查了插件自己的 8 个库就下了
「物理上不存在」的结论，而 `transcript.ts` 读的正是 `agent.session.events`
——数据一直在那里。

> 注意边界：`store/conversations.ts` 的模块注释声明 L0 存在正是为了**不依赖**
> 平台 session 日志（它会轮转、会被清理）。因此该路径只能用于**一次性调研**，
> 不得固化为常设诊断依赖。

**纠正二：比率那一半本身还没重新采集。** 按 v9（CJK bigram，`2575df0`）切分：

```
v9 之前: 302 次调用, 121 未命中 (40%)   ← 占样本 99%
v9 之后:   4 次调用,   2 未命中 (50%)
```

`STATUS.md` 早已写明「v9 之前的未命中率混入了分词损耗，不能直接用于该判断」。
**我引用的 29%–58% 有 99% 来自失效样本**，有效样本只有 4 次调用。所以阶段 4
的门禁不是缺另一半判据，而是**两半都还不成立**。

**纠正三：我提的「把请求与结果合并成一行」变体有安全缺陷。**
`memory_recall.query` **没有长度上限**（对比 `memory_propose` 有
`TITLE_MAX_CHARS=200`/`BODY_MAX_CHARS=2000`），而 `metrics.ts` 与
`inspect.mjs` 都用**前缀**匹配 `text LIKE 'No stored memories matched.%'`
统计未命中。合并后前缀变成模型完全可控的字符串：

- 未命中不再被计数 → 比率恒为 0；
- 若改成非前缀 `%…%` 规避，则一次 `memory_recall("No stored memories
  matched.")` 就能把命中伪造成未命中，**任意操纵阶段 4 的开工决策**。

而锁定该常量的回归测试（`layers.test.mjs:459`）锁的是**措辞**，锁不住
**前缀位置的语义**——测试会继续全绿。体积论据也反了：行占比 71% 但字节占比
仅 26%（未命中行恒为 27 字节），合并方案 **+4.2%** 比加一行 **+2.5%** 更贵。

## 真正的缺口

走错的调研撞上了一个更大的问题：**L0 的采集契约与它自己声明的职责不符。**

设计文档 §1 说 L0 是「原始对话与完整上下文」，用于「核对原话、时间、来源」。
实际它记录的是「工具说了什么」，而不是「agent 做了什么」。

`src/transcript.ts` 的 `collectTurnEvents` 有两处丢弃：

```ts
if (event.type === 'tool/call') {
  callNames.set(String(event.data.callId), event.data.name)
  continue                      // (1) 只取工具名，参数整体丢弃
}
...
if (entry !== undefined && entry.text.trim() !== '') out.push(...)
                                // (2) 文本为空的事件整条丢弃
```

`textOf` 只取 `type === 'text'` 的块，所以一条**纯 tool_use 的 assistant 消息**
经 (2) 被整条丢弃。

**实测（`session-43422ed9`，本仓库自身的真实会话）**：

```
assistant/message 事件: 722   其中有文本 341   纯工具调用 380 → 被丢弃 52.6%
tool/call  事件: 863  → 100% 被丢弃
tool/result 事件: 878 → 全部入 L0
```

> **更正一处我先前的夸大**：我曾说「L0 丢弃 99.9% 的 assistant 事件」。
> 那是把两类库混为一谈得出的。按库实测，assistant 占 L0 的比例是
> **1.0%–45.9%**：低的两个库（`3e857510`=1.1%、`edf7a686`=1.0%）是
> **外部导入的单会话**，不是本插件正常采集；正常采集的库（`5ed2b4d2`=32.0%、
> `aafbf0fa`=28.1%、`94394b03`=25.9%）assistant 采集**工作正常**。
> 真实丢弃率是 **assistant 52.6% + tool/call 100%**，不是 99.9%。
> 这仍然是重大缺口，但数字要诚实。

**为什么这比查询串重要一个量级**：

1. **extract 的输入就是这些事件**。它在**看不见 agent 任何一次工具调用**的
   情况下提炼记忆——只看得见工具返回了什么，看不见为什么调用、用什么参数。
2. **`parent-agent` 是默认注入集三个来源之一**（§2.3：`human` /
   `principal-explicit` / `parent-agent`），而它的供给被砍掉一半。
3. **孤儿结果**：L0 里每一条 `tool:<name>` 结果都没有对应的请求行。

## 业界对照

实际克隆读码，非读 README。

### TencentDB-Agent-Memory —— 差异恰好就在我们丢弃的那一行

[`MemoryCore/scripts/import-opik-to-memory-skill-py/import_opik.py:352-358`](https://github.com/TencentCloud/TencentDB-Agent-Memory/tree/feat/server_team)：

```python
text = content_to_text(raw.get("content") or raw.get("text"))
if text and text.strip():
    out.append({"role": mapped, "content": truncate(text)})
if mapped == "assistant":
    out.extend(extract_tool_calls(raw))    # ← 我们缺的正是这一行
```

**先取文本；文本为空不影响 `tool_call` 的独立采集。** 我们只做了第一步。

三条可借鉴的判断：

| 判断 | 腾讯 | 我们 |
|---|---|---|
| tool_call 是独立 role | `{"role":"tool_call","content":<args>,"tool_call_id":cid,"tool_name":name}` | `tool/call` 被 `continue` 丢弃 |
| 强制截断 | `MAX_MSG_CHARS = 32_000`，超出加 `…[truncated]` | 采集侧**无上限**（仅 extract 侧有 6000） |
| 孤儿清理 | `drop_orphan_tool_results()`：无配对请求的结果一律丢弃 | 无此概念，且**全部结果都是孤儿** |

第三条尤其刺眼：腾讯把「结果必须有对应的请求」当作不变量，而我们全库只有
结果没有请求——按它的规则，我们 L0 里每一行工具结果都会被判为孤儿。

### hermes-agent —— 不可比

记忆是**显式工具写入**（`memory_tool.py` 的 add/replace/remove），没有自动
转写层，`handle_tool_call` 只做分发。它靠 `memory_char_limit` /
`user_char_limit` 在**写入时**拒绝超限（该判断已在 ADR 0007 借鉴）。
**它不做 L0，对本议题无参考价值。**

### memorax-code —— 不可比

检索与预算在闭源服务端，本地仅采集适配与 HTTP 客户端；全仓 grep
`budget|token_limit|char_limit` 零命中。

## 四项缺口（本文只登记，不在此修）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| 1 | **L0 丢弃 assistant 52.6% + tool/call 100%** | 上表 | extract 输入残缺；`parent-agent` 供给腰斩 |
| 2 | `recallMissRate` 分母含 `Error:` 行 | 修正后 `edf7a686` 由 29% 变 **71%** | 指标算错，且是阶段 4 的门禁数 |
| 3 | 历史比率未按 v9 切分/作废 | v9 前样本占 99% | ADR 0005 的推论只活在文档里 |
| 4 | `memory_recall.query` 无长度上限 | 实测均值 9.2 字符、最长 36；schema 无 `maxLength`，`execute` 不截断 | 无界的模型可控串直接进 FTS 查询构造 |

另有两项**既存**缺陷，独立登记、不与上述混修：

- **L0 无凭据扫描**：`projection.ts` 的模式只作用于投影到仓库的渲染文本，
  `captureTurn` 写入路径上零扫描。extract 提示词里那句 "no secrets" 是
  **给模型的请求，不是机制**——与 `ROLLUP_TARGET_CHARS` 的教训同型。
  注意用户消息本已全文进 L0，故这不是新增缺口。
- **`conversations` 无体积上界**：`pruneConversations` 只按时间删，
  无行数/字节上限。若将来需要上界，应由「保留期 × 单会话事件率」这一
  不变量算出，而非拍一个常数。

## 修复方向（待下一轮方案审查裁决）

- `tool/call` 以**独立 label** 采集，**不与 `tool:<name>` 结果混用**——
  否则会污染 `RECALL_NO_MATCH` 的前缀匹配（见上文「纠正三」）；
- assistant 消息**即使无文本块也不整条丢弃**（有 tool_use 就记 tool_use）；
- **采集侧强制截断**：本项目已被「无界」坑过三次（rollup 输入、注入回退分支、
  以及本文第 4 项），采集侧不能是第四次；
- `provenance` 严格按 §2.4 fail-closed 定为 **`tool-output`**，
  **不得给 `parent-agent`**——否则等于为「模型可控文本 → 默认注入包」
  开一条新通路，而 `arguments` 按平台定义是模型原样产出、未经解析的字符串。

## 教训

1. **「数据不存在」与「我没去查那个地方」是两回事。** 我查了插件的 8 个库
   就断言证据从未被采集，而它就在插件每轮都要读的 `session.events` 里。
   下结论前先问：**我查的范围，是不是就是数据应该在的范围？**
2. **门禁判据失效时，先查判据的每一半是否还成立。** 我接受了「比率显著」
   这一半，只去补另一半——而前一半的样本 99% 已被自己的 v9 修复作废。
3. **把不可信输入放到指标的判定位上，是一种沉默的失效。** 合并方案会让
   `RECALL_NO_MATCH` 的前缀被模型控制，而锁常量措辞的测试照样全绿。
   这是「测试全绿 ≠ 产品有效」的第五次实例。
4. **调研要读源码，不读 README。** 三个项目里只有一个真正可比，另两个的
   核心逻辑或在服务端、或根本没有对应层——如果只看文档描述，会误以为
   三个都能借鉴。
