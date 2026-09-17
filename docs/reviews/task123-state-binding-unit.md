# 12.3 串行本机状态与双存储闭合

日期：2026-09-16。Leader要求“继续进行Task12.3直到完成”，沿用既有计划、本机固定fixture及Go固定测试外发授权。本报告记录中间单元，不把它等同整个12.3完成。当前仍未commit/push/PR。

## 规格与边界

详细设计§12.2.3.1：“两存储的动作在 registry prepared → TaskState canonical 引用提交 → registry committed 闭合；普通执行只接受双方闭合绑定。”同节：“只有串行控制面经 `applyMutations` 的新 set 字段可写；worker 模型不能 set/merge 此字段或自行授予权限。”本轮先在§12.2.3.2细化封闭数据结构及中断规则，再实现。

- L1新增localExecution-v1、纯校验与不可变引用转换；根/workspace/binding/receipt不删除或重解释，完整批次后校验task/project/worker/subtask/receipt关系。
- Reducer增加串行set；TaskState加载同验，返回值与输入隔离；TestResults对本机版本与旧路径混搭拒绝。此时文件manifest仍只是引用，不是完整验证证据。
- 投影前拒绝混搭；WorkerRuntime拒绝模型写入localExecution，包括串行模式，并在输出副作用处理前检查。未接本机companion的runtime在注册worker/申请lease前拒绝localExecution任务，不回落旧执行器。
- 生产registry codec严格校验root/grant/workspace/claim/operation，拒绝额外字段、访问器、循环、悬空/跨项目引用、别名根和重叠写claim；发布锁内复核不可变身份和单向生命周期。文件adapter在JSON序列化前调用codec，避免先执行输入getter。
- 内部LocalBindingCoordinator用实际LocalRegistryFile与既有TaskStateStore完成prepared→canonical→committed，冻结输入，使用稳定actionId/inputHash、prepared revision及规范Leader主消息引用。重放复核双方，prepared期间关闭新准入；同ID异输入、任务输入漂移、陈旧revision及跨scope修改拒绝。

**边界**：闭合服务只接受受信控制面参数，未注册为HTTP/MCP能力。Leader消息存在不单独授权任意根；正式selection/proposal/inputHash确认、活根/授权/claim准入、文件/命令端口及companion还需接入。记录schema及空绑定恢复测试不能替代OS或产品G5。并行worktree与完整接管仍按12.4/12.5分工。

## 红绿测试与检查

- 新领域模块缺失红测后，17项本机状态规则通过。
- 新registry codec缺失红测后，9项封闭记录规则通过。
- 初次4文件106测试有1项新测试引用错误（PHASE0_ROSTER未导入），改为文件已有DEFAULT_ROSTER后106通过，未修改原测试断言。
- 双存储首轮5项真实文件测试4通过/1失败：assertClosed只查receipt列表，额外注入未登记workspace仍通过。补核对最新规范操作的完整localExecution结果后5项通过；保留binding-red.log反例。不是产品入口已开放的授权绕过。
- 扩展至9项真实双存储测试：TaskState提交前/后中断、重开重放、异输入、非Leader来源、未登记引用、并发陈旧revision、canonical输入漂移、坏记录、连续操作和旧回执复验。故障adapter包裹实际TaskStateStore，不用假持久化替代。
- 最终定向7文件150测试全绿，7.92秒；typecheck/lint（527文件）和native构建通过。18份源码快照见[source-checkpoint.json](task123-state-evidence/source-checkpoint.json)。完整原始pnpm test随后退出1：7脚本通过，203文件中202通过/1失败，1529测试中1528通过/1失败，741.78秒。唯一失败是既有reducer启用字段精确白名单遗漏新localExecution；保留精确相等断言并补入该字段后，reducer/控制语法/双存储3文件100测试通过。原全量失败保留，当前G4等待后续整轮回归，不能据定向通过宣称全绿。

## 证据与下一步

日志及每个新固定fixture的原始文件hash、来源hash、停用/归属/空间清理回执在[本轮证据目录](task123-state-evidence)。所有固定输入均为虚构任务/空能力引用，不接用户项目。此前原始失败、证据、授权记录不改写。

完整回归后继续：正式选择/授权入口与活能力校验、普通目录原子创建/版本文件端口、固定输入/受管工具链与OS准入、下载/依赖副本、版本化MCP和本机companion、D16与适用恢复/G5。12.3保持in_progress。

- 后续将封闭workspace控制语法接入既有Leader intent解析器，未安装controller时明确rejected/workspace_controller_required，零mutation，不落入聊天或旧工具旁路。22项语法及46项Web intent测试共68通过，控制入口尚未激活执行能力。
