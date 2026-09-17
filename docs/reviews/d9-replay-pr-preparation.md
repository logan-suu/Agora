# D4/D9重复裁决修复：交付准备记录

日期：2026-09-17；基线`55d6385a8387634864886dfdec38a8d9b1fa804e`，分支`codex/fix-human-gate-replay`。此为已交付12.3相关路径的后续维护，原任务done保留，实现已提交并发布[PR #87](https://github.com/logan-suu/Agora/pull/87)，等待人工合并。

## 问题与实现

worker已从paused正常恢复为running/done/failed后，重复同一`/resolve-gate`请求仍按paused集合校验，误报`conflicts with its first write`。修复分离不可变计划解析、首次Fork准入和历史动作重放：首次仍严格校验paused/source refs；已有规范resumed事实时核验Leader envelope、receipt、marker及worker/session连续性，只确认已应用，不再次调用resume或重开worker。

后来的合法gate保留；跨task/role/cwd、未知session、断裂lineage、丢失worker/计划、篡改回执/marker及旧gate异常重现均拒绝。marker之后另一次进程中断仍需正式任务恢复，不利用旧裁决重新执行。旧无per-worker计划格式保留适用兼容，不能删除已有分区证据冒充旧格式。

控制来源：详细设计§5要求“重启或同 actionId 重放从最新规范 receipt 续办，并复核其参数、checkpoint refs、resumeSessionId 与当前 State 后置事实”；D4保持“done/failed不重开”。蓝图§21、详细设计§5、架构§4.2及开发计划维护说明已同步。冻结Executor方法不变，内部只读safe-point身份增加sourceSessionId。无新产品依赖、不切换编排引擎。

## 验证证据

| 检查 | 实际结果 |
| --- | --- |
| 修复前HTTP/JSON回归 | 6失败/8通过，确认paused-only校验错误 |
| 最终定向回归 | 4文件57项通过；新增文件16项 |
| 静态门禁 | 全项目typecheck通过，lint589文件通过，原生helper构建通过 |
| 完整pnpm test | 7项脚本测试；227文件1768项通过，0失败/skip，1070.88秒 |
| 提供方 | OpenCode Go / deepseek-v4-flash，无换提供方或跳过 |
| G5 | 全量包含真实Harness/MCP、Docker既有路径与Phase12本机执行；另有正式本机D4/Fork后done/failed重复D9请求无新增生命周期/派工的实测 |
| 独立故障探针边界 | 曾遇STREAM_CLOSED，失败任务保留；另建固定输入任务完成5项LRU测试。图对账曾需人工回收自己fixture的owner锁，不作为产品自动恢复能力 |
| 本次准备 | 六份代码/测试hash与上述最终验证来源一致；未将旧测试记为本次重跑 |

完整测试日志SHA-256：`1e2c263094605a6149c191aaad5f3c4bd6209c4ff2c4128782a9fd62678c390a`。定向日志SHA-256：`f03fb34049dffbc602919efd685eae7d06c425520e1ab759bba9af36b1d5a8ec`。原始输出按TEST-CLEANUP在保存摘要/hash/必要失败后清理。

全量启动时599份来源中，最后一项同gate损坏防护及其测试在无关Phase0长测试期间补入；最终Web套件明确运行16项新增测试。不能声称全部来源在启动时已冻结。以下是最终六份来源，准备PR时再次核验一致。

| 文件 | SHA-256 |
| --- | --- |
| `apps/web/src/server/human-gate-replay.ts` | `78912a2785923154ffe48864f8248309aed661e9ad1e09621b7bc5b58ffdaf87` |
| `apps/web/src/server/message-runtime.ts` | `f49425917007549f243177fc65d889d50a6892082086e59cae13e242f1b759fc` |
| `apps/web/src/server/task-orchestration-runtime.ts` | `98689b7fe9f562a46010ef1be2adc9e65f35304b435d9e79d04b809fb9512a5b` |
| `packages/core/orchestration/src/human-gate.ts` | `6afe452fd3b69f8cf3fa9cf48918d117f7eb3d7473bbd472d461635aaf1c1353` |
| `packages/runtime/executor/src/harness-executor.ts` | `b3cb7af3a776d3082e2a9bd216f5c18637f6858f21c58e661a1f7c489413bb5b` |
| `apps/web/test/human-gate-replay.test.ts` | `442fbec232691062c8fd261278dc7ed896c4544299a8c04092693daf5084d025` |

复验入口：

```sh
pnpm build:sandbox-native
pnpm typecheck
pnpm lint
pnpm exec vitest run apps/web/test/human-gate-replay.test.ts apps/web/test/message-flow.test.ts packages/core/orchestration/test/human-gate.test.ts tests/integration/phase8/human-gate-lifecycle.test.ts
pnpm test
```

## 审查、清理与交付边界

CodeRabbit CLI 0.7.6的首次广范围外传被自动审批拒绝，未启动审查。随后Leader明确允许7路径当前内容及4份代码基线版本，在不含remote或其他材料的隔离仓库执行审查；首次CLI因缺默认基线退出，显式指定review-baseline后完成，退出0并返回0 issues，完成事件列出全部6份变更代码/测试文件，AGENTS.md作为配置。没有新增代码修改；结果仅覆盖获批范围，不替代真实门禁或人工合并。当时产出为可审阅补丁和英文PR草稿；后续发布状态见文末。

本次相关实验此前清理两fixture及专用依赖83933142逻辑字节，回归输出/专用中间文件377份4049799字节；空间分别观察增加103247872/4845568字节。保留了必要失败、版本、源码/日志hash和清理事实；没有删除用户项目、正常依赖、产品数据或已安装应用。后续派工协议实验另有独立清理，不作为本PR执行能力覆盖。

获批范围审查完成后，核验专用目录身份、无句柄/挂载并删除51份文件（318880逻辑字节）及临时路径指针（727字节）；共享卷可用空间观察增加372736字节，不声称独占回收量。必要结果、失败、版本与hash已保留。

D9补丁单独交付运行时修复、测试和正式来源修正。本补丁不包含LangGraph候选方案、独立实验依赖或任务迁移路线；它们保留在原工作目录待另行审阅。D9代码已提交/推送并发布PR，人工合并仍待执行；12.4及产品引擎迁移未启动。

## 发布授权与提交前复核

Leader于2026-09-17明确授权提交、推送这份13文件D9补丁并创建面向dev-1.0.0的PR。发布前重新typecheck、lint589文件通过；源码hash匹配上述实测版本，完整回归和G5沿用原证据，未重复计费测试。LangGraph候选与实验附件仍不纳入此提交；合并由人类执行。

CodeRabbit完成日志SHA-256：`92ffccecb23809717a2291ca83e78244189f7a3639436d3833989c63d7c949c3`；缺基线失败日志SHA-256：`67c772357d0861888bac37c076fc7811f5bb9875760ed8474c047ba89b465f5c`。必要完成事件为`review_completed / findings=0`，列出上表六份变更来源；原始重复输出已按前述范围清理。

## 发布记录

实现提交`c41c3e6a8c0c45e581cb0302f1043151d7515b9b`已推送，PR：[#87](https://github.com/logan-suu/Agora/pull/87)，目标`dev-1.0.0`，13文件范围已核验。尚未人工合并，原12.3已完成状态及阶段保持。发布后清理已被远程提交和PR正文替代的patch/清单/草稿3份，共66876逻辑字节；审查结果与必要失败证据保留，独立研究材料未动。本次文档收尾没有修改已验证源码。

**2026-09-17 PR范围扩展：** Leader随后明确要求将D19契约定稿、正式任务登记及必要实验一起提交到PR #87。上述13文件与“独立研究不随补丁”是D9初次提交的时点边界，当前PR增加设计材料；产品修复仍为原六份已验证来源，新增设计未获原CodeRabbit全范围审查。详见[定稿审阅](langgraph-registration-20260917.md)。
