# Task10.5 ARCHITECT 交付边界修复

2026-09-10。v8第三次mixed在4个完整供应商响应后失败，自动停止后续47个样本。v8保留5pass/2fail，所有211个历史正式Go请求已结算，共享账本USD0.266488206；本次失败4请求/USD0.005936106。此前multi-1重复输出的失败单独保留，不能把未执行的独立验题当成代码判错。

三个假设按证据核对：供应商传输失败（四次stop/tool-calls、usage完整，不支持）；模型计划字段位置错误（原始最终JSON明确把executionPlan放顶层）；解析器静默丢弃该字段（已确认）。角色提示要求architecture.executionPlan，旧解析器只提取architecture/conventions并提交，然后协调器把对象modules当legacy字符串列表处理而失败。应在纯交付校验入口拒绝，使用既有格式恢复，而非把无效结果写入State后才失败。

修复只接受architecture/conventions两个顶层键；显式计划仍按既有领域DAG规则校验，无显式计划则复用executionPlanFromArchitecture校验legacy字符串modules。合法字符串列表、空/缺省模块的原有顺序退化保持；对象modules须搭配有效嵌套计划。角色提示同步说明这一限制。宿主不搬动字段、不补造计划、不修改候选程序或验题代码。

TDD先复现4项失败：多余顶层键、对象legacy模块被接受，以及真实Harness未启动格式修复。修复后相关3文件25项通过；Harness回归证明错误回答触发第二次请求，修复请求无工具，读取mutations恰一次且只接收正确回答。既有最多两次额外Step、抢占优先与异议不进入格式恢复的测试保持。typecheck和lint389文件通过。完整回归151文件1148项全过（379.91秒，0 skip），真实Docker预检99公开断言/4负例/12PM投影/2holdout正反例通过。

历史v3/v4/v5/v6/v7/v8各349/357/359/359/359/360份源码快照均逐文件SHA256复核无变化。v8保持停止，修复后另冻v9，公开version6/holdout包装version2、原任务/隐藏验题和模型组合均不变，继续共用USD5账本。

原始审查：`.data/evals/phase10-final-v8/stop-reviews/grade-school-mixed-3/review.json`。日志：`/private/tmp/agora105-plan-red-final.log`、`/private/tmp/agora105-plan-green.log`、`/private/tmp/agora105-plan-full.log`。

费用审计更正：本次完整回归命令漏设AGORA_EVAL_BUDGET_FILE，旧官方账本8.536625848不包含本轮真实模型费用；新增费用和请求数unknown，不能报零或把旧账本当完整当前总额。测试通过证据不受影响。已将缺口记录至.data/evals/phase10-regression-audit-gap-20260910-plan.json，不伪造usage/请求、不为了补账重复付费测试；新的官方付费回归先暂停，待显式费用审计解决后方可恢复。Go正式账本独立且始终执行USD5门禁，未受该缺口影响。

[2026-09-10 v9冻结/恢复] ARCHITECT入口修复通过最终1148项全回归、typecheck/lint及Docker正反例；v9组932106e23102bb3fd383285940614084676696a45b4e042c81de187effffbaca，源码2d8ef87c0c2148bb8eca5fcf9a9819236978936bd76356a9b9a299faf5395375，360份快照逐哈希验证。54项任务/seed/角色模型记录与v8完全一致，公开version6/holdout2不变。启动前Go正式累计0.266488206/剩余4.733511794，0未结算；继续原授权，同一USD5账本，日志/private/tmp/agora105-go-formal-v9.log。官方全回归费用审计缺口单列，暂停新的官方付费回归，不混入Go结果或费用。

[2026-09-10 v9逐次停止审查] 截至22条final为19pass/3fail。wordy-mixed-1非法异议控制尾标记保留模型协议失败；wordy-multi-3与book-store-multi-2出现连续相同成功读取/检查且无新工具证据，人工停止后续请求，等待当前响应自然结束，分别保留25请求/USD0.039911988与24请求/USD0.036405366。三次均未到独立验题，不能记作候选代码判错。后一案例读取范围明确为0-based字符[0,120)，工具返回120字符前缀正确；官方解码证明不同callId、唯一事件序号，连续五次完整响应片段哈希相同。真实Harness+MCP文件读取+实际Go序列化的离线HTTP截获2项通过，历史工具结果和ID完整，未复现上下文丢失；模型与服务端产生重复的具体根因仍inconclusive，不盲目修改执行契约。0新增外部模型诊断，证据见各组stop-reviews及/private/tmp/agora105-go-wire-retention-audit-final.log。360份执行源哈希一致，清理与路由pass、final lease=0、无关联容器/执行锁/未结算；Go共享累计USD0.703525716。按既有授权保留失败，继续v9后续32项，未重置预算或重跑失败项。成功调用无进展目前由人工观察停止，不能宣称已有自动检测。

[2026-09-10 v9半程] book-store-multi-3再次在REVIEWER出现相同完整测试文件读取和固定commit diff；人工停止后保留26请求/USD0.030353694，独立验题未执行。连续响应片段与结果哈希、独立callId及事件序号见该trial的stop-reviews；这次没有字符range，复用前述离线验证，不追加付费重放。27条final为23pass/4fail（其中3次人工停止），27项尚未执行，Go共享675请求/USD0.831492528、0未结算，清理/路由pass、lease=0、无关联容器/执行锁，360源哈希一致。只读观察采样缩短为5秒以更早识别快速重复，不改变冻结执行规则。另一次费用折扣怀疑经Go官方价目表核对排除，预防性标记在观察到任何拒绝前撤回；book-store-single-2正常通过、0供应商失败，证据在accounting-review-20260910，未调整金额或重跑。

[2026-09-10 v9停止与归因纠正] v9最终停于29条final（24pass/5fail/25pending），Go共享717请求/USD0.911844144、0未结算。后续新增真实Go输入顺序断言证明每个工具结果后会追加新的完整投影用户指令；此前历史保留测试未覆盖该缺陷，不能继续将重复输出归为纯模型/服务端问题。D1修复及一次空摘要请求的审查见 [投影输入修复证据](phase10-projection-input-repair-evidence.md)。旧结果与冻结源码保留；本段是新增证据，不回改原判分。
