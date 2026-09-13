# 10.6 规格合理性评审

日期：2026-09-11。任务：10.6「README 完善 + 产品演示录屏（终版）」。

Leader要求先评审现有规格是否合理，并直接修订不合理处。本次只做静态证据核对和规格同步；基线为`45ae0985b69d0173c01e5f08fc0db71415975fdb`，分支为`docs/review-task106-spec`。10.5已done，10.6仍ready；未启动实现、录屏或模型请求，不将文档准备标为任务完成。

## 结论

README、真实产品演示与面试材料符合本机作品集产品目标，但旧规格混合了过时的待办、未经证据支持的收益话术、过严的数据禁令及缺少验收定义的录屏要求。应修订后再制定实施计划。没有发现需要新增产品能力或改动冻结端口才能完成本任务的依据。

控制原文：

> “文档冲突先评审合理性，再直接修正来源章节并同步受影响文档”——task-status，DOC-CONFLICT。

> “三次样本不做普遍优越性结论，不以整批至少成功一次冒充单次成功率。”——详细设计§11.8。

> “TESTER/REVIEWER 只能产生完成候选，不能自动置 `isRequestSatisfied=true` 或 `done`。”——蓝图§21 D16。

## 发现与修订

| 发现 | 核对证据与判断 | 修订 |
| --- | --- | --- |
| Quick Start被当作尚无实现 | 10.6旧notes要求“替换占位仓库地址”，README已含真实clone地址和macOS步骤；package.json已有setup/doctor/start/stop，10.4证据记录正式启动链。 | 改为核验既有命令和现有环境，区分首次安装与复用依赖/钥匙串；不重复实现启动器。 |
| 面试话术预设收益 | 蓝图§18原文“保证产品不随对话变长而崩”“兼顾提速与一致”超出证据。最终报告公开多角色成功配对反而更慢；内部并行配对更快但通过4/6，串行为6/6。 | 用机制、取舍、验证及限制组织回答；比较同时给出失败和样本量，不承诺普遍收益。 |
| D1与抢占解释不够准确 | §18用deriveMessages和turn-stopping概括机制，未区分当前投影与历史。实际harness-executor的agentSetup用官方SystemPrompt.section/variable，pre-step准入新消息；safePoint请求拒绝下一proposal以闭合turn。 | 对齐D1系统段与官方历史/压缩分工，区分安全点、非阻塞reproject和D4持久暂停/Fork；不将API名字作为能力证明。 |
| “禁止单样本数字”过于笼统 | 详细设计§11允许带身份的逐次结果；10.4功能验证记录也包含测试数和本次耗时。限制应针对不成立的推论，不能禁止原始事实。 | 比较收益仍须重复/方差/失败；单次演示允许明确标注事实范围，既有G5可单列引用，不冒充Benchmark。 |
| 终版录屏无最小完成标准 | 10.6只有“产品演示录屏”，开发计划§17仍是Phase5的Reviewer后done及后续阶段未解锁场景。 | 保留历史契约并标注范围；§11.9新增当前Web真实链、并行Trace、中途指令、D16人工终审、归档/刷新与证据要求。 |
| 容易让一条视频承担全部出口测试 | 后期产品还包括sub、离职接手、阻塞Fork等；最终报告Fork/压缩均0触达，不能用成功计数推导覆盖。 | 主片聚焦可解释闭环，补充能力用独立片段/真实证据；不强造异议，不把普通reproject或完成gate说成worker Fork；10.7仍独立。 |
| 交付范围与版本关联不清 | README仍有Phase5 badge、顺序架构图和Docker per task描述，而Quick Start已有当前流程；正式比较v11/v14源码不同。 | 10.6实施须统一当前README能力与历史标签，图按当前多worker/逐worktree更新；分别引用冻结结果，不称为录屏源码的新成绩。README正文留实施阶段更新。 |
| 录屏真实性与可用性没有具体检查 | 历史规则禁止假消息，但未定义终版媒体、剪辑、原片、同任务关联及脱敏。 | 可播放终版+同运行原片+时间轴映射+源码/环境/任务/验证/归档/hash索引；不拼不同运行为一次成功，不发布原始session或凭据。 |

## 证据入口与范围

- `README.md`、`package.json`、`apps/web/scripts/local.mjs`：当前文档与正式命令入口；本次只核对命令映射，未重新安装/启动或宣称新机验收。
- `packages/runtime/executor/src/harness-executor.ts`：SystemPrompt装载、agentSetup投影与pre-step安全点接缝；本次是定向源码读取，不是全面代码审查。
- `docs/evals/phase10-local-startup-evidence.md`、`phase10-model-settings-evidence.md`：已有安装/密钥/连接与真实执行证据；各自历史状态不覆盖task-status当前状态。
- `docs/evals/phase10-opencode-go-final-report.md`及public/internal metrics：最终公开/内部组、成功/失败、费用和未触达机制的引用入口；本次不重跑、不改统计结果。
- `docs/deferred-items.json`：DEF-016/017仍open。本次不关闭延期项、不推断10.7已满足出口。

未重新研究AutoGen/AgentScope等外部产品。现有框架比较只能作为带日期的资料；若10.6要写当前竞品断言，须当时核对官方资料，不能把本次本地评审说成最新外部核验。

## 同步与后续

同步顺序：蓝图§18 → 详细设计新增§11.9 → 开发计划§13/§17 → task-status的10.6必读章节/notes与D11来源指针。既有D1–D17规则、生产端口、技术栈、任务状态/依赖不变，因此系统架构、技术选型、AGENTS及延期台账无需修改。

下一步实施计划仍需选定可验收的演示题面、模型、录制工具和次数/费用上限；本次没有授权或启动新的收费调用，不继承10.5剩余额度，不要求重跑Benchmark。按用户的本次授权先完成规格修订，具体录制与README交付仍属于10.6实施。

## 文档验证

`git diff --check`通过；`pnpm lint`检查398个既有覆盖文件、0违规（不将此等同于Markdown语义验证）。独立JSON核对确认顶层/任务字段合法，全部任务状态、依赖、phase元数据与常驻决策规则原文保持不变；仅10.6文档索引/notes及D11来源指针变化，无待级联任务。新增必读文件均存在，§11.9唯一，旧占位地址/收益保证/一概禁止单样本的活动要求已替换。检查脚本首轮因系统Python不支持zip的strict参数中止，改为显式长度校验后完整通过。本轮没有运行源码测试或模型实验，未commit/push。


## 2026-09-12 补充评审：真实用户需求变更

Leader拒绝录制6输入框中的`/requirement ... JSON`，明确选择自然语言聊天→系统识别→可读草案→确认。此前“无需新增产品能力”的结论只对应当时的录屏契约，本次用户体验要求下不再适用：普通自然语言原来仅持久化chat/action none，未进入需求控制面，不能只在视频中隐藏协议来宣称能力存在。

合理性结论：保留D9单入口、服务端解释、稳定身份、原子提交与D16人工完成裁决；新增独立无工具Harness解释端口、持久草案/澄清以及规范草案引用确认。原需求和决策仍是权威事实，普通worker不读取原始聊天；模型不能自行变更State。关联价格及报价验收使用单个批量需求动作，避免分别提交时的中间矛盾。已有文本命令作为兼容入口，正式录制改用自然语言与真实确认按钮。文档按蓝图→详细设计→架构/选型→计划/task-status→AGENTS同步。

歧义实测按证据排序的假设：①提示未具体界定代词加数值的澄清阈值；②错误准入已处理的上一草案/原始聊天导致推断；③解析器把澄清误转为草案。检查确认已处理草案不进入previous、原始聊天不进入解释输入；解析器按kind原样校验，真实输出本身为proposal。因此修正①：对象和单位必须由当前输入或明确传入的未处理草案/澄清上下文定位；旧目标不能覆盖当前需求，也不能用二者差异猜测缺失指代。相同“Make it 850.”复验返回澄清，不产生新需求。第一次猜测草案已显式取消，历史仍保留。

完整测试、真实模型与界面证据见[自然语言验证](https://github.com/logan-suu/Agora/blob/83fe416c1015d86616acdead7af2ebbad82e8384/docs/demo/task106-natural-language-evidence.md)。


## 2026-09-12 英文模块入口漏识别

录制7缺少并行的三个初始假设：①goal复杂度分类落在Tier1；②ARCHITECT缺失/无效DAG；③GlobalScheduler仅放行一个worker。只读State确认tier1.default且英文modules未匹配任何Tier2关键词，Architecture存在两个独立前置模块及依赖后继，未开启parallelExecution；①成立，②③不能解释已证实的入口路由。中文“模块”已在常量，而英文module遗漏，与面向全球用户的等价多模块语义不一致。按既有修复授权补充英文等价关键词，不以给演示脚本塞system/API等不相关关键词规避。两个复现测试红（2 failed/13 passed）后补一行常量转绿（15 passed）。Tier0/1/2架构和既有快照幂等不变；未批准完成的录制7保持其原Tier1与gate，不手改State。


## 2026-09-12 录制8累计测试删除失败

假设按现场证据排查：①provider错误；②MCP/Git提交失败；③既有累计测试被合并移除触发完成保护。101个Go请求全部HTTP200排除①；failed D工作树有真实新提交7caab73854a71387d526a94524263051d7aa178b、干净HEAD，新增test/quote.test.mjs并删除tests/下3个累计测试文件，排除②。通过真实WorktreeGitService.registerExistingWorktree及assertCoderWorktreeReady再次得到`inherited cumulative test files must not be removed or renamed`，确认③（私有failure-reproduction.json）。复现只读保留工作树，未dispose或手改State。

规格已有validation TESTER职责及累计测试保留规则，执行器保护正确。生产ARCHITECT却可把测试单独列为CODER节点；Reviewer要求按自拟布局迁移既有测试，Coder提示也缺少不可删除累计测试的规则，形成提示与硬保护的冲突。修复角色职责与返工提示、TESTER新文件布局指引，不放松删除/改名保护，不为镜头把错误提交补成已验证产物。先前65a6b904的29+8检查仍仅证明那个提交，不能替代返工后的当前候选验证。
