---
description: 编译并运行当前任务相关的单元测试，输出结果并分析失败原因
agent: build
---

## 🧪 单元测试执行

### 第一步：定位测试目标
1. 读取 `docs/task-status.json`。
2. 如果用户指定了任务 ID，优先使用用户指定的。
3. 如果未指定，找到当前 `in_progress` 的任务；无则找最近 `done` 的任务。
4. 如果没有找到任务，列出当前阶段所有任务及其 `test_file`。
5. 如果任务的 `test_file` 为 `null` 且用户未指定路径：
   - 输出："该任务尚未配置测试文件。"并列出该阶段已有 test_file 的任务供选择。

### 第二步：运行检查与测试
1. 类型检查：根 scripts 已建立则 `pnpm typecheck`，否则 `pnpm exec tsc --noEmit`
2. Lint：`pnpm lint`（或 `pnpm exec biome check .`）
3. 全量单元测试：
   ```bash
   pnpm test
   ```
   等价于 `pnpm vitest run`（Vitest 3.x）。
4. 如果用户指定了测试文件/目录，传入路径参数：
   ```bash
   pnpm vitest run [测试文件路径]
   ```

### 第三步：结果分析
1. **成功**：
   - 输出通过数量（X passed / Y total）。
   - 对照该任务的约束 notes 做覆盖对照（关键接口/schema 是否有断言）。
2. **失败**：
   - 解析失败堆栈，定位失败测试方法。
   - 引用相关文档约束原文，判定是业务代码逻辑错误还是测试本身过时（R11：不许改断言凑绿）。
   - 提出修复建议（不自动修改代码，除非用户明确要求）。

### 第四步：后续操作
1. 测试通过后输出 ✅ 标记与统计。
2. 提示：可执行 `/commit-agora` 提交推送（推送成功后标 done）；如为出口集成测试做准备，提示 `/test-phase-agora`。
