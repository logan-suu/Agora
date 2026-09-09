# 10.2 规格合理性评审

日期：2026-09-08。任务：10.2「错误恢复增强 + 日志完善」。

本次是 Leader 授权的规格评审和文档修订，不是代码评审完成或运行验收。依据产品目标、当前实现、锁定依赖的实际分发 JS、已有测试代码进行静态核对；未安装依赖、未新增生产代码/测试、未运行模型或 G5。旧计划的推断经本次评审修正；没有把上游 README 或既有测试源码当作本轮运行证据。

## 结论

恢复与日志完善的目标合理，但旧架构 §6 的描述不足以直接编码：缺少失败分类、预算边界、持久化失败后的真实性要求和可观测状态定义。上一版实现计划还错误采用了上游 README 的重试边界，并过度禁止失败产物归档。已按以下结论修正真相源。

| 发现 | 证据与合理性判断 | 修订 |
| --- | --- | --- |
| 请求重试被假定为 closed-step/new-turn | 官方 retry README 第 5/12 行声称重试另开 turn；实际 agent-loop.step 的 while/continue 仍在同一 turn/step，外层 finally 才写 step/end；retry invariant 明确要求 open step。README 与代码不一致，不能按 README 设计安全点或 Trace。 | 锁定当前 JS 行为；相同 turn/step 内多次 provider attempt。实施时须用真实 Harness 序列验证，未验证前不宣称链路通过。 |
| retryId 被误认为每次尝试唯一 | retry/lib/index.js 在 priorPolicyRetry 存在时复用 retryId；invariant 要求同链身份一致、retry 连续递增。 | 一次等待由 sessionId+retryId+retry 标识；重复 retryId 的不同 retry 序号合法。 |
| retry-started 被解释为下一请求开始/成功 | backoff 函数先 append started，随后返回 retry；agent-loop 之后才重建并发起下一请求。中间仍可能失败。 | 只显示 backoff_completed；请求/Step/turn 最终结果仍由对应原生事件证明，不制造 retry succeeded 状态。 |
| “全局 unhandledRejection = 对应 worker 失败” | worker 是进程内 Context/Agent/session 身份；WorkerRuntime 已有 scoped await/catch。真正进程死亡不保证运行事件回调，无法确保临终 State 提交。 | 在可归属执行边界写 failed；未知进程退出不猜 worker、不吞异常，重启显示实际持久状态的 interrupted/needs_attention，不自动重放业务。 |
| “自动重试或升级人”没有边界 | WorkerStepError 把 executor.step 抛出的错误统一包装；ParallelBatchError.retryable 主要按包装类别判断。永久 provider 错误或已耗尽预算可能被外层误当可重试业务，需在 TDD 中确认并修复。 | provider normal、格式修复、compaction 与业务返工分别限额；外层不得通过新 worker/context 重置已耗尽/永久错误。只对明确的业务反馈保留既有 8 轮返工路径。 |
| 原因被丢弃时仍可能宣称 failed 已落盘 | runOne 对 markFailed 错误 catch 后忽略，finally release 可能遮盖原错；并行 recordFailure 以 workerId 去重，可能遗漏同 worker 的后续提交/清理原因。均为静态风险，未在本轮复现。 | 原执行错误、规范状态提交失败、lease/suspend/归档/释放错误分别保留；提交失败不能声称耐久 failed，不能按 workerId 丢不同阶段错误。 |
| 一概“失败后不归档”不符合已有产品行为 | Web runtime #finalizeRun 接收 failed；orchestration-flow 测试明确要求失败时保存 available output 并 dispose。失败诊断产物有价值，不代表测试/Leader 验收成功。 | 保留顺序 failed 诊断归档；并行未验证失败继续 D17 suspend。两者均不标 D16 成功。清理失败保留 pending 状态。 |
| “官方 invariant 校验 inspect 结果”缺少真实调用路径 | retry/invariant 导出 Cordis 注册插件、依赖 invariants 服务，检查 live Session 与 session/event。当前 TraceReader 只有 SessionStore/JSONL persistence + inspect 数组投影。 | 不把 companion 当纯校验函数；正确写侧装配与读侧投影校验分别说明。读侧显式检查完整关系，不靠“安装过插件”声称已验证。 |
| 日志目标过宽或可能泄漏错误正文 | 当前 Web runtime errorMessage 会透传 Error.message；provider/工具原始内容不能进入公共错误摘要。session 顶层复制 turn/step retry 索引也不必要。 | 仅在 TraceStepView 增 retries，固定枚举和小字段集，现有响应上限、lineage、裁剪继续适用；公共错误采用有限代码与预定义说明，不新增日志平台/State 错误数组。 |
| G5 与文档分析混淆 | 旧阶段已有测试，不能证明新 retry 与 D4/D17 的交互；模型边界故障注入也不等于 live model。 | 独立 10.2 组合链、已有回归覆盖表、协议故障注入和真实模型证据分开。USD1 只是此前建议，当前未获批准或发生调用。 |

## 静态证据入口

仓库基线：`d465213`，本轮在 `feat/phase10-resilience`，保留前序 D2 文档变更；源码未修改。

- `packages/runtime/executor/src/harness-executor.ts`：agent/error 收集、whenIdle 后重新抛错、requestSafePoint/pre-step、正文读取与格式修复。
- `packages/core/orchestration/src/worker-runtime.ts`：runOne、pump、recordFailure、WorkerStepError、markFailed 与 releaseLease。
- `packages/core/orchestration/src/orchestrator.ts`：仅满足既有并行 CODER 路由的 ParallelBatchError 可回到 Coordinator。
- `packages/core/orchestration/src/parallel-coordinator.ts`：retryWorkers、MAX_ITERATIONS 与新 dispatch 身份。
- `apps/web/src/server/task-orchestration-runtime.ts`：#executeRun、#suspendFailedParallelRun、#finalizeRun 与 errorMessage。
- `apps/web/test/orchestration-flow.test.ts`：`archives available output and disposes resources when a run fails`；`reports an unfinished persisted task as interrupted after process restart`。
- `apps/web/test/parallel-failure-lifecycle.test.ts`：只重试 cleanup、不自动重执行业务的既有断言。
- `packages/runtime/executor/src/trace.ts`：官方 list/inspect、读侧跨事件校验、按完整 turn 裁剪。

依赖证据为本地 `node_modules/.pnpm` 中对应 `@deepseek-ai` 包、版本均为 `0.1.1-rc.2`。以下 SHA-256 固定本次查看的实际分发文件，防止后续以同名版本号替换证据；不把锁定源码静态核对描述为模型实测。

| 包内文件 | SHA-256 |
| --- | --- |
| dsh-agent-loop/lib/index.js | `1ca83637892559e88c43b815e8d5d7b065951751e73eee7a7bef99d65a71ad6c` |
| dsh-llm-retry/lib/index.js | `ebef5bf22314d09d7faa3022db341c71251459f1e30380adf61934764bb27e94` |
| dsh-llm-retry/lib/invariant.js | `7a84944b96860264d96aa0da12286892df396c23301af5d0c6ee1009c36ddbbd` |
| dsh-llm-retry/README.md | `b979760f5ad803b0469b2428910a0bdb1a446a13cc5fb1ebddc37e805a12c3be` |

## 同步范围与剩余工作

按真相源顺序同步：蓝图 §16/§21 → 详细设计 §6/新 §6.1 → 系统架构 §6 → 技术选型 §12 → 开发计划 §13 与 task-status 的 documents_required/test_file/notes/D15/D17 摘要 → AGENTS Trace 规则。`.data/plans/task102-implementation-plan.md` 按新规格重写。

本次没有未能裁决、需要暂停文档同步的架构分歧。采用有限官方重试和最小 retry DTO 是可验证的局部方案；复用与自研边界不变，不新增 D18、不关闭 DEF-016。实现计划仍需按 EPCC-V 确认后进入 Code；运行证据、最终门禁、实际模型预算与提交/PR 流程均未完成。

## 后续实施记录

Leader 在静态评审完成后确认修订实现计划。后续源码、TDD、全量回归/G5 与浏览器结果见 `docs/evals/phase10-resilience-evidence.md`；上文“尚未运行”描述保留为评审时点的事实，不作为当前实现状态。
