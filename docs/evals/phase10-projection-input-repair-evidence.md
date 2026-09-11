# Task10.5 投影输入与 Go 压缩请求修复

日期：2026-09-10。已完成D1修复的153文件1159项回归清单及两种Go模型真实压缩验证。v10现停于5final/3pass/2fail，后续控制交付提示冲突已修复并通过两模型真实验证，v11完整153文件1159项门禁已通过并冻结启动；Task10.5保持in_progress。旧失败与费用审计记录按时间保留，最新结果见文末。

## 审查结论

旧 v9 在 29/54 final 处停止：24 pass、5 fail、25 pending；其中4次因连续重复输出由操作者停止。五次失败均未运行独立 Outcome grader；实际运行的24次独立验题均通过。旧结果、源码快照与费用保留，不能混入修复后的统计。

按证据审查三个假设：

1. **重复任务指令（确认缺陷）**。锁定的 dsh-agent-loop 0.1.1-rc.2 中，preStep 读取新 claim 的 inbox；准入消息随后追加到 session surface。旧 D1 每个工具 Step 都追加完整投影，实际 Go 请求2为 `system,user,assistant,tool,user`。末尾 user 是重复任务指令，违反了保持同一工具回合连续执行的意图。
2. **历史工具结果丢失（本次复现不支持）**。真实 Harness、MCP 字符范围读取及 Go 序列化均保留先前工具结果、稳定 callId 和对应关系。此前测试只证明历史保留，没有检查末尾重复指令，因此不足以排除输入构造缺陷。
3. **纯模型/服务端循环（贡献仍不确定）**。历史相同输出确实存在，但现在不能仅归因模型；需要新版本的独立实验测量修复影响，不能把离线绿灯当作真实循环已经消失。

D1 来源文档已先行纠正，原文约束：

> `agent/pre-step.messages` 仅为当前领取的 inbox 消息

修复使用 agent-scoped 官方 `SystemPrompt.section/variable` 每次请求组装当前完整结构化投影。变量仅插值一次，保留任务数据中的字面量 `{{...}}`。每个 Executor turn 仅一次固定启动消息；工具 Step 准入原工具交换，显式输出格式恢复沿用原有界、无工具路径。官方 Harness 继续保留历史、触发压缩和提交摘要；初始、重投影、D4 Fork 复用同一路径。Executor 端口、State 写入、角色权限与安全点机制未变。

## 压缩请求的独立问题

v9 官方事件共有5次自动压缩开始、4次成功、1次失败，均已闭合。forth-multi-1 的失败事件为 `summarization produced no text summary content`。该摘要请求记录为 `tool-calls` 结束：请求在停止标记之前发出，摘要失败在流自然结束之后落盘，不是 context-limit 证据。

锁定 SDK 的 `GenerateOptions.purpose` 明确允许 adapter 应用辅助请求的生成策略。Go Eval 适配器现在仅对 `purpose=compaction` 去掉可调用 tools，保留 system/messages 中已有工具证据、模型与会话身份；普通请求工具清单不变。费用预留和输入估计使用实际发送参数，安全调用记录增加 purpose。官方压缩算法、历史选择、摘要校验和持久化未被替换。正式守卫还要求摘要请求以 stop 结束并产生非空文本；工具调用、空内容或空白摘要在流自然闭合并记账后持久停组。真实官方压力压缩回归证明：第一次普通请求和一次空摘要请求后，provider 调用数固定为2，后续恢复不再发起付费请求。旧失败仍保留，不回写成功。

## 验证证据

- RED：真实 Go 请求2多出 user；新 D1 三项回归在旧实现失败。日志 `agora105-projection-repeat-red.log`、`agora105-projection-input-red-final.log` 位于 `/private/tmp/`。
- GREEN：最终离线21文件99项通过，另新增真实官方压力压缩停止检查1项通过（该文件8项全过；合计100项），覆盖当前投影唯一性、字面量花括号、历史工具 ID/结果、投影更新、官方压力压缩、输出恢复、Fork、计量与实际 Go HTTP 序列化。日志 `/private/tmp/agora105-projection-offline-final.log`。
- 压缩工具 RED：两个 Go 模型的摘要请求仍携带工具；修复后摘要请求均不携带 tools，普通请求保留 tools，调用者输入不被修改，摘要调用单独计量。日志 `/private/tmp/agora105-compaction-tools-red.log`、`agora105-compaction-tools-green.log`；自动停止的三项 RED 及完整 Harness GREEN 见 `/private/tmp/agora105-compaction-guard-red.log`、`agora105-compaction-guard-harness.log`。
- 真实 Docker 集成：10文件70项通过，覆盖 Phase0–5、Phase8、Phase9与Phase10受影响路径，包括并行波次、累计验证、需求重投影、返工、暂停/Fork和 D16 终审。日志 `/private/tmp/agora105-projection-integration2.log`。第一次受沙箱 Docker socket EPERM 阻断，已停止该次检查并在获准访问 Docker 后补验，没有跳过失败用例。
- `pnpm typecheck`、`pnpm lint`（392文件）通过，`git diff --check` 通过。该检查点的全量 `pnpm test` 尚未执行；后续完整清单验证结果见文末。

## 费用与后续边界

本轮修复与离线验证未新增付费模型请求。Go 正式共享账本仍为717请求、USD0.911844144、0未结算，原总上限 USD5 不变。v9 冻结的360份执行源不覆盖；新源码只能在完整验证后另冻新组。

之前官方 DeepSeek 全回归漏设 `AGORA_EVAL_BUDGET_FILE`，本地缺少该次 usage/请求记录，也未启用可恢复会话持久化。新增费用无法可靠还原；已知官方账本 USD8.536625848 不包含缺口。没有把未知费用记零，也没有为补账重复付费运行。当时暂停新的官方付费回归，等待供应商账单核对原 USD20 额度；该阻塞已由下述费用审计解除。未来执行必须显式设置并核对预算路径。详细缺口记录在 `.data/evals/phase10-regression-audit-gap-20260910-plan.json`。

已同步：蓝图§21 D1、详细设计§0/§6/§7/§9/§11.8、系统架构§4.1、技术选型接缝说明、开发计划、task-status 的 D1索引/10.5证据及 AGENTS.md。早期任务 notes 中的旧 pre-step 说法属于历史记录，以本次 D1 校准为准。按 Leader 新约定，后续问题先停受影响工作、审查后直接修复，不重复申请范围内修复计划批准。

[2026-09-10 费用审计解除] 已通过现有DeepSeek平台只读导出，核对当前凭据掩码一致。13:00–14:00 CDT账单完整覆盖13:05:48起的379.91秒回归：24请求、未缓存输入21873、缓存输入251008、输出21713，平台CNY费用0.11374516。按原批准配置各token类别最高峰价1.32/0.044/3.96 USD每百万计算，全时段保守上界USD0.125900192，作为独立audit adjustment计入旧USD20/diagnostic USD3门禁；2357个原请求不改写、逐请求缺口不伪造。若该时段还有其他使用，整体计入只会高估缺口。账单ZIP哈希f4f06f95423eebf46260593952f7e10f18b2ff134e0cd67a5517446a3e37609c，原件及公式见.data/evals/phase10-official-billing-audit-20260910。补计后官方预算保守占用USD8.66252604，diagnostic剩余USD1.438678484，允许原范围内真实回归继续。Go预算未改变。

## Web回归补修

[2026-09-10 费用审计与Web投影回归] 供应商13:00–14:00 CDT账单覆盖此前未计量全回归：24请求，按原批准最高分类单价补计保守上界USD0.125900192。新增独立不可变audit adjustment参与原USD20/diagnostic USD3门禁，不伪造逐请求usage；补计后USD8.66252604，原费用阻塞解除。带计量全回归首个失败即停：20文件/144测试通过，Web脚本适配器仍从首条user解析旧投影导致1项失败，确认非真实模型接口故障。修正为读取唯一D1 system段，真实Docker/Harness/MCP链路2项通过，终审及产物断言未弱化。该次22真实官方请求全结算，新增USD0.021186272；当前官方保守占用USD8.683712312，0未结算。正在重新执行完整回归，尚不宣称G4通过；Go账本及v9历史不变。证据docs/evals/phase10-projection-input-repair-evidence.md，无commit/push。

RED日志：`/private/tmp/agora105-projection-full-audited.log`（首失败即停）。GREEN日志：`/private/tmp/agora105-web-projection-green.log`（2项通过）。其余脚本投影读取位置已再次搜索核对；工具结果JSON解析与AppState消息访问不属于旧投影入口。重新完整回归日志：`/private/tmp/agora105-projection-full-audited2.log`。

## 完整回归结果

[2026-09-10 D1全回归完成] 第二次全回归在Phase7首次失败处停止；确认phase7-exit与role-onboarding两个CapturingAdapter只采集messages，遗漏新的system投影。先复现后改为检查唯一D1段并采集完整system+消息，原入职事实及禁止原始群聊的断言保持。Phase7共4文件7项通过。按Vitest完整153文件清单保留43个未变文件的通过结果，补跑其余110文件801项，合计153文件1159项全部通过；没有跳过测试或移除真实凭据，文件集合逐一核对见.data/evals/phase10-regression-partition-20260910.json。typecheck/lint393文件通过。官方账本2396请求/保守USD8.701352732/0未结算；两次已停止回归均留档，原USD20不变。现开始两种Go模型合成压力验证，最多16请求，复用原USD0.50诊断余额；未启动新正式组。

第二次RED：`/private/tmp/agora105-projection-full-audited2.log`；独立入职RED：`/private/tmp/agora105-phase7-onboard-red.log`。Phase7 GREEN：`/private/tmp/agora105-phase7-projection-green.log`；完整剩余清单GREEN：`/private/tmp/agora105-projection-remaining.log`。43+110文件计数以清单中逐文件成功计数求和，不使用失败运行顶部的总进度推测最终结果。

## 修复后Go真实验证

[2026-09-10 Go修复实测与v10准备] 修复后两种指定Go模型各完成2轮合成文件读取，真实官方Harness持久事件各确认1次自动压缩成功，0失败/0未闭合，压缩后PAGE_MARKER与answer()=42约束保留。共10请求新增USD0.029477946，诊断累计59请求/USD0.129560616，原USD0.50池不变；不是Benchmark得分或重复原失败请求。证据.data/evals/phase10-go-projection-repair-df0e7a78-02e5-4f69-9aa1-6af2e5fa6f26。v10注册只更新协议/授权组标识并拒绝旧v9，12项针对性回归及typecheck/lint393文件通过；生产代码沿用已完成153文件1159项全清单验证。准备冻结opencode-go-system-projection-v10，任务/seed/模型/54次顺序与v9一致，共用原Go USD5账本（正式717请求/USD0.911844144），旧组不恢复或覆盖。

[2026-09-10 v10冻结与启动] 组指纹0a74a18c8d5c5c244b1a27397029a9ec33c2207d8a2bbc27a686d4f87bbd5c8d，源码5db38f775a5750810a763cc3dea79867672761c6948a4c37ebfdc191d3d4abce；364执行源加9份配置/规格共373份快照，逐哈希验证。54任务/seed/路由/模型配置与v9逐项一致。Go正式启动前717请求/USD0.911844144/0未结算，复用原USD5；日志/private/tmp/agora105-go-formal-v10.log。D1真实Go验证及官方压缩持久事件2/2成功已完成；正式实验逐次观察，发现问题停后续请求，当前流自然收尾。旧v9保持29final/24pass/5fail/25pending，禁止混入v10。

[2026-09-10 v10首次停止审查] 前3项single/multi/mixed均pass；grade-school-multi-2的PM首次请求反复改写需求，观测到后立即阻止后续请求，当前流自然结束。该请求260.172秒/17248输出token/USD0.010392642/stop正常结束；官方header及会话证明唯一system投影、单一启动user、零工具历史/零压缩，未证实重复注入或上下文缺陷。后续ARCHITECT在provider I/O前被挡，新增付费调用保持1；cleanup/routing通过、最终lease0、0未结算。此项记operator-interrupted-repetitive-initial-planning，独立验题未执行，失败保留，模型侧原因inconclusive；无新代码修复依据，保留停止审查后继续同v10剩余50项，不重跑失败样本。当前4final/3pass/1fail，Go共享771请求/USD0.960794220，364冻结源一致。审查.data/evals/phase10-final-v10/stop-reviews/grade-school-multi-2/review.json。

## v10控制交付提示审查

[2026-09-10 v10控制交付冲突修复] grade-school-mixed-2完成生产16项验证，但REVIEWER输出有效concern块后又追加verdict数组，严格解析器以非末尾控制块拒绝，未执行独立验题。23请求/USD0.015862212全部正常结算，cleanup/routing通过、最终lease0。审查确认普通最终JSON提示与通用异议末尾块提示缺少适用范围/优先级，而既有实现和规格已将控制turn与普通交付分开。明确三选一turn结果、控制turn优先于普通JSON格式、不混交requirements/architecture/verdict，普通交付待后续规范路由；PM/ARCHITECT/REVIEWER最终格式限定普通handoff。解析器与异议错误不重试规则未放宽，端口/State/D14/D16未变。详细设计§2同步提示范围校准，44项针对性回归通过，真实advisory链和后续门禁验证中。v10永久保留5final/3pass/2fail/49pending，Go累计794请求/USD0.976656432，旧失败不重写；修复后另冻组并继续原USD5。

[2026-09-10 控制交付修复验证] 普通handoff/异议/Channel action的提示优先级已澄清，严格解析和异常不重试规则保持。44项针对性回归、真实Docker/Harness/MCP的advisory→再次REVIEWER→Leader gate链通过。两种Go模型各在真实Harness中先交独立concern、后续turn交approved verdict，共4请求/19.384秒/新增USD0.001108308，全部stop正常结束并结算；不发送Benchmark/holdout，仅合成answer42事实。两轮修复诊断合计14/16请求，原USD0.50池累计63请求/USD0.130668924。证据.data/evals/phase10-go-control-handoff-5e3b0185-c57d-44d8-bb24-dda008d91130与/private/tmp/agora105-go-control-handoff.log。typecheck/lint394文件通过；v11注册已纳入当前全回归，完整结果待收尾，不启动正式请求。

[2026-09-10 v11完整门禁] 控制交付提示修复后的完整pnpm test一次运行153文件1159项全部通过（0 skip，382.51秒），包括真实官方模型、Docker/Harness/MCP和既有回归；typecheck/lint394文件通过。日志/private/tmp/agora105-control-scope-full.log。官方账本2415请求/保守USD8.720205628/0未结算，原USD20不变。新Go合成控制验证两模型共4请求正常交付独立concern及后续verdict；与压缩验证合计14请求，诊断累计USD0.130668924。准备冻结v11，沿用原Go USD5（正式794请求/USD0.976656432），不覆盖v9/v10失败或快照。

[2026-09-10 v11冻结启动] 组b0007a118d785ca17c229ea646bc90bf473afcf5057e6b8cce5e8013bb97e2a6，源码f1352ccf5d20bf6d8a0e343e8d53a076650a6ea1e6f5fd0c8d45d2dbc447316e；365执行源加9配置/规格共374份快照，工作/冻结哈希一致。54任务/seed/模型路由/顺序及价格配置与v10逐项一致，仅包含已验证的控制/普通交付提示范围修复。Go正式启动前794请求/USD0.976656432/0未结算，共用原USD5，日志/private/tmp/agora105-go-formal-v11.log。继续逐次监控，发现问题先停审查；v10保留5final/3pass/2fail/49pending，不重新执行其失败样本或覆盖快照。

[2026-09-10 v11 grade-school完成] grade-school的single/multi/mixed各3次全部整体及独立验题pass，当前9/54final，0失败；开始wordy。两个ARCHITECT曾各有一次预读尚未生成grade-school.test.mjs的ENOENT，均按冻结单次普通工具错误恢复规则保留并成功完成，未放宽第二次错误停组规则。Go共享累计约USD1.08834（952请求含当前预留），365工作/冻结执行源一致，9项归档费用与清理审计通过。仅此题完成，不能外推全部54项结论。日志/private/tmp/agora105-go-formal-v11.log，安全报告草稿/机制审计在.data/evals/phase10-final-v11。

[2026-09-10 v11 wordy人工中断复核] wordy-mixed-2的TESTER连续更换测试诊断命令，人工怀疑无进展后停后续请求；复核确认这是模型自生成的嵌套Node测试子进程继承NODE_TEST_CONTEXT导致的单项失败，不是宿主环境污染或沙箱缺陷。同镜像只读/无网络容器原版26pass/1fail/0skip，模型在停止前已写出的修正版27pass/0fail/0skip。此次干预偏早，打断了可恢复且已有代码修正的调试；分类operator-interrupted-recoverable-test-debugging，不宣称模型最终失败，不以事后自测替代未执行的独立Benchmark验题。保留该中断及费用，源码/门禁不变，继续同v11剩余40项。当前14final/13pass/1人工中断，Go共享1054请求/USD1.198155414/0未结算，365冻结源一致、cleanup通过；审查和复现.data/evals/phase10-final-v11/stop-reviews/wordy-mixed-2。

[2026-09-10 v11 wordy完成与输出预算审查] wordy-multi-3的REVIEWER单次请求输入估算12208，输出32768达到冻结上限，以max-tokens结束（315.658秒/USD0.019944654）；既有门禁自动停后续请求。该项22请求/USD0.044203602全部结算，生产22项测试通过但未到独立验题，零压缩触发，非context-limit或断流；归类reviewer-request-output-budget-exhausted，无已证产品缺陷，不抬高输出上限或补跑此样本。清理/路由通过、最终lease0、365冻结源一致。v11当前18final/16pass/1过早人工中断/1输出预算失败，Go共享1124请求/USD1.283487654/0未结算。保留失败和审查后继续同组剩余36项，从book-store开始；原USD5不变。

[2026-09-10 v11 book-store输出预算审查] book-store-mixed-1的deepseek-flash审阅请求输入估算7166，输出32768全部为reasoning，141.159秒后以max-tokens结束，自动门禁停止后续请求。生产24项测试通过但未执行独立验题；零压缩触发，不是context-limit或断流。23请求/USD0.044158950全部结算，cleanup/routing通过、最终lease0、365冻结源一致。分类reviewer-request-output-budget-exhausted，保留失败、不提高参数或重跑。当前21final/18pass/3fail，Go共享1180请求/USD1.359003066/0未结算；继续同组剩余33项，原USD5不变。

[2026-09-10 v11半程检查点] 27/54final、24pass/3fail；grade-school9/9，wordy7/9，book-store8/9。失败为1次过早人工中断与2次审阅输出预算耗尽，独立验题实际24次全部pass，不将未执行验题记作代码判错。book-store-mixed-2曾误读.spec.js收到单次ENOENT，恢复后整体通过，未放宽冻结错误门禁。365工作/冻结执行源哈希一致，归档费用与清理审计通过；官方会话压缩在27项内0触发，单独两模型压力验证已证实配置有效。继续forth及内部验证共27项；Go累计约USD1.460363，原USD5不变。安全报告草稿已更新，未发布最终结论。

[2026-09-10 v11公开集完成] 36项公开对照全部归档、33pass/3fail；single12/12、multi11/12、mixed10/12，forth9/9。独立验题实际33次全部pass，未交付的1次过早人工中断与2次REVIEWER输出预算失败保留。forth-mixed-1自测文件预读ENOENT、forth-multi-3测试角色误用容器Git各仅1次，均按原普通错误恢复规则完成，不放宽门禁。365冻结源一致、归档费用/清理核对通过，官方会话压缩36项内0触发。只读监控扫描碰到Git清理目录竞态，已改为避开动态工作树并容忍消失目录，未修改生产/冻结源、未影响正式结果。现开始18项内部协作验证；Go约USD1.725612/5，未发布最终报告。

[2026-09-10 v11首个内部样本停止审查] order-audit-multi-1在首个CODER step预读validate.mjs/package.json均ENOENT，触发冻结的第二个独立toolCallId错误停止。任务seed及规范Git HEAD均只有TASK.md，创建型任务初始化正确，无权限/挂载/上下文故障。4请求/USD0.015446880全部结算，cleanup/routing通过、最终lease0，未到生产验证或独立验题。分类tool-error-budget-exhausted-on-uncreated-files；明确严格按工具调用计数会截断可恢复的存在性探查，不能证明模型最终无法完成或发生无限循环。保留该限制及失败、不因得分放宽门禁或重跑。当前37final/33pass/4fail，Go1475请求/USD1.741058718，继续同v11剩余17项，原USD5不变。
