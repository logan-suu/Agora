# D4/D9 重复裁决修复与真实双存储窗口实验

日期：2026-09-17。授权：Leader在下一步计划后明确“开始进行”。分支`codex/fix-human-gate-replay`，基线`55d6385a8387634864886dfdec38a8d9b1fa804e`。原12.3的完成状态保留，本记录是已交付链路后续修复，不启动12.4，也不将LangGraph切换为产品引擎。未commit/push、建PR或合并。

## 修复内容

原失败保留于[第二轮实验](../langgraph-spike-20260917/README.md)：worker从paused正常恢复到done后，D9重复请求仍调用只接受paused的校验器，导致同一裁决误报冲突。

- `readHumanGateWorkerResumes`校验不可变计划的形状、唯一身份、排序和refs集合；原`validateHumanGateWorkerResumes`继续追加首次恢复所需的paused/ref一一对应条件，未放宽Fork准入。
- marker的正式写入和重放共用`assertHumanGateResumedMarker`。Web入口有规范marker时，核验当前worker、source作用域和连续session身份后返回已应用，不再次调用resume。没有marker时仍可续办原暂停恢复。
- 允许running/done/failed、多worker混合状态、新pause和经规范后续裁决证明的child；拒绝缺worker、缺计划、篡改receipt/marker、跨任务source、无依据的session切换及断裂lineage。旧gate被异常恢复为active也拒绝，后来的合法gate不受旧请求影响。
- Harness只读metadata补充`sourceSessionId`以核对后续child的连续性；opaque ref仍原样交回官方会话加载器。没有实现第二套Harness loop、会话存储或恢复器，冻结Executor方法不变。
- 规范marker后的请求重放只确认原D4动作，不借旧source重跑另一次进程中断。整任务崩溃恢复仍是独立能力，不能用重复裁决冒充。

相关来源已按顺序同步：蓝图§21、详细设计§5、架构§4.2、开发计划Phase12后续维护说明、D9摘要及12.3历史/短索引。技术栈、产品依赖、当前阶段与原任务done状态未改变。

## 验证与原始失败

| 检查 | 结果 |
| --- | --- |
| 新HTTP/真实JSON State回归，修复前 | 6失败/8通过，保留原失败事实 |
| 最终定向回归 | 4文件57项通过，包含原Phase8持久恢复测试；新文件16项 |
| 类型/格式 | 全项目typecheck、589文件lint及实验定向tsc通过 |
| 任务索引 | check通过，171任务/31阶段/25决策/69历史 |
| 原真实失败路径 | 正常完成后同D9请求成功，TaskState不变、生命周期不重入、无新增派工或工具调用 |
| failed后的重复裁决 | 首次真实请求遇到STREAM_CLOSED，worker失败并释放lease；重复裁决确认已应用，failed worker没有重启 |
| 全量回归 | `pnpm test`退出0；7项脚本测试、227文件/1768测试全通过，0失败/skip，1070.88秒；包含新增16项D9回归 |

本轮曾因文本替换误把main限制加到无关onboarding重放，既有子Channel拒绝回执测试立即失败；已撤回该无关改动，原断言未改，最终定向57项通过。该中间失败不是新的产品规则。

真实模型始终使用OpenCode Go / `deepseek-v4-flash`。第一次恢复请求的SSE提前关闭，官方有界恢复耗尽后明确失败，没有换提供方、模型或skip。保留该失败任务，再创建新的独立虚构任务完成同一固定LRU测试。成功路径仍通过正式本机授权、APFS版本事务、WorkerRuntime、Harness/MCP及Seatbelt内受管Node；5项测试全通过，原测试和假凭据文件未改动。

## 双存储窗口：已证明与限制

机器结果见[native-window-results.json](native-window-results.json)，保留本轮适配源码[sources/native-window.test.ts](sources/native-window.test.ts)。

1. 第二个真实任务已经完成业务State提交、官方会话持久化及真实本机命令回执，worker为done，lease=0，composition已dispose。
2. 首次用`process.exit(89)`注入被Vitest拦截为异常；只拦截`putWrites`也不能阻止另一个最终checkpoint写入。随后检查图已完成，因此**该次不算进程崩溃实验**。
3. 调整为同时拦截最终`put`与`putWrites`，通过官方图历史选择已经记录的待dispatch checkpoint，保留真实已完成业务State；这个历史选择仅为构造丢失图进度的实验输入，没有给产品增加time-travel重跑入口。
4. 对账器核验已完成worker的D9 receipt/marker及真实工作区测试回执后，在最终图输出尚未写入时对独立测试进程发送SIGKILL。信号发生前模型、工具及所有worker lease均已自然结束；没有中止LLM token流。runner的非零退出和IPC关闭是这次故障注入的预期结果，不能计作普通测试pass。
5. 下一进程首次启动被现有`.desktop-owner`遗留锁拒绝为`state_in_use`。确认记录PID就是本实验已退出进程、目录无句柄、锁dev/inode不变后，仅回收该fixture锁，TaskState hash未变。**这不是产品自动锁恢复能力**。
6. 接着新进程只读检查图仍待`continued`而业务worker已done；显式继续时，仅复核scope/session、既有命令receipt、inputVersion和当前授权，然后补齐图结果。再重复D9/图resume：真实派工总计仍为1，未新增模型/工作区工具调用；故障前、对账后、重复继续后的命令回执完全相同，生成文件hash不变。

该结果将S05从纯文件fixture推进到真实TaskState、官方Harness会话、本机版本/命令回执上的固定派工对账。它**不等于通用dispatch receipt协议已在产品落地**，也不覆盖效果已经发生但业务回执缺失、真实Git累计集成/D16、所有进程故障窗口或整应用冷启动。owner锁接管是正式崩溃恢复的前置问题；本轮只修D9，不擅自修改宿主所有权机制。

## 复现

正常产品回归入口：

```sh
pnpm exec vitest run apps/web/test/human-gate-replay.test.ts apps/web/test/message-flow.test.ts packages/core/orchestration/test/human-gate.test.ts tests/integration/phase8/human-gate-lifecycle.test.ts
pnpm build:sandbox-native
pnpm typecheck
pnpm lint
pnpm test
```

独立实验沿用[第二轮的package锁文件及配置](../langgraph-spike-20260917/README.md#4-复现)，将本目录`native-window.test.ts`复制到`test-outputs/langgraph-spike-round2/src/live.test.ts`。设置`LG_RUN_ID`可在同一results根创建独立attempt，不复用failed worker。每个mode是新Vitest进程，按顺序等待退出；真实模型和原生授权检查需要相应网络/宿主权限。

- `initial → inspect → resolve`：真实暂停、只读加载、裁决落盘。
- `resume-crash`：保留第一次故障探针的调用名，当前最终源码已不在此模式注入退出，会正常完成真实执行；历史被拦截的退出证据仍保留。
- `crash-reconcile`：选择已记录的待dispatch checkpoint，复用真实已完成业务结果，在图写入前SIGKILL；预期runner非零且fault-window记录证实安全边界，不能把任意错误当作成功注入。
- 冷启动先观察`state_in_use`；只允许在独立fixture已确认PID退出、无句柄、身份无漂移时回收其遗留锁，记录TaskState未变。没有生产自动接管脚本。
- `inspect-crash → reconcile → duplicate`：分别证明进度差异、显式对账和不重复执行。`failed-duplicate`用于保留的failed任务，不能用于把failed改回可运行。

清理与最终源码/版本/hash见[validation.json](validation.json)及[cleanup.json](cleanup.json)。第一、二轮历史附件不修改；原始模型reasoning、完整会话、重复日志、临时依赖和工作区不作为交付文件保留。

全量回归收尾另外保存本轮335份测试输出的hash、来源及fixture清理事实，再核验无句柄/挂载，连同42份专用中间文件共删除377份、4049799逻辑字节；观察可用空间增加4845568字节，不声称独占回收量。详见[回归清理记录](regression-cleanup.json)。旧输出、未知归属临时目录、正常项目依赖、已安装应用及产品数据未动。全量启动时599份来源中，最后一项同gate损坏防护及其测试在首个无关Phase0长测试期间补入；最终受影响Web套件明确运行16项新增测试，6份最终修改来源hash匹配，不把启动后的修改冒称为全程冻结。
