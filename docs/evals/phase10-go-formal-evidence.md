# Task 10.5 OpenCode Go 正式组

2026-09-10。Leader在完整流程诊断后授权新54次正式测评，并明确独立USD5订阅配额折算总上限。该额度不与官方直连历史账本或Go诊断账本合并；不是额外现金账单。

- 组：`phase10-final-v4`；54个预注册attempt。4个公开题×single/multi/mixed×3次，2个holdout×multi/parallel/sparse×3次。
- mixed的PM/ARCHITECT/REVIEWER为`deepseek-flash`，其余角色及其他组为`deepseek-v4-flash`。
- 组指纹：`59844577ea42c46f43fcb5b97e64d081aca50991fcfb57518a6409e9f753acf1`。
- 源码指纹：`c0074bbcfe6dab74345e2ff2cddfb18d9e2638a2342fb546a933324f783f02ff`；357份源码副本逐项SHA256验证，位于`.data/evals/phase10-final-v4/frozen-source/`。
- Docker镜像：`sha256:198dba14be3e05a6c663d97f2bdc53a8c5a3c32c50b090f665f131b8d9812934`。
- 正式账本：`.data/evals/phase10-opencode-go-quota-budget.json`；total/formal均为5，diagnostic为0，逐请求先预留上界再结算。有效usage缺缓存拆分时保守按输入全未缓存，缺输入/输出仍unknown并停止。
- 默认入口不自动授权；仅显式`AGORA_BENCHMARK_GROUP=phase10-final-v4 AGORA_GO_FORMAL_AUTHORIZATION=phase10-final-v4-usd5`允许执行该组。

执行前新增请求级持久停止检查，覆盖异常请求/结束原因/usage及系统性工具错误；每个attempt非pass先停止整组审查，已开始但未final的attempt也禁止未经审计重启。停止不会硬杀在途模型token流。首次停止原因不可被后续重试覆盖。冻结后源码不变；如发现需修复的源码问题，保留本组及费用，修复验证后重新冻结组。

验证：15文件42项定向离线测试通过；typecheck、lint通过。真实Docker公开4题与holdout2题正反例预检通过，冻结入口通过；上述步骤不调用模型。没有把定向测试表述为完整`pnpm test`。日志：`/private/tmp/agora105-formal-{offline,types,lint,preflight,freeze}.log`。新增停止检查先观察缺模块失败，再实现并验证下一请求不进入provider、unknown不抹除及首次停止原因保留。

正式运行日志：`/private/tmp/agora105-go-formal-v4.log`。当前运行结果以私有组`group.json`、`report.json`及独立账本为准；最终结果待运行或停止后补充。旧v3结果与官方账本保留，禁止跨提供方汇总成功率。

本次停止结果：首题`grade-school-single-1`在第2个模型请求发生`STREAM_CLOSED`。官方JSONL中有已返回内容，最终error为“SSE stream ended without [DONE]”；官方adapter源码在响应字节流自然结束但无终止标记时抛出该错误。未发现本地timeout/abort/context-limit证据；具体上游/网络断开原因仍inconclusive，不能通过放宽解析或编造usage修复。自动停止后未发起第3个请求，未启动第2个attempt，最终1失败/53未启动。该数据不支持模型质量或方差结论。

已结算配额USD0.000365100，1项未知usage保留USD0.058982400预留，占用上界USD0.059347500；实际总额仍unknown，不将预留称为实测费用。保持停止标记和unknown记录，不继续54次批量运行。原始结果与预留均保留；cleanup真实通过，独立Docker Desktop检查零遗留容器，审计位于组目录cleanup-audit.json。新357份和旧v3全部349份源码快照哈希核对一致。详见[指标](phase10-go-formal-metrics.json)。Task10.5保持in_progress。

后续排查澄清：官方adapter延迟发布usage/finish至DONE，旧JSONL未记录usage不等于原HTTP无usage。2次授权同内容请求重放均完整成功，原断流未复现；详细边界和额度见[断流排查](phase10-go-stream-investigation.md)。正式组仍停止，原始结果和未知预算不变。

[2026-09-10 Go正式v4恢复授权] Leader在两次传输重放成功后要求继续。357份冻结源码哈希不变，原grade-school-single-1失败保留，从grade-school-multi-1恢复。显式operator audit将未知请求bff36374-1259-4301-af4e-8641bb5e07bf按原预留USD0.058982400保守记账，保留previousStatus=unknown/audit原因及budget-before副本，不伪造usage或修改旧result。恢复前正式账本占用USD0.059347500，剩余USD4.940652500，total/formal仍5。停止文件归档到组resume-audits/2026-09-10T15-48-16.154Z，再解除标记；任一新异常仍自动停组。日志/private/tmp/agora105-go-formal-v4-resume-1.log。

[2026-09-10 Go正式v4继续后停组] 恢复后multi-1/mixed-1/multi-2均失败并逐次停组审查：两次PM写入与公开测试冲突的跨年级重复添加要求，ARCHITECT正确blocking；mixed为PM将concern控制块置于JSON前导致严格协议拒绝。当前4个final/fail、50pending、累计9请求，正式保守记账USD0.073971504（含原未知预留审计），0未结算，原usage未知不伪造。重复冲突表明PM无工具但goal要求读公开测试的输入缺口需要评审；已向Leader提出公开契约澄清+保留v4+共用USD5新冻结54次方案，等待选择前保持停止，不修改冻结源码。详见docs/reviews/task105-pm-public-contract-review.md及docs/evals/phase10-go-formal-continuation-metrics.json。
