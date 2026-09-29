# Task12.4 独立 TESTER 准备契约复评（2026-09-20）

本轮为实现前规格细化，不是 TESTER 运行通过的证明。完整契约以[详细设计§12.2.5](../详细设计方案.md#local-validation-preparation-124)为准；当前状态仍查 task-status.json。

## 判断与源码依据

独立工作区、固定完成版本、新 worker/lease 和原完成来源校验均合理，继续保留。直接把旧接口串起来尚不充分：

| 缺口 | 源码依据 | 修正要求 |
| --- | --- | --- |
| 仅固定派发消息不能证明完整后态 | [parallel-coordinator.ts](../../packages/core/orchestration/src/parallel-coordinator.ts) 的 dispatchValidation 经 finish 追加进度台账，另有 pending worker、testResults、phase、nextRole、activeWave.validation 变更 | 固定受信规范决定的全部 mutation 和完整前后态；不在 L4 复制另一份 Coordinator 业务规则，不接受模型提交的计划 |
| 初始/编码登记不是首次验证登记 | [local-git-workspaces.ts](../../packages/runtime/sandbox/src/local-git-workspaces.ts) 的 registerInitial 固定初始批次；registerCodingWave 只接 CODER 波次并从 wave.base 或已验收回执取得来源 | 单独登记一个 validation 目标，来源为原交接确认的精确完成版本；冻结 initialWorkspaceId、CODER/subtask 和 Integration |
| pending 路由可在恢复时重新出现 | [parallel-coordinator.ts](../../packages/core/orchestration/src/parallel-coordinator.ts) 的 recoverDispatch 对 testing 下 pending TESTER 返回 worker 路由 | 首次与恢复路由在 WorkerRuntime 开始前都经过同一准备屏障；准备失败不启动 worker，也不把 pending 误写为已执行失败 |
| 原交接只读入口不接受派发后的 State | [local-integration-handoff.ts](../../packages/runtime/sandbox/src/local-integration-handoff.ts) 的 read/proof 校验原完整 released 后态；[local-integration-authority.ts](../../packages/runtime/sandbox/src/local-integration-authority.ts) 的 handoffReader 同样严格 | 新来源视图绑定具体准备计划和允许的阶段，重验历史原生/Git链及当前物理事实；不放宽旧接口，不提供忽略当前 State 的开关 |

这些是未接入路径的契约缺口，不是上一冻结版本测试失败。无须更换依赖、接口路线、授权模型或已定产品规则；不新增 standing decision。

## 实现验收顺序

1. 规范派发计划：通过实际 Coordinator 路径产生完整决定；先保全原交接与计划，再执行一次精确前态条件提交。覆盖新实例重放、CAS 耐久后丢响应、台账遗漏和额外 mutation 拒绝。
2. 独立工作区：真实创建 validation linked worktree，绑定唯一新 TESTER；工作区、claim、原版本和完整 registry 变化可核验。覆盖登记耐久后丢响应、同 ID 异参数、缺原准备记录、物理来源漂移和越权。
3. 启动屏障：实际首次路由及 pending 恢复路由均检查准备确认；未确认时模型调用、worker lease 获取和执行 session 创建均为零。准备确认本身不把 pending 变为 running，也不自动恢复进程重启后的任务。
4. 执行与验收：经既有 WorkerRuntime/Harness 获取新 lease/session；TESTER 只修改允许的测试文件，提交后冻结新的验证版本，以真实受控命令产生证据。保留原 wave_validation/v1、控制指纹与 sourceReceiptId 语义；没有真实结果就不生成通过回执。

每步均须保留原生效果/真实 Git/完整 State 的独立证据，不能只比对模拟快照或最后 HEAD。部分创建/registry 事务不因显式重试而假装完成，仍由原恢复协议处理。先完成首次验证；指纹失效复验、accepted 后续波次、产品入口、D16及同任务新验收轮次仍需各自验证。

2026-09-20 本轮只同步规格和追踪，不新增 runtime/schema/测试代码，不重跑或改写当时上一轮 2175 项测试及 G5 结果，不宣称本契约已实装。文档检查记录位于 `test-outputs/task124/tester-preparation-spec-result.json`。

<a id="durable-dispatch-124"></a>
## 2026-09-21 耐久派发接缝复评

上一单元完整回归265文件2204项通过；本节是后续实现的接缝设计，不改变该结果归属。现有六项原则保留，进一步明确单一槽、精确恢复和分层职责，不增加产品权限、新依赖或常驻决策。

| 代码事实 | 接入时的风险 | 定稿处理 |
| --- | --- | --- |
| `LocalControlObjects.put/bindReference` 分别持久化对象和单个ref；无多ref事务，部分文件拒绝 | 先写slot再写action-plan后崩溃时，若只查action-plan会把已有准备认作缺失，或永久拒绝完整可恢复计划 | 所有对象先写并校验，唯一slot最后发布，slot直接指向完整计划；action索引不作权威，损坏对象仍拒绝 |
| `LocalIntegrationPreparation` 现有流程分别绑定slot和plan；该类用于旧integration准备 | 机械复制双ref流程会将未定义的缺口带进TESTER准备 | 新TESTER协议使用单一入口；本轮不改写旧integration协议或把本评审当作旧路径故障证据 |
| `createInitialValidationDispatchPlan` seed包含dispatch/ledger的ID和时间 | 重新生成seed或把dispatch/action加入排他槽键，会使同波次出现不同候选准备 | 槽只按project/task/wave/attempt/integration定位，计划固定action/seed/目标，读取原计划后精确重放 |
| orchestration的package.json依赖runtime-sandbox，sandbox不依赖orchestration | 在L4直接导入L2计划器将形成依赖环，复制决定规则则违反现有规格 | L2生成/重建；L3 companion隔离I/O，组合根注入受信能力，L4不导入L2或接受外部mutations |
| `LocalIntegrationHandoff.read`和`LocalIntegrationAuthority.handoffReader`只接受原精确关闭态 | 先提交testing再调用旧reader会失败；传入伪造旧State会遮蔽当前控制漂移 | 在CAS接入前完成绑定具体slot/plan的来源视图，只从原对象图取历史并逐次核对当前准入；旧reader不放宽 |
| `JsonTaskStateStore.compareAndCommit`在与普通commit相同队列中比较完整State | registry不是该队列的原子成员；抛错也可能是耐久后响应丢失 | 继续持有受信控制，前后复核registry/授权/物理版本；异常保留原计划，显式恢复按完整前后态辨认 |

完整规则位于详细设计§12.2.5的同日段落。单一槽发布不是宣称底层write具有全文件原子性：写入中断导致无效ref/对象时必须保全并拒绝；只有可完整回读的原引用才支持耐久后丢响应恢复。

### 接缝故障矩阵

| 注入点/当前事实 | 预期结果与必须验证的副作用 |
| --- | --- |
| 所有对象已写、槽未写，仍为原released前态 | 未持久化派发，不提交State、不登记、不启动；孤立对象不作为恢复凭据 |
| 槽有效，绑定已耐久但响应丢失 | 新实例通过槽读原计划，复用seed/action/目标；不重生成ID/时间 |
| 槽存在且action派生索引缺失 | 从原槽核验并继续，不补造原始事实；索引不是准入条件 |
| ref或对象部分写入、hash不符、缺原handoff confirmed | 拒绝并保全；不覆盖文件，不调用CAS或登记 |
| 相同槽换action/dispatch/worker/目标 | 冲突拒绝，不替换槽，不提交第二次决定 |
| 精确原前态且所有来源证明有效 | CAS提交完整规范决定一次，包含进度消息；原CODER/Integration/resultCommit与registry保持 |
| CAS提交前抛错且State仍精确原前态 | 显式重试重新验证后可使用原计划提交，不创建新准备 |
| CAS已耐久后丢响应，State为精确派发后态 | 专用来源视图核验原计划/当前事实；不重复CAS、进度消息或pending worker |
| 无有效槽但State已testing/pending | 拒绝，不能倒推生成原计划 |
| CAS后控制/registry/物理版本/授权漂移 | 拒绝启动并保全；不把部分成功当准备confirmed，也不自动回滚规范State |
| 原生历史被移除，或新视图请求acquire/edit/release/published | 仍拒绝，历史claim不获得能力；旧completion/handoff读取派发后态仍拒绝 |
| 后续WorkerRuntime将worker置running/paused/done | 不落入首次准备恢复；必须走对应执行生命周期协议 |
| 只有派发持久化、尚未登记validation | 准备confirmed缺失；首次和pending恢复路由均不得创建执行session、调用模型或取得lease |

后续编码按依赖组合成可实测单元：先落唯一槽/对象记录和严格来源视图，再接L2控制流程与精确CAS；随后独立登记和共同启动屏障。CAS前后丢响应要通过真实StateStore和新对象实例覆盖，原来源视图要经真实Git/native链及丢失证据反例验证；不能用纯序列化或test double替代G5。


## 2026-09-22 推进与验收单位校准

原四步契约及故障矩阵保持，不新增权限或削减证明。计划、记录存储、校验端口是“完成集成→独立TESTER真实验证”的组成部分，不分别作为产品能力交付终点。后续按同一个可验收目标接通：绑定唯一计划的来源读取→精确State CAS→独立validation登记→首次/pending共用启动屏障→实际Harness/受控命令证据。内部仍分步TDD，每个代码单元保持完整门禁；不一次性生成整个模块，也不以扩大工作单元为由省略检查。

依赖实现前只复评实际矛盾、不可测条款或已发现故障，不对已经定稿且未发现冲突的保护重复另起设计轮次。报告以能力和未闭合边界为主，不能用新增封装数量、测试数量或文档篇幅代替进度。首次验证完成后仍须验证本任务要求的accepted累计波次、确认应用及既定恢复边界；12.5接管交还、12.6首次配置保留其任务归属。当前事实与证据只查task-status.json及12.4历史。

## 2026-09-22 派发后来源实测进度

唯一槽控制读取已扩展出固定历史交接对，供原完成只读证明链内部使用；物理来源读取在调用前后都核对当前规范阶段、授权和完整控制，并实际重验原生批次与Git版本。原`handoff.read`在testing后仍拒绝，原生结果文件被移走时新读取也拒绝，proof-only入口仍不能编辑或发布。真实交接定向用例1项通过（1802.70秒），L2/存储59项与typecheck/lint通过；夹具与日志hash见`test-outputs/task124/validation-physical-targeted-result.json`。该版本完整回归尚待执行，正式派发CAS、独立validation登记/第三阶段和共同启动屏障尚未实现，因此不宣称TESTER产品G5完成。

## 2026-09-22 物理来源回归与受信CAS接缝

上一物理来源版本的完整回归已通过267文件2236项、追踪7项，125份Git夹具审计及88个新增临时根清理闭合；证据见`test-outputs/task124/validation-physical-complete-final-result.json`。本轮新增的`commitInitialValidationDispatch`再向前接一步：只从该唯一槽的完整物理来源取原前态及JSON计划，L2按当前context/roster重建规范mutations并进行精确CAS；提交前后重复检查来源，精确已提交后态重放不再CAS。纯控制用例覆盖提交、丢响应后的精确重放、后态漂移及计划篡改；真实Git/native用例已改为调用此受信服务，待该新增版本定向及完整回归核验。

该服务不是准备confirmed，也不发布最初唯一计划、登记validation工作区或让pending TESTER取得执行资格。后续仍须将计划发布及受信任务串行接入实际产品控制路径，完成独立登记/第三阶段和首次、恢复共用的启动屏障，再实测真实TESTER命令及accepted累计波次。

## 2026-09-23 CAS定向超时诊断

新增服务的首次真实两分支用例在原45分钟时限处超时，冻结1357份输入及7个原生产物未变化。保存的失败夹具State已经耐久进入testing且TESTER仍pending，Git在超时前继续活动，未到夹具清理。三个假设按证据排序：重复完整物理证明的耗时最高；独立原生/Git子步骤停滞次之；夹具清理等待最低。短小端口复现先红后绿，确认`readForCommit`原来每次调用两遍完整物理证明。修复只保留一次完整证明并在固定计划读取后复核当前控制；L2的CAS前及提交后独立来源读取均保留。真实用例不再额外重复成功来源重放和正例读取，仍通过服务的成功返回证明物理链，并保留缺原生日志拒绝反例。没有调高测试时限或削弱产品断言；修复版的真实结果须单独验证。

## 2026-09-23 修复版定向结果

修复后的真实两分支交接用例在原45分钟时限内1/1通过（Vitest 2214.69秒）；实际StateStore已持久化规范TESTER派发，缺失原生结果仍被拒绝，独立冻结及夹具审计均通过。证据与清理见`test-outputs/task124/validation-cas-repaired-targeted-result.json`及任务历史。审查时修正一处描述旧双重物理证明的过时源码注释，未改变执行语句；完整回归应基于该最终版本重新运行。此结果仅关闭受信派发CAS接缝，不代替独立validation登记、共同启动屏障、真实TESTER执行及后续累计验证。

同日该最终版本完整回归已通过268文件2241项及追踪7项；冻结源码/原生工具、125份Git夹具、模型链路和清理证据见`test-outputs/task124/validation-cas-complete-final-result.json`。首轮受限环境根检查失败单独留证，主机重跑未改测试范围。完整回归仍不证明独立TESTER产品G5。

## 2026-09-23 唯一计划发布接合

在原受信CAS之上补上正式发布入口：L2先查唯一槽，有槽则只按固定计划重放；无槽时L4读取原已确认handoff和真实物理来源，L2生成规范决定，L4保存原call、完成版本、完整前态/registry、handoff引用与决定，再由固定准备来源复核并做原State条件提交。L4不重新实现Coordinator规则，也不创建TESTER执行资格。纯控制测试覆盖发布已耐久但响应丢失、CAS已耐久但响应丢失及同槽异action拒绝；真实两分支Git/native交接用例现通过该正式入口，不再由夹具手工构造计划。

定向真实用例1/1通过，耗时2462.81秒，仍在原2700秒时限内；初次受限沙箱运行在根检查前失败，主机环境以同一断言和期限重跑通过。原生夹具自动清理、源码哈希及原交接独立审计见`test-outputs/task124/validation-publication-targeted-result.json`。本版本的全量回归尚待执行；产品任务串行入口、独立validation工作区/claim登记、准备confirmed、首次/pending共同屏障及实际TESTER执行仍未完成，Task12.4产品G5仍待实测。

同日全量首轮在原45分钟时限处于首个真实用例超时，实际只执行1/268文件，不构成G4。失败现场已保存原交接证明和唯一计划槽，State尚未进入派发后态，说明超时位于槽发布后、CAS前的来源复核。新增入口先独立`readForCommit`检查计划，再调用已有CAS服务，而后者本来就会在首次来源读取中复核相同对象和原生/Git链；这是重复物理证明。红测证实丢CAS响应前发生3次来源读取、正确链路只需2次。修复把预期seed、前态和计划比较放入已有首次读取，保留CAS前独立重读和提交后物理复核，不放宽来源条件。失败、归档与清理见`test-outputs/task124/validation-publication-complete-timeout-result.json`；修复版仍须真实定向及完整回归，不以旧版通过代替。

修复版真实两分支交接用例已在原时限内1/1通过（2317.36秒），夹具、源码哈希、原交接独立审计及自动清理见`test-outputs/task124/validation-publication-repaired-targeted-result.json`。首轮全量超时仍保留为失败证据；当前修复版的完整G4待另行验证，独立validation登记和产品G5边界不变。

同日修复版完整回归已通过268/268文件、2242/2242项，实际执行文件集合与预收集清单一致；冻结1359份输入、7个原生产物及HEAD无漂移。125份真实Git夹具、13份不可变记录夹具、原两分支交接与关闭收据独立审计通过。88个本轮新增测试临时根在确认无进程、句柄、挂载和容器引用后清理，449275逻辑字节；失败首轮归档继续保留。证据汇总为`test-outputs/task124/validation-publication-repaired-complete-final-result.json`。此结论只关闭当前内部发布/CAS版本的G3/G4及适用既有真实链路回归，不证明产品任务串行入口、独立validation登记、共同启动屏障或实际TESTER产品G5。

## 2026-09-23 专用登记接缝核对

`LocalGitWorkspaces.registerInitial`只能建立初始批次，`registerCodingWave`从编码wave.base或accepted回执取源；二者均不能从已完成Integration.resultCommit登记本轮唯一pending TESTER。现有准备来源只接受原released和规范dispatched两个完整阶段，登记导致registry变化后也不能继续沿该读取路径自称confirmed。故后续须有专用L4登记事务及其精确第三阶段证明，而不是复用初始/编码接口或放宽当前来源。

已先落L2纯控制请求：固定slot身份、原集成工作区/已释放claim、源版本、新validation工作区与worker，并重建Coordinator后态；漂移拒绝用例通过。它不触发真实Git或binding。下一实现单元必须从唯一槽和当前受信来源取输入，完成实际linked worktree创建、binding收据、耐久丢响应重放及登记后来源/准备confirmed，再接首次与pending共同启动屏障。当前新代码全量回归结果见12.4历史，不把纯计划当G5。

首次真实接线尝试在原2700000ms超时：原handoff及唯一计划槽已存在，State为规范testing/pending TESTER，未创建validation绑定；原输入和7个原生产物未漂移。新增测试把原有的完整物理`read`换成`readForCommit`，额外增加固定计划与末端控制的重复读取；该用例本来已通过原物理读取证明来源。现改为保留原物理读取，从同一已校验的唯一槽读取计划对象，再由L2重建规范决定并导出请求。不删原生/Git来源、旧交接、缺原生证据拒绝或用户工作区不变断言，不改时限。失败归档/清理见`test-outputs/task124/validation-registration-targeted-timeout-result.json`；修正版本仍须单独实测，不能沿用先前成功结果。

2026-09-24修正版本的真实两分支交接用例在原时限内1/1通过（2499.11秒），冻结1360份输入、7个原生产物与HEAD不变；夹具自动清理，无新增测试根。原完成、两次原生应用及关闭收据的独立审计通过，证据`test-outputs/task124/validation-registration-repaired-targeted-result.json`。这只证明新请求可从真实已发布来源导出；实际validation linked worktree/binding、第三阶段准备确认及TESTER启动仍未实现。本版完整G4尚待跑，不能把上一版268文件2242项移作本版结果。

同版本完整回归现已通过268/268文件、2243/2243项；事前清单、冻结1360份输入/7个原生产物/HEAD、125份真实Git夹具、13份不可变记录夹具和原交接独立审计均核对通过。88个本轮新增测试根在进程/句柄/挂载/Docker引用检查后清理，首次超时失败仍保留。证据与hash见`test-outputs/task124/validation-registration-complete-final-result.json`及任务历史。G4已闭合，但登记请求规划仍不是实际validation工作区登记，也不构成Task12.4产品G5。

2026-09-24新增专用L4验证登记，真实两分支夹具证明独立linked工作区、原`resultCommit`来源、新binding/claim及用户HEAD/index不变。代码审查在长测前纠正两个遗漏：绑定后无准备确认可能被`resolveAssignment`提前准入；Git效果与binding提交之间还需复核唯一槽。测试中途主动停止并留证，修复后真实用例在原45分钟内通过。已提交登记的重入仍显式要求专用恢复，不把既有编码批次重放当恢复成功；第三阶段准备确认和首次/pending共同启动屏障仍未实现。定向证据见`test-outputs/task124/validation-native-registration-final-targeted-result.json`，当前版本完整G4仍待执行。

同一登记版本的完整回归随后通过268/268文件、2243/2243项；四项已获批真实模型场景使用OpenCode Go `deepseek-v4-flash`，没有运行正式Benchmark。冻结1355份输入、7个原生产物和HEAD未漂移；125份真实Git夹具、13份不可变准备记录及新增validation绑定的独立审计通过。88个本轮新增测试根经进程、句柄、挂载、容器及身份检查后全部清理，复扫无遗留。证据与hash见`test-outputs/task124/validation-native-registration-complete-final-result.json`和任务历史。G4已闭合，但登记后丢响应专用恢复、准备confirmed、产品入口与实际TESTER验证等产品G5步骤仍未完成。

## 2026-09-25 专用登记丢响应恢复复核

已完整提交的同输入重试现从唯一槽、原派发后态及原registry重建完整binding、操作和当前双存储后态，再重验原native/Git完成、当前授权及源/目标linked版本，成功时只读返回原validation工作区。部分事务或漂移仍拒绝；此入口不形成准备confirmed或TESTER执行资格。首轮双CODER前置在45分钟超时且未到恢复断言，保留失败与清理证据；专用单CODER真实定向在原时限内通过，既有双CODER登记用例未变。最终完整回归269/269文件、2245/2245项通过，冻结输入无漂移，88个新增专用根已清理。证据见`test-outputs/task124/validation-replay-complete-final-result.json`及12.4历史。本版G4闭合；产品任务串行入口、准备confirmed、首次/pending共同启动屏障、实际TESTER与后续累计波次仍属Task12.4未完成范围。

## 2026-09-25 登记后准备确认与完整回归

内部确认入口仅在登记binding与操作完整提交后，沿已登记只读恢复分支重验原native/Git完成、当前授权和源/目标linked版本。确认前后完整State、registry及对象引用必须不变；首次只新增一条绑定原plan、登记输入、binding和双存储后态的不可变确认引用，丢响应时同槽复用，更晚worker阶段拒绝。单CODER真实定向1/1通过；旧双CODER交接用例删去夹具控制器的一次冗余物理读取后在原45分钟时限内通过，原生/Git安全证明、断言和产品代码未放宽。首次全量在旧用例超时，仅完成1/269文件，失败现场仍保留。

修正后的完整`pnpm test`通过269/269文件、2248/2248项；四项固定真实模型场景使用OpenCode Go `deepseek-v4-flash`，未运行正式Benchmark。冻结文件与HEAD无漂移，126份真实Git夹具和来源hash均通过；88个本轮测试根在进程、句柄、挂载、容器及身份检查后清理。最终证据见`test-outputs/task124/validation-confirmation-repaired-complete-final-result.json`和12.4历史。当前G3/G4及适用内部真实链路通过，但普通产品串行入口、首次/pending共用启动屏障、真实TESTER受控命令、accepted累计波次与交付仍待产品G5实测。

## 2026-09-25 首次与恢复启动门禁的当前实现边界

编排层在本机Git的首次TESTER路由上阻止普通State提交，改由受信任务串行准备入口返回已持久化且已登记的testing/pending后态；随后重新路由，首次和恢复的pending TESTER统一经过准入入口，才交WorkerRuntime。缺入口、错误阶段/worker/Integration、改变当前State均拒绝。L4确认服务的准入读取以唯一确认回执为起点，重新验证原native/Git登记与当前完整State；单元测试只证明控制次序，真实Git/native复核及完整回归结果以12.4历史中的本版证据为准。

Web组合根现在只暴露宿主注入的准备/准入接缝，生产单例尚未提供本机任务串行准备实例。因此现阶段缺少服务时保持拒绝，不能称普通Web任务已能完成首次TESTER验证。下一单元须把唯一计划发布、规范CAS、独立登记、确认和准入按同一受信任务队列接入本机组合根，并在真实TaskRuntime中验证模型、受控命令、固定HEAD测试回执；之后继续accepted累计波次与交付闭合。

## 2026-09-25 派发来源读取耗时复评

启动门禁版完整回归的首个旧两分支用例在原2700000ms超时，立即停止其余测试，不计G4。现场完整handoff已写出，唯一计划槽尚未发布，State仍为integrating；该次交接证明约在第38分钟才完成。将测试控制器一次紧邻准备服务的正例`handoff.read`观察合并进准备服务的真实读取后，定向重跑仍在原时限超时；这次handoff约第19分钟完成、唯一槽已发布，State仍为integrating。两轮没有发生validation登记或半State提交，显示首轮还受宿主时序波动影响，单靠测试读取去重不够。失败日志、现场hash及各自安全清理记录在12.4历史与忽略的`test-outputs/task124/`。

检查L2 CAS服务发现：在计划槽已发布之后，它为拿固定计划先调用一次完整原生/Git来源证明，随后在CAS紧前再次完整证明、提交后再次证明。首次读取的计划和当前控制可以由唯一槽的受信只读读取获得；它不能批准CAS。调整后CAS紧前和提交后仍分别调用完整物理证明，且提交前的证明必须与原计划、前态、context/roster相符；缺证明时拒绝State提交。端口红测先证实旧实现未调用固定计划读取，新实现的控制测试55项通过。原2700000ms真实两分支与全量回归仍须按修正版重新执行，未通过前不把G4或产品G5记成完成。

首轮单CODER真实复验在CAS前明确拒绝`initial_validation_preparation_state_changed`：固定计划读返回时漏掉原`call/version`，与完整物理读的整个对象比较不相等，State保持integrating且夹具自行清理。已将两端口的封闭返回形状统一为`stage/planHash/call/version/before/plan`，并在控制测试中逐字段复核、保留CAS前缺物理证据拒绝；该真实失败不记为通过。修正后仍须重跑真实链路及完整G4。

返回形状修正后的单CODER真实Git/native登记、确认与pending准入用例1/1通过（1145.22秒），冻结输入与HEAD不变，夹具自动移除专用根；证据见`test-outputs/task124/validation-proof-shape-repaired-single-result.json`。该结果证明新读取调度能接通真实来源，不替代先前超时的两CODER交接或完整G4；下一步仍按原2700000ms重跑两CODER用例。

随后同版两CODER真实交接与validation登记用例1/1通过（2232.52秒），保留原故障注入、断言和2700000ms时限；冻结文件、HEAD均不变，夹具自行删除专用根。它在约第27分钟完成handoff，并成功越过此前两轮超时的唯一槽/CAS节点，证据见`test-outputs/task124/validation-proof-shape-repaired-double-result.json`。这一结果不能改写此前超时；本版完整`pnpm test`仍需另跑。

## 2026-09-25 启动屏障回归、超时定位与控制对象读取复评

本机Git首次TESTER路由现要求宿主受信准备入口先发布计划、完成规范CAS、独立validation登记和准备确认，再重路由；首次与恢复的pending TESTER在WorkerRuntime前经同一准入读取，缺入口或当前State/worker/Integration漂移拒绝。现有Web组合根仅转发宿主注入端口，生产单例尚未提供服务，普通产品任务G5不得据内部端口测试宣称通过。

本版首次默认`pnpm test`先通过真实双CODER交接和IntegrationService，但随后两个真实Git用例报`local_git_deadline`；系统记录显示相同时间段闲置睡眠，运行又在部分输出后退出，只有4/270文件记录，不能算完整G4。冻结的1372项输入及HEAD未变；失败、睡眠、夹具与清理证据见`test-outputs/task124/validation-start-barrier-repaired-incomplete-audit.json`（SHA256 `b4cf7a172167a4c90aec6c55fad034cceef59d50469b1eaf6412d89393b3db0c`）。仅为测试进程阻止闲置睡眠后，首个旧双CODER交接仍在原45分钟处超时，立即停批；合成交接证明已写出，测试State尚未CAS。失败现场归档及安全清理见`validation-start-barrier-caffeinated-timeout-result.json`（SHA256 `55120c8af8e25b34fbd20860dcefd14fc0e7857847574075178a4e067e31aa4d`）。不能再将该超时仅归因于睡眠，也不扩大测试期限。

三项假设按证据审查：收尾`lsof`扫描在停用夹具上约0.4秒完成，不能解释21分钟等待；原生/Git来源读取和多次对象读取仍需验证；派发CAS/登记路径可能叠加真实证明耗时。保留原断言的定向计时用例1/1通过（2313.99秒）：交接证明约第25分钟，准备入口内`completion.readHandoff`约77秒，派发服务约8.5分钟，CAS约第30分钟，后续登记闭合。采样显示大量文件状态与子进程操作；不把一次采样当完整因果证明。检查`LocalControlObjects.read`发现每次读都再次fsync文件/目录且按16MiB上限分配缓冲；创建/ref发布已单独fsync，详设§12.3仅要求读取身份、权限、大小与内容hash。读取改为按已校验大小加一字节分配，保留读前后身份/时间/内容检查，写入耐久路径不变。

修正后受影响真实文件测试3文件/43项通过，静态检查全绿；原双CODER交接、派发和validation登记用例1/1在原时限与断言下通过，耗时1750.46秒（修正前定向2313.99秒），夹具37项原生及41项派发来源hash匹配、自行清理；日志`validation-start-barrier-control-read-handoff-test.log` SHA256 `78e3ef4fbb9306964f3f0169d887baa7ebfece1e684673806ee8f9a3fd645192`。首次超时和睡眠版本独立保留。此为性能与边界定向证据，当前源码完整`pnpm test`及产品G5仍待完成。

## 2026-09-25 控制对象读取修正版完整回归仍失败

对1372份源码/文档冻结输入执行默认`pnpm test`，追踪前置7项通过，但Vitest首个真实两CODER交接用例在原2700000ms时限超时；随即停批，实际仅1/270文件，未运行后续真实模型用例，**不能记G4通过**。进程绑定`caffeinate -i -s`有效，运行窗口没有系统睡眠，HEAD及全部冻结文件hash不变。现场有完整Integration.done、registry revision 14和已发布handoff plan，却没有handoff confirmed、交接证明文件、validation计划槽或登记；最后状态/registry约在21:59、Git对象约在22:00更新，22:26超时前没有后续落盘。5秒进程采样见主事件循环等待且当时无Git/native子进程，不能单凭采样断言具体死锁。

按证据排序的待查假设：①最终交接释放内的原完成证明/串行队列存在间歇等待，最贴近已释放claim但无confirmed的现场；②底层异步文件/进程回调在该次环境中异常延迟，虽无系统睡眠或整体磁盘饱和证据，仍需定位；③纯重复证明成本使原45分钟预算不足，但同版带阶段标记的定向完整走通只用1922.12秒，单靠平均成本不能解释25分钟静止。不得据一次定向通过宣布根因已修复，也不得扩大期限、删除反例或把未执行的270文件记为通过。

同一真实用例临时加入仅记录阶段/时间的标记后，在原断言和时限下1/1通过：累计集成约17分钟，失响应drain/release分别约2/1分钟，最终handoff约2分钟，派发约6分钟，独立登记约3分钟；夹具passed且自动移除。测试文件已按原字节恢复。失败根完整归档后，两处本轮测试专用根核对归属、无进程/句柄/挂载/Docker引用并清理447022逻辑字节；冻结输入及清理后的临时根集合复核通过。审计见忽略输出`test-outputs/task124/validation-start-barrier-control-read-failed-final-audit.json`，SHA256 `4819e23f363cacc7afc97fdb0fb68556fa3fe4e8ca372659b9680a167732cb64`。下一个验证单元应在handoff的最终`verify`及其内层只读证明、串行队列边界加入可撤销的时序/等待诊断，先定位间歇停滞再做最小修复；当前G4和普通产品G5均未闭合。

## 2026-09-26 产品入口与Git固定验证再审

Go订阅恢复后的上一代码版已完成270文件/2254项默认回归；这不等于本机Git产品链路G5。沿`task-runtime.ts`、`task-composition.ts`、`local-task-composition.ts`追踪发现，生产单例尚未提供`localFactory`；本机组合根当前没有`integrate`/`parallelContext`，TESTER完成回调仍调用只接受`mode=direct`及`kind=files`的`LocalValidationService`。桌面`DesktopService`持有私有state owner，但Web bootstrap只取得凭据状态；现无可供生产组合根任意创建已获批根、registry和受管工具链的授权入口。因此直接将首次准备服务注入单例，会把尚未闭合的Git生命周期误写成可用能力。Phase12仍只对获批验收目录做显式受信组合；普通项目入口按12.6及阶段门禁推进，不用内部夹具代替产品实测。

进一步核对受控命令：`LocalWorkspaceCommands.run`调用`LocalVersionStore.verify`，后者对`kind=git`明确报`git_workspace_verifier_required`；现有`localValidationCommand`/报告解析也只接受files版本。当前先增加Git专用的纯固定输入/完整报告单元，不更改普通目录行为；它尚不证明Git物理版本、真实命令或`wave_validation/v1`。后续顺序是：受信Git活版本验证及固定输入执行→独立TESTER提交HEAD/manifest与业务回执→累计accepted波次→获批验收组合根接入、同任务消息/CAS与首次/恢复运行实测→应用/复验/交付。每个前置步骤缺失时保持拒绝，不放宽旧direct或Docker保护。

同日随后完成第一段受信执行入口：`LocalWorkspaceAuthority`在活动lease、授权、规范State/registry与真实linked身份下捕获或重验精确HEAD/tree及文件manifest；`LocalWorkspaceCommands.runFixedGitValidation`只接受独立TESTER validation worktree中由完整manifest导出的Node测试集合，前后各校验活版本。原`runCommand`仍拒绝Git，`verifyCommand`可只读回查固定回执。真实受管Node/Seatbelt定向用例已执行提交后的CJS测试，拒绝模型式通用Git命令与缺测试的固定命令，结果及用户checkout HEAD/index不变见任务历史。宿主`WorkspaceWorkerSession`另设非模型的`inspectCommittedGit`和`runFixedGitValidation`：未完成`completeWorktree`先拒绝，提交后规范HEAD未持久化时捕获拒绝，持久化后才由宿主形成完整测试命令并运行；真实session定向用例已覆盖。它尚未接入WorkerRuntime的`completeLocalAssignment`业务回调，也没有形成`wave_validation/v1`或当前生产组合根能力；上一段“尚不证明真实命令”只描述当时纯输入单元，不能继续当作当前进度。
