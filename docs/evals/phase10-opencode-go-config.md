# Task 10.5 OpenCode Go 评测配置

最终执行配置（2026-09-11）：正式入口为`phase10-final-v14`与`AGORA_GO_FORMAL_AUTHORIZATION=phase10-final-v14-usd5`，18项现已全部归档，0pending；不再发起请求。v11公开36项已完成并通过冻结结果hash引用；v14内部18项使用thermal-inspection/daily-availability，各multi/parallel/sparse重复3次。所有历史Go正式组共用原USD5账本，不重置。single及非mixed用deepseek-v4-flash，mixed的PM/ARCHITECT/REVIEWER用deepseek-flash，其他角色用deepseek-v4-flash。Go修复诊断请求额度16/16已用完，不增加诊断。最终对照见[Go最终报告](phase10-opencode-go-final-report.md)。当前修复/验证证据见[工具恢复与入口修复证据](phase10-recovery-scope-repair-evidence.md)。以下按时间保留历史配置，旧groupId及旧授权标识均不能代表当前入口。

历史v5修复状态（2026-09-10）：公开契约澄清将进入所有变体goal与TASK.md，保持PM无工具；public task version=4，默认新组phase10-final-v5，需显式AGORA_GO_FORMAL_AUTHORIZATION=phase10-final-v5-usd5。v5继续使用现有USD5 Go正式账本，缺账本禁止创建零费用替代。v4保留4次失败及USD0.073971504保守记账，暂未启动v5付费测评。详细方案见../reviews/task105-pm-public-contract-review.md。


[2026-09-10 Go正式组授权] Leader确认新54次正式测评独立USD5订阅配额折算总上限，formal=5/diagnostic=0，不合并旧官方USD20或Go诊断USD0.094028250账本。仅phase10-final-v4配合AGORA_GO_FORMAL_AUTHORIZATION=phase10-final-v4-usd5显式入口可执行；默认modelRequestsEnabled=false仍防误运行。冻结模型/任务/源码/镜像及预算后顺序执行；每次请求前检查持久停止标记，请求异常、缺有效usage、异常finish或系统性工具错误立即禁止后续请求，在途流自然结束；任一attempt非pass先停止整组审查，原失败与费用保留，源码修复须重新冻结新组。非空未知工具名仅允许一次原生纠正。预算不足请求上界时提前停止，绝不扩额。

以下配置调整阶段记录按时间保留；最新完整流程诊断见[证据](phase10-go-flow-evidence.md)。正式组预检、冻结及运行结果另行记录。

2026-09-10。Leader 已选择“OpenCode Go 的 DeepSeek”。随后明确 mixed 使用 deepseek-flash 与 deepseek-v4-flash，单模型使用 deepseek-v4-flash。本次调整后续 Eval 的模型 API 连接和角色映射，继续使用现有 DeepSeek Harness 执行器及官方压缩引擎。

| 项目 | 当前配置 |
| --- | --- |
| Provider | `opencode-go` |
| API base | `https://opencode.ai/zen/go/v1` |
| 模型 | mixed 的 PM/ARCHITECT/REVIEWER 用 `deepseek-flash`（V4.1 Flash），其余角色用 `deepseek-v4-flash`；single/multi/parallel/sparse 全部用 `deepseek-v4-flash` |
| 输入准入上限 | 65,536 Harness 启发式 token |
| 最大输出 | 32,768 token |
| 凭据来源 | 优先 `OPENCODE_API_KEY`，否则只读取本机 OpenCode `auth.json` 中的 `opencode-go` API 凭据 |
| 请求身份 | 原生 Harness User-Agent 与稳定的 `x-deepseek-harness-session-id`；压缩摘要也使用同一会话身份 |
| 计量 | `subscription-quota-equivalent-usd`；独立的 `phase10-opencode-go-quota-budget.json` |
| 执行开关 | `modelRequestsEnabled: false`，正式模型入口在准备实验和费用预留之前拒绝执行 |

配置源为 [model-profile.ts](../../tests/evals/phase10/final/model-profile.ts)，凭据解析为 [opencode-go.ts](../../tests/evals/phase10/final/opencode-go.ts)。本机 Go 凭据已确认可解析；没有复制到仓库、修改 OpenCode 配置或删除原 `DEEPSEEK_API_KEY`。在线鉴权、订阅剩余额度和实际响应尚未验证。

依据 [OpenCode Go 官方文档](https://opencode.ai/docs/go/)，本轮核对的高峰配额折算单价（每百万 token）为：V4 Flash 与 V4.1 Flash 均为输入 0.30、缓存读取 0.006、输出 1.20。高峰为 UTC 工作日 01:00–04:00 和 06:00–10:00，其余时段减半。此处是订阅额度折算，不能直接当作额外现金账单，也不与官方 DeepSeek 历史费用合并。

默认未来组名改为 `phase10-final-v4`，尚未冻结或创建该组，也未创建 Go 配额账本。旧 v3 的 54 次结果和 349 份冻结源码保持，哈希逐项核对一致。旧官方账本仍为 USD8.472523904，零未结算请求。代码中原有额度参数并不构成 Go 新实验预算授权；重新运行前需要确定新的小规模诊断及配额预算。系统性错误或失败集中出现时应停止新增 attempt，等待在途请求自然结束，先修复并做最小验证。

本轮验证：

- 定向离线测试：10 文件、34 项全部通过。真实 Harness/DeepSeek adapter 执行请求序列化、SSE 解析和计量，外部 HTTP 回复由测试夹具提供；覆盖 Go 路由、会话头、压缩请求、凭据拒绝回退及官方费用隔离。日志：`/private/tmp/agora105-opencode-offline-final.log`。
- `pnpm typecheck` 通过。日志：`/private/tmp/agora105-opencode-types-final.log`。
- `pnpm lint` 通过，373 文件零违规。日志：`/private/tmp/agora105-opencode-lint-final.log`。
- 候选变更未匹配到本机已配置 API 凭据；历史冻结文件和账本审计通过。本轮在线模型请求数为 0，没有重跑正式实验。

本轮没有运行包含真实模型调用的完整 `pnpm test`，没有把离线结果表述为 Go 在线 G5 验收。上一轮 1,114 项完整回归结果属于当时源码，不代表本次连接调整后的全量验收。

同时纠正上一轮 G3 记录：原 typecheck 日志实际包含新增投影测试夹具的类型错误（多余数组 spread 使 `Message.type` 拓宽），先前误报通过。现已移除该 spread，断言不变，并重新通过 typecheck；历史 [修复证据](phase10-repair-evidence.md)、[指标](phase10-repair-metrics.json) 和私有审计均注明更正。Task 10.5 保持 `in_progress`，未 commit/push。

模型组合调整后的验证：先观察到 3 项预期失败，再更新路由、准入模型清单和单价；定向离线 10 文件 / 34 项全部通过，typecheck、lint 通过。HTTP 测试覆盖两个 Flash 模型各自的主请求与 compaction 请求，并确认后续 Eval 拒绝 Pro；旧 Pro 仅保留于独立的官方回归配置和历史实验。日志为 `/private/tmp/agora105-flash-mix-{red,tests,types,lint}.log`。本轮模型调用数仍为 0，未运行完整在线回归或新增实验。V4.1 Flash 的角色定位采用 Leader 指定的实验分工，不将其写作已实测的能力结论。

后续状态：Leader已授权独立的小规模在线诊断，正式54次入口仍暂停。诊断发现Go的usage有时省略缓存拆分，现按全部输入未缓存计算明确标注的配额上界，不修改usage；缺少输入/输出或非法值仍停止。此前“0次在线请求”仅指配置调整阶段。在线结果和预算见[诊断证据](phase10-go-diagnostic-evidence.md)。

[2026-09-10 v5冻结完成] 359份源码快照已验证，54pending，线上尚未开始；公开澄清和完整回归的具体结果见[修复证据](phase10-public-contract-repair-evidence.md)。混合路由集成fixture遗留Pro断言已更正为deepseek-flash，正式模型配置未再改变。Go正式累计USD0.073971504/剩余USD4.926028496，本轮未新增Go请求。

[2026-09-10 工具循环修复] v5已停（1fail/53pending），新默认组改为v6，正式入口授权标识phase10-final-v6-usd5；同用原USD5账本，当前正式累计USD0.089858826，剩余USD4.910141174。模型/连接/65536上下文及32768输出上限不变；重复工具故障自动停组、空patch说明同源和失败trace留档修复正在全量验证，不允许用修改后的源码恢复v5。Leader已明确授权任务提示及工具结果向Go传输，修复本身不追加模型请求。

[2026-09-10 grade排序澄清与v7] 当前默认/允许正式组为phase10-final-v7，授权标识phase10-final-v7-usd5；公开version5，holdout1。已完成50项相关测试和真实Docker正反例预检，359份源码冻结，沿用现有USD5账本，停止和修复权限不变；历史v6两pass两fail保留。详见phase10-grade-order-review.md。

[2026-09-10 当前v8] 当前默认/允许组phase10-final-v8，授权标识phase10-final-v8-usd5；public包装6/holdout包装2，统一Node20且无GitCLI的环境说明已真实预检并绑定hash，业务任务和隐藏验题不变。继续共用原USD5账本，恢复前剩余USD4.845611168；证据phase10-environment-repair-evidence.md。

[2026-09-10 v9冻结/恢复] ARCHITECT入口修复通过最终1148项全回归、typecheck/lint及Docker正反例；v9组932106e23102bb3fd383285940614084676696a45b4e042c81de187effffbaca，源码2d8ef87c0c2148bb8eca5fcf9a9819236978936bd76356a9b9a299faf5395375，360份快照逐哈希验证。54项任务/seed/角色模型记录与v8完全一致，公开version6/holdout2不变。启动前Go正式累计0.266488206/剩余4.733511794，0未结算；继续原授权，同一USD5账本，日志/private/tmp/agora105-go-formal-v9.log。官方全回归费用审计缺口单列，暂停新的官方付费回归，不混入Go结果或费用。
