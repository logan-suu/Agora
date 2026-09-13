# Agora：简历事实与面试备答

日期：2026-09-11。依据：已合并的10.2–10.5实现与验证记录、T10.6工作区实测、蓝图§18和详细设计§11.9。当前任务状态以[任务索引](../task-status.json)为准；本文不宣称10.7最终出口已通过。

当前已接受演示：[全英文自然语言交互视频与证据](../demo/task106-natural-chat-demo.md)（quote-en-take-9）。同一真实任务展示并行Coder、自然语言改价与显式确认、累计测试、Reviewer→Leader终审、归档和刷新；归档18+8项检查通过。真实返工与剪辑均披露，单次演示不作为可靠性/性能结论，不宣称本场景触发历史压缩或暂停worker真Fork。旧录制6仅作[历史诊断索引](https://github.com/logan-suu/Agora/blob/83fe416c1015d86616acdead7af2ebbad82e8384/docs/demo/task106-product-demo.md)。

## 30秒介绍

Agora是一个在Mac本机运行的群聊式AI编码协作产品。用户作为Leader指挥六类角色，系统按任务复杂度组织规划、编码、测试和评审，支持独立worker并行、运行中修改需求以及最终人工确认。单Agent循环和会话复用DeepSeek Harness；我实现了角色投影、协作编排、全局并行额度、持久暂停恢复和Git工作区集成，并用真实链路与分组评测验证边界。

## 可用于简历的事实

- 构建TypeScript全栈编码协作产品，以Next.js群聊展示持久进展，HTTP接收Leader指令、SSE推送展示消息，模型上下文经角色和assignment切片。
- 基于官方Harness loop/session实现独立worker，使用全局lease调度、任务内串行提交与Git linked worktree隔离；累计测试绑定已验证commit后推进波次。
- 实现安全点后的需求更新及持久humanGate恢复，区分普通返工、阻塞异议和Leader最终完成权威；保留可追溯的官方JSONL与安全Trace。
- 交付macOS安装/启动入口、系统钥匙串主密钥管理，以及逐Agent或全员模型连接配置。
- 建立可审计工程评测：固定公开JavaScript四题与两个内部协作任务，每task×variant三次独立attempt，保留失败、版本与成本限制。

这些条目描述已实现机制，不应追加“完全自主”“永不崩溃”“无限扩展”或“普遍提速”等结论。旧录屏已按Leader要求撤下，新版quote-en-take-9已获接受并提供成片。此前尝试、修复和验证仍见[演示索引](https://github.com/logan-suu/Agora/blob/83fe416c1015d86616acdead7af2ebbad82e8384/docs/demo/task106-evidence.md)，历史记录不改写为本轮成功，视频接受也不等于10.7出口通过。

## 问题、取舍与证据

| 高频问题 | 回答要点 | 实现与验证入口 | 限制 |
| --- | --- | --- | --- |
| 为什么TS全栈、自研编排？ | 前后端与领域契约统一；产品的角色、Leader权威和暂停边界由确定性控制层实现。自研的是协作语义，单Agent循环复用Harness。 | [架构文档](../系统架构设计文档.md)、[编排入口](../../packages/core/orchestration/src/coordinator.ts)、[角色路由测试](../../packages/core/orchestration/test/coordinator.test.ts) | 这是项目取舍，不证明TS或自研方案普遍优于其他框架。 |
| 群聊会不会让上下文爆炸？ | display与payload分离，原始群聊不进模型；当前角色/assignment事实用官方SystemPrompt系统段每请求刷新，工具历史和压缩由Harness负责。 | [投影](../../packages/runtime/executor/src/project.ts)、[执行器](../../packages/runtime/executor/src/harness-executor.ts)、[D1修复证据](../evals/phase10-projection-input-repair-evidence.md) | 仍受模型窗口、输出上限和任务复杂度影响；累计输入token不是单次上下文长度。 |
| 为什么同角色能并行但不写乱？ | 每个worker有独立Context/session/worktree；GlobalScheduler lease限制执行额度。并行模型只提交有稳定身份的append，TaskStateStore写入串行重读并校验，WorkerRuntime独占自身生命周期提交。 | [调度器](../../packages/core/orchestration/src/global-scheduler.ts)、[worker运行时](../../packages/core/orchestration/src/worker-runtime.ts)、[Phase9出口证据](../evals/phase9-exit-evidence.md) | lease上限不是容器总数、磁盘或供应商GPU资源上限。 |
| 多分支如何变成一个可信产物？ | 独立模块按DAG集成；TESTER在独立validation工作树提交测试，可信服务运行真实命令并以receipt绑定dispatch、HEAD和控制指纹，再推进累计基线。 | [验证服务](../../apps/web/src/server/wave-validation.ts)、[并行编排](../../packages/core/orchestration/src/parallel-coordinator.ts)、[真实波次链测试](../../tests/integration/phase9/phase9-parallel-flow.test.ts) | 不是任意语言/测试框架的通用验收器；现有Node/TAP入口有明确边界。 |
| LLM不能硬中断，如何改需求？ | 正式消息入口校验指令，固定活动cohort；在途Step自然结束并提交后才执行控制变更。非阻塞更新重投影并保留context/lease；currentRequirements保留全部当前有效需求，最新指令不能代替完整需求视图。 | [消息服务](../../packages/core/orchestration/src/message-service.ts)、[详细设计§4/§5](../详细设计方案.md)、[Phase9出口](../evals/phase9-exit-evidence.md) | 不承诺指令瞬时生效；等待中不取消token流。 |
| 暂停恢复与普通更新有何区别？ | blocking gate要先flush完整checkpoint、持久gate再释放资源。裁决后按receipt重建context，校验source prefix与lineage，为paused worker取得新lease。 | [Web组合根](../../apps/web/src/server/task-composition.ts)、[Phase8出口测试](../../tests/integration/phase8/phase8-exit.test.ts)、[Phase9出口测试](../../tests/integration/phase9/phase9-exit.test.ts) | done/failed worker不重开。完成gate恢复composition不等于触发worker Fork；崩溃后不保证任意任务自动续跑。 |
| Agent意见不同谁决定？ | 普通代码缺陷走测试失败/changes_requested返工；质疑需求或决策本身的blocking异议才要求Leader裁决，接受可能撤回目标。TESTER/REVIEWER只给候选，完成须D16 Leader终审。 | [蓝图D14/D16](../项目蓝图.md)、[返工修复证据](../evals/phase10-recovery-scope-repair-evidence.md)、[Phase8出口测试](../../tests/integration/phase8/phase8-exit.test.ts) | 模型仍可能误解语义；严格解析器不替模型猜测或自动改分类。 |
| Trace能展示什么？ | 从官方JSONL读时派生role/session/turn/step/工具状态，按lineage去重并限制响应大小；群聊SSE与Trace快照分开。 | [Trace HTTP入口](../../apps/web/src/server/trace-handlers.ts)、[泳道](../../apps/web/src/app/trace-lanes.ts)、[Trace流程测试](../../apps/web/test/trace-flow.test.ts) | 不展示原始prompt、reasoning、工具参数/结果；截断显式，损坏日志拒绝。 |
| 沙箱隔离了什么？ | 逐worktree容器、任务自有canonical repo；正式宿主文件入口绑定目录身份，Git/验证/归档操作期间冻结同目录容器写入。 | [Phase9出口证据](../evals/phase9-exit-evidence.md)、[详细设计§6/§11.7](../详细设计方案.md) | 本机单用户边界；不能将未越界的有限测试当作对所有攻击的证明。 |
| 为什么角色可增删却不承诺任意自主路由？ | roster与Channel同revision持久化；离职先drain再交接、责任明确后depart。新增能力装载与自动拓扑选择是不同契约。 | [详细设计§2/§8](../详细设计方案.md)、[延期台账DEF-016](../deferred-items.json) | 任意自定义角色的自主调度仍延期；并行计划对缺wave/subtask绑定的指派明确拒绝。 |
| 本地运行是否意味着离线？ | 后端、Git/Docker、State/session均在本机；模型服务可在线，也可为兼容的本地服务。API key密文存储，主密钥由macOS钥匙串管理。 | [启动证据](../evals/phase10-local-startup-evidence.md)、[模型配置证据](../evals/phase10-model-settings-evidence.md)、[正式启动器](../../apps/web/scripts/local.mjs) | 当前产品启动器仅macOS；Linux底层沙箱支持不能替代Linux产品适配。 |
| 如何防死循环、控成本？ | 产品有有限provider重试、格式恢复和8轮编排上限；Eval另外冻结调用/时间/费用并逐请求预留计账，异常先停查。 | [韧性证据](../evals/phase10-resilience-evidence.md)、[最终报告](../evals/phase10-opencode-go-final-report.md) | Eval USD上限不是产品已有的通用计费UI；有界停止也不能保证模型一定完成。 |

## 如何诚实解释最终评测

公开v11：single 12/12、multi 11/12、mixed 10/12；内部v14：multi 6/6、parallel 4/6、sparse 4/6。各task×variant仅3次，两组源码不同，不算合并成功率。全部配置/逐次记录/方差/失败见[最终报告](../evals/phase10-opencode-go-final-report.md)及[公开指标](../evals/phase10-opencode-go-public-metrics.json)、[内部指标](../evals/phase10-opencode-go-internal-metrics.json)。

公开single/multi的11个成功配对中，多角色平均多用176.12秒，速度比均值0.44、样本SD 0.20。内部serial/parallel的4个成功配对中，并行平均少用142.80秒，速度比均值1.38、样本SD 0.20；同时并行整体只通过4/6，串行为6/6。解释应是“在这些可比成功样本上观察到差异，同时存在失败与编排开销”，不能写成“系统稳定提升38%”。

两组最终样本均未触发worker Fork或官方压缩。此前真实功能测试/压力验证单列说明这两项能力，不以未触达的Benchmark通过记录推导其收益。未进入独立判题的失败保留为流程/预算/传输等分类，不擅自判作错误代码；unknown用量不填0，Go配额折算不是实际额外账单。

## 演示解说边界

后续优化全部完成后，再按[任务10.6录制计划](https://github.com/logan-suu/Agora/blob/83fe416c1015d86616acdead7af2ebbad82e8384/docs/demo/task106-recording-plan.md)执行；媒体、版本、任务、实际结果和后续清理修复在[证据索引](https://github.com/logan-suu/Agora/blob/83fe416c1015d86616acdead7af2ebbad82e8384/docs/demo/task106-evidence.md)中分别记录。演示是一条可审计功能链，不是新的统计样本。遇到产品缺陷先定位和修复；不剪掉失败后宣称一次稳定成功，不让Agent代替Leader做最终裁决。
