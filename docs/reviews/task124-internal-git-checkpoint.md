# Task 12.4 内部 Git 历史检查点

> 本文保留各日期的实现边界、失败及验证证据；下文“当前”“下一步”“待完成”均指对应历史时点，不代表最新状态。最新工作入口见[会话交接](task124-next-session-handoff.md)，当前任务状态以 `docs/task-status.json` 为准，完整后续记录见[任务历史](../task-history/12.4.md)。

## 2026-09-22 当前检查点：部分证据已收尾，完整入口已纠正

期限修复90项定向、typecheck及lint通过。最新运行已退出0，但参数转发使实际命令为`vitest run 1`，只运行65文件408项及追踪7项，遗漏预期267文件中的202文件；不能记完整G4通过。原handoff和integration-service用例此次通过，仅为局部证据。原日志保留，覆盖审计见test-outputs/task124/git-deadline-coverage-audit.json；该部分运行证据已核验：51 Git/57原生/13 binding及23条证明引用；6个额外测试目录已清理29282逻辑字节，缺失的历史发布单元证明仍不记通过。收尾见test-outputs/task124/deadline-partial-closeout.json。

完整入口已改为直接向Vitest传递--bail=1，实际收集的267文件集合已核对且含四条真实模型链路；启动及结束都校验覆盖。运行状态见test-outputs/task124/deadline-complete-live-state.json；完成回归及收尾前G4仍未闭合。后续交付目标为“集成完成→独立TESTER真实验证”，来源/CAS/独立登记/共用启动屏障须接成完整链路，不能用计划或存储单元代替。任务剩余范围及边界见[开发计划§18.2](../开发计划安排.md)和[准备复评](task124-validation-preparation-review.md)；[完整历史](../task-history/12.4.md)。Task12.4仍in_progress，无新增完整产品G5，未commit/push/PR。

---

## 2026-09-21 上一检查点：Git期限误分类已修复，完整回归待完成

真实等待30.1秒复现了过期授权后metadata_invalid误报。现已在授权前后、所有Git/helper启动前和返回后核对原30秒截止时间，ETIMEDOUT明确归为local_git_deadline，过期不再补1ms执行窗口。90项定向、typecheck及严格lint通过，夹具均已留证清理。原失败期间有290秒闲置睡眠，环境关联已记录，原调用细节仍不完整。

汇总test-outputs/task124/git-deadline-targeted-result.json；[任务历史](../task-history/12.4.md)。修复后完整回归仍待完成，G4未通过；严格来源/CAS/登记/启动保持待办。未commit/push/PR。

---

## 2026-09-21 上一检查点：完整回归失败，原用例待诊断

交接用例635486ms后报local_git_metadata_invalid，后续批次已中断退出130；1353输入/7产物无漂移，G4未通过。已定位到首个分支应用确认后的复核，尚未进入handoff/TESTER，具体根因仍inconclusive。失败夹具已留证清理，中断夹具归档核验后清理228496逻辑字节。

汇总test-outputs/task124/dispatch-binding-incomplete-result.json；[任务历史](../task-history/12.4.md)。下一步仅原用例诊断，不改期限/断言；严格来源reader及后续CAS/登记/启动暂缓。未commit/push/PR。

---

## 2026-09-21 上一检查点：受信L2校验接缝定向通过，完整回归待完成

L3类型端口与实际Coordinator适配已实现，每次重读当前context/roster并固定原前态及完整准备身份，只返回两个精确阶段。新增17项先红后绿，与原28项合计45项通过；typecheck/严格lint通过。严格来源reader尚未接入，物理来源、registry与授权不由此端口证明；无新增TESTER执行G5。

完整回归与清理尚未完成，不沿用上一版本G4结论。执行记录见test-outputs/task124/dispatch-binding-active-checkpoint.json及[任务历史](../task-history/12.4.md)。下一步完成本轮回归，再接严格来源reader、精确CAS、独立validation登记与启动屏障。未commit/push/PR。

---

## 2026-09-21 上一检查点：唯一准备槽存储已实现并通过完整回归

内部LocalValidationPreparationRecords实现固定scope的单槽load/publish：引用对象完整回读后发布，重启读取复用原计划，同槽异参数、孤立对象冒用及损坏引用拒绝。真实owner重启、耐久后丢响应和竞争实例等13项存储测试通过；与既有28项规范派发共41项定向通过。来源对象的业务/原生关系仍由后续受信来源视图校验，存储记录不授予执行权限、不提交State或写准备confirmed。

1352输入/7原生产物/原HEAD冻结不变，完整pnpm test退出0：266文件2217项＋追踪7项通过，0skip，8639.39秒；typecheck及严格lint通过。四条真实Go deepseek-v4-flash链路通过，无fallback或正式Benchmark。124 Git/57原生/13 binding/26引用及新增13份存储夹具核验通过；新增存储夹具自清理18090逻辑字节，额外88测试入口清理449274逻辑字节，新增遗留0，保留两处旧共享VM占用根。

[本轮汇总](../../test-outputs/task124/validation-records-result.json)，SHA256 `8c7c9a6db1e34089d03b96bd6861eb282edeee64a798904e6fe1d600d47b6f91`；[完整历史](../task-history/12.4.md)。下一步严格准备来源视图及与已有L2校验器接合，再接精确CAS、独立validation登记和共同启动屏障。Task12.4仍in_progress，无新增独立TESTER执行G5，未commit/push/PR。

---

## 2026-09-21 上一检查点：TESTER耐久派发接缝已细化

接入前源码评审补齐单一槽发布/丢响应恢复、L2/L4分工及派发后的严格来源视图。唯一槽按project/task/wave/attempt/integration定位，计划固定action/dispatch；禁止双ref原子性假设、缺槽补造计划或放宽旧handoff读取。详见[耐久派发复评与故障矩阵](task124-validation-preparation-review.md#durable-dispatch-124)及详细设计§12.2.5。

本轮只同步文档，索引、7项追踪测试、严格lint及差异检查通过；生产/测试/构建未改。上一冻结版本265文件2204项＋追踪7项通过保持原归属，不代表新协议已实现。下一步编码唯一槽/对象记录和阶段来源视图，再接精确CAS；独立validation登记/启动屏障及TESTER执行G5仍待完成。Task12.4保持in_progress，无commit/push/PR。

[本轮规格核验](../../test-outputs/task124/tester-durability-spec-result.json)，SHA256 `b4a1140edea7aec64702143b459f9d371a00db222fc7a5b80a223d7088080c8e`；[完整历史](../task-history/12.4.md)。

---

## 2026-09-21 上一检查点：完成重入修正后完整累进回归通过

冻结1350个输入、7个原生产物及原HEAD，完整pnpm test正常退出0：265文件2204项及7项追踪测试通过，0skip，总9121.44秒；typecheck及严格lint通过。此前服务超时用例及清理初始化13项均通过，四条真实模型链路沿用获批OpenCode Go/deepseek-v4-flash、原任务/参数/期限，无fallback或正式Benchmark。

124份Git、57份原生夹具、13份binding及26条证明引用核验通过。核验身份、句柄、挂载和容器引用后清理88个本轮新增测试入口、449275逻辑字节，新增遗留0；2处旧共享VM占用根保留。原失败和逐调用诊断证据仍保留，原40分钟超时的具体触发仍inconclusive，不以本轮通过改写旧结论。

[本轮完整汇总](../../test-outputs/task124/completion-replay-result.json)，SHA256 `e7f719087f978b69afd4c3700ac5eb8e4c83c89f578a0edb15ea07e0eeb0e9c2`；[完整历史](../task-history/12.4.md)。G4通过；下一步将原完成handoff及完整规范TESTER派发计划接入耐久CAS，再接独立validation登记和统一启动屏障。Task12.4仍in_progress，无新增独立TESTER执行G5，未commit/push/PR。

---

## 2026-09-21 上一检查点：完成重入重复核验已收敛，定向实测通过

逐调用诊断原用例通过（1447498ms）；缺失原生历史约29.7秒拒绝，未复现挂起。确认已完成重入先history再read重复遍历相同证明；原全量40分钟超时的具体触发仍未确定。

最小修正将已有confirmed的complete直接交给原完整read，保留当前State/授权、原候选和原生/Git链、最新物理版本及返回前重读。首次完成与未确认恢复不变，无证明缓存或期限/断言调整。默认配置原真实用例通过（1440933ms），控制21项、typecheck及严格lint通过；1350输入/7产物未漂移，78来源hash及8份原生回执已核验，两处本轮fixture均清理。

[修正实测汇总](../../test-outputs/task124/service-replay-result.json)，SHA256 `1427a153a237a50d432366b7dc52ef88ae10dc97165992dfadc00b6c264ebd0e`；[诊断汇总](../../test-outputs/task124/service-profile-result.json)；[完整历史](../task-history/12.4.md)。总时间差不是受控性能结论，旧失败证据保留。

下一步完整累进回归，G4仍未完成；通过后继续TESTER耐久CAS、独立validation登记及启动屏障。Task12.4仍in_progress，无新增TESTER执行G5，未commit/push/PR。

---

## 2026-09-21 上一检查点：清理初始化已修正，服务超时待定位

独立测试清理helper遗漏ready已用真实350ms首次加载重现并修正；绑定/启动39项、typecheck及严格lint通过，原产品代码/安全断言/期限不变。

完整回归在IntegrationService用例触及原40分钟期限，已停止后续批次，实际退出130。已过追踪7项及handoff1项，其他回归未完成，真实模型尚未开始，G4未通过。现场显示Integration已done，停在暂移原生result.json后的completion.read拒绝反例；需测量逐调用时序以区分重复校验开销、单次阻塞或宿主波动，不能直接延长时限。

2处中断fixture已保存完整现场及hash并核验清理，新增遗留0。[本轮结果](../../test-outputs/task124/cleanup-ready-incomplete-result.json)，SHA256 `b600b0b895d2c78ba15d84b7c646f24544b6c7b55c190b41d7bd1f7ab544b850`；[完整历史](../task-history/12.4.md)。

先解决服务读取超时并完成全量回归，再接原handoff/派发计划耐久CAS、独立validation登记及启动屏障。Task12.4仍in_progress，无新增TESTER执行G5，未commit/push/PR。

---

## 2026-09-21 上一检查点：规范派发计划完成，清理失败待定位

L2已复用实际Coordinator生成首次TESTER完整派发计划（含台账），支持精确前/后态重放和篡改拒绝；仅规划，尚未接耐久CAS、独立validation工作区或启动屏障。

新增28项、定向108项、类型检查和严格lint通过。完整回归2202通过/1失败，另追踪7项通过，四条真实模型链路通过。唯一失败是control-drift场景的测试专用清理返回needsAttention；完整文件12项诊断复验通过，但根因inconclusive，不能记G4通过。先定位并解决该失败，再推进执行接合。

已核验124份Git/57份原生夹具和26条证明引用，清理88个新增入口，新增遗留0，保留2处旧共享VM占用根。Task12.4保持in_progress，未commit/push/PR。

[本轮原始汇总](../../test-outputs/task124/dispatch-plan-incomplete-result.json)，SHA256 `94cfa549395768061d721549018d6eb059be2ff48083ec2738d6f68fe39a5ab4`；失败、诊断、夹具隔离修正和完整边界见[Task12.4历史](../task-history/12.4.md)。

---

## 2026-09-20 上一规格检查点：独立TESTER准备契约细化

已完成[接入前规格复评](task124-validation-preparation-review.md)：规范派发须包含Coordinator进度消息和完整前后态；独立validation登记绑定原handoff版本；首次与pending恢复路由共用准备屏障，未确认不启动worker。旧完成/handoff校验不放宽，缺证据或部分创建仍拒绝。

本轮只修改规格与追踪；上一代码版本的2175项全量结果保持原归属，没有新增TESTER G5。下一步实现完整派发计划及专用工作区登记，再验证启动和固定输入命令。Task12.4保持in_progress，未commit/push/PR。

---

## 2026-09-20 上一代码检查点：完成来源与claim关闭交接

完成前保存的原State/registry、完成计划及原生/Git应用链，现可经原binding协议完成精确drain/release后只读核验。两处耐久后丢响应恢复不重复关闭；缺原始证据、控制漂移或越权均拒绝，旧completion准入保持。独立TESTER尚未派发。

冻结1346个输入、7个原生产物及原HEAD执行完整pnpm test：264文件2175项及7项追踪测试通过，0skip，退出0，总8903.93秒。typecheck及严格lint667文件通过；26项控制测试通过。四条真实模型链路沿用已批准OpenCode Go/deepseek-v4-flash、原目的地/固定任务/参数/期限，无fallback、skip或正式Benchmark。

124份Git、57份原生夹具及26条证明引用哈希核验通过；本轮新增测试资源已清理，额外88入口共449283逻辑字节，新增遗留0；2处旧共享VM占用根保留。

汇总：[本轮交接验证](../../test-outputs/task124/handoff-validation-result.json)，SHA256 `92dd8c7aebd6f3295b895141b9ac167c3bb1e4af6a1a363658bae23ab2f600f8`；完整范围、原始证据、失败与清理记录见[Task12.4历史](../task-history/12.4.md)。

下一步将确认后的完成来源绑定到规范TESTER派发、独立验证工作区及固定输入真实命令证据。部分binding/文件/Git恢复、accepted后续波次、普通Web队列接合、REVIEWER/D16实际应用和同task新验收轮次仍待完成。当前内部交接G5已实测，完整Task12.4产品G5未完成；保持in_progress，未commit/push/PR，未越过Phase12出口。

---

> 2026-09-20 上一单元检查点：首波规范Integration准备已接通，并用于完整IntegrationService实测。最终冻结1342输入/7产物，全量262文件2165项＋追踪7项通过，0skip；4条真实Go链路通过。123份Git/57份原生证据及25条引用哈希核验通过，清理88新增测试入口（449281逻辑字节），保留2处旧共享VM占用根。汇总test-outputs/task124/preparation-validation-result.json（SHA256 `54129ad544cefeb29affea5ea0ded59aaac6080ab3e28db8df026e34a3757230`）；完整证据见docs/task-history/12.4.md。独立TESTER固定版本/claim交接及完整产品G5仍待完成，未commit/push/PR。下文保留上一单元历史结果。

# 12.4 Git 与执行准入检查点（2026-09-20）

## 2026-09-20 历史检查点：IntegrationService与不可变完成证明

- 实际IntegrationService通过受信companion消费原规范计划、完整发布及State确认；只有本机服务提交规范State，L2不重复提交。当前入口限定目标预登记、规范Integration已持久化且原claim有效。
- 完成规划逐项重建完整确认前缀，只规划done/resultCommit；运行时完成计划固定原before/after、完整应用确认链和最后精确Git/manifest版本。完成专用只读视图从原计划读取历史State并持续核对当前事实，不把done改写为merging来重新授予写能力。
- 最终冻结版真实双分支服务实测1469.312秒通过：分支确认及最终完成两处丢响应后恢复，共3次CAS；完整重入不新增提交，用户HEAD/index不变。缺完成计划或历史原生日志、普通done准入、只读acquire/edit/release及跨call均拒绝。原生应用项为[4,4]，私有候选16份原生结果、Git发布、State前后态及完成确认hash均独立核验。

类型检查、严格lint659文件通过；冻结1338输入、7原生产物及原HEAD，完整pnpm test为260文件2153项及追踪7项通过，0skip，退出0，总7484.55秒。四条真实模型链路保持既有批准OpenCode Go/deepseek-v4-flash、原目的地/固定任务/参数/期限，无fallback或正式Benchmark。122份Git夹具、57份原生夹具及各层证明审计通过。

保存证据并核对身份、进程、挂载、容器挂载及打开句柄后，清理88个额外测试入口、449282逻辑字节；本轮新增遗留0。两处旧共享VM占用根保持原身份并保留，未停止共享资源或触及用户数据。

汇总：[本轮服务验证](../../test-outputs/task124/service-validation-result.json)，SHA256 `cb21c28e04020de9f5ee1c7aa81d5cf504abe91423775fb4f074bf2b22d3b5f5`；完整开发失败、修复、来源和清理证据见[Task12.4](../task-history/12.4.md)。首次定向实测属于补强前版本，本次完整回归才覆盖最终版本。

下一步实现新集成准备及固定完成版本到独立TESTER的交接。部分文件/Git发布恢复、accepted后续波次、产品组合根、REVIEWER/D16实际应用、同task新验收轮次及完整产品G5仍未完成。Task12.4保持in_progress，未commit/push/PR。

---

## 2026-09-20 历史检查点：正式集成接入规格复评

已核对实际IntegrationService、Web transition、MessageService与StateStore队列、本机组合根及原应用证明：直接包装旧WorkspacePort会出现重复State提交，旧Web transition不比较expected State，旧亲缘恢复缺原生效果证明，done早返回缺独立完成回执，且现有本机组合根未提供integrate入口。以上是接入前缺口，不是已启用产品路径的新增回归。

已在详细设计§12.2.5细化受信带前态companion、唯一提交者、完整State/队列边界、独立完成计划及完成后验证来源；同步架构§10与开发计划12.4。保留旧backend规则、冻结接口及当前全State校验，不放宽证据来迁就旧接口。本轮只改规格与追踪；下一代码单元先实现完成证明及companion，再用实际IntegrationService执行双分支验收，随后接独立TESTER。该计划沿用已获批12.4范围，不需要再次批准。

规格复评不新增G5结论；Task12.4仍in_progress，未commit/push/PR。以下累计应用实测是上一代码检查点。

## 2026-09-20 历史代码检查点：同波次累计应用链

- 后续有序position消费前次原result.version和不可变确认收据；原编码基线保持，第二个done分支能形成保留前次内容的完整候选并真实应用/发布/确认。
- 历史链按position递减，重建完整Integration前后态，逐项核验原生journal/seal、私有候选、原始baseline及真实Git双父对象和发布记录；当前物理版本另由规范authority与版本校验保证。缺历史证明、外来作用域或旧action均拒绝，不能重新capture替代来源。
- 第二次State提交响应丢失后恢复不重复commit，保持merging；worker/Subtask和用户HEAD/index不变。实际目录累计覆盖包含空目录；源码/原生产物及完整证据hash见汇总。

类型检查、严格lint653文件通过；冻结1332输入、7原生产物及原HEAD，完整pnpm test为258文件2140项及追踪7项通过，0skip，退出0，总5726.05秒。四条真实模型链路保持既有批准OpenCode Go/deepseek-v4-flash、原目的地/固定任务/参数/期限，无fallback或正式Benchmark。121份Git夹具、57份原生夹具及既有发布/应用/来源证明审计通过。

保存证据并确认归属与停用后，清理88个额外测试入口、449277逻辑字节；本轮新增遗留0。两处旧共享VM占用根保持原身份并保留，未停止共享资源或触及用户数据。

汇总：[累计集成验证](../../test-outputs/task124/cumulative-validation-result.json)，SHA256 `bd3d2768c5a778fdbc934c985be525a8996ac2c11ed85d0ab0a06367fdf2a437`；完整执行记录见[Task12.4](../task-history/12.4.md)。首次红测、静态检查修复和必要原始证据保留，旧原语证明不能替代本轮结果。

下一步接受信IntegrationWorkspacePort及既有IntegrationService，处理进度消息与完整State固定窗口，再接独立TESTER验证与accepted来源。部分Git恢复、accepted后续波次、Web/REVIEWER/D16实际应用及完整产品G5仍未完成。当前未commit/push/PR，12.4仍为in_progress。

---

## 2026-09-19 历史检查点：完整发布后的State确认

`acknowledgePublished`已接原动作→原position索引、完整原Integration和证明限定的只读恢复准入。原生效果、来源及精确Git发布全部证明后，以state-plan和同实例条件提交确认一项merged及目标HEAD；冻结TaskStateStore方法不变。已提交但响应丢失可重读收敛且不再commit；确认后复核失败永久失效，完整重放只读。其他State变化或后续前缀变化仍拒绝，尚不提供历史应用链。

类型检查、严格lint652文件通过；冻结1331输入、7原生产物及原HEAD，完整pnpm test为257文件2139项及追踪7项通过，0skip，退出0，总4763.04秒。四条真实模型链路保持既有批准OpenCode Go/deepseek-v4-flash、原目的地/固定任务/参数/期限，无fallback或正式Benchmark。120份Git夹具、57份原生夹具及既有发布/应用/来源证明审计通过。

保存证据并确认归属与停用后，清理88个额外测试入口、449278逻辑字节；本轮新增遗留0。两处旧共享VM占用根保持原身份并保留，未停止共享资源或触及用户数据。

证据汇总：`test-outputs/task124/state-confirmation-validation-result.json`，SHA256 `4212c87d1fc37221fb7672f4bfd7afb136c88db98842d3f7abb39069b4df1a0b`。完整开发失败与恢复说明见[12.4历史](../task-history/12.4.md)。此为内部真实接缝，不代表产品编排G5。下一步消费原确认回执接后续position累计集成；Task12.4仍在进行中，未提交或创建PR。以下为先前检查点与历史证据。
## 2026-09-19 当前检查点：有序确认领域规则

新增planIntegrationAcknowledgement，固定完整原Integration与规范selection，只规划下一条merged及HEAD mutation；精确重复无mutation，控制漂移、错位置及早期前缀替换拒绝。实际状态持久化与半提交恢复仍未接入，当前普通authority保持拒绝Git/State分歧；领域测试不替代物理证明或产品G5。

类型检查、严格lint650文件通过；冻结1329输入、7原生产物及原HEAD，完整pnpm test为256文件2135项及追踪7项通过，0skip，退出0，总3844.41秒。四条真实模型链路保持既有批准OpenCode Go/deepseek-v4-flash、原目的地/固定任务/参数/期限，无fallback或正式Benchmark。118份Git夹具、57份原生夹具及既有发布/应用/来源证明审计通过。

保存证据并确认归属与停用后，清理88个额外测试入口、449288逻辑字节；本轮新增遗留0。两处旧共享VM占用根保持原身份并保留，未停止共享资源或触及用户数据。

结果索引：Git忽略的test-outputs/task124/acknowledgement-validation-result.json，SHA-256 fb34cb933b0d0c77e37034e09b0a0c5efe31c7ed745dff0619271eecc3ed6f50。完整记录见[12.4任务历史](../task-history/12.4.md)。下一步从不可变原prepared恢复完整前缀并固定action/position，接同一受信任务队列的物理证明、State确认和重复请求。此前检查点及失败证据保留。


**当前进展**：首次规范候选→原生树效果→精确Git发布已接通，本固定版完整G4通过。State确认、半提交恢复和累计集成仍待完成。

- **完整回归通过**：255文件2116项及追踪7项，0skip，3999.23秒；4条真实Go模型链路通过，原模型/参数/期限不变。
- 新3场景覆盖正常发布、效果后中断及完成后失效；原生效果、双父commit/tree与完整manifest交叉验证，State/registry及用户HEAD/index不变。
- 已有应用槽拒绝重试和换actionId绕过；普通authority仍拒绝Git/State半提交，未开放恢复或产品入口。
- 故障注入全扫描失败已复现留证；改固定引用查询后通过，原断言与Git会话期限不变。
- typecheck/严格lint647通过；1326输入、7原生产物及HEAD一致。118份Git、57份原生夹具及证明审计通过。
- 另清理88测试入口、449280逻辑字节，本轮新增遗留0；两处历史共享VM占用根保留。
- 下一步：受信半提交恢复和State有序确认，再接累计manifest及验证链；12.4及产品G5未完成，未commit/push/PR。

完整证据见[本轮历史](../task-history/12.4.md#2026-09-19首次规范候选到精确git发布接合)。

**上一应用后证明读取检查点（254文件2113项为历史）**


**当时进展**：应用后原候选与原生树效果证明的只读读取已实现，本固定版完整G4通过。精确发布与规范State的协调、累计集成仍待接合。

- **完整回归通过**：254文件2113项及追踪7项，0skip，3344.94秒；四条真实Go模型链路通过，原模型、参数及期限不变。
- 新2项真实组合及受影响17项通过。读取原候选与真实树效果，保持记录、Git及State不变；缺证据、部分应用、文件/目录漂移、控制变化和claim释放均拒绝。
- Unicode排序误拒绝已用真实文件红测复现并修复；原红测与提前中止的回归保留，未弱化断言或期限。
- typecheck、严格lint645通过；1324输入、7原生产物和HEAD前后一致。115份Git、57份原生夹具及各项证明核验通过并清理。
- 另清理88测试入口、449277逻辑字节，无本轮新增遗留根；两处历史共享VM占用根保留。进程查询凭据回显事件已告知Leader，凭据值未写入项目证据，建议轮换。
- 下一步：绑定原候选/树效果与精确Git发布，再经受信队列/applyMutations确认有序merged项并接累计manifest。当前读取仍要求原目标Git/State准入，未开放半提交恢复；12.4及产品G5未完成，未commit/push/PR。

完整证据见[本轮历史](../task-history/12.4.md#2026-09-19应用后原候选与树效果证明读取)。

**上一历史发布证明检查点（253文件2111项为历史）**


**当时进展**：历史Git发布证明只读核验已实现，并修复候选重算会补建丢失原对象的问题。本固定版本完整G4通过；上层原生树效果证明消费、State确认及累计集成仍待实现。

- **完整回归通过**：253文件2111项及追踪7项，0skip，2930.09秒。真实Go LRU、本机闭环、算术和频道摘要均通过，原模型、参数、期限不变。
- 新3项历史发布读取及原6项发布/恢复均通过，9份证明独立核验。用户后续合法提交可读原证明，写/恢复仍严格固定当前状态；缺失commit/tree/blob或损坏blob拒绝，不补建原证据。
- 已保留真实缺失对象红测、提前中止全量及9项断言通过但RPC错误的整体失败。夹具边界让出事件循环后定向9项及完整回归通过；未放宽断言或期限。
- typecheck、严格lint644通过；1323输入、7原生产物和HEAD前后一致。113份Git、57份原生夹具及候选/完成来源/发布/基线/重试证明核验通过并清理。
- 另清理88测试入口、449279逻辑字节，无本轮新增遗留根；预验33夹具及中断根131050字节已清理，两处历史共享VM占用根保留。
- 下一步：消费原规范候选与完整树效果证明，再以受信任务队列/applyMutations确认唯一有序merged项并接累计manifest。当前只读入口不授予业务准入；12.4及产品G5未完成，未commit/push/PR。

完整失败、修复、来源及hash见[本轮历史](../task-history/12.4.md#2026-09-19历史发布证明只读核验与原对象完整性修复)。

**上一精确发布固定版本检查点（252文件2108项为历史）**

**当时进展**：精确双父候选发布与显式Git恢复的固定版本已完成一次完整回归。当前G4闭合；上层规范树应用回执消费、State确认及累计集成仍待实现。

- **完整回归通过**：252文件2108项及追踪7项全部通过，0skip，2854.89秒。真实Go LRU、本机闭环、算术和频道摘要均通过；原模型、参数、期限及保护规则未改。
- 安装授权35项整组通过，安装receipt与原生journal证明exited/quiescent及发现未报错；发布/恢复6项通过，无RPC超时。历史失败继续保留，根因未定，不以本轮通过宣称已修复。
- 1322输入、7原生产物与HEAD前后一致，复用已通过的native/typecheck/严格lint643证据；本轮无产品源码或规格变更。110份Git和57份原生效果夹具、候选/历史来源/发布/基线/重试证明均审计通过并清理。
- 另清理88个测试入口、449281逻辑字节，无本轮新增遗留根；两处历史共享VM占用根继续保留。
- 下一步：独立读取原候选与应用证明，核验精确发布回执，再经受信任务队列/applyMutations确认唯一有序merged项，接通后续累计manifest。12.4及产品G5未完成，未commit/push/PR。

完整结果和hash见[本轮历史](../task-history/12.4.md#2026-09-19精确发布固定版本完整回归恢复)。

**上一发布单元检查点（完整回归中止为历史）**

**当时进展**：内部精确双父候选发布与显式Git恢复已实现。原HEAD/index、固定完整树及来源证据核验后分步发布；普通半提交重试拒绝，显式恢复仅接受三种原计划状态，完成后失效永久拒绝。不写规范State，不授予产品集成/交付资格。

- 新6项真实发布/故障恢复及既有49项定向通过；最终6项与6份发布证明复核通过。typecheck、严格lint643文件0错误/0警告通过，7份原生产物hash一致。
- **当时G4未闭合**：第一轮全量已报告137项中136通过/1真实模型失败，第二轮81项中80通过/1安装收尾失败，两轮均主动停止、退出130。LRU及安装各自原配置单项复验通过，不替代完整门禁，也不证明外部模型/进程观察问题已修复。
- 安装失败已定位至原生发现child_token_before/unknown，main exit 0但cleanup不闭合。现有规格要求needsAttention；底层触发原因仍inconclusive，未放宽保护、断言、期限或切换提供方。首次Vitest通信超时及两轮原失败均保留。
- 1322输入/7原生产物/HEAD未变。累计本单元208份已完成Git夹具已清理，另回收2个中断根166424逻辑字节；新Phase9临时根309453字节仍被共享VM占用而保留，旧占用根也保留。证据与清理边界详见历史。
- 下一步先恢复完整G4，再接规范原生树应用回执、受信队列State确认、历史发布证明和后续累计来源。12.4及产品G5未完成，未commit/push/PR。

完整结果和hash见[本轮历史](../task-history/12.4.md#2026-09-19精确双父候选发布与显式恢复完整回归未闭合)。

**上一规范候选检查点（2102项为历史）**

**当时进展**：规范首分支私有候选及历史完成证明的同一固定代码已取得完整回归全绿。候选绑定有序来源、原完成回执、完整历史基线与目标版本；发布后控制变化会持久失效。仍未推进用户或集成目标HEAD/index/State。

- **当时G4闭合**：原配置LRU先独立通过，随后原始pnpm test完整251文件2102项及追踪7项全部通过，0skip，2692.04秒。真实Go的LRU、本机闭环、算术与频道摘要均通过，模型固定deepseek-v4-flash，参数/断言/期限未改，无正式Benchmark。
- 1320输入、7原生产物及HEAD前后一致；复用hash核验一致的native/typecheck/lint641证据。本轮未改产品代码或规格，结果核验后仅更新检查点、历史和notes。
- 104份Git与57份原生文件/目录/计划夹具通过并清理；2份规范候选、5份完成来源、3份完整基线、重试回执和39份候选native结果审计通过。另清理88测试入口、449268逻辑字节，无新增遗留测试根；旧共享VM占用项保留。
- 前次中止全量、缺回执分类修复、原5000ms超时及Go STREAM_CLOSED失败仍保留于历史，不以本次成功推定网络/服务端根因。当前结果取代“G4待恢复”的状态，未改写原失败。
- 下一步：绑定精确双父候选及文件效果，接HEAD/index发布、规范State确认与显式中断恢复，再接后续累计来源、验证/REVIEWER/Web和同task新轮次。12.4与产品G5仍未完成，未commit/push/PR。

完整结果与证据hash见[本轮历史](../task-history/12.4.md#2026-09-18原配置真实模型恢复与完整回归闭合)；此前失败见[上一轮历史](../task-history/12.4.md#2026-09-18规范首分支候选准备与真实模型回归阻塞)。

**上一首波基线检查点（2098项为历史）**

**当时进展**：完整首波历史基线只读证明已接通。当前worker→编码批次→初始批次的固定输入、规范绑定、原manifest和Git创建回执交叉核验；文件及空目录均保留，不重读用户目录替代历史B，用户后续HEAD/index可合法变化。Integration来源现同时核验基线与真实完成来源，仍不授予合并/交付权限。

- 真实首波、普通重试和双worker来源接合通过；缺失证据/私有ref漂移/自洽删除空目录拒绝。新增测试构造曾遗漏父目录声明，修正构造后原断言通过，未弱化断言。
- native/typecheck/lint638通过；本固定版原始pnpm test完整250文件2098项及追踪7项全绿，2319.80秒。1317输入、7原生产物和HEAD冻结一致，本版G4闭合，上一2097项保留为历史。
- 100份Git、57份文件/目录夹具全部通过并清理；首波/重试/集成来源3份完整基线证明及39份候选native结果独立审计通过。另清理88测试入口、449280逻辑字节；7份预验证夹具已清理，旧共享VM占用项继续保留。
- 下一步：实际验证/返工基线、HEAD/index/State协调及恢复、累计验证/REVIEWER/Web和同task新验收轮次。12.4与产品G5仍未完成；未提交、推送或建PR。

完整证据与hash见[本轮历史](../task-history/12.4.md#2026-09-18首波完整历史基线只读证明)。

**上一编码重试检查点（2097项为历史）**

**当时进展**：已修复本机编码登记错误拒绝规范worker重试的问题。`readCodingWorkerLineage`从唯一原始coding_wave推导plan及成员，按消息顺序核对首attempt普通重试的旧成员状态、新worker身份、assignment和共同base，不再要求重试消息重复存planId。测试失败/冲突的新attempt仍须后续证据接合，当前拒绝。

- 新20项领域与1项真实Coordinator/Git登记测试通过；原始错误已红测复现。详细设计§12.2.5同步实现边界，未更改冻结接口或模型工具权限。
- 原始pnpm test第一次为2096通过/1算术真实测试120秒超时；原配置单项15.242秒通过，根因仍inconclusive。代码/参数/期限不变，第二次完整249文件2097项及追踪7项全绿，2218.27秒；native/typecheck/lint635通过。1314输入/7原生产物/HEAD一致，本固定版G4闭合，首次失败不改写。
- 两次全量各99份Git和57份文件/目录/计划夹具通过并清理；各39份候选native结果、有序来源及重试5份真实建树回执独立审计通过。两轮各回收88入口、449280逻辑字节；红/绿预验证2夹具已清理，旧共享VM占用项继续保留。
- 下一步：完整规范历史baseline manifest、验证/冲突新attempt及返工来源证据；HEAD/index/Integration State协调与显式恢复，累计验证/REVIEWER/Web和同task新轮次/归档。12.4及产品G5仍未完成。未提交、推送或建PR。

完整证据与hash见[12.4历史](../task-history/12.4.md#2026-09-18普通编码重试派发追溯与完整回归)。

**上一有序来源检查点（2076项为历史）**

**当时进展**：已接通当前Integration下一条有序来源的只读核验。精确绑定wave/base、CODER集合、worker/subtask引用、拓扑依赖与merged前缀，再核验真实完成证明；读取中控制变化拒绝，不写HEAD/index/State或创建执行实例。

- 复评并修正§12.2.5“后续只从accepted”与§3.1失败返工规则的冲突。独立波次与显式返工来源资格分开；完整baseline manifest、原dispatch/重试链及实际验证消费者仍待接合，不把控制选择当作可应用资格。
- 新19项领域+1项真实双worker用例通过；受影响6文件50项通过。完整247文件2076项及追踪7项全部通过，native/typecheck/lint632通过；1311输入/7原生产物/HEAD冻结一致。本固定版G4闭合，上一轮STREAM_CLOSED失败保留为历史。
- 98份Git、57份文件/目录/计划夹具通过并清理；完成来源和39份候选native结果审计通过。另删除88测试入口、449279逻辑字节；旧共享VM占用目录继续保留。
- 下一步：完整规范基线来源与派发/重试链，HEAD/index/Integration State协调及显式恢复，累计验证/REVIEWER/Web和同task新轮次/归档。12.4及产品G5仍未完成。未提交、推送或建PR。

本轮完整证据、失败与修复、固定hash见[12.4历史](../task-history/12.4.md#2026-09-18当前波次有序来源选择与完整回归)。

**上一完成来源检查点（2055通过/1失败为历史）**

**当时进展**：已新增只读worker完成来源核验。当前done worker的session/claim/绑定、不可变完成引用、真实close、原manifest与Git提交必须一致；缺失、伪造或物理漂移拒绝。只读Git验证不能补造首次提交，也不重新捕获当前目录冒充已完成版本。

- 新4项真实来源测试及原Git基线44项定向通过；native构建/typecheck/lint628通过。全量245文件2056项实际为**2055通过、1失败**：算术模型流缺`[DONE]`，`STREAM_CLOSED`。原配置单项复验随后通过，但本检查点**没有新一次完整全绿，G4未据此闭合**。1307输入/7原生产物/HEAD未变。
- 新4份完成来源证据及候选39份原生结果独立审计通过。全量97份Git、57份文件/目录/计划fixture通过且清理；累计Git1940份、文件/目录/计划639份、registry18/state57份均清理。另回收88入口、449285逻辑字节；旧共享VM占用目录保留。
- 下一步仍需当前Integration有序来源选择与wave/accepted完整基线、HEAD/index/State协调及显式恢复，随后累计验证、REVIEWER/Web和同task新轮次/归档。12.4及产品G5未完成；完整门禁按后续实际全量结果闭合。未提交、推送或建PR。

**上一候选物化检查点（2052项为历史）**：完整Git候选已能在受信私有目录实际物化，并捕获、复核真实WorkspaceVersion。保留二进制、执行位和空目录，固定scope/来源/授权；prepared、结果、完成及失效标记共同决定重放资格。部分创建、来源/目录身份漂移及发布窗口修改均拒绝，不自动补跑或回滚。

- 新8项真实候选测试通过，Unicode路径排序差异经红测修复；完整244文件2052项及追踪7项全绿，native构建/typecheck/lint626通过。1305输入、7原生产物及HEAD冻结一致，完整12.4和产品G5仍未完成。
- 全量93份Git及57份文件/目录/计划fixture全通过并清理；候选39份native结果及完成/失效引用已独立核对。累计Git1783份、文件/目录/计划582份、registry17/state54份均清理；另回收88入口、449277逻辑字节。旧共享VM占用目录保留。
- 下一步：规范worker完成/wave/accepted manifest来源组装、HEAD/index/Integration State协调及显式部分恢复，随后累计验证、REVIEWER/Web、同task新轮次与分轮归档。未提交、推送或建PR。

**上一完整合并树检查点（2044项为历史）**：完整Git合并候选读取已实现。固定完整共同基线、显式两侧目录集合并验证唯一merge-base；真实Git处理文件正文，目录节点单独三方判断。保留空目录，目录冲突不给可应用文件；读取及重放核验来源/授权，不更新refs/index/源码，也不伪造物理版本。

- 新15项领域与5项真实Git测试通过；完整243文件2044项及追踪7项全绿，native构建/typecheck/lint624通过。1303输入、7原生产物及HEAD冻结一致，完整12.4和产品G5仍未完成。
- 全量85份Git及57份文件/目录/计划fixture全部通过且清理；累计Git1667份、文件/目录/计划525份，registry16/state51份均清理。29份native journal复核通过（保留预期缺回执反例），另回收88入口、449281逻辑字节。旧共享VM占用目录保留。
- 下一步：受信候选物化与规范完整manifest来源，HEAD/index/Integration State协调、显式部分恢复，随后累计验证/accepted、REVIEWER/Web、同task新轮次及分轮归档。未提交、推送或建PR。

**上一树批次检查点（2024项为历史）**：受信集成树批次已实现，复用实际native文件/目录效果，持久化prepared、开始记录、子回执及最终完整manifest；目录身份漂移、部分失败、原生证据缺失与收尾标记丢失均封锁后续批次和claim释放。成功对象后复核失效保留历史并派生partial，不自动补跑/回滚。显式remove策略已补齐，默认授权及模型工具范围未扩大。

- 固定版9项真实批次测试通过；完整241文件2024项及追踪7项全绿，原生构建/typecheck/lint622通过。1301输入、7原生产物和HEAD冻结一致。此为内部效果单元，完整12.4及产品G5尚未完成。
- 全量80份Git、57份文件/目录/计划fixture通过且清理；29份批次native journal已核对，唯一缺失结果为预期的拒绝重放反例。累计Git1565份、文件/目录/计划468份，registry15/state48份均清理。另回收88个入口、449278逻辑字节；旧共享VM占用的215297逻辑字节目录仍保留。
- 下一步仍需显式部分恢复、integration候选完整目录来源及HEAD/index/State协调，随后接累计验证/accepted来源、REVIEWER/Web、同task新轮次和分轮归档。未提交、推送或建PR。

**上一完整树计划检查点（2014项为历史）**：完整树比较与固定应用计划已实现。新接缝保留空目录、检查每级父目录和排除项保护，文件↔目录互换展开为有序单项效果；用户新增后代与祖先删除冲突时整批不给计划。候选put字节只引用已验证artifact对象，活目录后续修改不改变固定输入。38项领域与5项真实manifest测试通过，完整240文件2014项及追踪7项全绿；native构建/typecheck/lint620通过，1299输入/7原生产物/HEAD冻结一致。实际整批执行、partial恢复和完整12.4仍未完成。

- 本次57份文件/目录/计划fixture及71份Git fixture全部通过并清理，累计文件/目录/计划411份、Git1463份均已清理；registry14份/state45份清理。另回收88个临时入口、449302逻辑字节，旧共享VM占用的215297逻辑字节目录保留。真实Go测试范围和原参数不变，无正式Benchmark。
- 下一步是受信批次prepared、原生逐项执行与partial恢复封锁，以及integration候选完整目录来源和HEAD/State协调。本只读计划不能代替实际应用、当前物理身份校验、验证收据或D16批准。

**上一集成控制检查点（1971项为历史）**

新增内部integration持久写占用，以规范Integration/wave/计划、Leader授权和真实linked身份准入，不创建虚假worker/lease。先draining关闭新准入，再凭真实收尾证明released；获取/排空/释放的提交前后中断均可恢复，完成态不阻断关闭。新17项codec与7项真实恢复测试通过；完整238文件1971项和7项追踪测试通过，native构建/typecheck/lint616通过。1295输入、7原生产物及HEAD冻结一致。完整12.4未完成，内部能力尚未接产品累计集成/Web。

- 新回归真实复现并修复了关闭证明失败后仍active、Integration完成后误拒绝释放；保留红测与修复证据。源业务完成事实是明确测试fixture，不冒充模型/完整累计集成G5。
- 本次71份Git fixture与52份文件/目录fixture全部通过且清理；Git累计1392份、文件/目录335份均清理，registry13份/state42份清理。另回收88个测试临时入口、449284逻辑字节。旧215297逻辑字节目录仍被共享VM只读占用，保留并留证。
- 上一目录原语检查点为236文件1947项，原生空目录创建/隔离、完成后复核及目录身份回执均已在本次全量回归通过。整批目录manifest/部分失败恢复仍待接合。真实Go测试沿用批准范围，无正式Benchmark。

**上一单文件效果检查点（1915项为历史）**

- 删除保留实际旧inode及完整版本，不unlink或覆盖隔离对象；外部编辑/新建、撤权或根漂移保留效果并要求恢复。执行位在私有候选上准备，其他权限与受支持xattr保留。新20项与旧创建/替换32项均在完整回归通过，完成回调竞争和伪造效果字段失败原证据保留。
- 该时点单文件能力未接模型删除工具、目录事务、整批应用或Integration State；目录原语现已补齐，整批/State仍待接合。integration根的内部受信控制入口现已补齐，产品接合仍待完成，不伪造worker/lease。旧对象候选与固定字节实现仍有效，以下1895项结果为历史。

**上一固定字节提取检查点（1895项为历史）**

- 新提取入口仅返回成功候选的文件字节与Git目录信息；冲突、非法路径/类型、超限、损坏对象及撤权均拒绝。真实反例证明Git遍历可接受损坏子树，现逐层重建tree对象并核对hash；不把文件提取当作完整空目录manifest、受控应用或波次验收。
- 16MiB边界曾因Vitest深比较展开Buffer触发OOM，改用等价完整字节比较后通过，原失败及清理证据保留。最终定向6项通过；完整回归中的真实模型调用沿用获批Go/deepseek-v4-flash范围。当前Git fixture70份、registry10份/state33份均通过归属/占用清理；额外88个临时入口回收449279逻辑字节。旧共享VM占用目录仍保留。

**上一对象合并与进程发现检查点（以下1893项为历史）**

- 新合并原语通过独立文件、非重叠文本、冲突、撤权及伪造回执拒绝；候选不更新refs/index/源码，不代表累计集成已完成。
- 安装回归曾返回unknown；真实最小用例复现快照已退出僵尸子进程被误判。先复评详设§12.2.6，再排除已退出候选、保留未知失败、向私有记录保存固定诊断码；原安装故障精确触发仍inconclusive。
- 一次附加停止参数被pnpm解析成文件筛选，48文件313项仅作部分覆盖；随后原始pnpm test全量通过。失败和部分覆盖原始证据均保留，详见任务历史。

**上一D17登记与worker HEAD检查点（以下1888项均为历史）**

- 本轮跨包14项定向通过（216.36秒），包括空worker基线、双CODER规范波次、用户后续编辑隔离及错误/漂移拒绝。完整回归中该组231.19秒；实际双worker提交/写入封闭/规范HEAD重放125.67秒。执行器决策仍脚本化，不冒充完整linked Harness模型/G5。
- 首批登记可只建立integration基线，再按已持久D17 dispatch注册精确pending CODER集合。后续accepted来源必须有实际验证消费者，目前未接通；direct切换、后续integration/TESTER正式登记及REVIEWER仍未完成。
- worker完成提交使用固定manifest字节，完成后封闭源码写入；Runtime写规范HEAD，TESTER保留独立引用/claim关闭证据。重放复核规范当前HEAD及原物理身份，外部HEAD回退仍拒绝。Git与State中断缝隙保留证据并阻断，专门恢复尚待实现。

**范围**：固定来源对象合并候选（无refs/文件写入）、进程发现退出候选细化、D17初始基线/首轮coding登记与完成HEAD接缝、内部身份映射、受管 Git 基线/linked-worktree/固定输入提交、纯 B/A/U 比较，以及工作树物理登记、持久绑定协议、原生事务区初始化、只读物理复核、Git固定版本与受信完整树批次效果/不完整封锁。12.4 产品链路尚未完成；不构成阶段出口或产品 G5 通过。

- 此前固定源码完整回归：232文件1888项通过，另前置7项任务脚本测试通过；1284个输入文件及helper前后hash一致、无增删、HEAD不变。此前1885/1882/1871/1860/1838/1825项结果保留作历史。
- 上一检查点14项跨包、Git44项及WorkerRuntime49项均纳入其G4。该时点typecheck与lint（605文件）通过，原生helper已冻结核验；本次对象合并/进程发现回归结果见本文顶部。
- 真实依赖：Apple Silicon/macOS 26.5（25F71），安装包内 Git 2.53.0；Git SHA-256 `fe37e33ef9f909061f0ca6f181bc52e43b5393b1afdb2e9f43dcc0f427941789`。最低 macOS 15 未验。
- Git metadata helper SHA-256：`5fbcd56bc5af80620308e3cef0534460df9ebf0b2450b98c533dfc523b99654c`；当前process-control helper：`d55f3060984a6d0808cb7e4a0a93890d39e840cac74c6287d959a3ad4c33c2b2`。
- 真实模型调用仅按本任务历史中 Leader 已批准范围执行：OpenCode Go/deepseek-v4-flash；未运行正式 Benchmark。

## 必要失败及修复

1. 首次完整回归与红测编辑交叉，发生缺模块加载失败；明确作废该次G4结论，冻结源码重跑通过。
2. Git Seatbelt 启动所需 literal 根读取与内置 fork 缺失；分别定位并最小开放，其他exec/网络保持拒绝。
3. `.lock` 源文件误识别、文本NUL截断、空基线、跨类型action重用、relative worktree配置、canonical别名及回执字段缺口均先红测后修复。
4. 替换提交后index/HEAD相符不能证明固定字节已验；新增Git tree逐项比较，保留伪造回执红测。
5. branch CAS后撤权保留实际副作用和prepared；拒绝自动重试补完，不宣称撤权使既有副作用消失。
6. 初始化回执不能只比较hash；补足原生成功字段、输入与journal身份复核，拒绝语义伪造及权限漂移。原生journal必须独立于工作树，未放宽原有保护。
7. 初始化后Git提交显式绑定事务区identity，以固定fd验证后排除；无identity、错identity及权限漂移均拒绝，私有journal不入源码。新增提交组合用例超出默认5秒后拆为两个独立用例，保留全部断言与既有期限。

8. 只读复核接受了缺失/策略篡改/可写native prepared；3个反例先红后修复。现在完整复核prepared/result及owner、单链接、只读权限和目录链，策略hash与实际初始化共用生成函数。
9. 新增Git版本复合用例首次超过默认5秒；保存失败日志，为这组新用例明确设置10秒以覆盖真实Git创建、native捕获、固定物化及复验。既有测试、原生命令和真实模型期限均不变，全部断言保留。
10. 原创建入口忽略空目录却返回成功；先用登记前拒绝防止遗漏，随后实现真实目录物化、inputHash绑定和原生路径集合核验。重命名空目录即使Git tree不变也拒绝旧提交回执，排除文件不复制。
11. linked TESTER仍被角色适配器错误映射为只读；按已验证Session的模式映射原白名单，并通过实际MCP/Harness ToolRuntime写入独立测试工作树。direct TESTER仍只读，缩减白名单不扩张。

12. worker正常完成却没有Git HEAD；新增固定输入提交与Runtime规范确认，先红后绿。linked TESTER关闭回执现按实际writer保存claim证据，完成后新apply拒绝。
13. 旧登记重放误用初始base，合法完成提交后被拒绝；改为规范引用的一致当前HEAD，并验证磁盘回退仍拒绝，未放宽到任意HEAD。

## 清理与证据

本轮1090份Git fixture均removed，匹配当前17个运行时源码、5个调度测试来源及helper的90份全部通过；registry9份/state30份均清理，task124前缀无遗留。另核对95个旧fixture入口，94个已清理（478552逻辑字节）；仅agora-failed-parallel-q5Ae6Q因共享虚拟机只读句柄保留215297逻辑字节，无活测试进程、对应容器或挂载。待句柄释放后复核回收，不将其写成全部清理。必要失败、版本/hash及文件清单见任务历史和test-outputs/task124的清理JSON，未触及用户数据或正常依赖。

完整执行与授权见[12.4历史](../task-history/12.4.md)。原始日志保留在Git忽略的`test-outputs/task124/`；以下hash固定本检查点所依据字节。

| 原始证据 | SHA-256 |
| --- | --- |
| `completed-source-full-test.log` | `4f0a8ef6f91b11d80c6b5951c2a06c1afa8b1b5a5c8f2b46084ea3140714e4b2` |
| `completed-source-stream-recheck.log` | `8e3e2ebb978bc8c7f1c3c010bfe29226d61a6f96a24c1d1a8099dd08a006c9c2` |
| `completed-source-validation-result.json` | `0b763cc8972476a3fb8ebc339f674ab0387030dd7bdc7738f62399d6bc9ed482` |
| `completed-source-frozen-result.json` | `83218f9cba7fd91dcf27c1879c70df0bb107d04c83a8621cd858ccd17eab5652` |
| `completed-source-proof-audit.json` | `e7d6c2c9e9c6fa6e7e110e1874c6d0209cf323ce8571b6a72bddcb04b209b6f7` |
| `completed-source-candidate-evidence-check.json` | `9639c4e32fcb2367f060b977d33a3e251abbf00471d8505377d2335fb002b6c4` |
| `completed-source-native-evidence-check.json` | `5a18118413d1f75baf321de553277b2afbdbd2fce0f3f810c079fc7bff4daeeb` |
| `completed-source-checkpoint-cleanup.json` | `622f09cf3be04aa243c90804c4605eebda5b0010ddb8aa37d7a580aa01455416` |
| `completed-source-regression-roots-cleanup.json` | `7a49b4ece97a0f4cb228945be459e326725844aa4aa82a81174a3502370831f5` |
| `completed-source-stream-recheck-cleanup.json` | `2b9a74f38591928717da4e43025817fd425b78adaa1e94a0ffd2275007f53040` |
| `completed-source-old-vm-cleanup-check.json` | `dda3aba5509ec4af8564091352f37547bce3d80ce1fdac1d42d4857a45d2bbd5` |
| `completed-source-final-targeted.log` | `37d4d9a86c174d8491b1dc4bf3d1268d65fa3b9be00b81b43594d362fb8ef012` |
| `completed-source-red.log` | `a6a51aa6ffceb846f9904b2d05649494629cdc2553a0ad1a7713682d01c63693` |
| `completed-source-targeted.log` | `b9f8beb6a4398959cf2fa751fc0769337271ca31167647a84ec2d87fa6fef5b7` |
| `completed-source-actions-targeted.log` | `b260bebbf050d2348dcb30abf375487b48ea4b68faf33950a5697b984249e3c6` |
| `completed-source-native-build.log` | `15f0e79d2609c020672b91e2addd7c555a5aab46d34af02a74e31eb7c4700f15` |
| `completed-source-final-typecheck.log` | `31bca0e1de9f7370c83be8bf321cf3a80e619b1997255ee0410177c1cafa6144` |
| `completed-source-final-lint.log` | `550d55255d56194aa0d5085bc319c7a1e6c7dcfa0a30504124e6f0db1d34968a` |
| `materialize-full-test.log` | `e0bd3981ed85617ccd7af8f8e96fd47ffb3915162e70c9ef260bcf7f5bf7694a` |
| `materialize-frozen-result.json` | `71ec0e7904ea924046090c1c6b3574b600a576ee363e176fddaec9a03db8c81b` |
| `materialize-candidate-evidence-check.json` | `883d0e085169c025f5c2a9e0f6ea98694bc53a0fc769092cc90f292ecd9e5c21` |
| `materialize-native-evidence-check.json` | `c2bed21e843ac0ba9737f4aade54bb45d98505bd54de1f1c5c119ed04e8bf50e` |
| `materialize-checkpoint-cleanup.json` | `4ecbbbcbbca3cc177da6756eec9703fcdf08fadd465547d6cc1e5a415bdf48ca` |
| `materialize-regression-roots-cleanup.json` | `b8f2cacdd6d0a1bf3a55fecd22c20cbd8cca40d147e6f55443087005b482f5f9` |
| `materialize-old-vm-cleanup-check.json` | `dda3aba5509ec4af8564091352f37547bce3d80ce1fdac1d42d4857a45d2bbd5` |
| `materialize-final-targeted.log` | `445319eca0797a4618248921402866efb7ab768e358e97e07387954dd89fbd86` |
| `materialize-red.log` | `38821c7515925577d4eda748f97e3b8f63dce69ae4d9679be319c327858e9dea` |
| `materialize-order-red.log` | `2deecf0552b1633713890ceaef6894b73d158ca7c4192bcba4044c10d59c0cb2` |
| `materialize-native-build.log` | `15f0e79d2609c020672b91e2addd7c555a5aab46d34af02a74e31eb7c4700f15` |
| `materialize-typecheck.log` | `31bca0e1de9f7370c83be8bf321cf3a80e619b1997255ee0410177c1cafa6144` |
| `materialize-lint.log` | `1694e12ef7f61a7146cf6ea3b338abd8242d85cfe6dce1ee0100534173ded8b4` |
| `merge-tree-full-test.log` | `07947f2003158520bf1282bcd1764e5c278ee31aafba229a3b0caaadfa123b2d` |
| `merge-tree-frozen-result.json` | `61d40d73f811c1302c212470e2325c82bd926a77b864414e5ca6413af9d8a885` |
| `merge-tree-native-journal-audit.json` | `c6d1437065ca0561ef23a5bde2d0cfae7ccd603ca4cb50bcd3f1fcfc58ad1525` |
| `merge-tree-native-evidence-check.json` | `0678025e4a81bca0709b37d4a462aa5c4e56efaa0ddc0366318f6cc3492271cc` |
| `merge-tree-checkpoint-cleanup.json` | `74f99e0174a1c34b5df86327609f681af4b8b7672ca557165f9967657738b64b` |
| `merge-tree-regression-roots-cleanup.json` | `6ac9a60c02a48fcbcf1b7aabc967ad4d43d9e1fd93fc24af89cf14aa72f73aaf` |
| `merge-tree-old-vm-cleanup-check.json` | `f05c45e97e54ba5e720e1a201823905653694aed32b486b7b71bf9de6db310b5` |
| `merge-tree-checked-targeted.log` | `2647ac00693ff548506b07e51d0f53d797893cceba70db713c224cce667f75b5` |
| `merge-tree-red.log` | `361c86a3c9ecade6b04d512caa6ceb232f4c8f321d6242c5074ca6873a56af7e` |
| `merge-tree-runtime-red.log` | `128a86c9e58eb4df7c94e4d5cc1c4c4b13122a002af746e19a783a91dfb6c0d9` |
| `tree-batch-full-test.log` | `0d3c43c5d25f08efdbf55c3ffacd06094ffe75dcc55105a6b7aa111fc075384b` |
| `tree-batch-frozen-result.json` | `726c978eb8d1528f55b149c5c8da7fd84d221dcc58dec258d6cb8485bcad8f20` |
| `tree-batch-native-journal-audit.json` | `d37e72d1c7397f706cfd9cd19743e070e05e5a19135f2effc77ec642e1dd9641` |
| `tree-batch-native-evidence-check.json` | `75c1f3f07182991b9d834201856ec1d3315f0194d0576af4b5f13c83974c7799` |
| `tree-batch-checkpoint-cleanup.json` | `2fad0538354023b65f67b5a1592adbfbfdb3c026fdc4d200204c65c91569a093` |
| `tree-batch-regression-roots-cleanup.json` | `6abe06884e63818a20ebe13525592c65c2f64648113199ec9d79a677ff7aed05` |
| `tree-batch-old-vm-cleanup-check.json` | `ea9f1322c06a95144f3c4bc3f788846b901d0f7f1c40c7d058628242c1186ed9` |
| `tree-batch-checked-targeted.log` | `a248096da0c390efd3c54e3484f2a5259a88f5d9a56f5fb5d5d6b7ee6f3412e0` |
| `tree-batch-policy-red.log` | `f199b3544d9f2461d620630ff268b0651e79de0748df101f0428a7a93c8e4903` |
| `tree-batch-red.log` | `bcdeea296e0d5a87c47483771f8e6f7d1c43152b6e2d8dc721765cc3f1072de1` |
| `tree-plan-full-test.log` | `bf31233f4c4436c22702109dcfbe1f58418c99d485496cafabc777da9b2ba453` |
| `tree-plan-frozen-result.json` | `8de755d937cb57ea24436b6e7bb1705e9894a7ff58417629916b9bb0fbfff2e8` |
| `tree-plan-native-evidence-check.json` | `7e2851ec2d896536fa4912f5f39e884ab61bcdb4502806f86d6143420c6882ef` |
| `tree-plan-checkpoint-cleanup.json` | `aeeeb74aa798cbcc92787f0aaaded50ba3a20b0853e17ede180d65dfe956399c` |
| `tree-plan-regression-roots-cleanup.json` | `acaef69ec55f1af72f91c788f7f750a871707609f2fcee710c89160ae0e06ee7` |
| `tree-plan-old-vm-cleanup-check.json` | `ea9f1322c06a95144f3c4bc3f788846b901d0f7f1c40c7d058628242c1186ed9` |
| `tree-plan-checked-targeted.log` | `157b4ba0d0b0714bf93a8577d56de279691992f598e51421e1fa2c409128ffca` |
| `integration-control-full-test.log` | `370e22f33af19ec994c934e6ea8ecd44efcb41de54a8d4d3166b98fe2d69fd12` |
| `integration-control-frozen-result.json` | `f383c1e5a61e7e629a9c14e565e2f345f5c661147d24ea4cc16e4911802e005d` |
| `integration-control-checkpoint-cleanup.json` | `b2fd65b8fb50cd542fe81810b344c5066e429eb93c44399cf81d1bff3dda0cbe` |
| `integration-control-native-evidence-check.json` | `2de389da8d5f819c418103ecf4f26ea24586b7abb5d03c25073e2cc044157e7c` |
| `integration-control-regression-roots-cleanup.json` | `76ed370c6a6bd273c96c2e4b8839ffabb9161fcc7b7200513b1d0b27d2f5cade` |
| `integration-control-old-vm-cleanup-check.json` | `ea9f1322c06a95144f3c4bc3f788846b901d0f7f1c40c7d058628242c1186ed9` |
| `integration-complete-release-red.log` | `af59f8e83e02f6086c24b647947bbfe87d87c0345ac09e566e195868ab0eb6ef` |
| `integration-complete-release-green.log` | `668ba6b511d2937cb1103895b56784c294a9d55f1df6bc065b12199122498371` |
| `directory-effects-full-test.log` | `742dc3ababe260bee80b2a9badbb1db79cc545c18cd57a6a669eaa5d09e1872a` |
| `directory-effects-frozen-result.json` | `0a8714f4c6c56780d4e9a83bcf91d189594b327c4fb6efa1d58d134642894c18` |
| `directory-effects-native-evidence-check.json` | `f502a2c5327868871e54b535eeb554e87a62fcf4fb61dd68acdf7536167140e4` |
| `directory-effects-checkpoint-cleanup.json` | `a60e7f637b2cc1d872b0248de2424896b777a22c5cd5c32d9898df72d0d59f1f` |
| `directory-effects-regression-roots-cleanup.json` | `99f62417fa4045f8c33bba0e114e880fb049589877d6841bd8a0955c1949d6ee` |
| `file-effects-full-test.log` | `1770252320eca8eedf8cc9ec7536e846571ee30c3913a740b9447e52da3279a8` |
| `file-effects-frozen-result.json` | `7effaf286a8f8aeed979220c8a8b0303389585c2b421e26dd4f924be95a6b7b7` |
| `file-effects-native-evidence-check.json` | `0701c9c674ae725ff6b4d409eb78fb7fcf50a5ea85a8d3cd0601bffee11a242f` |
| `file-effects-checkpoint-cleanup.json` | `6ccc27217e2012a34d0e679d077b823756345a64152dbc64a53d48b717f00520` |
| `file-effects-regression-roots-cleanup.json` | `9b0bed498dae0d3fc576c75f5b9d29aece9d3dd53b972c205622bd819baeb15d` |
| `candidate-full-test.log` | `9e8220c6e5d74b52d824a562e45a8ae836fac96ec7b10ecceb7dd8f8a2878278` |
| `candidate-frozen-result.json` | `09650e9ae9a8ced741811e854e620d99081ed8b7740a8cf000826deee01d68b2` |
| `candidate-checkpoint-cleanup.json` | `4600197637c664c5ff3dc1bf83c43742bb6f4796717c501274c54459d209269a` |
| `candidate-regression-roots-cleanup.json` | `24fd9d9104c5ca575b9c89cbd7022d3e42c66f95caea120049fd4779efe98893` |
| `merge-discovery-full-test.log` | `eea8a2dbece1ea671705b925655e4b343a73e6e8821bc7633ea589ac1e625ad8` |
| `merge-discovery-frozen-result.json` | `117da3c7a574e6e94031d1084a6555ffde29a89acc24cde220913d23de552454` |
| `merge-discovery-checkpoint-cleanup.json` | `db64df7868f7996603f205184a63c6c896f6818c5183d4c41ad975f6b2e16504` |
| `regression-roots-cleanup.json` | `9c7b55645404d4eaa043fcb2194d0557242c13a3196ef1bdf556fc3e0a4dd71a` |
| `merge-discovery-filtered-result.json` | `2e5a7ee786f8dfce49204ba1fa3a90775e38fc19e09786d040610c17074377c5` |
| `discovery-zombie-red.log` | `c131128f3e3f1e7c8ca02f9133f4de8d195a5a3f8aace35d6fc47d27e1c5ec80` |
| `wave-head-full-test.log` | `0377273508907e69b4d0c0d1c0f6f4150bf447673afd853eb65e160607b20207` |
| `wave-head-frozen-result.json` | `ea22f0884e41c3f6f9ae97a3cbce30439832968af93762bd097b8f7dfb5e1a9c` |
| `wave-head-checkpoint-cleanup.json` | `02cb3b9b7939e8e33c79dc1a61410f648c8f4c11801baf906f0c44b3cb424fe2` |
| `wave-head-targeted.log` | `da7ec12ed0c3a45011366b274b4107316c0e2aecdb2976416440dc927ce74602` |
| `wave-head-typecheck.log` | `31bca0e1de9f7370c83be8bf321cf3a80e619b1997255ee0410177c1cafa6144` |
| `wave-head-lint.log` | `a9cb82429a670be06ffc12bb6241dbec0a577e3ba212f8a6fc11a4ad027eea92` |
| `worker-head-replay-red.log` | `74a5a4471ee2bb7f2390d492ea21ca0bb28c78a531ae155b0e8f7afa2bdb0399` |
| `worker-git-commit-red.log` | `22a8a32f77d3fb9a08c6ca754adc8c9aad703cb0c879e048a605ed1f1f104a4c` |
| `directories-full-test.log` | `a902eb518886d3bb8bf201f0b0c36da9c01f84632e50355971b60e65d06ea4ac` |
| `directories-frozen-result.json` | `ea22f0884e41c3f6f9ae97a3cbce30439832968af93762bd097b8f7dfb5e1a9c` |
| `directories-checkpoint-cleanup.json` | `b2da9492e9da20c5ea5a6ca00512b0d83286379a7d0b057a4422eb564e93169b` |
| `directories-mcp-integration.log` | `5aa15b1d0eaf3c57c005a0becb58ad152f514d4c291d7b8149d604cd3f6f2340` |
| `directories-mcp-typecheck.log` | `31bca0e1de9f7370c83be8bf321cf3a80e619b1997255ee0410177c1cafa6144` |
| `directories-mcp-lint.log` | `f67e29a978b72ebfdc44e5fb96879ffb5c1002cdde4fe2c404c0b4677841f559` |
| `registration-full-test.log` | `8fa0fe07fd6d443c0be51097aa7a7605c29d4d3082e82a6e6bf917b2eaab47ec` |
| `registration-frozen-result.json` | `9399ea5fd614612aace5e454a6f448edeabbbca547fe3fb91aee963e50d288fb` |
| `registration-checkpoint-cleanup.json` | `3f4576440911faa2e0d1108d0c827ba49c31d85e57ffd59c2edbcd3ce250389f` |
| `registration-targeted.log` | `b026aec9d3fff07ff419cde090a737e86e845dcd6f307c18d73c940aadfe976c` |
| `registration-final-typecheck.log` | `31bca0e1de9f7370c83be8bf321cf3a80e619b1997255ee0410177c1cafa6144` |
| `registration-frozen-lint.log` | `34b8e4bdc586786e358ca8ce39af8d80458f7b3167383d6d819d2c9342bbb5b3` |
| `version-full-test.log` | `7a37b92ab46dcca726eabe952e4682789a973cc24029bcaa0dd33264be5c83b5` |
| `version-frozen-result.json` | `d65964060d186a437609e1187b4f6fa976d5d7f47479a810d585d11a590953b4` |
| `version-checkpoint-cleanup.json` | `9431bcfc7aa1a6751c950e8ab7e24e481e126060413a6d69b4c6cb1a910151a4` |
| `version-final-targeted.log` | `127b27f495543faf7a57a220e6abc697b28c2fb01ca83124b886a979c9a43b3a` |
| `version-final-typecheck.log` | `31bca0e1de9f7370c83be8bf321cf3a80e619b1997255ee0410177c1cafa6144` |
| `version-final-lint.log` | `47b38fe3f47b59459ee355ed27f6192f2030f3f9e9172df5be64d87e27bc8451` |
| `linked-native-proof-red.log` | `e482d5ea7e858e72da4e1fa2ddd343daea3029a3388313eacef6c608ecdd7a7a` |
| `linked-native-proof-green.log` | `a28e8c6d4b8e451134e2d249be775e79f231ab97b86b8ebd19bd16efad3c4f59` |

## 仍需完成

Web组合根、accepted后续波次及产品累计集成接合、独立Tester的最终Git版本链、REVIEWER、D16确认应用及目录入口、补偿/清理正式接合、完整12.4 G5。终态后同需求合并复验已按[规格复评](task124-delivery-spec-review.md)修正为同task显式新轮次；该生命周期、分轮归档及真实验证尚未实现，不以当前接合通过替代这些工作。

下个实施入口：实现本机受信`IntegrationWorkspacePort`及转换桥接并复用既有`IntegrationService`，消费已实现的候选、完整树、精确Git发布与State确认；Git发布后的refresh及原transition须绑定原应用证明，避免重复提交、旧快照覆盖或仅凭物理亲缘推断恢复。对象合并无MERGE_HEAD时验证工作区未变，不虚构abort。从规范派发登记integration/validation根，再接最终Git+manifest/实际命令验证与accepted来源。Git原语只接已有Git主工作区；用户linked-worktree根、direct切换、创建补偿及正式回收仍未接入。

D17规划前initialBase及worker完成HEAD的两个时序缺口已由本轮实现和完整回归覆盖。余下Git/State半提交不能用磁盘HEAD自动接管绕过，须以固定输入与真实完成证据定义受信恢复路径。
