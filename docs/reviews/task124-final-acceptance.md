# Task 12.4 工作树验收结果

2026-09-29。当前分支：`codex/feat-local-worktree-integration`。本任务范围内的实现、真实链路验证及完整回归已完成，可审阅工作树已保留；功能提交`9d2b8fb`已推送并创建[PR #88](https://github.com/logan-suu/Agora/pull/88)（base=`dev-1.0.0`），任务按人工合并规则保持`in_progress`。这不是Phase 12出口或发布验收。

## 最终验证

完整命令 `pnpm run test --reporter=verbose --bail=1`，session90159自然退出0，用时13676.06秒：**298个文件、2458项测试全部通过，另7项追踪测试通过，零失败、零跳过**。实际文件集合与预期298文件完全一致，没有筛选、缺项或额外文件。运行前保存的252个变更/未跟踪文件hash在运行结束时全部一致。

`pnpm typecheck`、`pnpm lint`通过；Lint检查755个文件。追踪索引检查有效，差异空白检查通过。原模型、断言、期限及真实依赖保持；模型为OpenCode Go / `deepseek-v4-flash`。完整范围经Leader明确批准，见[范围清单](task124-full-regression-scope.md)。正式Benchmark未运行。

## 任务能力与证据

| 验收能力 | 当前证据 |
| --- | --- |
| 固定完整基线、独立编码worktree、原生身份/授权/lease准入 | linked-workspace、coding-baseline、coding-retry及原生Git/helper测试通过；用户修改、HEAD/index保护与漂移拒绝覆盖 |
| 累计集成、不可变候选、唯一发布/确认、响应丢失恢复 | IntegrationService、handoff、publication、acknowledgement、tree-batch及来源/完成证明通过 |
| 初始/恢复TESTER登记屏障与后续累计波次 | 独立登记精确重放通过；第二波baseline/published/ack/集成交接/TESTER/回执/REVIEWER共7项通过，最后一项1140070ms |
| 首次Git真实终审、固定产物与实际应用 | 真实审阅→D16→同候选归档335818ms；原候选直接应用245013ms，不创建多余轮次；Git新轮复验应用255784ms |
| 同task新轮、新worker/Context/lease，旧事实不改写 | 普通目录复验53478ms；先应用后终审56114ms；实际应用、部分失败、缺完成标记、旧动作重放和归档保护通过 |
| 受控返工后重新验证及交付 | 普通目录Leader/REVIEWER/TESTER触发真实返工分别222936/226082/246265ms；Git来源Leader返工435666ms通过 |
| 既有路径回归 | Phase 0真实LRU、受控本机LRU、真实Docker及Phase 9/10安全点、Fork、累计验证与交付回归包含于完整2458项 |

## 门禁与边界

G1：对照详设§12.2.5/§12.2.5.1、开发计划12.4及本任务复评检查；既有Executor、SandboxManager、TaskStateStore、MessageBus、Channel接口定义与HEAD逐字节相同。新增能力使用内部companion/受信控制端口，公开冻结签名未改。G3/G4：静态及完整测试通过。G5：上述真实Harness、MCP、Git、Seatbelt、文件事务和Docker链路实测；不以替身替代真实验收。G6：结果、失败及修复历史见[12.4历史](../task-history/12.4.md)。G7：固定夹具载荷与原生越界/凭据隔离测试通过，变更文件未发现凭据文件或私钥头；该静态筛查不是独立安全审计。

本任务不开放12.6/Phase13普通项目入口，不代替12.5接管交还或12.7阶段出口，不恢复旧引擎任务，不声明正式Benchmark指标。首次候选真实审阅用例从固定已验证候选开始，要求候选及非REVIEWER worker不变；它不是任意初始编码返工宿主的验收。新轮返工已另以真实链路验证，不放宽缺工作区绑定时的拒绝。

## 失败保留与修复

- 历史基线读取的零新增引用断言曾混入显式U捕获。已分开边界，保留原严格断言，并增加唯一元数据引用/幂等/不变性断言；完整回归20754ms通过。
- 首次Git真实REVIEWER指出算术测试不覆盖交付文件。保留原算术断言和单项测试计数，补充精确文件字节校验与结构化需求；定向310994ms及本轮335818ms通过。没有强制模型批准或放宽D16。
- 早先Git deadline与apply-first缺gate的原始原因仍为inconclusive；本轮对应985820ms和56114ms通过，不据重跑成功改写历史失败。新失败诊断在清理前保留规范状态和D15安全Trace。

## 证据、清理与交付

忽略目录的最小可复核入口：`test-outputs/task124/full-regression-final-checkpoint.json`、`file-coverage-full-source-snapshot.json`、`full-regression-cleanup-audit.json`及完整日志`task124-full-regression-file-coverage.log`。日志SHA256：`277fba051ae626ba9363cc5af12684716693a1bc9bdb8b29521ba37cc224ca82`；源码快照SHA256：`cef32aeb7643a3f9fbebe309e40f48b4739e237cf8076aecdd9a99f91504f99c`。完整失败日志和旧检查点仍在任务历史引用中。

本轮核对200份独立根清理记录：均已删除，原路径均不存在，owner/句柄/挂载检查及空间观察保留在原审计中。另1份进度快照指向其中同一根，不重复计数。全盘可用空间变化不当作专用目录字节总和。剩余`/private/tmp/agora-task123-validation-bX9Okg`无本轮归属证据，保持不动；Docker只读检查只见两周前或更早资源，未删除既有资源。正常依赖、共享缓存、用户项目、产品数据不清理。

日常原始输出继续放在Git忽略的`test-outputs/`；本报告是当前结论，复评文档保留契约解释用途，交接改为短当前状态，完整历史保留失败与过程。2026-09-29 Leader明确要求“提交推送”；功能提交`9d2b8fb`及PR #88已交付，等待人工审阅合并，代码任务仅在人类合并后标done。
