# Task10.5 Go完整流程小规模试跑

2026-09-10，Leader“继续下一步”授权。使用自有answer42小题，顺序执行一次single和一次mixed；不使用正式题或holdout，不重跑54次组。沿用前一阶段同一诊断账本，原USD0.50配额上限不变，开工前累计保守占用USD0.078770214、19次请求；本阶段最多新增40次请求。请求前检查时间/额度/停止标识，provider失败、未知usage或系统性工具错误停止后续请求，不截断在途token流。任一流程结果不通过即不启动下一组。

入口：tests/evals/phase10/go-flow-diagnostic.eval.ts。复用正式runSingle/runMulti、Harness、MCP工具、Docker与Git实现。single全部deepseek-v4-flash；mixed的PM/ARCHITECT/REVIEWER使用deepseek-flash，其余角色deepseek-v4-flash。固定一项executionPlan，实现answer.mjs导出answer()返回42，模型自写Node测试，独立Docker验证器另行验题。mixed继续通过既有D16 gate和预设诊断Leader批准动作；校验批准绑定当前已验证产物，不用模型自行批准。

执行记录保留模型路由、用量、源码哈希、镜像身份、官方会话、验证结果及cleanup证据。原正式入口modelRequestsEnabled=false。本试跑不构成统计对照或正式成功率。

环境预检首次在模型调用前停止：Dockerode按agora-benchmark:task105标签inspect返回404，不能据此认定镜像缺失。后续只读核对确认listImages中的标签唯一指向sha256:198dba14be3e05a6c663d97f2bdc53a8c5a3c32c50b090f665f131b8d9812934，与原锁定镜像一致；按该ID inspect成功（arm64）。入口改为从标签列表唯一解析后按ID检查，未重建或替换镜像。该预检未发出模型请求；首份日志/private/tmp/agora105-go-flow-live.log保留，后续日志/private/tmp/agora105-go-flow-verified-image.log。

首次single模型试跑phase10-go-flow-single-model-a1-b998450c-9568-4daa-8ddc-5ff8ae7d0592在1次请求后停止，mixed未启动，cleanup通过。官方工具记录证明fs_read成功，模型随后选择未提供的bash（可用工具实际为sandbox_run），并非上一阶段空工具身份覆盖。原诊断将一次非空未知工具名也当作系统故障，阻断了Harness已有工具错误反馈路径。明确调整为：一次非空未知工具名允许由原生loop纠正；同一历史错误重投不重复计数，第二个不同callId错误、空工具身份或基础设施故障停止。无工具别名映射、额外权限或新增模型循环；离线策略回归通过。第一次失败保持fail并计费USD0.00025425，不改写旧结果；累计额度此时USD0.079024464。

本阶段40次请求上限从同一账本中的go-flow请求累计计算，后续重启也不重置。调整后的运行日志/private/tmp/agora105-go-flow-bounded-recovery.log。

## 完整流程结果

| 配置 | 结果 | 模型请求 | 工具调用 | 耗时 | 配额折算/上界USD |
| --- | --- | --- | --- | --- | --- |
| single重试 | final/pass | 8 | 10 | 20.380秒 | 0.001448400 |
| mixed | final/pass | 19 | 24 | 129.991秒 | 0.013555386 |

single成功runId为phase10-go-flow-single-model-a1-b372c455-6264-4c9b-8907-5d44a70fd9c7；mixed为phase10-go-flow-mixed-model-a1-d1d207b8-b4d7-4b1f-947b-4afdb294cb9c。两组均通过独立Docker验题（exitCode=0、未超时）和cleanup检查，路由与固定模型配置逐请求核对一致。mixed的PM/ARCHITECT/REVIEWER实际使用deepseek-flash，CODER/TESTER实际使用deepseek-v4-flash；第一轮完成，2项波次测试通过、返工0、D16 completionBound=true、gate及最终worker lease均为0。Fork=0符合本次无paused worker的完成终审路径，不代表重新验证了真Fork。

包含保留的首次single失败，本阶段共28次请求，新增保守额度USD0.015258036；加上前一阶段，累计47次请求、USD0.094028250 / 0.50，零未结算请求。首次环境预检未调用模型。未启动正式54次组，旧v3的349份冻结源码及官方费用账本不变。

## 收尾观测修正

mixed原始resources.containerPeak=0不可用：Docker Desktop的listContainers挂载路径为/host_mnt/...，旧采样使用宿主taskRoot直接比较，漏计真实容器。原始运行证据不改写，对外containerPeak标记unknown。新增mountBelongsToTask处理已实测的Docker Desktop前缀及macOS路径别名，保持目录边界匹配；采样与cleanup查询共用该函数。真实无模型容器检查确认修复后运行中计数1、清理后0，证据.data/evals/phase10-go-flow-mount-audit.json。另以修复后的查询独立核对三个试跑目录均无遗留容器，因此本次资源清理结论有独立实测支撑。此修复不重跑模型，不补造本次容器峰值，也不更新旧正式组的观测值。

镜像按标签inspect返回404的问题已统一修正到公开/holdout预检及正式prepare入口：唯一标签列表解析→按不可变ID inspect→校验身份；缺失、歧义或漂移仍拒绝。只读真实API验证取得同一锁定镜像。上述收尾修复发生在两组成功运行之后，运行源码哈希仍保留；未把旧运行指纹冒充新源码实测。

最终离线回归14文件/37项通过，pnpm typecheck通过、pnpm lint通过（384文件）。日志/private/tmp/agora105-go-flow-final-{tests,types,lint}.log。没有运行包含其他真实模型调用的完整pnpm test。Task10.5保持in_progress，未commit/push；摘要与证据哈希见phase10-go-flow-metrics.json。
