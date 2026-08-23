# 0001 · `.repo_memory/` 是纯输出投影，Personal 永不投影

- 日期：2026-08-23
- 状态：已采纳
- 相关：`src/projection.ts`、D1、[`design/4x4-memory.md`](../design/4x4-memory.md) §2

## 背景

原始 4×4 设计写明：「Personal Memory 和 Procedure Memory 保存在当前仓库的
`.repo_memory/` 下」。当前实现与之不同——`.repo_memory/` 只写经人工审批的
`team-shareable` 条目，且代码显式拒绝投影 personal（`personal memories are
never projected`）。二者不可兼得，需定夺。

## 决定

维持实现：`.repo_memory/` 是**纯输出投影**（删了重写、从不读回），
Personal 留在 `~/.dsh/strataloom/global.sqlite`。

## 理由

1. **隐私**：个人偏好是语气、语言、解释深度——把它提交进团队仓库，等于把
   个人工作习惯公开到代码评审里。这不是共享，是泄露。
2. **信任边界**：投影文件人人可编辑、可提交。若它能被**读回**成为记忆输入，
   任何能改仓库的人就能给 Agent 植入记忆——这正是 D1 要挡的事。保持"只写
   不读"，该攻击面根本不存在，而不是靠校验去防。
3. **少即是多**：若要按原设计把它当存储，就得新增一套「文件可被外部编辑后
   读回」的信任与冲突协议。删掉这个需求比实现它便宜得多。

## 代价（如实记录）

- 换机器时个人偏好不随仓库走，需另行同步 `~/.dsh/strataloom/`。
- 团队无法通过仓库看到彼此的协作偏好——**这是有意的**。

## 替代方案

- *按原设计存入 `.repo_memory/`*：被隐私与信任边界两条否决。
- *Procedure 存文件、Personal 存本地*：Procedure 已可经审批投影，
  已覆盖「随仓库携带」的需求，无需改变存储归属。
