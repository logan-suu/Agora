# AGENTS.md — Agora 项目宪法

**版本**：v2.0
**生效日期**：2026-08-25
**适用对象**：所有参与 Agora 项目开发的 AI Agent（OpenCode / Codex / Cursor / Claude）及人类开发者
**优先级**：本规约优先于任何 Agent 的默认行为。当本规约与 Agent 默认行为冲突时，以本规约为准。
**任务追踪**：`docs/task-status.json` 记录全部任务执行状态、依赖关系与常驻决策（standing_decisions）
**决策记录**：蓝图为主要决策定稿处——重大架构决策集中于 §21「已定决策」，个别按章节落位（如 §16 实时通信 / §17 阶段路线），均带 `[YYYY-MM-DD 架构决策更新]` 标记。**真相源层级**：每条决策的完整定义以其来源文档章节为准；`docs/task-status.json` 的 `standing_decisions` 是唯一的摘要索引（ID / 一句话规则 / source 指针）；本文档只按 ID 引用。决策变更时必须经 `$agora-sync-docs` 一并更新，不得只改其一

---

## 0. 项目文档与快速索引

所有规格、架构、实现规范与计划均存放于 `docs/` 目录。Agent 在执行任何编码任务前，**必须**先查阅相关文档并引用原文。

### 0.1 文档目录

| 文档 | 文件路径 | 角色 |
|---|---|---|
| **项目蓝图** | `docs/项目蓝图.md` | 唯一主文档：定位/架构/分阶段路线/§21 已定决策定稿 |
| **详细设计方案** | `docs/详细设计方案.md` | 落码规格：§0 工程结构与 Harness 约定 / §1 State schema / §2 角色 / §3 编排 / §4 抢占 / §5 通信 / §6 执行器沙箱 / §7 投影 / §8 多租户与 KB / §9 阶段 0 切片 / §10 校验 |
| **系统架构设计文档** | `docs/系统架构设计文档.md` | L1-L4 分层 / Monorepo 映射 / 关键路径（§4）/ 一致性模型（§5）/ 韧性表（§6）/ 扩展点（§7）/ 权衡（§8）/ 部署（§9） |
| **技术选型文档** | `docs/技术选型文档.md` | 版本锁定（§12）/ 备选方案排除（§4）/ MCP 工具清单（§6）/ 沙箱（§7）/ SSE（§9）/ 持久化（§10）/ 决策记录（§13） |
| **开发计划安排** | `docs/开发计划安排.md` | Phase 0-10 任务分解 / 里程碑 M0-M10 / 风险 / 秋招 Demo 检查点（§17） |
| **框架调研与借鉴决策** | `docs/框架调研与借鉴决策.md` | AutoGen/AgentScope 源码级结论 / 8 个借鉴模式 / 借鉴-拒绝矩阵 |
| **任务状态** | `docs/task-status.json` | 11 phase / 60 任务 / 依赖图 / standing_decisions——每个任务开工前必读 |
| **延期项台账** | `docs/deferred-items.json` | 全阶段延期项统一台账（DEF-NNN，格式对齐 iTestAgent）；常驻决策 DEF 的唯一数据源，阶段出口检查时逐条核对 |

### 0.2 任务类型 → 文档快速索引（Agent 必读）

**使用方式**：收到任务后先判断类型，按下表确定要读的文档和章节，**只读取相关章节**而非整篇。

| 任务类型 | 应读取的文档 | 重点章节 |
|---|---|---|
| 初次启动/建立全局认知 | 本文件 + `task-status.json` + 蓝图 §21 | 全文阅读，建立决策与进度地图 |
| State/reducer/schema/合并函数 | 详细设计 §1 + 架构 §5 | Mutation 三 op 交换律幂等性 |
| 角色 prompt/RoleSpec/权限矩阵 | 详细设计 §2 | 六角色规格 + 工具白名单矩阵 |
| 编排主循环/coordinator 路由 | 详细设计 §3 + 蓝图 §9 | 4 通用节点 + 条件路由 + 反馈升级 |
| 复杂度 Tier/进度台账 | 详细设计 §3 + 框架调研 模式③ | Tier 0/1/2 + Ledger 双循环改造版 |
| worker 生命周期/配合式抢占 | 详细设计 §4 + 架构 §4.2 + 框架调研 模式⑦ | 安全点 = step/end；interrupt 语义 |
| Channel/消息总线/threadId/intent | 详细设计 §5 + 蓝图 §11 | 单一 Channel 原语 + leader 恒在不变量 |
| Executor/HarnessExecutor 接入 | 详细设计 §0/§6 + 选型 §4 + 框架调研 §1 | 四扩展点映射 + pre-step 覆写（决策 D1） |
| MCP 工具 server | 详细设计 §6 + 选型 §6 | fs/test/git/lint/sandbox 五类接口签名 |
| 沙箱（LocalTemp/Docker/worktree） | 详细设计 §6 + 选型 §7/§8 + 架构 §7.3 | SandboxManager 接口 + 决策 D5 |
| 投影/压缩/三铁律/sliceKB | 详细设计 §7 + 蓝图 §8 | 三条投影铁律 + 存储与上下文分离 |
| Project/KB/Librarian/GlobalScheduler/收件箱 | 详细设计 §8 + 蓝图 §20 | 独立世界隔离 + 终止并分叉（决策 D4） |
| humanGate/异议双轨/权威级别 | 详细设计 §8 + 蓝图 §14 | blocking/advisory + leader 最高权威 |
| 热插拔/招募离职交接 | 蓝图 §12 + 详细设计 §2 | Coordinator 不可删 + 先暂停再交接 |
| 前端群聊 UI/SSE | 选型 §9 + 蓝图 §10 | display/payload 分离 + 展示层与 context 层解耦 |
| 状态持久化（.data/JSONL） | 选型 §10 + 架构 §9 | Phase 0 文件系统方案 |
| 部署/韧性/错误恢复 | 架构 §6/§9 | 韧性表逐项落地 |
| 阶段目标/里程碑/时间线 | 开发计划安排 对应节 + task-status `exit_criteria` | 出口标准逐条核对 |
| Spike/执行链路验证 | 详细设计 §9 + 架构 §4 | 最小闭环链路 |
| 决策变更后文档同步 | `$agora-sync-docs` Skill 流程 + 蓝图 §21 | 同步顺序与标记规范 |

> **决策变更同步·浓缩顺序**：① 蓝图（§21 或对应章节，打标记）→ ② 详细设计对应节 → ③ 系统架构 / 技术选型（如涉及）→ ④ 开发计划安排 + `task-status.json`（含 standing_decisions）→ ⑤ AGENTS.md（如涉及红线）。逐步操作清单以 `$agora-sync-docs` Skill 为唯一详版。

### 0.3 Agent 文档读取规范

1. **启动时**：自动加载本文件，并**必须**读取 `docs/task-status.json` 以确认当前任务状态与常驻决策。
2. **执行任务时**：根据 §0.2 映射表精准读取相关章节。
3. **引用原文**：回复中必须**逐字粘贴**相关约束/接口签名/决策规则原文。
4. **禁止推断**：严禁"根据常规做法，我认为应该…"式推断。文档描述模糊时必须停止编码并向人类提出澄清问题。

### 0.4 一句话项目定位

Agora 是一个**群聊式多 Agent 代码协作系统**：人类以 Leader 身份在一个群聊里指挥一组各司其职的 AI Agent（Coordinator/PM/Architect/Coder/Tester/Reviewer）完成编码任务——像带一支真实的远程工程团队，而不是操作一条流水线。

```
一切皆群聊, Leader 唯一裁决, 角色投影, 配合式抢占, 薄执行器 + 自研轻编排.
群聊是唯一协作面；人始终在场并拍板；每个 agent 只读自己该读的切片；
LLM 永不在 token 流中被硬杀；底层循环复用 Harness，编排只有 4 个通用节点。
```

| 真实软件团队 | Agora 对应物 |
| --- | --- |
| 团队群聊/小群对齐 | Channel（main/sub），leader 恒为成员 |
| Team Leader 拍板 | humanGate + decisionLedger（authority='leader'） |
| 各司其职的工程师 | RoleSpec 数据驱动的 6 角色，可热插拔 |
| 新人只看交接文档和现状 | 角色投影（project(state, role) 切片） |
| 改需求先开会对齐再继续 | 配合式抢占：广播暂停→安全点→注入新上下文→resume |
| 代码评审通过才合入 | integrate 检查点 + REVIEWER 卡点 |

第一目标用户：**求职作品集的作者本人**（2026 秋招），需要可演示、可讲解、工程决策经得起追问的完整产品。

---

## 1. 规格来源（Single Source of Truth）

本仓库的"真理"来自 `docs/` 下 8 份文档 + 本文件；实现与文档冲突时，先改文档或纠正实现，禁止放任漂移（R12）。

```
项目蓝图            定位/架构/路线/§21 决策定稿（最高权威）
详细设计方案        可照着写代码的精确规格（schema/接口/伪代码）
系统架构设计文档    L1-L4 分层与 Monorepo 映射
技术选型文档        选型定稿与版本锁定
开发计划安排        Phase 0-10 分解与里程碑
框架调研与借鉴决策  外部框架结论快照（带日期）
task-status.json    进度与常驻决策（standing_decisions）
deferred-items.json 全阶段延期项台账（DEF-NNN，常驻决策 DEF 的数据源）
```

---

## 2. 硬红线（NEVER，违反必被拒绝）

```
R1  共享 State 写入只走合并函数 applyMutations()（append/mergeById/set），op 必须可交换、幂等；禁止直接赋值共享 State
R2  上下文只经投影切片喂给 agent，永不投原始群聊 log；display（给人看）与 payload（给 agent 用）严格分离
R3  leader 是唯一裁决者：不做 agent 间自动共识/投票；blocking 异议必须升级 humanGate 由人拍板
R4  配合式抢占只能在安全点（step/end）打断，绝不硬杀 LLM token 流；humanGate 按 D4 终止并分叉，不做动态挂起
R5  阶段 0–9 所有 Worker 强制薄执行器（Harness）；RoleSpec.external 仅预留，不实现切换逻辑；厚 Agent 到阶段 10
R6  阶段 0–N KnowledgeBase 只读（Write-Block），Librarian 仅空桩，不引入向量检索依赖；sliceKB 阶段 0 返回空对象
R7  阶段 0 沙箱只用 LocalTempSandbox；文件操作限定沙箱目录内；run 默认超时 30s；dockerode/simple-git 为 optionalDependencies
R8  分层依赖倒置：L1 core/domain 禁止任何 I/O（fs/http/child_process）；L2 编排只能调用 L3 端口接口；业务代码不直接 child_process（沙箱包内除外且经 MCP server 暴露）
R9  接口先行：Executor/SandboxManager/MessageBus 等接口签名从阶段 0 定稿，阶段退化只改实现体不改签名
R10 目录与命名严格对齐架构文档 L1-L4 映射；State 字段 camelCase；角色用字面量联合 'COORDINATOR'|'PM'|'ARCHITECT'|'CODER'|'TESTER'|'REVIEWER'
R11 测试红线：禁止弱化断言或 mock 绕过真实代码让测试变绿；必须分析根因（业务 bug→修代码；测试有误→修测试）；mock 必须在文件头注明原因；真实依赖优先。澄清：单元测试中 mock 外部依赖允许（注明原因）；G5 执行链路验收不得以 test double 替代真实实现；LocalTempSandbox 属真实实现而非 mock
R12 有代码变更必须同步受影响文档；重大决策更新蓝图 §21 并打 [YYYY-MM-DD 架构决策更新] 标记；文档冲突作为 GitHub Issue 记录，不得写入 task-status.json
R13 提交信息用英文一句话祈使句 + 可选 body 要点（对齐仓库既有风格）；严禁提交 secrets/.env/token
```

---

## 3. 技术栈（固定，不得随意替换）

```
语言/运行时   TypeScript 5.9+ / Node.js 20 LTS
包管理        pnpm 9 workspaces（catalog 统一版本）
单 Agent 内核 DeepSeek Harness v0.1（loop 可替换/事件溯源/Turn-Step 两层/inbox steering/ctx.subagents/ctx.compaction）
编排          自研轻量层（4 通用节点 + coordinator 条件路由，~500-800 行）
工具协议      MCP TS SDK v1（@modelcontextprotocol/sdk 1.30.0，锁定）
沙箱          Phase 0: LocalTempSandbox(fs.mkdtempSync + child_process.spawn)；Phase 1+: Docker(dockerode ^4)
版本控制      simple-git 3.36.x（worktree/merge，Phase 1+ 实际启用）
前端          Next.js 15 + React 19（Phase 5 起）
实时通信      SSE（收）+ HTTP POST（发），禁用 WebSocket
持久化        Phase 0: 文件系统 JSON/JSONL（.data/）；Phase 5+: SQLite 可选
测试          Vitest 3.x
代码质量      Biome 2.x（Lint + Format + Import 排序一体）
模型路由      经 Harness agent/request：规划/评审强推理模型，编码代码专精模型
```

复用与自研边界：

```
直接采用     Harness / MCP TS SDK / dockerode(P1+) / simple-git(P1+) / Next.js / React / Vitest / Biome / Zod(MCP 内置校验)
借鉴不依赖   AutoGen: TerminationCondition 语义、CodeExecutor 接口形态、MagenticOne Ledger 双循环、Handoff-as-tool
             AgentScope: reply/observe/print 语义、写所有权不变量、interrupt()/handle_interrupt、存储与上下文分离
必须自研     4 通用节点编排 + coordinator 路由、角色投影 project()、配合式抢占 preemption、单一 Channel 通信、
             两层 KB 与 Write-Block 门控、GlobalScheduler(终止并分叉)、GlobalInbox 聚合、LocalTempSandbox、Leader 意图映射
```

> 引入任何未列入的新依赖前，先核对《技术选型文档》§12，未列入的先讨论。

---

## 3.1 Git 协作规范

### 3.1.1 分支策略（dev 集成流）

| 分支 | 角色 | 合并方向 |
|---|---|---|
| `main` | 稳定发布分支（对外展示 / 打 tag） | 仅接受来自 `dev-1.0.0` 的合并（阶段里程碑 / MVP 验收时） |
| `dev-1.0.0` | 开发集成分支 | 所有功能/修复/文档 PR 的唯一合并目标 |
| `{type}/{description}` | 功能分支（feat/fix/docs/refactor/test/chore） | 从 `dev-1.0.0` 切出，PR base 为 `dev-1.0.0` |

- 所有开发变更一律：`git checkout dev-1.0.0 && git checkout -b {type}/{description}` → 提交 → `gh pr create --base dev-1.0.0`（标题正文全英文）。
- **禁止**直接向 `main` 或 `dev-1.0.0` push 功能代码；PR 由人类审阅合并，Agent 不得自动合并。
- **豁免（[2026-08-26 架构决策更新]）**：`$agora-pr-merge` 收尾时，**纯 `docs/task-status.json` 任务状态记录**（status/last_updated/notes 的收尾更新）允许直接在 `dev-1.0.0` 上提交并推送，不走功能分支/PR，避免为纯状态记录形成合并链。**豁免仅限该文件且仅限收尾记录**；任何代码变更（`packages/`、`apps/`、`tests/` 等源码）仍强制走功能分支 + PR + 人类合并；Agent 仍不得自动合并其他 PR。
- 合并后执行 `$agora-pr-merge` 同步本地并收尾任务状态。
- `main` 的更新只发生在阶段里程碑（如 MVP 验收、Demo 冻结），由人类确认后从 `dev-1.0.0` 发起 dev→main 的 PR。

### 3.1.2 Commit Message 格式

```
{英文一句话祈使句}

- change point 1 (English, optional body)
- change point 2

Task: {task-id}        （涉及任务时）
```

风格对齐仓库既有历史（PLAIN 英文）：`Add .gitignore`、`Document 5 architecture decisions`、`Add design docs and resolve cross-doc conflicts`。

### 3.1.3 提交前强制自检

1. `pnpm typecheck`（scripts 未建立前 `pnpm exec tsc --noEmit`）— 0 错误
2. `pnpm lint`（`pnpm exec biome check .`）— 0 违规
3. `pnpm test` — 全部通过（含既有回归）
4. 已更新 `docs/task-status.json`（status/notes/last_updated）
5. 无敏感数据提交（G7）
6. 相关文档已同步（R12）

### 3.1.4 外部可见内容的语言规范

Git commit message、分支名、PR 标题/描述、代码注释一律**英文**；`docs/` 目录下的 `.md/.json` 项目文档**豁免，沿用中文**。

---

## 4. 架构与命名

分层（上层依赖下层，禁止反向，R8）：

```
L1 领域模型层   packages/core/domain                   State/Reducer/RoleSpec/Entity —— 纯类型纯函数，零 I/O
L2 编排应用层   packages/core/orchestration            Orchestrator 主循环/Coordinator 路由/complexity
                packages/core/preemption               Preemptor 配合式抢占信号控制
L3 端口抽象层   packages/comm/bus                      MessageBus 接口（Port）
                runtime/executor/base.ts               Executor 接口
                runtime/sandbox                        SandboxManager 接口
L4 基础设施层   runtime/executor/harness-executor.ts   薄执行器（P0-P9 唯一允许形态）
                runtime/executor/external-executor.ts  厚执行器（仅 P10+）
                runtime/sandbox/local-temp-sandbox.ts  LocalTempSandbox（P0）/ docker(P1+)
                packages/tools/*                       MCP servers
数据与配置      packages/comm/channels                 Channel/Inbox 管理（基于 State 的 Adapter）
                packages/roles/definitions             RoleSpec YAML/TS；packages/shared 类型常量
交互层          apps/web                               Next.js 群聊前端（P5+）
```

Harness 边界（薄执行器职责，详见详细设计 §0/§6）：

```
- 构建与作用域骑 ctx.subagents.start（inheritsParentContext=false + toolFilter/persona/outputSchema/depthLimit 映射 RoleSpec）
- 逐步驱动自行回 runStep（subagent.start 是 one-shot 取向，不合 per-step 安全点）
- agent/pre-step：直接覆写 messages 数组为 project(state, role) 返回值（决策 D1）
- agent/request：按 RoleSpec.model 路由模型
- agent/turn-stopping：配合式抢占落点（steering 反对关轮 → step 边界停）
- ctx.compaction：单 agent 历史压缩委托 Harness，不自研；压缩伪历史属预期行为
- 隔离两层互补：subagent 进程内上下文隔离 ≠ 文件隔离（后者归沙箱）
```

命名约定：

```
- State 字段 camelCase；类型/消息/phase 用字符串字面量联合
- 角色标识：'COORDINATOR'|'PM'|'ARCHITECT'|'CODER'|'TESTER'|'REVIEWER'（roster 可扩展 string）
- 目录名对齐 L1-L4 映射，不发明新顶层包；shared 只放类型与常量
- orchestration 不直接拼底层命令，一律经 L3 端口接口；backend 实现之间不互调
```

---

## 5. 目录结构与测试约定

```
agora/
├── packages/
│   ├── core/{domain,orchestration,preemption}/
│   ├── runtime/{executor,sandbox}/
│   ├── comm/{bus,channels}/
│   ├── tools/{fs,test,git,lint,sandbox}/
│   ├── roles/definitions/
│   └── shared/
├── apps/web/                       # Next.js 群聊前端（Phase 5+）
├── tests/integration/
│   ├── phase{N}/                   # Phase N 跨包集成测试（出口验收级）
│   └── cross-phase/                # 跨 Phase 联调（累进回归，N 不破坏 N-1）
├── docs/                           # 7 份设计文档 + task-status.json（见 §0.1）
├── .agents/skills/                 # 14 个 Codex 项目级工作流 Skill（主入口）
├── .opencode/commands/             # OpenCode 兼容副本（迁移验证后再退役）
├── AGENTS.md
└── pnpm-workspace.yaml
.data/                              # 运行时状态（gitignored）：projects/{projectId}/tasks/{taskId}/{state.json,events.jsonl}
```

测试文件存放约定：

- 单元测试：各包内 `packages/<pkg>/test/*.test.ts` 或 `packages/<pkg>/__tests__/**`（Vitest 自动发现）
- 集成测试：`tests/integration/phase{N}/phase{N}-*.test.ts`
- 跨 Phase 联调：`tests/integration/cross-phase/*.test.ts`
- `src/` 只放生产代码；task-status.json 的 `test_file` 字段指向具体测试路径
- Mock 约定：真实依赖优先（真实临时目录/真实子进程/真实文件系统）；mock 必须在文件头注明原因（R11）

---

## 6. 领域关键规则（务必内化）

```
投影        三铁律：①永不投原始群聊 log（只投结构化切片+所属 channel localContext）②代码传引用不传全文（fileRefs 路径+行号）
            ③理由随决策走（rationale 防下游推翻上游）
安全点      一个 Harness Step（一次模型请求+其工具调用）的 step/end；绝不在 assistant token 流中途打断
humanGate   决策 D4：置字段→销毁(Terminate)该 Harness 子进程释放资源→Leader 裁决→按 safePoint 事件游标重新 Fork 恢复；
            阶段 0 简化为"任务即进程，结束即销毁"
KB          阶段 0–N 只读（决策 D3）：sliceKB 返回空对象/极简硬编码默认值，不依赖向量检索；
            启用写入需双重门控：①相关任务测试全绿 ②Leader 显式 /approve-kb——否则蒸馏结果直接丢弃
写所有权    结构化切片只读投影，agent 只写自己私有区——消除写-写冲突靠构造（WO）
裁决        leader 唯一；blocking 异议=暂停相关工作+humanGate；advisory=记录可见继续干；拿不准从宽 advisory
并行度      上限 3 worker 同时跑；subtask.dependsOn 拓扑排序，依赖未满足不激活
迭代上限    iterationCount 默认 8 轮，超限强制置 humanGate 升级人（默认开启，不许设 None）
沙箱        超时 30s；文件限目录内；agent 产出的代码只在沙箱内执行（G7）
实时通信    SSE 收 + HTTP POST 发；Vercel Serverless 兼容；不引入 WebSocket（FE）
意图映射    @X 指派→nextRole=X；插新需求→更新 requirements/ledger+触发抢占；否决批准→驱动 humanGate
```

---

## 7. 工作流：EPCC-V（每个任务必须遵循）

新会话一律先执行 `$agora-init-session`。

```
Explore  读 documents_required 章节 + 相关代码；逐字粘贴约束原文；发现文档矛盾必须暂停上报
Plan     产出实现计划（改哪些文件/接口/schema/测试），等人确认
Code     小步实现，一次一个可验证单元；TDD：写测试→红→写实现→绿
Check    pnpm typecheck + pnpm lint + pnpm test
Verify   对照 exit_criteria 逐条自检；执行链路能力真实跑通（G5）；证据留档进 notes
交付     $agora-commit：门禁→功能分支提交→PR(base=dev-1.0.0)；PR 合并后 $agora-pr-merge 标 done→级联翻转→阶段收尾
```

铁律：

```
- 未经人确认的计划不进入 Code（R8 之工作流表达）
- 每个 Code 单元必须能被 Check 验证
- 沙箱/Harness/工具链能力必须真实跑通，不以 mock 规避（G5）
- Explore 发现矛盾/模糊/不可测 → 暂停编码报告问题等人类决策
- 有代码变更必须同步相关文档（R12）；重大决策更新蓝图 §21 打标记
```

---

## 8. 质量门禁 G1-G7（并入主线前必过）

```
G1 规格一致      实现与 8 份文档及 standing_decisions 不冲突
G3 静态检查      pnpm typecheck + pnpm lint 通过（scripts 未建立前用 pnpm exec 等价命令）
G4 测试通过      pnpm test 全绿，含既有回归
G5 执行链路实测  沙箱/Harness/工具能力必须真实跑通验证，不以 mock 规避
G6 证据留档      task-status.json notes 记录自检结论、关键发现、偏差与延期项引用（延期项本体入 docs/deferred-items.json）
G7 安全合规      无敏感数据落盘明文；agent 产出的代码只在沙箱内执行
```

> **Phase 0 过渡规则**：某门禁的对象尚未建立时（如 vitest 未配置、沙箱未实现），该项自然空转，须在任务 notes 显式注明「暂缺」；能力一旦落地即恢复强制，且已落地链路的 G5 不得事后用 test double 补验。

## 8.1 任务状态机

所有状态记录在 `docs/task-status.json`。

### 8.1.1 状态定义

```
pending -> ready -> in_progress -> done
                     （blocked 为旁路：notes 写明解除条件）
```

| 状态 | 含义 | 谁变更 |
|---|---|---|
| `pending` | 已定义，依赖未满足 | 级联自动翻转 |
| `ready` | 依赖全部 done，等待执行 | Agent 幂等级联 |
| `in_progress` | 开工确认后 / 执行中 | Agent（经 `$agora-do-task` 等） |
| `blocked` | 外部阻塞，notes 注明解除条件 | Agent，解除后回 ready |
| `done` | 门禁 G1-G7 全过 + PR 已合并到 dev-1.0.0 | `$agora-pr-merge` 收尾时 |

### 8.1.2 done 转换规则（PR 合并流）

- 代码类任务：`$agora-commit` 创建 PR 后任务**保持 `in_progress`**（notes 记 PR 链接与实现摘要）；PR 合并到 `dev-1.0.0` 后由 `$agora-pr-merge` 标 `done`，notes 补记合并 hash、G5 实测结果。
- 非代码类任务（文档/调研/验证产出）：产出经人类确认后标 `done`。
- `main` 仅在阶段里程碑（MVP 验收 / Demo 冻结）由人类确认后从 `dev-1.0.0` 发起 dev→main PR，不影响任务级 done 判定。

### 8.1.3 task-status.json 字段约束

```
task-status.json 是纯任务追踪文件，禁止添加非任务字段。
允许顶层字段：version/project/description/last_updated/current_phase/usage/standing_decisions/baseline/milestones/phases
允许任务字段：id/title/story/status/last_updated/documents_required/dependencies/test_file/notes
文档冲突 → GitHub Issue（R12）；延期项 → `docs/deferred-items.json`（DEF-NNN，见常驻决策 DEF）；决策 → 蓝图 §21 标记段
```

**级联更新（幂等）**：启动或任务完成时，遍历所有 `pending` 任务，`dependencies` 全部 `done` 则翻转为 `ready`。

### 8.1.4 跨阶段阻断规则

阶段 N 的任务**不得**在阶段 N-1 的出口集成测试（integration_test 任务）完成前开始执行。必须先过出口门禁、推进 `current_phase`，再进下一阶段。

---

## 9. Agent 自检清单与禁忌

### 9.1 每次任务执行前

```
[ ] 已读取 AGENTS.md 与 docs/task-status.json
[ ] 已按 §0.2 映射表读取对应文档章节
[ ] 已在回复中逐字粘贴相关约束/接口签名原文
[ ] 已对照 standing_decisions 筛出本任务相关的 D-x/C4/FE/WO 条目
[ ] 已确认所有 dependencies 为 done（含跨阶段阻断检查）
```

### 9.2 每次提交代码前

```
[ ] pnpm typecheck 通过
[ ] pnpm lint 通过
[ ] pnpm test 全部通过
[ ] 已更新 task-status.json（status/notes/last_updated）
[ ] 无敏感数据提交（G7）
[ ] Commit message 符合 §3.1.2（英文祈使句）
[ ] 相关文档已同步（R12）
```

### 9.3 Agent 禁忌清单

| 行为 | 后果 | 规则 |
|---|---|---|
| 把群聊原始 log 整段喂给 agent | 上下文爆炸，撞《Don't Build Multi-Agents》反模式 | R2/支柱 2 |
| 用 LLM 替代 leader 拍板（自动共识/自动合并） | 决策不一致温床 | R3/支柱 1 |
| 在 token 流中途硬杀 LLM | 状态半截撕裂 | R4 |
| 直接赋值共享 State | 并行写乱 | R1 |
| 中途修改接口签名 | 破坏阶段退化承诺 | R9 |
| 阶段 0-9 实现厚执行器切换 | 越阶段范围 | R5/决策 D2 |
| 阶段 0 强装 Docker/Git 依赖 | 违背瘦身决策 | R7/决策 D5 |
| 引入 WebSocket 替代 SSE | 违背选型决策 | FE |
| mock 绕过沙箱实测让 G5 变绿 | 能力失真 | R11/G5 |
| KB 阶段 0-N 写入或引入向量检索 | 违反 Write-Block | R6/决策 D3 |
| 业务代码直接 child_process | 破坏分层 | R8 |
| 改代码不更新文档 | 规格漂移 | R12 |
| 凭想象实现、不读文档 | 幻觉产物 | §0.3 |
| 跨阶段抢跑 | 依赖断裂 | §8.1.4 |
| 未经确认的计划就编码 | 方向错误 | §7 铁律 |
| 一次生成整模块不分步验证 | 无法定位问题 | §12 |
| force push / 擅自删历史 | 不可逆破坏 | 禁止 |
| 绕过 PR 直接向 main / dev-1.0.0 push 功能代码 | 破坏集成分支模型 | §3.1.1 |
| Agent 自动合并 PR | 跳过人工审阅 | §3.1.1（合并必须由人类执行） |

---

## 10. 在 Codex 中的工作约定

> Codex 从仓库根目录向下自动加载 `AGENTS.md`，并从 `.agents/skills/` 发现项目级工作流。Skill 通过 `$skill-name` 显式调用，也可在请求与其 description 匹配时自动触发。`.opencode/commands/` 仅为迁移期兼容副本，不是 Codex 真相源。

```
- 新会话第一条工作流永远是 `$agora-init-session`
- 优先读本文件与相关规格章节再动手；不要凭想象实现
- 大改动先出计划让人确认；小步提交便于验证
- 需要外部库/新依赖前先核对《技术选型文档》§12，未列入的先讨论
- 涉及危险操作（删除/覆盖/写项目外目录）必须显式征得确认
- 无用户明确要求不擅自 commit/push
```

项目级 Skills：

```
$agora-init-session     新会话初始化          $agora-status           状态速览
$agora-next-task        下一个 ready 任务      $agora-do-task <id>     执行指定任务
$agora-retry-task       重试中断任务           $agora-read-spec        规格速读
$agora-explain          概念溯源解释           $agora-sync-docs        决策同步文档
$agora-commit           门禁+提交+建 PR        $agora-pr-review        PR 架构预审+评论处理
$agora-pr-merge         PR 合并后收尾          $agora-test-unit        单元测试
$agora-test-phase       当前 Phase 集成测试    $agora-test-integration 累进全量回归
```

---

## 11. 任务模板（贴给 Agent 用）

实现任务：

```
执行者身份：Agora 研发 Agent
目标：实现 <task-id / 模块>
必读：AGENTS.md + task-status.json 该任务的 documents_required + standing_decisions 相关条目
硬约束：五大支柱 + 红线 R1-R13 + 常驻决策 D1-D5/C4/FE/WO；不确定必标注
交付：1) 复述约束与现状 2) 出计划等确认 3) 小步实现+测试 4) 对照 exit_criteria 自检附证据
```

评审任务：

```
执行者身份：严格评审 Agent
检查：规格一致 / 目录命名对齐 R10 / 复用未违红线 / 测试覆盖出口标准 / 无臆造与静默降级 /
     投影未泄漏原始 log / State 写入全走 applyMutations / 接口签名未变
输出：按严重度的问题清单 + 必改项
```

调试任务：

```
执行者身份：调试 Agent
要求：先给 >=3 个假设按证据排序 → 最小复现验证 → 根因确认后最小修复+回归 → 证据不足则 inconclusive
```

---

## 12. 反模式（禁止）

```
- 把群聊原始对话史整段塞进任何 agent 的上下文（全量广播反模式）
- 用另一个 LLM 当"裁判"替代人类拍板
- 一次性生成整模块不分步验证
- 不给文档上下文凭想象实现
- 静默降级/吞错误/假装能力可用
- 改代码不更新文档造成规格漂移
- 自研 Harness 已提供的能力（事件溯源/单 agent 压缩/inbox steering）
- 阶段未到提前引入重型组件（Docker/向量库/Redis/SQLite 事件溯源）
- 测试失败就改断言凑绿
- 在群里让 agent 互相投票达成一致
```

---

## 13. 完成定义（DoD）

一个任务"完成"当且仅当：

```
[ ] 对照该阶段 exit_criteria 与任务 notes 约束逐条满足
[ ] G1-G7 全过；执行链路能力已真实跑通（G5）
[ ] 接口签名未变；若确需变更，已按 R12 同步全部受影响文档并打标记
[ ] 不确定/降级/延期项已显式标注并注明解除条件（延期项入 docs/deferred-items.json）
[ ] 无敏感数据落盘明文
[ ] 相关文档已同步更新，无规格漂移
[ ] task-status.json 已更新（status/notes 含提交 hash/last_updated），级联翻转已执行
```

---

## 14. 动态上下文

```
人力        1 名独立开发者（AI Native 全程，Codex）
当前阶段    禁止在本文件静态记录；每次从 docs/task-status.json 的 current_phase 与任务 status 读取
阶段策略    先回合制单 worker 跑稳闭环，Phase 9 再升真并行；每阶段有可演示产出才进下一阶段
时间线      约 13 周到 Phase 10；Phase 5 完成（Week 7）必须产出秋招 Demo 录屏（开发计划 §17 检查点）
验证基线    当前 Phase 出口以 docs/task-status.json 对应 phase.exit_criteria 为准
```

一句话给 Agent：**先读规格、投影切片喂上下文、leader 拍板不搞共识、小步可验证、执行链路必实测、接口签名神圣不可轻改、能复用绝不自研、不确定就标注。**
