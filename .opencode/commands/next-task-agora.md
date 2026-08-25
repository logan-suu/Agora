---
description: 找到并执行下一个 ready 任务，按 EPCC-V 流程完成开发
agent: build
---

## 📋 任务：执行下一个 ready 任务

请严格按照 Agora 项目 `AGENTS.md` 的 EPCC-V 工作流执行：

### 前置检查：Git 状态
0. 执行 `git status --porcelain`，检查是否有未提交的变更。
   - 如果有未提交的变更，输出："检测到未提交的变更，请先处理（提交或暂存）。"

### 第一步：定位任务
1. 读取 `docs/task-status.json`。
2. **级联更新 pending → ready**：遍历所有阶段中 `status: "pending"` 的任务，若其 `dependencies` 全部为 `done`，则翻转为 `ready`（同步更新文件）。
3. 找到当前阶段中第一个 `status: "ready"` 的任务。
4. 如果找不到 ready 任务：
   - 输出："✅ 当前没有待执行的任务。"
   - 检查是否有 `in_progress` 的任务：如果有，询问是否继续该任务（可转 `/retry-task-agora`）。
   - 列出当前阶段的所有任务状态摘要。
5. 确认所有依赖已标记为 `done`。
6. 输出任务信息卡：
   ```
   找到下一个 ready 任务：
   - 任务 ID：[任务ID]
   - 标题：[任务标题]
   - 阶段：Phase X - [阶段名称]
   - 依赖状态：全部已完成 ✅
   - 相关常驻决策：[D-x ...]
   ```
7. **等待用户确认**："是否开始执行该任务？"

### 第二步：查阅文档（EPCC-V: Explore）
1. 读取任务 `documents_required` 中的文档章节。
2. 读取 `AGENTS.md` 中相关红线 R1-R13、常驻决策、命名约定（R10）、技术栈约束。
3. 在回复中**逐字粘贴**相关约束原文。

### 第三步：出计划等确认（EPCC-V: Plan）
4. 输出实现计划（改哪些文件/接口/schema/测试），等待用户确认。
5. **未经确认不进入编码**。

### 第四步：小步实现（EPCC-V: Code + Check）
6. 用户确认后，将任务状态更新为 `in_progress`。
7. 按 TDD 流程：
   - 编写测试用例
   - 运行 `pnpm test` 确认失败（红）
   - 编写实现代码
   - 运行 `pnpm test` 确认通过（绿）
8. 运行 `pnpm typecheck && pnpm lint`（根 scripts 未建立前用 `pnpm exec tsc --noEmit` / `pnpm exec biome check .`）。

### 第五步：验证与交付（EPCC-V: Verify）
9. 对照该阶段 `exit_criteria` 与任务 notes 中的约束逐条自检。
10. 涉及沙箱/Harness/工具链的能力必须真实跑通（G5），不以 mock 规避。
11. 如涉及重大架构决策变更，按 R12 更新蓝图 §21 并打 `[YYYY-MM-DD 架构决策更新]` 标记。
12. 完成后提示用户执行 `/commit-agora`：从 `dev-1.0.0` 切功能分支提交并创建 PR（任务保持 `in_progress`）；PR 合并到 dev 后由 `/pr-merge-agora` 标记 `done`。
