# Task10.5 实施与预检证据

2026-09-09，分支`feat/phase10-final-benchmark`。Leader已确认实施计划及USD20总模型预算；任务保持in_progress，尚未提交或创建PR。

## 真实环境和判定

- Aider Polyglot JS来源commit：`7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f`；按官方helper commit `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`启用全部xtest。
- grade-school/wordy/book-store/forth分别10/23/17/49测试；四个参考解均通过、四个空实现均失败，合计99测试且零skip。
- 内部订单审计/排班冲突任务已冻结精确接口和DAG；独立Node验证器参考解通过、空模块失败。参考实现/判定脚本不进入Agent工作区。
- 镜像用提交候选中的固定package-lock执行npm ci重建；image ID为`sha256:198dba14be3e05a6c663d97f2bdc53a8c5a3c32c50b090f665f131b8d9812934`，基础镜像digest固定。`.data/evals/phase10-preflight/{preflight,holdout-preflight}.json`保存正反结果与镜像身份，`verifier-reports`保存原始判定及输入哈希；判定后复核代码/测试/config未改变。
- `pnpm eval:phase10:preflight`最终锁文件镜像复验2个预检通过；选择器未运行其他历史Eval，不把未选中的历史Eval计为通过，也未在默认回归中排除任何测试。

## 驱动与机制

`tests/integration/phase10/phase10-benchmark.test.ts`初版四个真实工具链检查通过：单solver Harness/MCP/Git/Docker；生产多角色并行→验证→终审→归档；首个CODER canonical commit后的正式需求更新及稀疏Channel投影；混合角色实际请求模型映射。只有外部LLM输出脚本化，所有工具、State、沙箱、lease和回执来自真实实现。

初次驱动检查发现两个接缝假设错误并修正：预先initialize任务会使正式start返回interrupted；固定场景前史应在产品初始化后、首次投影前以COORDINATOR的eval_scenario_background经MessageService提交，不能旁路D9创建Leader结构化handoff。完成gate时全员done不会Fork，恢复composition后不重开done worker才符合D17。最终检查断言规范恢复计划为空、worker Fork数为0，不能用此宣称paused Fork覆盖。全量回归中的`phase9-parallel-flow.test.ts`已独立验证TESTER在0/2个真实工具后暂停并产生一个真正lineage child，未改变该测试断言。

单solver采用真实linked worktree与Docker同路绑定，Git提交/产物快照期间冻结容器写入；独立Verifier只接收允许的候选源文件，初版v1模型拿不到上游测试；Leader随后批准v2将公开测试作为可读契约，参考解、独立Verifier配置与宿主凭据仍隔离。首次/重投影/恢复均使用同一Channel策略接缝；mixed实际请求模型将与官方session角色交叉核验。

## 计费诊断与回归状态

新增预算台账在请求前耐久预留，区分正式/诊断额度，保留未知和中断请求；未知费用阻止后续调用。三笔早期诊断请求由于旁路响应采集未取得usage而锁住后续请求。最小真实G5显示模型回复本身通过，但`response.clone().text()`在官方正常关闭流时得到`DeepSeek stream consumer stopped`。新增取消流用例复现该问题，改为在原消费流逐块采集、原样转交每个字节，并匹配官方`prompt_tokens - cached_tokens/cache_hit`映射。

前三笔保留unknown历史和显式审计，按各自完整峰值预留量合计约USD1.02占用预算，这是保守上界而非实测账单，未把缺失计量改成0，也未增加预算。修正后的最小真实G5与计费审计均通过，后续usage正常结算。完整原始预算与审计元数据在`.data/evals/phase10-budget.json`及其`.audit.jsonl`，不包含凭据。

完整冻结源码回归已通过141文件/1098测试（630秒），包含真实LRU、Channel摘要和Harness G5，0失败、未skip。此前一次LRU真实模型输出`invalid agora objection: expected one final control block`失败已保留；控制块解析按现有规格fail-closed，未放宽断言或解析器。既有开发凭据保留，模型实测费用纳入同一诊断预算。四个驱动检查最终独立复验通过（41.8秒）。

随后使用不属于公开集或holdout的`answer()=42`小题实跑模型驱动：单solver通过10次模型调用；mixed在TESTER阶段被评测侧错误的65536字节限制阻断，13次已发生调用保留并计费。该限制比预期64K token小得多，会扭曲比较，正式attempt仍为零。修正为复用锁定Harness TokenMeter的消息估算，纳入system/tool定义，按65536估算token做准入；这仍是启发式估算而非精确tokenizer，实际用量另存官方usage。费用预留使用更保守的序列化字节上界。新增大字节数但低于token估算限额的回归，新增单元合计16个通过，typecheck/lint通过。

修正后真实诊断v2两条链均通过（205.9秒）：single 13次调用，mixed 19次调用；混合组实际PM/ARCHITECT/REVIEWER请求Pro，CODER/TESTER请求Flash，并与官方session角色交叉核验。mixed输入最大85121字节、Harness估算18927 token，经过可信测试、D16终审和归档。诊断结果分别位于`.data/evals/phase10-driver-diagnostic-single-model-a2-54181607-ec0d-495f-8519-ab9636b21814`与`phase10-driver-diagnostic-mixed-model-a2-325fac13-2686-48fa-ae14-e93b7afd2f21`。v2运行前发生本地Docker标签查询404/重绑定500，但原镜像ID始终可读，随后原标签恢复；失败发生于镜像inspect、没有发出模型请求，镜像内容未替换。诊断结束时台账占用USD1.132921028（含上述保守审计上界），正式预算未使用。该修正的全量回归结果见下文。

两份全部54条均pending的预注册草稿保留在`.data/evals/phase10-final-v1-preregistration-draft`及`phase10-final-v1-preregistration-context-draft`，分别记录正式Leader入口和上下文计量修正；均无正式模型暴露，最终组须待修正验证后重新冻结。

本文的以上记录为v1启动前预检与研发诊断，不能作为Benchmark结果或对外能力分数；v1停止及v2验证见下文。

最终上下文修正后的首次完整回归执行了全部1099测试：1097通过、2项Phase9真实流程在原60秒限额超时（架构返工、合并冲突恢复），日志`/private/tmp/agora105-regression-final.log`。其余140文件通过，包含新增四个驱动检查和真实模型G5。未修改测试/生产代码，两项隔离复验按原断言/原时限均通过（36.1/40.5秒），日志`/private/tmp/agora105-phase9-timeout-recheck.log`；该命令选择器显示的9项未选中已在完整回归执行，不将其计为本次隔离通过。现有证据无法区分Docker临时阻塞、资源争用与未稳定复现的流程竞态，根因记inconclusive；随后整套回归结果如下，不以重跑抹除失败历史。

最终整套确认回归通过：141文件/1099测试，0失败、0 skip，540.85秒，日志`/private/tmp/agora105-regression-confirmation.log`。两项超时用例在本轮分别21.9/11.7秒通过，全部原断言/时限保留。G3 typecheck/lint与16个新增单元通过，G4已获得完整通过记录，真实模型G5均执行。正式组冻结前预算累计USD1.198816112，其中USD1.01930048为三笔显式保守审计上界，正式USD0，无未知或在途费用。

## 要求与证据索引

| 要求 | 本次入口/证据 | 边界 |
| --- | --- | --- |
| 上游Outcome保真、完整覆盖及负对照 | `tests/evals/phase10/final/preflight.eval.ts`、`public-adapter.test.ts`；四题99测试正反结果 | 不等于模型解题成功 |
| 新holdout独立判定 | `holdout-preflight.eval.ts`；订单10项、排班8项Node断言正反结果 | 参考解不进入模型工作区 |
| 单Agent实际执行 | `phase10-benchmark.test.ts`的single用例；answer42真实single诊断 | 无产品终审/Fork，不伪造适用检查 |
| D17波次、D16终审及归档 | 同文件multi用例；answer42真实mixed诊断 | done worker不重开，完成gate本身不证明Fork |
| 正式需求更新及R2上下文裁剪 | 同文件sparse用例、`context-policy.test.ts` | 只裁剪已授权Channel条目；效果须看正式样本是否触达 |
| 真实paused Worker Fork | 既有`phase9-parallel-flow.test.ts`中暂停于0/2个工具后恢复用例；本次全量回归 | 独立机制回归，不算新holdout成绩 |
| 实际模型/角色映射、预算和token计量 | mixed驱动用例、`model-adapter.test.ts`、answer42实际routes/usage | 别名不保证权重固定；上下文是Harness估算 |
| 请求先预留、未知费用停止、全部attempt保留 | `accounting.test.ts`、`manifest.test.ts`、`wire-usage.test.ts` | 审计上界与实测cost分列，不删除失败 |
| G3/G4、真实依赖与秘密隔离 | typecheck/lint、最终全量回归、候选文件秘密扫描 | 正式Benchmark不替代这些门禁 |

## 公开测试契约修正（v2）

Leader在v1发现公开题接口契约缺口后批准公开测试可读并重跑。原组保留13条final（11条正常结束、2条受操作暂停影响）、41条未启动，不与v2混算；USD0.489798432继续占用原正式预算。新组仍为54条，USD20总/17正式/3诊断上限不变。公开题version=2，内部holdout仍version=1且尚未暴露；组清单锁定每个实际模型seed文件哈希，预算身份增加组前缀。

新测试先红后绿：公开spec可读且全部xtest启用、参考解/config无泄漏、holdout只含原契约；版本组隔离费用；stop-requested只阻止下一attempt，当前链路自然结束。8文件20单元通过。真实链路检查增加模型经正式MCP读取公开测试契约的用例，5项通过（31.61秒），外部LLM脚本化但Harness/MCP/Git/Docker真实执行。typecheck/lint通过。v2全量回归通过：143文件/1104测试、0失败/0 skip，482.79秒，日志`/private/tmp/agora105-v2-regression.log`；原开发凭据、原断言/时限与计费审计均保留。全部请求结算，累计USD1.719824108（旧正式0.489798432、诊断实测0.210725196、保守上界1.01930048）。46个候选文件精确凭据扫描0命中，git diff --check通过。

## v2可读夹具与生产可信验证不兼容

v2正式运行发现：生产wave-validation的TEST_FILE同时匹配.test/.spec的mjs/cjs/js，故模型工作区中的原Jest .spec.js被无条件纳入可信Node命令。grade-school-mixed-1原契约哈希不变，但两次可信验证均因该文件失败（18/21项中各1失败），触发无效返工；并非模型改写契约或独立Jest判定错误。原新增可读回归只走single，未覆盖该多角色接缝，这是评测夹具覆盖遗漏。生产收集器/断言不改，修正模型侧为同内容.spec.txt并补实际taskDefinition→多角色真实验证。

v2于23:30:17 UTC按stop-requested在attempt间停止，无执行锁/未结算请求。3条final、51条pending均保留：single通过；multi ARCHITECT模型异议控制块格式失败；mixed受上述夹具缺陷导致返工，最终超过请求准入时长自然闭合，未截断token流。v2正式费用USD0.3067079，总台账USD2.026532008，预算不变；旧v1 USD0.489798432仍单列。v2不与修正组混算。修正组仍完整54条，因此历史已有16条加新54条共70条，不隐藏前两组支出或失败。

修复TDD证据：新增真实多角色回归在旧seed下失败，可信结果15项中wordy.spec.js失败（20.9秒），日志`/private/tmp/agora105-v3-red.log`；同时新路径/版本断言先红。仅改模型契约路径为.spec.txt及task/protocol/group版本后，9文件26项定向检查通过（112.54秒），其中6条真实驱动、新增多角色契约回归27.28秒，归档文本与原激活内容一致、原私有源不变。typecheck/lint通过（369文件），生产验证器/独立verifier/模型配置/预算均未改变。v3完整回归通过：143文件/1105测试，0失败/0 skip，612.76秒，日志`/private/tmp/agora105-v3-regression.log`；保留开发凭据和原测试断言。冻结前台账USD2.048121372（正式0.796506332、诊断实测0.232314560、保守上界1.019300480），无未结算项。

v3第14条后发生一次REVIEWER Pro传输中断，官方llm/retry code=TRANSPORT，无最终usage，后续请求被unknown-cost门禁阻止。清理确认通过、执行锁释放；审计按完整事前预留USD0.21920448占用正式预算，原result.costUsd及原用量继续unknown。未把失败重跑为新成功，原8小时组时钟和USD20/17/3上限不变；同组继续剩余40条。pause-after-14/resume-after-14/usage-audit与全局audit.jsonl保留审计证据。

## v3第二次传输审计与启动恢复

2026-09-10 UTC，book-store-multi-1的TESTER请求78ffaf6a-3f28-42de-9e09-ec12d47e32fc在26.161秒后以官方TRANSPORT结束，未返回usage。全部20调用有end、cleanup通过、执行锁释放、runner退出；按事前完整预留USD0.09873468完成显式操作审计。原样本成本/token仍unknown且失败保留，既不填零也不重跑。预算累计USD3.449002324后仅续跑pending，原组指纹、8小时时钟及20/17/3上限不变；证据见组目录pause-after-20、usage-audit-after-20与resume-after-20。

第一次续跑曾在attempt前遇到Docker标签inspect 404；按固定镜像ID inspect仍成功，校验ID与大小后将同一镜像重新绑定原tag，未重建或改变冻结输入，未新增attempt。startup-recovery.json保留该恢复记录。

## v3最终完整性核对

2026-09-10T03:19:59.555Z核对：54/54 final，54次safety.cleanup通过；340个manifest冻结执行文件与349个快照文件哈希均一致，执行锁已释放，预算无reserved/unknown未结项。正式命令因29条未通过按契约返回1，报告命令返回0，不能把实验执行完整等同模型任务全过。G4仍为冻结前最新143文件/1105测试全部通过、0 skip；冻结后没有执行源码变更。失败与未触达机制完整披露，合法advisory后的REVIEWER续行缺口仍未修复，不以该报告宣称产品出口完成。详见最终报告及机器指标；原始证据final-integrity-audit.json保留组目录。

最终文档检查：pnpm lint通过（369文件，0 fixes）、git diff --check通过；47候选文件最终安全扫描中，已配置开发API key精确匹配0命中、无.env/私钥文件。机器指标已JSON解析并递归核对，无prompt/projection/reasoning/arguments/results/apiKey/authorization/rawLog/display/goal原始内容字段。未再修改冻结执行源码，沿用已通过的typecheck与1105项全量回归，不增加或替换模型样本。
