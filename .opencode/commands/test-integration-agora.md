---
description: 累进全量集成测试 — Phase 0→N 全部集成测试 + 跨 Phase 联调 + 单元测试全量回归
agent: build
---

## 🌐 累进全量集成测试

此命令运行**从 Phase 0 到当前 Phase** 的全部测试，包括跨 Phase 联调。当前 Phase 专项测试请用 `/test-phase-agora`。

### 第一步：定位范围
1. 读取 `docs/task-status.json`，获取 `current_phase`。
2. 确定测试范围：Phase 0 至 Phase {current_phase} 的所有集成测试。

### 第二步：检查跨 Phase 联调测试
3. 检查 `tests/integration/cross-phase/` 目录。
4. 如果目录**不存在**或为空：创建目录，基于各 Phase 之间的数据流依赖生成跨 Phase 联调测试。典型场景：
   - Phase 0 的 State/reducer 产出能否被 Phase 2 的角色投影正确切片消费
   - Phase 1 的 MCP fs/test server 能否驱动 Phase 0 的验证任务闭环
   - Phase 3 的 decisionLedger 能否被 Phase 8 的 classifyObjection 正确分类
   - Phase 4 的 complexity.tier 能否被 Coordinator 路由正确消费
   - Phase 6 的 Channel 冒泡结论能否写回 main 群并进投影切片
5. 目录**已存在**：审查覆盖是否反映当前各 Phase 间的关键数据流。

### 第三步：运行全部测试
6. 对 N = 0..current_phase，逐个运行：
   ```bash
   pnpm vitest run tests/integration/phase{N}/
   ```
7. 跨 Phase 联调测试：
   ```bash
   pnpm vitest run tests/integration/cross-phase/
   ```
8. 全部单元测试：
   ```bash
   pnpm test
   ```

### 第四步：质量门禁
9. 类型检查：`pnpm typecheck`
10. Lint：`pnpm lint`

### 第五步：累积回归报告
11. 汇总输出：
    ```
    ## 🌐 累进全量测试报告（Phase 0→{N}）
    | 层级 | 测试数 | 通过 | 失败 | 状态 |
    | --- | --- | --- | --- | --- |
    | 单元测试 (packages/) | X | X | Y | ✅/❌ |
    | Phase 0 集成 | A | A | 0 | ✅/❌ |
    | ... | ... | ... | ... | ... |
    | 跨 Phase 联调 | C | C | 0 | ✅/❌ |
    | **合计** | **Z** | **Z** | **F** | |
    ```

### 第六步：失败处理
12. 任一失败按红线 R11 处理：定位根因——业务回归则修复代码、测试过期则更新测试；**禁止跳过或弱化断言让绿灯通过**。修复后重跑本流程直到全绿。
