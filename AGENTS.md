# AGENTS.md — Agora 项目宪法

> 本文件是所有 AI 会话与自定义命令的最高规约。任何实现与本文件冲突时，以本文件及其引用的设计文档为准。

## 1. 项目定位

**Agora** 是群聊式多 Agent 代码协作系统：人类以 Leader 身份在群聊中指挥一组各司其职的 AI Agent（Coordinator/PM/Architect/Coder/Tester/Reviewer）完成编码任务。五大支柱：

1. 一切皆群聊（单一 Channel 原语，leader 恒为成员）
2. Leader 唯一裁决（不做 agent 自动共识）
3. 角色投影（agent 只读结构化切片，永不投原始群聊 log）
4. 配合式抢占（安全点 = step/end，绝不硬杀 LLM）
5. 薄执行器 + 自研轻编排（单 agent 内核 = DeepSeek Harness，编排仅 4 个通用节点）

技术栈锁定：纯 TypeScript 5.9+ / Node.js 20 LTS / pnpm 9 workspaces / Vitest 3.x / Biome 2.x / MCP SDK v1（1.30.0）/ Next.js 15 + React 19（Phase 5 起）。完整版本见 `docs/技术选型文档.md` §12。

## 2. 文档地图（规格唯一来源）

| 文档 | 角色 |
| --- | --- |
| `docs/项目蓝图.md` | 唯一主文档：定位/架构/分阶段路线/§21 已定决策定稿 |
| `docs/详细设计方案.md` | 落码规格：State schema/角色 prompt/编排/抢占/通信/执行器/投影/多租户 |
| `docs/系统架构设计文档.md` | L1-L4 分层/Monorepo 映射/关键路径/韧性表/部署视图 |
| `docs/技术选型文档.md` | 选型定稿、版本锁定、备选方案排除记录 |
| `docs/开发计划安排.md` | Phase 0-10 任务分解与时间估算 |
| `docs/框架调研与借鉴决策.md` | AutoGen/AgentScope 源码级调研快照与 8 个借鉴模式 |
| `docs/task-status.json` | **进度追踪核心**：11 phase / 60 任务 / 依赖图 / standing_decisions——每个任务开工前必读 |

## 3. 常驻决策（违反即打回）

以下决策已定稿，任何任务实现前先对照（详见 `docs/task-status.json` 的 `standing_decisions` 字段与来源章节）：

| ID | 决策 |
| --- | --- |
| D1 | `agent/pre-step` 直接覆写 messages 数组为 `project(state, role)` 返回值；deriveMessages() 仅事件流记录；compaction 压缩伪历史属预期行为 |
| D2 | 阶段 0–9 所有 Worker 强制薄执行器（Harness）；`external` 仅预留；厚 Agent 到阶段 10 |
| D3 | KnowledgeBase 写入全局禁用（Write-Block）；sliceKB 阶段 0 返回空对象；启用需双重门控（测试全绿 + `/approve-kb`） |
| D4 | humanGate = 终止并分叉：销毁 Harness 子进程 → safePoint 游标重新 Fork；不做 yieldSlot 动态挂起 |
| D5 | 阶段 0 沙箱 = LocalTempSandbox（fs.mkdtempSync + child_process.spawn）；dockerode/simple-git 为 optionalDependencies |
| C4 | Phase 0 三角色闭环：COORDINATOR → CODER → TESTER |
| FE | 实时通信 = SSE + HTTP POST，不引入 WebSocket |
| WO | 写所有权不变量：结构化切片只读投影，agent 只写自己私有区 |

## 4. 红线（R1-R13）

- **R1 共享 State 写入只走合并函数** `applyMutations()`（append/mergeById/set），op 必须可交换、幂等；禁止直接赋值共享 State。
- **R2 上下文只经投影切片**喂给 agent，永不投原始群聊 log；展示层（display）与 context 层（payload）严格分离。
- **R3 leader 唯一裁决**：不做 agent 之间自动共识/投票；blocking 异议必须升级 humanGate 由人拍板。
- **R4 配合式抢占只能在安全点**（step/end）打断，绝不硬杀 LLM token 流；humanGate 按 D4 终止并分叉。
- **R5 执行器锁定**：阶段 0–9 只允许薄 HarnessExecutor；不实现 external 切换逻辑。
- **R6 KB 只读**：阶段 0–N 禁写 KnowledgeBase，Librarian 仅空桩；不得引入向量检索依赖。
- **R7 沙箱纪律**：阶段 0 只用 LocalTempSandbox；文件操作限定沙箱目录内；run 默认超时 30s。
- **R8 分层依赖倒置**：L1 core/domain 禁止任何 I/O（fs/http/child_process）；L2 编排只能调用 L3 端口接口；业务代码内不直接 child_process（沙箱包内除外且经 MCP server 暴露）。
- **R9 接口先行**：Executor/SandboxManager/MessageBus 等接口签名从阶段 0 定稿，阶段退化只改实现体不改签名。
- **R10 目录与命名**：目录严格对齐 L1-L4 映射（core/{domain,orchestration,preemption} + runtime/{executor,sandbox} + comm/{bus,channels} + tools + roles + shared）；State 字段 camelCase；角色用字面量联合 `'COORDINATOR'|'PM'|'ARCHITECT'|'CODER'|'TESTER'|'REVIEWER'`。
- **R11 测试红线**：禁止弱化断言或 mock 绕过真实代码让测试变绿；必须分析根因（业务代码 bug→修代码；测试有误→修测试）；mock 必须在文件头注明原因；真实依赖优先。
- **R12 文档同步铁律**：有代码变更必须同步受影响文档（防规格漂移）；重大决策更新蓝图 §21 并打 `[YYYY-MM-DD 架构决策更新]` 标记；文档冲突作为 Issue 记录，不写入 task-status.json。
- **R13 提交纪律**：提交信息用英文一句话祈使句 + 可选 body 要点（对齐仓库既有风格）；严禁提交 secrets/.env/token。

## 5. 工作流：EPCC-V

新会话一律先执行 `/init-session-agora`。任务执行遵循五步：

1. **Explore** — 读任务的 `documents_required` 文档章节，回复中逐字粘贴关键约束/AC 原文；发现文档矛盾必须暂停先解决。
2. **Plan** — 输出实现计划（改哪些文件/接口/schema/测试），**等待用户确认后才编码**。
3. **Code + Check** — TDD 小步循环：写测试 → `pnpm test`（红）→ 写实现 → `pnpm test`（绿）；随后 `pnpm typecheck && pnpm lint`。
4. **Verify** — 对照任务出口标准逐条自检；执行链路能力必须真实跑通（G5）。
5. **交付** — 执行 `/commit-agora` 提交推送，成功后将任务标 `done`。

## 6. 质量门禁

| 门禁 | 内容 |
| --- | --- |
| G1 规格一致 | 实现与设计文档/常驻决策不冲突 |
| G3 静态检查 | `pnpm typecheck` + `pnpm lint` 0 错误 |
| G4 测试全绿 | `pnpm test` 全部通过（含既有回归） |
| G5 执行链路实测 | 沙箱/Harness/工具链能力必须真实跑通验证，不以 mock 规避 |
| G6 证据留档 | task-status.json notes 记录自检结论、关键发现与偏差 |
| G7 安全合规 | 无敏感数据落盘明文；agent 产出的代码只在沙箱内执行 |

> 根 package.json scripts（`typecheck`/`lint`/`test`）在任务 0.1 建立；此前以 `pnpm exec tsc --noEmit` / `pnpm exec biome check .` / `pnpm vitest run` 等价命令替代。

## 7. 快捷命令

`/init-session-agora` 新会话初始化 · `/status-agora` 状态速览 · `/next-task-agora` 下一个 ready 任务 · `/do-task-agora <id>` 指定任务 · `/retry-task-agora` 重试中断任务 · `/read-spec-agora` 规格速读 · `/explain-agora` 概念溯源解释 · `/sync-docs-agora` 决策同步文档 · `/commit-agora` 提交推送 · `/test-unit-agora` 单元测试 · `/test-phase-agora` 当前 Phase 集成测试 · `/test-integration-agora` 累进全量回归

## 8. 任务状态流转

- task：`pending` →（依赖全部 done 自动翻转）`ready` →（开工确认后）`in_progress` →（质量门禁全过 + 推送成功）`done`；阻塞置 `blocked` 并在 notes 写明解除条件。
- phase：出口集成测试任务 done 且 exit_criteria 全满足 → 整 phase 置 `done`，`current_phase` 递增。
- 每次状态变更同步更新 `last_updated`；notes 记录提交 hash、PR/链接、关键发现与延期项（延期项注明解除条件）。
