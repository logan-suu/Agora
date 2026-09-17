> **2026-09-17交付整理：** 本页下方保留实验当时结果；D9缺陷随后修复并纳入PR #87，见[后续验证](../d9-replay-fix-20260917/README.md)。第二轮package.json/package-lock.json与首轮逐字节相同，已删除重复副本；复现时将[首轮package.json](../langgraph-spike-20260916/package.json)与[首轮锁文件](../langgraph-spike-20260916/package-lock.json)复制到本页runtime目录。sha256.json保留原实验路径/hash，README原hash对应本说明之后的原文；失败log仅移除文件末尾一个空行以通过Git空白检查，原字节可追加换行还原，前后hash见定稿验证；后续登记见[定稿记录](../langgraph-registration-20260917.md)。

# LangGraph / Harness 第二轮实验

日期：2026-09-17（America/Chicago）。用户“继续”授权的独立方案前置实验，沿用第一轮固定依赖与 Agora 基线。**结果部分通过：真实本机暂停/Fork/执行和原生打包探针通过；生产 D9 完成后重复裁决失败，尚未修复。** 不修改产品代码、依赖、来源规格或任务索引，不替代阶段验收。

完整机器结果、源文件 hash、生命周期事件、工具执行回执、会话元数据及用量见 [results.json](results.json)。第一轮证据不改写。本轮方案结论见 [独立方案 §25](../../langgraph-harness-design.md#section-25)。

## 1. 实际通过的路径

单个完整 CODER 由 LangGraph 节点调用正式 `createLocalTaskCompositionFactory`、`WorkerRuntime.runOne`、`MessageRuntime`、`LocalWorkspaceSessions`、Harness 官方持久化及 MCP 本机工具。图不调用旧 `while/switch`。图与生命周期的连接代码属于测试适配器；没有声称已替换产品 `TaskOrchestrationRuntime`。

1. 在临时 APFS 普通目录准备虚构 LRU 文件和固定 5 项测试，通过正式 `/workspace grant` 入口授予测试目录 read/edit/run，网络禁用，输出限每次操作私有目录。现有安装应用只提供受管 Node，不修改应用。
2. 首次 `workspace_read` 的工具审批边界触发正式 task-scoped `requestPause`，让工具自然返回。WorkerRuntime 写 paused/safePoint 后，正式 `materializeHumanGate` + State commit 落盘；此时 lease 仍为 1。`completePause` 后 lease 为 0，composition dispose 后图才停在 interrupt。
3. 新进程只读加载图与 State，无模型调用。另一个新进程通过真实 `POST /api/messages` 的 `/resolve-gate` 生成规范 Leader Message、resolution receipt 并清 gate；测试 lifecycle port 只接收已验证 receipt，不自动执行。
4. 再一个进程重放同一裁决（此时 worker 仍 paused，成功），显式 `Command({resume})` 继续图。正式工厂创建全新 Harness Context，加载真实 source prefix，产生确定性 child session，生成稳定 resumed 控制消息；执行前 WorkerRuntime 重新获取 lease 和本机能力。工厂创建完成时 lease=0，实际工具调用时 lease=1。
5. Agent 通过 `workspace_apply` 修改 LRU，再经 `workspace_run` 在 Seatbelt 下执行受管 Node `--test --test-reporter=tap @input/lru-cache.test.cjs`。固定 5 项全部通过，skip/cancel/fail 均为 0；版本验证器重新核验 inputVersion、root binding 和授权，原测试与假凭据文件未改动。任务只验证 CODER，未走 TESTER/REVIEWER/D16 完成终审。
6. 图自身的完成后重复 resume 为 no-op，无新增派工或工具调用。该独立检查不能替代下面失败的 D9 请求重放。

实际 6 个 native Harness Step、6 次工具调用（initial 1 / resume 5）。官方 child header 的 parent 指向 `session:lru-coder`，child 为 `human-gate-resume:graph-native-continue:lru-coder`，seedLength=64。用量按显式 native usage 事件统计并排除 seed：inputTokens=7260，outputTokens=3698，cacheReadTokens=30720；保留提供方字段含义，不推算价格。

## 2. 发现的生产缺陷：完成后重放裁决误报冲突

原本要求：对同一 msgId、同 gateId、同 option 的重复请求返回已应用结果，不能重新执行 worker。

实际：worker 正常完成后，重复请求抛出 `humanGate resolution action "graph-native-continue" conflicts with its first write`。原失败输出见 [d9-replay-failure.log](d9-replay-failure.log)。该失败没有改成通过断言，也没有绕过 D9 后宣称端到端通过。

三个假设已用证据区分：

| 假设 | 结果 |
| --- | --- |
| 请求参数或已存回执变化 | 排除本 fixture 的该原因：同一 action/gate/option；规范 resumed marker 中 workerResumes 与 receipt 相等 |
| source checkpoint 或 child session 身份漂移 | 排除本 fixture 的该原因：source ref 保持，当前 sessionId 等于回执的确定性 child，真实恢复工具与测试已通过 |
| 请求重放误用只接受 paused 的恢复前校验器 | 确认：同一 receipt 对真实 paused worker 通过，对正常 done worker 拒绝 |

生产调用点为 `apps/web/src/server/message-runtime.ts:1151`，调用 `validateHumanGateWorkerResumes`。后者 `packages/core/orchestration/src/human-gate.ts:385` 强制 `paused.length === plans.length`，本例完成后分别为 0 和 1。该约束用于**开始 Fork 前**是合理的；用来校验**已经恢复后的历史裁决请求**会误拒绝合法进展。

原规格要求：“重启或同 actionId 重放从最新规范 receipt 续办，并复核其参数、checkpoint refs、resumeSessionId 与当前 State 后置事实。”（详细设计 §5 D9 扩展）同时“`done/failed` 不重开”（详细设计 §6 D4）。因此修复不能简单删除身份校验或重新把 done worker 改回 paused。

本轮保留 [replay-fixture.json](replay-fixture.json) 与 [最小诊断源码](sources/diagnostic.test.ts)，不修改生产实现。建议正式修复分离恢复前与历史重放校验：恢复前维持 paused/ref 一一对应；历史重放验证不可变 receipt、规范 resumed marker 与 lineage/派工身份，允许合法进展，并保证终态不重启。后续还应覆盖 running、done、failed、新一轮 pause、多 worker 混合状态、篡改 marker/ref 和跨 task 的拒绝；本轮不声称这些均已测试。

## 3. 原生打包探针

使用当前生产 `reviewTraceFile`、`copyTracedFile`、`auditResources` 和 `signValidationBundle`，对固定 LangGraph/SQLite 包做 Next NFT 依赖裁剪：722 个追踪文件，无 warning，包含 `better_sqlite3.node`。建立最小 Node `.app` 并 ad-hoc 签名、deep/strict 验签，创建压缩 DMG、只读挂载。

原目录先写 SQLite checkpoint，镜像内另一进程只读查看并继续，卸载后搬迁应用再加载/重复继续：已完成 work 节点累计调用始终为 1，SQLite 数据位于镜像外的测试目录。代码和原生模块在只读安装布局中可加载；镜像已卸载。

第一次受限执行的 `hdiutil create` 返回 1，没有创建成功，失败原因不能进一步确认为某个具体系统错误。相同 staged app/checkpoint 的镜像步骤取得宿主权限后成功，未重跑 work 节点。失败摘要保留在 results.json。

**范围限制：** 这是独立 npm 锁定依赖布局下的最小 Node 应用，未构建完整 Agora Electron/Next 应用，未覆盖生产 pnpm 全布局、新版本升级/降级、Developer ID/公证、Gatekeeper、macOS15 或断电恢复。该结果支持原生打包可行性，不构成发布验收。已清理镜像，不提供下载链接。

## 4. 复现

从 results.json 的固定 Agora 基线及正常项目开发依赖开始，在忽略目录重建下列结构（保留本证据目录不动）：

```text
test-outputs/langgraph-spike-round2/
  runtime/package.json
  runtime/package-lock.json
  src/live.test.ts
  src/diagnostic.test.ts
  src/package-probe.mjs
  src/package-dmg.mjs
  vitest.spike.config.mjs
  vitest.diagnostic.config.mjs
  tsconfig.spike.json
  results/replay-fixture.json
```

`sources/`复制到`src/`，本目录配置复制到根、package 文件复制到 runtime。真实模型经既有 helper 使用 OpenCode Go / `deepseek-v4-flash`，不切换、不跳过。live initial 会编译测试专用 C helper 并创建新的 `/private/tmp/agora-langgraph-round2-*`；模型生成代码只由正式 Seatbelt 路径执行。

```sh
npm ci --prefix test-outputs/langgraph-spike-round2/runtime --cache test-outputs/langgraph-spike-round2/npm-cache --no-audit --no-fund
LG_ROUND2_MODE=initial pnpm exec vitest run --config test-outputs/langgraph-spike-round2/vitest.spike.config.mjs
LG_ROUND2_MODE=inspect pnpm exec vitest run --config test-outputs/langgraph-spike-round2/vitest.spike.config.mjs
LG_ROUND2_MODE=resolve pnpm exec vitest run --config test-outputs/langgraph-spike-round2/vitest.spike.config.mjs
LG_ROUND2_MODE=resume pnpm exec vitest run --config test-outputs/langgraph-spike-round2/vitest.spike.config.mjs
LG_ROUND2_MODE=duplicate pnpm exec vitest run --config test-outputs/langgraph-spike-round2/vitest.spike.config.mjs
LG_ROUND2_MODE=graph-only-duplicate pnpm exec vitest run --config test-outputs/langgraph-spike-round2/vitest.spike.config.mjs
pnpm exec vitest run --config test-outputs/langgraph-spike-round2/vitest.diagnostic.config.mjs
pnpm exec tsc -p test-outputs/langgraph-spike-round2/tsconfig.spike.json
node test-outputs/langgraph-spike-round2/src/package-probe.mjs
node test-outputs/langgraph-spike-round2/src/package-dmg.mjs
```

每个命令使用独立进程并等待退出。基线的 `duplicate` **预期暴露非零失败**；后面的诊断只确认已发现的错误原因，不将其变成业务通过。诊断默认使用本次真实运行保留的最小 fixture，不冒充重跑 live 链路。打包阶段需要现有 desktop build 输出、安装的受管 Node 与系统 DMG 权限。

严格定向 tsc 通过。Biome 因测试忽略目录而处理 0 文件，未计为 lint 通过。未运行全量产品门禁或 Benchmark。

## 5. 留证与清理

保留源码、锁文件、基线与关键实现 hash、两份 session hash/lineage、必要工具回执、唯一 D9 失败及诊断 fixture；不保留原始模型 reasoning、完整会话、重复日志、生成代码副本或测试应用。清理前核对测试进程退出、无文件句柄/挂载，核对目录身份；删除本轮专用依赖/cache/签名应用/DMG/工作区。正常项目依赖、现有应用、用户目录与产品状态不在范围。实际回执见 [cleanup.json](cleanup.json)。
