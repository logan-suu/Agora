# Task10.5 工具恢复作用域修复

2026-09-10。沿用Leader已授权的“审查后直接修复、发现问题先停实验”规则，无新增费用上限、无额外任务提示外传范围。

v11在38项归档后永久停止：公开36项33通过、3失败；内部2项均因门禁作用域缺陷失败，另16项未启动。所有原结果和成本不变。首个内部样本曾先按冻结协议继续，第二个并行样本证明跨worker首次探查互相消耗额度，原单项解释不足，已追加修正审查；并未继续跑完内部矩阵。

根因：FlowToolPolicy按attempt累计每个sessionId/toolCallId错误，未区分独立worker，也未区分同一步多个工具结果与模型看到结果后的再次失败。后者并不是已经使用两次恢复机会。修正后每个独立session按生成步骤计数，同一assistant消息的tool-call集合形成稳定批次，历史重读幂等；第一个失败步骤给官方loop一次纠正机会，第二个失败步骤仍在provider I/O前停组。基础设施/权限/未知费用/输出不完整和原调用、工具、时间、费用上限保持。

验证：两项新单元回归先RED（旧6项通过），修复后8项通过。真实生产并行worker共享同一正式meter，四个worker各首次批量读取两个不存在文件后成功恢复，经过真实Harness/MCP/Git/Docker、两波累计验证和D16完成；清理后lease峰值确认大于1。连续坏补丁仍恰两次请求，第三次provider I/O被阻止且闭合trace/账本留存。两项G5通过，不调用付费模型。

为避免重跑有效公开对照，v11公开36项作为独立完成的公开比较保留；内部旧题转开发证据。v12只冻结两道不同业务新题shipment-quotes/daily-availability，各multi/parallel/sparse重复3次，共18项。保持同一模型、参数、镜像、每attempt与Go累计USD5上限；v12manifest绑定v11公开结果hash，不复制旧attempt，不跨版本合并总分。新任务初始仓库明确只有TASK.md，参考解及隐藏验题不进入模型上下文。运费题通过既有D9安全点路径注入冷链价格更新；日程题固定比较并行和结构化上下文保留。

新独立验证器正负预检已在同一隔离镜像通过：正确解通过、空导出拒绝；运费旧冷链价格、日程不合并相邻区间两个语义负例也被拒绝。5文件33项定向回归通过，typecheck与lint395文件通过。完整回归运行中，不宣称G4完成。日志/private/tmp/agora105-recovery-scope-{red,green,g5}.log、/private/tmp/agora105-v12-{offline,types,lint,holdout-preflight,full}.log。

停止时Go正式1481请求/USD1.759530606/0未结算，原USD5不变；Go诊断63请求/USD0.130668924不变。官方回归原USD20账本保留，其完整回归请求继续逐项计量。无commit/push。

[2026-09-10 v12完整验证] 普通错误按独立session/失败步骤计数已修复，真实四worker首次双文件探查后恢复完成与连续坏补丁第三请求前停止两项G5通过。新shipment-quotes/daily-availability各12/11隐藏测试，正确解通过、空导出及各一业务语义负例被拒绝。5文件33项针对回归、typecheck/lint395文件通过；完整pnpm test一次153文件1165项通过，0skip，411.32秒，真实凭据保留并逐请求计量。官方原USD20账本2436请求/保守USD8.758638532/0未结算。准备冻结v12仅18项新内部对照，绑定v11公开36结果hash，原Go正式1481请求/USD1.759530606/5不变。证据docs/evals/phase10-recovery-scope-repair-evidence.md，无commit/push。

[2026-09-10 v12冻结启动] 仅shipment-quotes/daily-availability×multi/parallel/sparse×3共18项；组42e8a76e85334a09d917d50148f652945862a8811db7c306ff36f660274aa8a2，源码fc2359c80daf4eb73fd1a7b0a8eb024775913cd260ba68deae208112887eefbd，366执行源加9配置/规格共375快照。逐哈希核对后启动，frozen.completedPublicComparison绑定v11公开36项原result hash，未复制为新attempt。配置/镜像/模型与原选择保持，正式前Go1481请求/USD1.759530606/0未结算，共用原USD5；独立新组8h从2026-09-11T01:39:28.675Z计时。日志/private/tmp/agora105-go-formal-v12.log；v11停止38final/33pass/5fail/16pending原记录不覆盖，内部旧题转开发。

[2026-09-10 v12入口预检遗漏修复] 首个shipment-quotes-multi-1实际只创建benchmark-sub-0，主动发现后立即停后续请求。根因是新题包装JavaScript library未匹配生产evaluateComplexity的Tier2信号，落Tier1；不是上下文故障或新工具恢复门禁失败。此为本次新fixture及预检遗漏：先前只验证独立判题，没有核对DAG准入。18请求/USD0.036137952结算，生产自测24pass但未独立验题，cleanup通过/lease0；v12保留1final失败/17pending，Go累计1499请求/USD1.795668558。新增冻结前生产Tier2断言、预检记录及两项RED回归（原5通过），不改生产分类器。已暴露运费题转开发，v13改用未运行inventory-restock与daily-availability，后者只修正入口API词汇，目标仍18次、引用v11公开36项、原USD5不变。

[2026-09-10 v13完整门禁] 两道未运行的inventory-restock/daily-availability在生产evaluateComplexity及真实taskDefinition→Web组合根→A–E并行worker入口验证通过；新入口回归先RED两项、修复后绿。独立Docker参考正例/空导出反例/旧标签阈值与不合并相邻区间的语义反例通过；每题11个隐藏测试，代码不提供给模型。typecheck/lint396文件通过；最新完整pnpm test153文件1170项全过，0skip，378.75秒。官方原USD20账本2454请求/保守USD8.787146292/0未结算，Go正式1499请求/USD1.795668558/0未结算，原USD5不变。准备冻结v13仅18项，绑定v11公开36项原结果，v12保留1fail/17pending，不重跑公开或已暴露运费题。

[2026-09-10 v13阻塞异议提示修复] v13首项库存串行通过，57请求/USD0.075952584/437.628秒，独立11测试全过、清理lease0；并行项29请求/USD0.052523832后因TESTER阻塞异议停止，保留2final(1pass1fail)/16pending。实际unitPrice对数组类别发生JS键转换，原隔离镜像重现4pass1fail，TESTER断言符合题面；runtime正确执行D14。审查确认提示只说proven conflict而未区分实现缺陷与质疑需求本身，且未说明accept撤回目标，导致普通返工误升裁决。按常驻授权先保持停组，再补明确语义边界、三角色真实请求提示回归（RED3项、既有24项绿），不改解析器/裁决权限、不替模型修答案。Go累计1585请求/USD1.924144974/0未结算，原USD5不变。

[2026-09-10 v14准备] 按D14既有accept撤回目标语义修正通用提示：普通实现缺陷使用测试失败/changes_requested返工，阻塞异议明确质疑需求或决策本身。三角色实际Harness请求提示回归修正测试roster后再RED3项（既有24绿），修复后6文件67项通过；解析器/控制块/Leader权限未变。库存题已用于定位提示问题，v13保留2final/1pass1fail/16pending及费用，后续不继续；v14仅未运行thermal-inspection与daily-availability各multi/parallel/sparse×3，继续引用v11公开36项，不跨版本混算。热量题为合成整数换算/剂量/阈值任务，五模块宽DAG与预授权中途阈值变更；模型不获取隐藏测试/参考解。原GoUSD5不变，目前1585请求/USD1.924144974；无新增模型诊断。

[2026-09-10 v14真实提示验证] 原16次修复诊断已用14次，本次仅使用剩余2次，各Go模型一次合成subtract代码评审（不是失败任务重放）。两模型均返回changes_requested普通返工且未发异议，6.278秒，两请求USD0.001244604，原Go诊断账本65请求/USD0.131913528/0未结算，16次修复请求额度已用满，三诊断入口统一计数拒绝后续请求。官方Harness请求提示及严格普通交付解析均真实执行；未声称该小样本能保证所有未来模型输出。证据.data/evals/phase10-go-repair-handoff-439fb01c-9f6a-4b59-9349-1af630f55bc4/evidence.json。typecheck/lint与新fixture预检通过，完整回归仍运行。

[2026-09-10 v14完整门禁] 全量pnpm test153文件1175项通过，0skip，393.04秒；包括真实失败测试返工、D14/D16与三新旧任务宽DAG入口；typecheck/lint398文件通过。两模型合成返工诊断各一次通过，原16次修复诊断额度用满。官方原USD20账本2479请求/保守USD8.820343188/0未结算；Go正式1585请求/USD1.924144974/5、诊断65请求/USD0.131913528，均无未结算。准备冻结v14热量检查/日可用时间18项，引用v11公开36项；v13原1pass1fail和16pending保留，不继续已暴露库存题。

[2026-09-10 v14冻结与首项通过] v14组257e8c78bef43ca1139b645ebc96307f8090894aab25e872a2619e3c6ac85eec，源码93cafece021f1c5ada5a7db7173738405317a11569665ec555ba82efdd89f1e4，369执行源+9配置规格共378快照，逐hash核对后启动。首项thermal-inspection-multi-1完整通过：50请求/USD0.070208892/487.800秒，两波生产验证19及27项、11项独立隐藏测试全过、最终lease0/峰值1，阈值更新与D16绑定通过。后续17项按冻结顺序执行，不修改模型/限额/源码；原USD5共用，发现失败即停审查。无commit/push，保持in_progress。

[2026-09-10 v14重复审阅停审] thermal-inspection-parallel-1生产两波18/26项通过后，REVIEWER步骤2–9连续8次读取相同完整299行/10090字节测试文件，反复同一结论、无代码或证据变化；已人工停后续请求，当前流自然结算。53请求/USD0.089783268/580.725秒，未独立判题、清理lease0。输入估计最高37127低于65536，官方历史保留工具ID/result、0压缩，未发现执行器丢上下文证据；保留人工中断局限，不声称模型最终无法完成。审查分类operator-interrupted-reviewer-readonly-stagnation，369源码hash一致、0锁/0未结算。当前2final/1pass1fail/16pending，Go1688请求/USD2.084137134；不加诊断、不改源码/模型/限额，在同组继续后续独立样本。

[2026-09-10 v14半程] thermal-inspection九项全部归档：multi3/3、sparse3/3、parallel2/3；唯一失败为已审查保留的第一次并行重复审阅人工停止。八个成功样本均独立11测试通过、资源清理lease0，两个成功并行样本lease峰值3，稀疏三项均12次实际裁剪。最后并行333.432秒/USD0.062199312。当前9final/8pass/1fail，Go2037请求/已结算USD2.567043906，daily-availability-multi-1开始、剩余8项未启动。仍共用原USD5，运行源码未变，无新诊断，无commit/push。


## v14 首个日可用时间稀疏样本断流

[2026-09-10 v14断流审计] daily-availability-multi-1及parallel-1完整通过，随后sparse-1首个PM请求在96.811秒发生官方STREAM_CLOSED: SSE stream ended without [DONE]，0工具、输入估计4693，usage未返回。已立即停止剩余6项，供应商/网络细分根因inconclusive，无执行器缺陷证据，不重放。显式审计原预留峰价USD0.0589824计入原USD5，原result及model-requests仍保留unknown，不伪造用量。当前12final/10pass/2fail/6pending，Go2137请求/保守预算占用USD2.774879802（包含历史v4和当前v14两个预留上界），0未结算/锁、369执行源码hash不变。报告区分用量费用与保守预算占用，未知格不显示完整费用均值；同组仅恢复未启动6项。证据phase10-final-v14/stop-reviews/daily-availability-sparse-1；无新增诊断、无commit/push。


## v14 稀疏样本时限停审

[2026-09-10 v14时限停审] daily-availability-parallel-2通过（50请求/USD0.038369004/443.744秒，生产22/35与独立11测试全过）；sparse-2因20分钟新请求准入上限停止（71请求/USD0.072872178/1205.445秒），保留失败。其REVIEWER普通changes_requested已进入第二轮目标A及依赖E返工，生产20/28/29项通过；最长两条评审/验证请求207.579/206.873秒。原审阅问题本身未经独立判定，不据此声称代码缺陷。全部usage已知、provider0failed、输入估计峰31119未越65536、输出峰14118未越32768，官方错误attempt budget exhausted；未到最终隐藏判题，清理lease0。停后审计369源码hash一致、0未结算/锁，Go2258请求/保守USD2.886120984，原USD5不变；同组仅继续剩余4项，无新诊断/重跑/源码修改。


## v14 最终完整性与交付

[2026-09-11 Task10.5最终Go对照收尾] v11公开36/36归档、33pass3fail（single12/12、multi11/12、mixed10/12）；v14内部18/18归档、14pass4fail（multi6/6、parallel4/6、sparse4/6），两组冻结源码不同，分别报告，不计算合并成功率。内部14次独立隐藏判题全部通过；4失败为thermal并行1重复读取人工停止、daily稀疏1断流、daily稀疏2长评审/返工后20分钟准入耗尽、daily并行3重复推理后断流。最后样本已设置后续请求停止标记，未取消在途流，直接失败原因保留STREAM_CLOSED，不伪称人工中断流。两次缺usage原始结果仍unknown，显式审计各USD0.0589824原预留上界，不重放、不补跑、不改源码/模型/限额。Go正式总2462请求/保守预算占用USD3.089997504/5，含所有历史组及3次预留上界；v14本组877请求/保守USD1.165852530，v11公开USD0.748955406。独立Go诊断65请求/USD0.131913528，修复请求16/16用满；官方原USD20回归保守USD8.820343188单列。最终369执行源码hash一致，18次cleanup通过、lease0、0active/0pending/0锁/0未核算预算项；官方会话压缩审计0触发/0失败/0未闭合，已有两模型真实压力压缩成功另列。G3/G4/G5沿用冻结前153文件1175测试全绿0skip及typecheck/lint、真实Docker入口/返工/D14/D16，不新增付费回归。最终报告docs/evals/phase10-opencode-go-final-report.md及public/internal-metrics.json含逐次结果、方差、四比较/机制覆盖、完整费用历史与限制。源码不变，后处理修正未知费用口径；无commit/push/PR，Task10.5保持in_progress，10.7产品出口独立。

最终静态复核：`pnpm lint`398文件0违规，`git diff --check`通过；493候选文件敏感路径/密钥格式扫描0命中，公开指标递归禁止原始内容字段核对通过。日志`/private/tmp/agora105-final-delivery-lint.log`，审计`.data/evals/phase10-final-v14/delivery-security-audit.json`。执行源码未变，沿用冻结前1175项完整回归，不重复付费验收。


## 提交前复验

[2026-09-11 提交前复验] Leader已授权提交并推送。pnpm typecheck及lint通过；完整pnpm test --maxWorkers=1 --bail=1再次153文件1175项全过、0skip，397.27秒，含真实DeepSeek回归和Task10.5 Harness/MCP/Git/Docker G5。日志/private/tmp/agora105-commit-full.log及.data/evals/phase10-commit-verification.json。官方回归账本现2498请求/保守USD8.836436804，0未结算，沿用原USD20/17/3；Go正式2462请求/USD3.089997504不变，未重跑正式评测。审查修正夹具README旧默认分组/预算/停止及D1说明，仅文档变更，冻结执行源码未变。131个Task10.5文件准备提交，敏感路径及密钥格式扫描0命中、11份JSON报告原始内容字段0命中。任务保持in_progress，PR仍须人工合并。
