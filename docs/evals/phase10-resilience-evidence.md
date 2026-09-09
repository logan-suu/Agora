# 10.2 错误恢复与日志：实现及验收证据

日期：2026-09-08。分支：`feat/phase10-resilience`，基线 `d465213`。Leader 已确认经规格评审修订的实现计划。当前实现/验收完成，Leader 已调用 agora-commit 授权交付；任务保持 `in_progress`，不替代 10.7 出口或人类合并。

## 实现结果

- 精确声明 `@deepseek-ai/dsh-llm-retry` 与其官方 companion 所需 `dsh-invariants`，均为 `0.1.1-rc.2`。直接复用官方 loop、normal 策略、invariant 注册与 JSONL。产品默认最多 5 次额外请求、500ms 初始/10s 上限/10% jitter；测试 provider 用 2 次、1ms–10ms、无 jitter 进行确定性验证。拒绝无界/扩大白名单的注入 provider 策略，模型名在 composition 创建时固定；未升级依赖或修改 vendor。
- 请求失败以 `ExecutorRequestError` 保留原始 typed cause。任意执行异常均不再由 WorkerRuntime 生成可自动重派的 `ParallelBatchError`；TESTER/REVIEWER 结构化返工仍按原业务协议处理。顺序执行同时失败时保留原错、failed 写入与 lease 释放原因；并行失败按 execution/state_commit/lease_release 保留各阶段原因，HEAD 刷新/提交失败不覆盖原错。规范状态未写成 failed 时不会伪造持久 failed 事实。
- TraceStepView 增加最小 `retries`，只从官方 `llm/retry`/`llm/retry-started` 派生。校验 open step、request header provider、固定 policy/maxRetries、连续链、唯一 started 与时序、有限数值、安全身份；chain ID 可复用、同序号不可重复。完整 turn 裁剪时两个事件都计数，child seed 不重复投影。started 只表示退避完成。
- Web run/cleanup 摘要使用有限错误代码和固定说明，不透传 Error.message/stack/cause 或任意 thrown value。原始诊断仅按执行/挂起/归档/释放阶段有界保留在进程内，不增加 State 日志或跨重启原始错误档案。顺序 failed 诊断归档、并行未验证 suspend、D4 gate/Fork 等原有生命周期继续保留。

控制规格：详细设计 §6.1；规格评审的上游 README/分发 JS 差异与源码 hash 见 `docs/reviews/task102-spec-review.md`。源码实现后额外纠正详细设计 §8 遗留的“自动恢复留 10.2”表述：普通活动 run 的进程重启自动续跑仍不在本任务范围。

## TDD 与覆盖矩阵

| 验收点 | 实际测试/证据 | 结果 |
| --- | --- | --- |
| 同 Step 两次重试、链身份、partial output、永久/unknown/预算耗尽、Retry-After、暂停不 abort | `packages/runtime/executor/test/request-retry.test.ts`；先在未装配时得到 7 个实际行为失败，后装配官方插件通过 | 通过 |
| compaction 与 normal 分账、normal 不重置 overflow 上限、格式修复禁工具且只发布最终正文 | 同上共 10 测试；真实 compaction/end 与 retry 事件，overflow 第二次拒绝；另回归 `output-repair.test.ts` 10 测试 | 通过 |
| 原执行错 + failed 持久失败 + lease 释放失败 | `packages/core/orchestration/test/worker-failure.test.ts` 2 测试先红后绿；故障只注入端口，规范 join/reducer/scheduler 实际执行 | 通过；持久 worker 仍 running，不冒称 failed 已落盘 |
| 未启动队列保留、成功兄弟 all-settled、真实 Git HEAD 失败恢复、未知/永久故障不由外层重派 | `worker-runtime.test.ts` 41 测试、`orchestrator.test.ts` 15 测试 | 通过 |
| Trace 有界白名单、三种状态、身份/策略/序号/数值漂移、重复或闭合后 started、父子去重 | `packages/runtime/executor/test/trace.test.ts` 25 测试 | 通过；裁掉的坏 turn 仍拒绝 |
| 公共错误脱敏、聚合 cause、循环 cause 遍历有界 | `apps/web/test/run-error.test.ts` 3 测试；`trace-flow.test.ts` 8 测试含小数 delay DTO 解析 | 通过 |
| 独立 10.2 跨包链 | `tests/integration/phase10/phase10-resilience.test.ts` | 通过，详见下节 |
| failed 诊断归档、归档失败重试、清理失败不重执行业务、进程重启 interrupted | `apps/web/test/orchestration-flow.test.ts` 14 测试、`parallel-failure-lifecycle.test.ts` 2 测试 | 通过 |
| D4 pause/Fork、resolution/suspend 竞态、工作区身份、归档 receipt、D17 真并行/返工/保留证据 | 全量中的 Phase 8/9 integration、cross-phase、`phase9-parallel-flow.test.ts` 等 | 通过，未以本任务的短组合链替代阶段出口 |
| 沙箱 30s 默认与自定义超时、Git merge conflict、KB Write-Block、8 轮业务上限 | 既有 sandbox/Phase 1/3/4/9 与 domain/orchestration 回归 | 通过，既有业务返工覆盖继续保留 |

旧测试修改均是已确认规格/公共接口变化，不是删断言：两项 orchestrator 测试从“任意 worker 异常自动重派直到 8 轮”改为明确断言只执行一次、未启动 assignment 保持 pending、未到 integration；真实 Git HEAD 和成功兄弟断言保留。Web/Phase 9 的旧原始错误正文断言改为精确安全摘要，资源/状态/幂等断言保留。没有 skip、排除文件、移除凭证或降低真实依赖等级。

## 独立 G5 与 live model 的区别

10.2 新组合链仅 provider 响应为固定故障注入，不声称它是 live model。实际执行：TRANSPORT → 官方重试 → MCP fs_write → Docker 中执行无限循环并在 150ms 超时 → 同容器成功执行第二条 node 命令 → MCP git.applyPatch 形成实际 commit → TaskStateStore 原子提交 worker/message → GlobalScheduler lease 归零 → flush 官方 JSONL → dispose 原 Context → 真 lineage child Fork → 再次完成 turn → 经正式 Trace HTTP handler 和前端严格 DTO parser 读取；只出现一次父重试记录，原始错误标记未外泄。150ms 为测试覆写，不是产品默认 30s。

最终全量还实际执行了现有三个 live DeepSeek Flash 回归，均通过：

- `packages/runtime/executor/test/g5-real-chain.test.ts`：真实投影/模型请求/消息返回。
- `packages/runtime/executor/test/channel-summary-g5-real-chain.test.ts`：虚构固定协作事实的受限摘要。
- `packages/core/__tests__/e2e/lru-cache.test.ts`：真实模型在临时沙箱完成 TTL LRU 编码、测试与编排闭环。

目的地为官方 `https://api.deepseek.com`；这些测试的载荷为固定题目、角色投影及临时任务工具结果。未提交凭证正文或读取密钥值做日志；未运行额外 Benchmark、九次对照或新增付费实验。既有模型回归没有本轮完整 usage/账单汇总，实际成本明确为 **unknown**，不以先前 USD1 提案宣称成本已受验证。

## 最终检查

| 检查 | 命令/结果 |
| --- | --- |
| 原生沙箱 helper | `pnpm build:sandbox-native` 通过 |
| 类型 | `pnpm typecheck` 通过 |
| Lint/格式 | `pnpm lint` 通过；新增测试格式修复后重跑 |
| 全量回归 | `pnpm run test --maxWorkers=2`：**124 文件、1035 测试通过，0 失败、0 skip**；215.81s；日志 `/tmp/agora-task102-final-tests.log` |
| Next 生产构建 | `pnpm --filter @agora/web build` 通过；日志 `/tmp/agora-task102-web-build.log` |
| 文档/补丁 | JSON 解析、任务依赖图、历史阶段状态不变、Markdown fence 与 `git diff --check` 检查 |

先前失败如实记录：第一次沙箱执行拒绝 Docker socket/网络；36 测试失败、2 因 beforeAll 失败未运行，不计通过。第一次提权请求被自动审批拒绝，理由为模型 payload/目的地及 Docker 副作用范围不清。核对上述固定测试载荷与用户已确认的全量回归授权后，重试获准。获准首轮 1030 通过、1 项旧错误正文断言失败；按安全公共接口修正后重跑最终全量，全部通过。依赖声明先遇 pnpm store 路径不一致，随后使用现有 store 的离线缓存，锁定版本未升级。

## 浏览器 QA

流程：本机首页 → Trace 重试信息 → 展开/折叠 session → 刷新 → 手机端打开任务状态抽屉。

环境：`http://127.0.0.1:3102/`，生产 Next 构建；1440×1000 与 390×844。Browser plugin/skill 不可用，按 frontend-testing-debugging 流程使用已有 Playwright；它的内置 Chromium 未缓存，改用已安装 Chrome，没有下载浏览器或增项目依赖。Trace API 使用明确标记的展示 fixture，以稳定覆盖 waiting/backoff_completed/closed_without_start；这是 UI 展示验证，真实 JSONL/HTTP/DTO 链由上面的 G5 独立证明。初次无 fixture 打开页面有一次 404，最终展示验证轮次 HTTP/console 均无错误。

| 页面检查 | 结果 |
| --- | --- |
| URL/标题 | localhost 3102，Agora |
| 页面非空/无框架错误遮罩 | 通过 |
| 三种重试状态 | 正确显示 Waiting to retry / Backoff completed / Closed without retry start；不显示 retry success |
| 展开/折叠、刷新 | 折叠隐藏详情、展开恢复；刷新后仍正确显示 |
| 截断 | 显示 7 older trace events omitted |
| 手机端 | 点击 Open task status 后抽屉内 Trace 可读；页面无横向溢出 |
| 控制台/HTTP | 最终轮次 errors=[]，httpErrors=[] |
| 截图人工检查 | 状态文本可读，无新增重叠/裁切；沿用现有抽屉布局 |

临时截图：`/tmp/agora-task102-desktop.png`、`/tmp/agora-task102-closed.png`、`/tmp/agora-task102-mobile.png`。自动化脚本 `/tmp/agora-task102-ui.cjs` 未加入仓库。截图未充当 live model 或完成裁决证据；未测试其他浏览器引擎。

## 交付边界

D2 全角色继续统一 Harness，未新增外部 Agent 执行器。Executor/SandboxManager 冻结签名未变，L1 未引入 I/O，未新建日志平台或全局异常吞没器；普通崩溃续跑、KB 写入和 10.7 阶段出口不在本次交付。Phase 0–9 任务记录不改动，10.2 仍 `in_progress`；交付门禁已重跑通过，等待 PR 人工审阅与合并。

## 交付门禁复跑

2026-09-08，Leader 调用 agora-commit 后重新执行：原生 helper 构建、typecheck、lint 全通过；全量 `pnpm run test --maxWorkers=2` 为 **124 文件/1035 测试通过、0 失败、0 skip，286.07s**，含三项 live DeepSeek 与所有 Docker 回归。独立 `pnpm exec vitest run tests/integration/phase10/phase10-resilience.test.ts` 为 **1/1 通过，4.70s**。日志分别为 `/tmp/agora-task102-delivery-tests.log` 与 `/tmp/agora-task102-delivery-g5.log`，临时日志不提交。

本轮未改实现或测试；此前 Next 构建与浏览器证据继续适用于同一源码。交付审查覆盖 33 个明确文件，未发现密钥样式字面量、未纳入 .env/.data；任务依赖有效、Phase 0–9 记录保持不变。

实现提交：`ec2670d`。PR：[Agora #69](https://github.com/logan-suu/Agora/pull/69)，`feat/phase10-resilience` → `dev-1.0.0`。已推送并创建 PR，10.2 保持 `in_progress`，待人工审阅与合并。

## PR #69 修复复验

2026-09-08，Leader 授权修复评审问题。回归先红：有状态 adapter 第一次策略为 normal、第二次为 always，旧实现在 AUTHENTICATION 错误后发出 8 次请求；另 4 个非法策略用例因初始化拒绝阻断 dispose 而失败（10 通过/5 失败）。修复后注册时仅捕获一次策略，统一从 ctx.llm 注册表校验注入 adapter 和内置 DeepSeek 路由；认证错误只发出 1 次请求。always、次数 6、延迟 10001ms、扩展 AUTHENTICATION 白名单均在 dispatch 前拒绝，仍可清理已装配插件。执行入口保留初始化错误。

针对 request-retry 与 harness-executor 的 39 项测试通过；完整交付复验结果如下。未改变请求头 fail-closed 或新增 Docker skip；CodeRabbit 两条建议不符合 D15/详细设计 §6.1 的日志校验与必跑 G5 要求，不作为延期项。当前内置 DeepSeek 默认配置本来就是有限 normal，未宣称其默认无界重试。

本轮原生 helper 构建、pnpm typecheck、pnpm lint 全通过；pnpm run test --maxWorkers=2：124 文件/1040 测试通过、0 失败/0 skip，219.13s，含既有三项真实 DeepSeek 与全部 Docker 回归；独立 10.2 G5 1/1 通过，4.64s。日志 /tmp/agora-pr69-fix-tests.log、/tmp/agora-pr69-fix-g5.log；故障复现日志 /tmp/agora-pr69-fix-red.log。五个明确交付文件经 diff/敏感信息校验，未发现密钥样式字面量，Phase 0–9 记录不变。
