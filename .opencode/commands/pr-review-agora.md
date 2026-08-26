---
description: 对当前 PR 做架构预审（红线/常驻决策/投影纪律）+ 逐条处理 PR 评论，输出风险清单与合并建议
agent: build
---

## 🔍 PR 架构预审

请按 Agora 项目 `AGENTS.md` 的质量门禁 G1-G7 与红线 R1-R13 对当前 PR 进行审查：

### 第一步：获取变更
1. 确定 PR 编号（用户提供，或 `gh pr view --json number,url` 从当前分支自动检测）。
2. 获取变更：`gh pr diff {编号}` 或本地 `git diff dev-1.0.0...HEAD`。
3. 仅审查新增/修改的源码与文档；忽略纯数据/资源文件。

### 第二步：架构合规检查（核心清单，逐条扫描）
1. **红线检查（R1-R13）——Agora 特有重点关注**：
   - R1：共享 State 写入是否全部走 `applyMutations()`？Mutation op 是否可交换、幂等？
   - R2：**投影是否泄漏了原始群聊 log？** display/payload 是否分离？（本项目头号死穴）
   - R4：是否存在硬杀 LLM token 流的代码？抢占是否落在安全点（step/end）？
   - R5：阶段 0–9 是否混入厚执行器切换逻辑？
   - R6：KB 是否被写入？sliceKB 是否返回空对象？
   - R7/R8：沙箱外是否有文件操作/child_process？L1 domain 是否引入 I/O？分层方向是否反向？
   - R9：Executor/SandboxManager/MessageBus 等接口签名是否被修改？
   - R10：目录与命名是否对齐 L1-L4 映射？字段 camelCase？角色字面量联合？
   - R11：断言是否真实？mock 是否注明原因？
   - R12：相关文档是否已同步？
   - R13：commit 信息英文祈使句？无 secrets？
2. **常驻决策对照（D1-D5/C4/FE/WO）**：
   - D1：上下文注入是覆写还是追加？（必须覆写）
   - D4：humanGate 是终止并分叉还是动态挂起？
   - D5：阶段 0 是否引入了 Docker/Git 强依赖？
   - FE：是否出现 WebSocket？
3. **分层与复用**：L2 编排是否只调 L3 端口接口？是否重复自研 Harness 已有能力（事件溯源/单 agent 压缩/inbox steering）？
4. **EPCC-V 痕迹**：是否有计划确认记录？测试是否先于实现？

### 第三步：规格一致性验证
1. 对照该任务 `documents_required` 中的约束原文（接口签名/schema/伪代码）逐项核对实现。
2. 对照所属 phase 的 `exit_criteria` 检查完成度。
3. （建立 CI 后）检查 CI 状态。

### 第四步：输出审查报告
每条问题包含：
- **风险等级**：🔴 严重（违反红线/G1-G7）/ 🟡 警告 / ✅ 合规
- **问题描述**：具体违反了哪条规约
- **文件位置**：`文件名:行号`
- **修改建议**：具体的代码修改示例
- **关联规约**：引用 AGENTS.md 章节/常驻决策 ID

### 第五步：审查结论
- **存在 🔴** → "❌ 审查未通过，禁止合并。"回到 `/do-task-agora` 修复后重审。
- **仅 🟡** → "⚠️ 发现 N 条警告，优先在当前 PR 中修复；确需延期的按第五步之半留档。"
- **全部 ✅** → "✅ 审查通过，建议合并。"

### 第五步之半：延期项留档（强制执行）
> 先判断能否立刻修，能修的当场修；真有必要延期的才留档。

1. **判定是否必须延期**（满足任一才可延期）：依赖未到位的接口 / 跨 Phase 协调的变更 / 改动过大超出本 PR 合理范围。
2. **无需延期** → 当前 PR 内立即修复（commit + push），重新跑门禁，无需留档。
3. **必须延期** → 统一写入 `docs/deferred-items.json`（常驻决策 DEF，唯一延期项台账，格式对齐 iTestAgent）。按序取下一个 `DEF-NNN` 编号，条目字段：
   ```
   id/source/pr/pr_url/comment_id/comment_url/task/severity/item/detail/target_phase/status/resolved_by/created_at/notes/resolved_at
   ```
   `status` 取值：`open`（待处理）/ `resolved`（已解决）。同步更新该文件顶层 `last_updated`。任务 notes 不再内嵌 `[DEF]`，仅可加一行指向 `docs/deferred-items.json` 的引用。输出确认："✅ N 条延期项已留档至 docs/deferred-items.json；M 条已在当前 PR 修复。"
4. 后续若修复了某条目：在 `deferred-items.json` 中把该条 `status` 置 `resolved`、补 `resolved_by` 与 `resolved_at`（保留审计轨迹），**不删除原条目**。

### 第六步：处理 PR 中的评论（人工 reviewer / AI 审查机器人）

> 核心原则：**先读实际代码验证，再决定是否采纳。** 机器人的发现可能是误报、过时代码引用或正则巧合。

**决策流程（每条评论依次判定）**：
```
评论 → 读取指向的实际代码 → 逐条评估是否合理？
  ├─ 不合理（误报/噪声/代码已变更）→ 输出评估依据 → hide 或回复说明后 resolve
  └─ 合理 → 是否必须延期？
       ├─ 否 → 立刻修复 → 门禁验证 → push → 英文回复 → resolve conversation
       └─ 是 → 回复 "Deferred — tracked in docs/deferred-items.json (target_phase: N)" + 按第五步之半写入 deferred-items.json + resolve
```

1. 获取评论：`gh pr view {编号} --json comments,reviews`
2. **逐条合理性评估表（修复前强制输出）**：
   ```markdown
   ## 📋 评论逐条评估
   | # | 评论摘要 | 代码验证 | 合理性 | 依据 | 处理决策 |
   |---|---------|---------|--------|------|---------|
   | 1 | xxx | ✅ 问题存在/❌ 误报 | ✅/❌ | 引用红线/决策/exit_criteria 原文 | 修复/延期/忽略 |
   ```
3. **不合理评论的 hide**（需 GraphQL node ID，非 databaseId）：
   - 查询 node ID → `minimizeComment(input: {subjectId, classifier})`
   - classifier 选择：`OUTDATED`（代码已变）/ `RESOLVED`（已正确处理）/ `DUPLICATE` / `OFF_TOPIC`
   - 权限不足时改为回复不采纳理由并 resolve
4. 所有回复使用**英文**（外部可见语言规范）。
5. 输出评论处理报告表（来源/摘要/判断/处理方式）。

### 第七步：阶段出口延期检查（防遗忘）
1. 若当前任务是某 phase 的 `integration_test` 任务：扫描 `docs/deferred-items.json` 中 `target_phase` 属于该阶段且 `status: open` 的条目，逐条检查是否已被顺手解决；已解决的按第五步之半标记 `resolved`。
2. 启动新阶段时（`/next-task-agora`）：提醒 `deferred-items.json` 中尚存的 open 条目。

### 第八步：结论后续
- **通过** → 提示人类合并 PR → 合并后执行 `/pr-merge-agora {编号}` 收尾。
- **未通过** → 修复 🔴/🟡 → 重跑门禁 → push → 重新预审直到通过。
