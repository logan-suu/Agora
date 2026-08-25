---
description: 当前 Phase 的集成测试 — 生成、审查完整性、补全缺口、运行回归
agent: build
---

## 🔗 Phase 集成测试（当前阶段专用）

此命令只关注**当前 Phase** 的跨包集成测试。累进全量回归请用 `/test-integration-agora`。

### 第一步：定位当前 Phase
1. 读取 `docs/task-status.json`，获取 `current_phase` 与该 phase 的 `exit_criteria`。
2. 找到该 phase 的 `integration_test` 任务 ID（如 `0.7`）。

### 第二步：检查集成测试目录
3. 检查 `tests/integration/phase{current_phase}/` 目录是否存在。
4. 目录**不存在**：创建目录，跳到第五步（生成集成测试）。
5. 目录**已存在**：列出所有 `.test.ts` 文件，进入第三步（审查完整性）。

### 第三步：审查现有测试完整性
6. 读取 task-status.json 中当前 Phase 所有已完成任务的 `notes`，了解模块职责与关键 API。
7. 列出当前 Phase 所有**跨包交互链路**（基于各包 public API 与任务依赖关系）。
8. 对比现有测试覆盖的链路，标记缺失项。

### 第四步：补全缺口
9. 对每个缺失链路编写新测试或扩展现有文件。优先级：
   - **P0**：核心编排链路（orchestrator → coordinator → HarnessExecutor → SandboxManager → applyMutations 写回）
   - **P1**：MCP server / 沙箱实现 / 投影管线
   - **P2**：类型/契约验证（State schema round-trip、Mutation op 交换律与幂等性）
10. **失败处理红线（R11）**：
    - ❌ 禁止弱化断言或 mock 绕过真实代码让测试变绿
    - ✅ 分析根因：业务代码 bug→修代码；测试逻辑有误→修测试；环境限制→显式 `.skip(reason)` 并记录
11. 真实依赖优先：真实文件系统（LocalTempSandbox）、真实子进程 spawn。mock 必须在文件头注明原因。

### 第五步：生成集成测试（目录不存在时）
12. 遍历当前 Phase 已完成任务，提取跨包交互。
13. 按 P0→P1→P2 生成测试文件，命名 `phase{N}-{name}.test.ts`。

### 第六步：运行当前 Phase 测试
14. 类型检查 + Lint：`pnpm typecheck && pnpm lint`
15. 当前 Phase 集成测试：`pnpm vitest run tests/integration/phase{current_phase}/`
16. 输出报告：
    ```
    ## 🔗 Phase {N} 集成测试
    | 指标 | 结果 |
    | --- | --- |
    | Phase {N} 集成测试 | X pass / Y fail |
    | 类型检查 | ✅/❌ |
    | Lint | ✅/❌ |
    | 跨包链路覆盖 | X/Y (P0: a/n, P1: b/m, P2: c/k) |
    ```

### 第七步：更新任务状态与收尾
17. 更新 integration_test 任务状态 → `in_progress`，notes 记录测试文件清单与数量。
18. 后续操作：
    - **全部通过且 exit_criteria 全满足** → `/commit-agora` 创建 PR；合并后经 `/pr-merge-agora` 收尾（整 phase 置 done、`current_phase` 递增）
    - **部分失败** → 分析根因修复后重跑
    - **覆盖不足** → 列出缺失链路继续补全
