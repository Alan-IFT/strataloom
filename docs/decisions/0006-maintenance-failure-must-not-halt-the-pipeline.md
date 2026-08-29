# 0006 · 维护失败不得停掉任务流水线——而「逐步防护」只会更糟

- 日期：2026-08-29
- 状态：已采纳
- 相关：§5.2（调度）、§9（可观测性）、§10（busy 重试）、`src/pipeline/runner.ts`、`src/store/tx.ts`、[`0004`](0004-l3-rebuild-trigger.md)

## 背景

`JobRunner.run()` 给每个库一次 tick，而这个 tick 把两件互不相干的事放进了**同一个**
`try` 块：周期性维护（`maintain`）与租约任务的认领/执行。

```ts
try {
  if (doCleanup) maintain(this.ctx, store, now)
  if (peekClaimable(store, now) === undefined) continue
  ...
  await this.runJob(store, job)
} catch (error) { this.ctx.logger.warn(...) }
```

实测：让 `collectMetrics` 抛异常（`DROP TABLE usage`），同库一个 pending 的
`extract` job 的 `attempts` 停在 **0**。一个周期性杂务坏掉，该库当轮跑了**零个**任务。

## 决定

拆成两个 `try` 块，外加一行的单独防护，再加一个**只针对 BUSY** 的跳过。

1. **维护与认领分开防护。** 维护失败只 `warn`，tick 继续去认领并执行任务。
   流水线不再是杂务的连带受害者。
2. **`maintain` 内部给 metrics 那一行加 try。** 纯观测不得有能力停掉它所观测的系统。
3. **维护若因 BUSY 而失败，则本轮跳过该库的认领。**（见下节 B1；这是审查打回后补上的。）

`maintain` 的内部**未动**：同样的五步、同样的顺序、同样的全有或全无语义。它仍然在
第一次抛出时中止，且只记日志。最后这点看着像遗漏，其实不是。

## 被否决的方案，以及否决它的算术

> 「顺手把每个维护步骤都包上 try，免得一步失败跳过其余几步。」

这是最直觉的下一步，而它**严格更差**。这里连算术一起记下来，因为没有数字它一定会被
重新提出。

### 真正的触发条件是 SQLITE_BUSY，不是坏数据

`DROP TABLE usage` 是复现装置，不是线上故障。两个 harness 进程指向同一仓库是
**常态**——本仓库自己就断言了这一点（`resilience.test.mjs` 的
「concurrent processes can open the same store and all their writes land」）。
线上真正打到 `maintain` 的是 `SQLITE_BUSY`，且它打击的是**写**步骤：`cleanupJobs`、
`pruneConversations`、以及 decay 的 `enqueueJob`。读步骤在别的进程持写锁时**正常返回**
（已实测）。

### `Atomics.wait` 让一次 busy 重试变成同步冻结

`tx.ts` 用 `sleepSync` 重试 busy 事务，而 `sleepSync` 就是 `Atomics.wait`。整个 store
层是同步的（因为 `DatabaseSync` 是同步的），所以一次 busy 重试**不让出事件循环**——
它**冻结整个进程**。

于是单个写步骤耗尽预算的代价是：

```
BUSY_TIMEOUT_MS (2000) × (IMMEDIATE_TX_RETRIES (3) + 1) = 8 秒
```

### 8 秒 对 24 秒

- **现状（首个抛出即中止）**：整轮撞一次争用，冻结约 8s，放弃，记日志。每 tick 一份预算。
- **逐步防护**：三个写步骤各自撞上同样的争用、各付一份预算——约 **24s** 的事件循环冻结。

实测方式是在一个持有真实跨进程写锁的测试里还原该修复：**8426 ms → 25530 ms**。
那个「更健壮」的版本是 3 倍冻结。（复审独立复现为 25401 ms，与此吻合。）

所以**全有或全无在争用下恰恰是提前退出**——是特性，不是缺口。锁还被别人握着，第二、
第三步只会更慢地再输一次同样的竞争。退出并等下一个间隔重试才是正确反应，而维护间隔
就是那个重试节流器。

`test/resilience.test.mjs` 现在断言持锁时一次 tick 的墙钟量级
（`< 2 × BUSY_TIMEOUT_MS × (IMMEDIATE_TX_RETRIES + 1)`），好让「顺手也把其它步骤保护
一下」大声失败，而不是把一个没人测量的冻结翻三倍。

## B1：正确的论证少扫了一步，而那一步在 try 块外面

本 ADR 最有价值的部分是这条：上面那套算术**本身没有错**，它只是**没有扫到
`claimNextJob`**。

`claimNextJob`（`jobs.ts`）走 `store.tx()` → `immediateTx`，**它自己就是一个写事务，
拥有一份完整的 busy 重试预算**。而它位于 `maintain` 之外，所以「逐步防护」的清点
（cleanupJobs / pruneConversations / enqueueJob 三个写步骤）从一开始就没把它算进去。

拆 try 块之前：`maintain` 抛出 → 整个认领块被跳过 → 只花一次 8s 预算。
拆 try 块之后：维护失败被吞掉 → 控制流**必然**走到 `claimNextJob` → 在同一把仍被别人
握着的锁上**再输一次同样的竞争，再冻 8s**。

实测（真实 `StoreRegistry` + 同款跨进程锁，且预置一个可认领的 job）：

```
16936 ms = 2.12 × 单次预算(8000ms)
job attempts = 0        ← 付出双倍冻结，任务依然没被认领
```

这正违反本 ADR 自己立下的规则——「锁还被别人握着，第二、三步只会更慢地再输一次同样的
竞争」。`claimNextJob` 就是那个「第二步」，只是它站在 try 块外面，所以逐行审查名单时
被漏掉了。**教训：清点「还有几份 busy 预算会被花掉」时，边界不是 try 块，而是控制流
在这一 tick 里还会碰到多少个写事务。**

### 修法

```ts
} catch (error) {
  this.ctx.logger.warn(`strataloom: maintenance failed for store ${store.repoKey}:`, error)
  if (isBusy(error)) continue
}
```

要点有两个：

- **判据是复用而非新写。** `isBusy` 原本是 `tx.ts` 的模块私有函数，现改为导出。全仓
  只此一处 BUSY 识别逻辑（`errcode & 0xff === 5`，覆盖 261/517 等扩展码），认领跳过
  与重试循环因此必然对同一个错误给出同一个答案。另写一套判据就会是同一规则的第二处
  实现，而这正是本项目栽过三次的坑（D7–D9）。
- **只跳过 BUSY，绝不扩大。** BUSY 是唯一「已经证明了下一步必然失败且昂贵」的失败：
  它证明锁在别人手里。坏数据/投毒导致的维护失败**不持有任何锁**，认领照常进行——
  拆 try 块要打断的正是这条连坐，它必须保持被打断。

修后同一测试：**8434 ms**，仍在一份预算内。

## metrics 那一行为何仍然豁免

`collectMetrics` 的防护不是「逐步防护的迷你版」；它是另一个类别，且恰恰在逐步防护昂贵
的地方它是免费的：

- 它是**读**，而读在打垮这一轮的那种争用下正常返回。这个 catch 从不吞掉 busy 错误，也
  从不花掉 busy 重试预算。**零冻结代价。**
- 它**不改动任何状态**。其余每一步都在改库，那里失败意味着维护确实没做成、必须被看见；
  而这一行只是把数字交给 logger——为它中止整轮，是拿真实维护换一行日志。

**它真正能救的面有多大，是逐表实测出来的，不是假设的**：

| DROP 的表 | collectMetrics | 后续四步 | 本防护的作用 |
|---|---|---|---|
| `usage` | 抛→被吞 | **全部成功** | 真正**吸收**，整轮维护被救回 |
| `conversations` | 抛→被吞 | `pruneConversations` 抛 | 只是把抛出推迟一步 |
| `memories` | 抛→被吞 | `enqueueRebuildIfOverflowing` 抛 | 只是把抛出推迟一步 |
| `jobs` | 抛→被吞 | `cleanupJobs` 抛 | 只是把抛出推迟一步 |

即：**`usage` 是唯一只被观测读取、而任何维护写步骤都不碰的表**，所以对坏数据而言，这道
防护「救回整轮维护」只在这一张表上成立。因此不要把它写成「覆盖投毒或畸形数据」——那说得
过宽。另一条理由是 **logger exporter 抛异常**：exporter 由部署注入、活在本仓库之外、
从这里无法审计——这恰恰是它不该被托付一票否决权的理由，且这条路径**与哪张表无关**。

**但这条理由的适用面同样要说清楚**（QA 实测指出）：该 try 只包住 exporter 的 `info`
调用，紧随其后的 `warn` 在它之外——所以一个**每条通道都抛**的 exporter 依然会中止整轮
维护。要堵死它就得把 runner 里每一处日志调用都包起来，为一个从未被报告过的故障模式增加
一圈机制，不划算。**故此处记录为已知边界，而不是假装已经覆盖**——这与本 ADR 其余部分
一样：宁可把限制写明，也不留给读者去假设。该缺口在本次改动前后**行为完全相同**，属既有
问题，不是本次引入。

原则本身不变，也不该删：规则不是「便宜的东西就加防护」，而是**观测不得停掉被观测的系统**。

## 一并否决

### 每库各自的 `lastCleanup` 时间戳

`lastCleanup` 是 runner 级的单一字段，所以维护失败的库要等下一个全局间隔才重试。改成
每库一份的方案考虑过并放弃：

- **放内存**——重启即丢，而重启正是这个信息唯一值钱的时刻。
- **放 `meta`**——自相矛盾。要记录的失败本身就是锁争用下的*写*失败，记录它却需要那个
  刚刚失败的写。一条在关键时刻写不进去的记账行比没有更糟：它恰好在它存在的理由出现时
  静默缺席。

当前行为是诚实的：没维护成的库，在下一个间隔像其它库一样被维护。

### 持久化的「维护失败」记录

不加列、不加表。一轮维护失败的**后果**已经能从既有数据里查出来：

- decay job 的 id 内嵌日期（`jobId('decay', repoKey, YYYY-MM-DD)`），某天没有这一行
  就是那天维护没做完；
- `collectMetrics` 的 `pendingJobs` 与 `oldestPendingJobAgeMs` 在 cleanup 停摆时会向上漂移。

专设一列会是**同一事实的第二处实现**，而本项目已被「一条规则写在两处」咬过三次
（D7–D9）。日志说出失败，库里显示后果。

## 连带改动

`DECAY_INTERVAL_MS` 在同一轮里被删除。`src/` 与 `test/` 从来没有读过它：decay 的每日
一次由幂等键 `jobId('decay', repoKey, <日期>)` 实现，而不是拿它与某个间隔比较。它是
一个陈述着「由别处实现的规则」的常量——同样的「一条规则、两个地方」隐患，只是还没发作。

## 验证

`test/resilience.test.mjs` 中的四条测试，每条都先还原它对应的那个修复、确认变红之后
才被信任：

| 测试 | 还原的修复 | 证伪结果 |
|---|---|---|
| 维护失败不连坐流水线 | 合回一个 try 块 | 失败（`attempts` 为 0，非 1） |
| 观测不能停掉被观测系统 | 拆掉 `collectMetrics` 的 try | 失败（cleanup 与 decay 入队都没发生） |
| 争用只花一次 busy 预算（无可认领 job） | 加逐步 try/catch | 失败（25530 ms vs 8000 ms 预算） |
| 争用只花一次 busy 预算（**有**可认领 job） | 去掉 `if (isBusy(error)) continue` | 失败（16936 ms，且 `attempts` 仍为 0） |

四条都经真实 `tick()` 驱动。`maintain` 保持不导出——`lastCleanup` 从 0 起步，故首个 tick
必是维护 tick，既有测试本来就是这样触达它的。

### 为什么需要第四条（第三条测不到 B1）

第三条显式断言 `count(*) FROM jobs == 0`（注释写明「nothing claimable, so the
measurement is maintenance alone」）。它**故意**把认领排除在测量之外，于是它测的是
`maintain` 独自的墙钟——B1 恰好发生在被排除的那一段里，所以它对 B1 天然免疫。第四条
用同款锁、但预置一个 pending job，阈值同为 `2 × 单次预算`。**一条把某段控制流排除在
测量外的性能测试，就是那段控制流的盲区**；这与 B1 的成因（论证少扫了 try 块外的一步）
是同一个错误的两个面。

墙钟断言在此是可靠的：被测的是 `Atomics.wait` 的定时器时长，不是 CPU 工作量。第三条
连跑 5 次为 8576/8512/8557/8554/8578 ms，阈值 16000 ms，余量 1.87 倍，波动 ±0.4%。

### 测试一的规格为何从 `DROP TABLE usage` 改为 `DROP TABLE conversations`

「维护失败不连坐流水线」最初用 `DROP TABLE usage` 制造维护失败。加入 metrics 防护
（决定 2）之后这个破坏方式**失效**了：如上表所示，`usage` 是唯一被该防护完整吸收的表，
`maintain` 于是根本不再抛出，测试就算不拆 try 块也会变绿——它测不到自己声称要测的东西。

改用 `DROP TABLE conversations`：破坏点落在一个**写**步骤（`pruneConversations`）上，
无论 metrics 那行怎么防护，`maintain` 都会抛出。这也更贴近真实触发形态——SQLITE_BUSY
打击的正是写步骤。两个破坏装置因此各自隔离**一个**修复，互不遮蔽：

- `breakMaintenanceWrite`（`DROP TABLE conversations`）→ 只检验「维护/认领拆分」；
- `breakMetrics`（`DROP TABLE usage`）→ 只检验「观测不停掉被观测系统」。
