---
description: 执行指定的任务 ID（如 0.4），按 EPCC-V 流程完成开发
agent: build
---

## 🎯 执行指定任务

请按 Agora 项目 `AGENTS.md` 的 EPCC-V 流程执行。

### 第一步：定位目标任务
1. 读取 `docs/task-status.json`。
2. **如果用户指定了任务 ID**（如 `do-task-agora 0.4`），锁定该任务。
3. **如果用户未指定**：
   - 输出："请指定要执行的任务 ID，如 `do-task-agora 2.3`。"
   - 列出当前阶段所有 `ready` 和 `pending` 状态的任务。
4. **验证任务状态**：
   - 如果任务状态为 `done`，输出："该任务已完成，无需重复执行。"
   - 如果任务状态为 `in_progress`，输出："该任务正在进行中，是否要继续？（也可用 /retry-task-agora 从中断点恢复）"
   - 如果任务状态为 `blocked`，输出 notes 中的阻塞原因与解除条件，不执行。
5. **检查依赖**：
   - 确认该任务的所有 `dependencies` 均已标记为 `done`。
   - 如果有未完成的依赖，列出并提示："请先完成依赖任务后再执行。"
6. **级联更新**：将所有依赖已满足的 `pending` 任务翻转为 `ready`。
7. 将任务状态更新为 `in_progress`。

### 第二步：Explore — 查阅文档并引用原文
1. 读取任务 `documents_required` 中的文档章节。
2. 在回复中**逐字粘贴**关键约束原文（接口签名/schema 定义/决策规则）。
3. 对照 `standing_decisions` 筛出本任务相关的 D-x 条目并逐条列出。
4. 如果发现文档问题（矛盾、模糊、不可测），**必须暂停**并先解决（R12）。

### 第三步：Plan — 出计划等确认
5. 输出实现计划（改哪些文件/接口/schema/测试）。
6. **等待用户确认**。未经确认不进入编码。

### 第四步：Code + Check — 小步实现
7. 用户确认后开始编码。遵循红线：
   - 共享 State 写入只走 `applyMutations()` 合并函数（R1）
   - 永不投原始群聊 log，上下文只经投影切片（R2）
   - 不做 agent 自动共识（R3）；安全点外不打断 LLM（R4）
   - 阶段 0-9 只用薄执行器（R5）；KB 只读（R6）
   - 目录与命名对齐 R10；接口签名不改只改实现体（R9）
8. TDD 循环：写测试 → `pnpm test`（红）→ 写实现 → `pnpm test`（绿）。
9. 运行 `pnpm typecheck && pnpm lint`。

### 第五步：Verify — 验证与交付
10. 逐条对照该阶段 `exit_criteria` 与任务约束自检。
11. 执行链路能力真实跑通（G5）：沙箱/Harness/工具能力不以 mock 规避。
12. 如涉及重大技术决策变更，更新蓝图 §21 并打 `[YYYY-MM-DD 架构决策更新]` 标记（R12）。
13. 完成后提示用户执行 `/commit-agora` 创建 PR 到 dev-1.0.0（任务保持 `in_progress`）；PR 合并后由 `/pr-merge-agora` 标记 `done` 并更新 notes。
