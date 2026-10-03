# 12.5 已有修改保护、接管交还与撤销规格复评

日期：2026-09-30。性质：开工前DOC-CONFLICT评审与文档修正；不是运行时验收。

## 授权与审查范围

Leader要求：“不一定严格依照现有的规格文档，需要先评审一下当前的规格文档合不合理，不合理的话先对文档进行修改”。本轮范围为当前首个ready任务12.5；未授权据此开始产品代码、扩大宿主执行/费用或提交推送。依据蓝图§21 D18/§22.3.1/§22.7.5、详设§12.2、开发计划§18.2/§18.3/§18.11和现有生产接口评审；按AGENTS.md原文“文档冲突按 DOC-CONFLICT 先评审合理性再直接修正并同步”直接修正确定缺口。

合理且保留的要求：已有修改基线与用户index/HEAD保护；固定输入实测与D16；自然安全点而非硬杀token流；真实根/父链及当前授权；非合作外部编辑的冲突检测/版本保全；有界进程收尾和未知效果失败关闭。不能为了现有代码容易实现而取消按文件接管或让独立工作默认停摆。

## 问题、反例与修正

| ID / 严重度 | 原规格缺口与具体反例 | 修正与落点 |
| --- | --- | --- |
| S01 / P1 | 交还段把“单任务非阻塞重投影沿用既有语义”用于长期局部接管。现有Preemptor固定整个task active cohort，reproject保持原lease并恢复原Context；用户接管组件时其他独立worker会被一起停住，或静止执行长期占用额度 | 独立受信范围companion；自然安全点保存、关闭相关执行并释放lease，持有期间保留逻辑责任，交还后新Context/官方Fork及新lease。现有task-wide语义与真正D4 gate保持；§12.2.6.1 |
| S02 / P1 | 未区分接管屏障与claim/普通prepared。把claim置draining后交还时改回active违反单调转换；把接管一直留在prepared会使整个registry的授权读取关闭。只暂停请求时的worker还允许排队/新writer、集成或delivery绕过 | 同一registry唯一持久范围屏障，阶段提交与用户持有时长分开；所有实际能力/副作用接缝核验。闭合阶段、排队/新准入及恢复均纳入验收；§12.2.3.1/§12.2.3.3/§12.2.6.1 |
| S03 / P1 | “独立工作继续”缺独立性依据。不同文件名、projectId或worker声明不能证明物理不重叠/读依赖无影响；整manifest版本校验也不能被静默缩成单文件。用户重命名到原范围之外时旧paths不自动保护新路径 | 按真实根/对象、文件槽位或目录子树及读写/传递依赖判断，未知扩大阻断并展示；跨范围先确认，不能自动扩权，不能跳过DAG/波次；§12.2.6.1 |
| S04 / P1 | 撤销只有“以原操作B/A和当前U三方比较”原则及一个receipt/hash参数。无法判断hash固定的是旧效果还是当前U，也未定义partial、删除后同名新建、重复undo或半journal | 受信可读逆操作提案绑定原已证明实际效果、当前完整U及候选C；创建/删除/目录各有前提，未知效果停，逐项partial与历史重放明确；§12.2.4.5 |
| S05 / P2 | L07要求“全部可观察版本可追溯”，但同时列watcher丢失及旧fd持续写。无法从丢失事件还原每个瞬时外部版本；换出对象也不一定停止变化 | 追溯实际捕获的版本、对象、时点和journal，保留旧inode；不承诺未观察的瞬时内容，不凭一次hash/cleanup checked删除对象；§12.2.4.3/L07 |
| S06 / P1 | return阶段、已撤销授权及重复动作未闭合。若先释放屏障再重读/失效旧证据，writer可带旧版本开工；旧return重放可能解除后来接管；撤权后仍读新根或恢复隐含扩权 | 新版本/责任/当前资格失效先闭合，屏障释放后再次检查执行准入；重放只确认原历史，拒绝错引用，撤权/根变化保持等待，不复活终态worker；§12.2.6.1/L13 |

原文“已证明独立的workspace可继续；范围无法确定时扩大阻断，不猜测读写集。”保留，补足可测试解释。本轮修正是从既有产品目标、安全所有权和接口证据推出的必要细化，不表述为Leader对新增条款逐项确认，也不宣称候选机制已通过G5。

## 源码证据与边界

固定Git基线：`047b8f6ea41a43b9fc8ad8c00d4751f92b839735`。以下生产文件未修改，SHA-256为本轮读取版本：

| 文件 | 事实 / SHA-256 |
| --- | --- |
| `packages/core/preemption/src/preemptor.ts` | PauseScope只有projectId/taskId；requestPause读取整个activeWorkerIds；reproject调用resumeReprojected。`92517f2de4788a55e2a8957b55d40d1456274f81ac430baf00d836c2d005f4df` |
| `packages/core/domain/src/workspace-control.ts` | takeover/return/undo已有封闭数据解析；合法结构不代表控制能力。`c0f0cbf08a26caa5818c744879a4f28220b2d5304c55973c3839443cdff8bf9e` |
| `packages/runtime/sandbox/src/local-registry-records.ts` | 当前claim含worker/integration/delivery，按真实根检查重叠；转换拒绝重新active。`9bf0951c4045cdbe4911f63c17d1d86e039147bd23ebe03ff6044dc4bcf6b94d` |
| `packages/runtime/sandbox/src/local-workspace-authority.ts` | 后继writer注册须原claim真实闭合并释放，再登记更高epoch；不能以暂停或终态状态替代关闭证明。`ae4ee0f741466502dbcfa65820a6c6fdfa4527212509dffc1b0f232a4915148e` |

`LocalGrantController.assertGrant`对prepared关闭；`MessageService`按task串行提交，故持有期间不能长期占用普通prepared或等待安全点的提交队列。全仓生产文本搜索takeover/return/undo仅发现控制数据解析，未发现本轮接管/撤销运行时实现；这是待实现的规格缺口，不把它报告为已开放入口上的安全事故。12.4已完成事实仍以当前索引为准，不由历史文档中的“进行中”改写。

## 同步与验证要求

已同步蓝图D18/§22.7.5、详设§12.2.3/§12.2.4.3/新增§12.2.4.5/§12.2.6/新增§12.2.6.1及L07/L12/L13、架构§10、选型§14、计划§18.2、D18摘要/来源和12.5索引/历史。没有修改R1–R13或冻结签名，故不修改AGENTS.md；没有新增延期项、GitHub Issue或产品依赖。

12.5真实验收须覆盖表中反例：同task独立worktree继续、相关worker自然停止及lease释放；队列/后继writer和集成/交付/undo统一屏障；别名/子树/范围外重命名；各阶段丢响应、坏记录与重启保留；交还新集合/撤权/旧动作重放；逆操作的版本竞争、同名新建、partial、二进制/元数据冲突及旧fd持续写。现有单元通过数不能替代这些新链路证据。

本轮只改文档与研发追踪，检查来源/引用、索引长度/依赖/历史和差异；不虚构TDD/G4/G5，不启动模型、宿主项目命令、打包或Benchmark。12.5保持ready，下一步形成完整schema/companion/控制接缝/测试的实现计划，经确认后再编码；后续提交仍执行原完整提交门禁。

## 2026-10-01 后续实施验证（Leader已批准开工）

以上2026-09-30的ready/仅文档结论是当时的历史记录。Leader随后明确“好的按照修订后的规格开始”，当前12.5为in_progress；实现、修复与正式最终门禁记录见[12.5历史](../task-history/12.5.md)。实现保留冻结Executor/SandboxManager签名、D4、R1–R13及Phase12限定验收入口，未扩大普通项目/宿主授权或跨阶段恢复。

| 修订 | 当前实现与验证入口 | 证据范围 |
| --- | --- | --- |
| S01 | WorkerRuntime范围companion、实际本机composition与HTTP host；`phase12-5-live-range`/`phase12-5-live-protection-host` | 指定Go真实模型自然Step闭合、能力关闭、旧lease与完全静止composition释放；独立linked CODER实际继续；原paused身份官方Fork及新lease |
| S02 | registry-v2范围屏障、全owner共用准入；`phase12-5`/`phase12-5-session-ownership`/`local-range-activation` | 真实native/registry证明新writer和后继准入拒绝；故障单元证明阶段丢响应、未知记录与旧重放保留阻断，不冒充跨进程自动恢复 |
| S03 | canonical依赖+真实root/chain；`phase12-5-root-admission`/`local-range-targets` | 真实同项目/跨项目/子根重叠登记拒绝和symlink selector拒绝；DAG依赖影响另由单元校验。当前完整manifest使实际屏障扩大到workspace，明确展示，不宣称文件名不同即允许并行 |
| S04 | 原生实际效果与完整B/A/U/C、正式HTTP撤销host及规范结果；`phase12-5-live-undo-proposal`/`phase12-5-native-undo-batch` | 真实Go原写入→当前提案→HTTP独立撤销→原生逆写→规范结果与占用释放；真实五项逆树/已知无效果partial/未知末项保留；批次故障测试仅隔离authority/proposal端口，不能替代完整授权链 |
| S05 | 原生journal/seal/installed对象证明；`phase12-5-installed-object`/`phase12-5-file-actual-effects`/`phase12-5-undo-restoration` | 保存已观察效果与旧对象；拒绝同名替换、损坏/未闭合证明、二进制/元数据及保全对象冲突；既有12.3旧fd/漂移原生用例继续完整回归 |
| S06 | return捕获→规范版本失效→release→全cohort准入/Fork；`phase12-5-native-return`/`local-range-resume-controller` | 新增/删除/重命名全集合、捕获后竞争保留屏障、旧return/冷start只读；恢复首个外部Fork前预检全cohort原claim/current资格，不复活done/failed，不跳D4/真实TESTER或REVIEWER资格 |

当前静态检查通过（类型、lint843文件0错误/警告）。三次最终全量G4均未完成：首次发现测试checkpoint空桩，修复为真实官方Harness闭合；第二次发现既有Git精确登记恢复被新准入检查提前阻断，最小修复及15项相关回归通过；第三次真实交还后目标读取缺失。全部原失败、自然取消及未执行边界保存在任务历史，分项通过不替代完整G4。

按Leader“继续，并检查是否跑偏”复核：功能仍对应S01–S06，未扩大阶段、普通入口或授权。先修复live-range夹具未向CODER投递具体任务/需求的确定缺口；后续有界诊断确认child没有新工具调用，却把父会话file_taken_over误报为当前拒绝。匹配当前成员/child时采用固定交还启动文案后，真实linked恢复读取通过。正式HTTP复验进一步定位准备Fork时缓存登记前投影，覆盖实际执行时的新恢复记录；去掉该过早缓存，改由WorkerRuntime执行时提供最新规范投影后，真实HTTP接管交还、新读取及旧重放只读全部通过。65项相关回归、类型和lint通过；每turn一次、系统投影、原权限/断言/额度/期限与既有D4路径保持。文档中的早期增量状态属于历史，不作为当前完成声明。

真实模型统一OpenCode Go的deepseek-v4-flash。过早重启全量的验证策略偏差已纠正，第四次G4正式取消并自然收尾（八项通过，其余未完成）；两处具体问题修复并取得真实证据后，第五次冻结874源码/119变化文件及七helper执行完整G4。当前完整manifest使实际屏障扩大到workspace；正常产品开放、跨进程主动恢复与阶段发布仍分别按13.x/12.7门禁推进。完整结果、失败与来源hash见[12.5历史](../task-history/12.5.md)。

2026-10-02：第五次G4的三条新增真实模型链路全部通过，但启动屏障旧测试替身缺rangeDispatch导致四项失败，原生交还删除证明后canAcquire快路径仍返回允许导致一项失败。发现后正式取消并自然收尾：87文件/740项通过、2文件/5项失败，250文件未执行，版本无漂移。当前修复使用真实WorkerRuntime范围判断保留原顺序断言；状态查询和准入在无未释放占用时也复核assertClosed及revision，缺证明拒绝激活。增强原生反例红测后，六项最小复验及相关148文件1451项扩展回归全部通过，三条真实Go链路再次通过，类型和lint843文件通过。

**此前提交候选验证**：第六次原完整`pnpm test`退出0，339文件2653项测试及7项脚本全部通过；清单、逐文件数量及874源码/七helper哈希核验一致，无skip/cancel或版本漂移。三条新真实Go链路、缺证明拒绝与既有累进回归均在同轮通过，完整证据与前五次失败/取消见[12.5历史](../task-history/12.5.md)。进程退出后清理88个归属明确的测试临时目录/链接，回收449276逻辑字节，保留必要证据。本轮实现与适用验证完成；12.5按代码任务流程仍in_progress，未commit/push/PR，未推进阶段。当前完整workspace保护、独立linked工作继续及Phase12预览边界不变。

**2026-10-02交付授权更新**：Leader已调用`agora-commit`。提交前复核128个变更文件，120个非文档文件全部属于已验证候选；874输入及七helper哈希未变，复用以上完整G3/G4/G5。所有待交付文件的常见秘密格式及已配置凭据值匹配均未命中。另清理42份无引用且已被最终G3覆盖的中间日志（20550逻辑字节）；保留唯一最终/失败证据。提交与PR回执以[任务历史](../task-history/12.5.md)为准，人工合并前保持in_progress。


**2026-10-02 PR #89修复复核**：评审发现返工后误选历史依赖workspace及空运行cohort漏取消pending队列。已按§12.2.6.1修正当前worktree映射、受阻申请收敛和独立批次后继继续；预分配逻辑会话需结合规范状态及真实资源关闭证明判断，外来ID/已有safePoint继续拒绝。定向编排等23文件368项、原生五项通过；修复后完整pnpm test的339文件2661项及7脚本全通过，三条真实Go链路、类型和lint843文件通过，874输入/七helper无漂移。清理88项临时对象449271逻辑字节及10份无用中间日志8237字节；保留必要最终/失败证据。以上第六次结果仅对应旧候选，新结果/hash及清理证据见任务历史。当前实现仍对应S01–S06，未扩大到普通项目开放或跨进程主动恢复，证据见任务历史。
