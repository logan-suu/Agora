# 12.3 文件事务首单元实现与验证

日期：2026-09-15。承接[规格复评](task123-spec-reasonableness.md)和Leader“好的继续”。

## 当前结论

新增内部单文件替换原语：真实Seatbelt进程、同句柄读版本、持久prepared、同卷候选准备、关闭候选写fd、原子交换保留旧inode、交换后校验和不可变结果回执。17项事务测试与5项原语诊断通过；不是12.3全部完成，也不是正式workspace端口G5通过。

原语尚未接入包公开导出、默认native构建/桌面打包、授权registry、TaskState、MCP或普通项目入口。测试使用受信clang在已获批的临时目录编译，不冒充11.4受管工具链或最低macOS验证。

## 已实现的行为

- root及其规范父链、目标父链、技术暂存区固定dev/inode；每次原生检查点与副作用前复核。主进程在最终异步授权返回后再次复核，避免等待期间发生漂移却仍写applied。
- 原生读取从同一次打开取UTF-8内容、inode、mode/uid/gid及扩展属性指纹；拒绝路径重定向、多硬链接、特殊文件、超限和不支持的元数据。读取内容上限16MiB；当前原语不支持二进制、非空ACL及特殊文件flags，明确拒绝，不静默丢失。
- 扩展属性纳入版本，候选复制后再比对；测试含系统自动添加属性、自定义属性和可执行位。候选自身写fd在进入源码路径前关闭。源文件从不以可写data fd打开。
- 应用状态与项目分目录：预期内容、候选内容和prepared先持久化；原生进程按checkpoint等待受信控制面授权。helper不执行项目代码，策略不允许fork；主进程等真实退出后才确认该原语的fd已关闭。此证明不适用于将来允许派生后代的项目命令。
- 发现根/父链变化、授权撤回或冲突立即停止后续步骤；已发生交换则如实保留exchanged事实与原inode，不自动回滚。未知原生结果用exchanged=null/recoveryRequired，不把非零退出等同于无副作用。
- 同actionId同输入只返回已闭合回执；不同输入、缺失或不一致回执拒绝，不重跑交换。这里是技术journal，不能替代正式授权/claim CAS或跨registry与TaskState的闭合协议。

## 测试与修复证据

入口：`tests/integration/phase12/phase12-3-transaction.test.ts`。覆盖正常替换、根移动、父目录移动、替换根、交换后根移动、用户内容冲突、符号/硬链接、同输入重放、最终授权期间根/父移动、元数据冲突、准备/交换前撤回，以及异输入/坏回执/缺回执重放。

TDD首轮缺fixture导致收集失败。实现后的早期失败及修复：

1. macOS没有本实现误用的`closefrom`声明：移除该调用，以禁止fork的真实进程退出和host close事件确认全部fd释放；不把stdout结果行当收敛证据。
2. 外层研发沙箱禁止嵌套sandbox_apply：受审批的测试控制器在外层运行，实际被测helper仍强制Seatbelt；没有裸跑fallback。
3. `O_RDONLY`父链目录句柄需要该目录自身的读取权限：加入逐项literal规则，不开放父目录的其他后代文件。
4. 新建文件存在系统扩展属性，不能以“无xattr文件”代表正常用户文件：增加同句柄属性指纹和复制/复核，不删除测试文件属性规避。
5. 新增竞争用例复现最终异步authorize期间根移动仍报applied：等待返回后重核根/父链，测试转绿；不修改断言。

原探针“OS必须撤销旧fd”的失败断言已按获批规格复评调整为OS行为诊断；原测试源码逐字保存在[原断言](task123-transaction-evidence/original-phase12-3.test.ts.txt)，SHA-256仍为`6bebd29a2719a4e2682f8f8b433b44cc9a49c2124555b7e4383202a1083a2358`。原始4通过/1失败与25份旧证据保持，不改写为历史通过。新的停止/回执/保全保证由上述17项真实事务测试承担，不能仅凭旧探针新断言算G5。

当前宿主macOS26.5/build25F71 arm64，研发控制器Node24.20.0、Apple clang21.0.0；编译目标macOS15不等于在macOS15实测。结果见[22项测试日志](task123-transaction-evidence/verified-tests.log)、[类型检查](task123-transaction-evidence/typecheck.log)、[lint](task123-transaction-evidence/lint.log)及[证据索引](task123-transaction-evidence/summary.json)。`pnpm build:sandbox-native`也通过，它构建的是既有正式helper，不将新增原语冒充已打包产品能力。

## 完整回归与下一检查点

完整`pnpm test`首次请求被自动审批拒绝，未启动：审批器认为真实OpenCode Go模型外发内容尚未明确授权。列明固定算术任务、虚构群聊事实、临时LRU任务/生成代码/测试结果，以及Agora角色提示与工具描述后，Leader明确回复“授权”；随后自动审批通过原命令，未绕过拒绝或改测试匹配。

**授权后完整回归通过**：7项任务追踪脚本测试通过，Vitest 191个文件/1362项测试全部通过，0失败，Vitest用时544.27秒。三个真实模型用例（LRU闭环、Harness单回合、群聊摘要）日志均确认为`opencode-go/deepseek-v4-flash`；没有启动正式Benchmark，没有切换提供方/模型或跳过测试。日志见[完整回归](task123-transaction-evidence/full-regression.log)。当前代码G4通过，不代表尚未实现的命令执行/授权registry/MCP已通过G5，也不将12.3标完成。

单元A后续还需真实验证项目命令的源码只读、输出准入、凭据/网络/IPC隔离及后代收敛（L03/L04/L05/L14/L15）。本机SDK `sys/event.h`明确写`NOTE_TRACK, NOTE_TRACKERR, and NOTE_CHILD are no longer supported as of 10.5`，且NOTE_FORK不向实际kevent传递child PID；因此不能直接采用kqueue自动递归跟踪或“父进程退出/进程组为空”作为证明。这只是排除未经支持的实现假设，尚未证明所有候选机制不可行，也未获L14通过。若不能证明收敛，按既定契约needsAttention并保留资源，不提前启用依赖它的registry/MCP产品执行。

## TEST-CLEANUP

本轮事务控制器生成的82个专用fixture均在证据先落盘后，核验uid/dev/inode/realpath、进程退出、lsof无句柄和无对应挂载，清理成功且路径不存在。各路径、结果及可用空间变化逐条入JSON；APFS可用空间变化不当作精确回收字节数。没有下载/安装第三方依赖；正常项目native构建产物保留。旧原语诊断的新测试fixture按其控制器同样留证清理。未删除用户项目、产品数据、共享缓存或钥匙串。

### 完整回归后的清理

完整回归新增测试产物另作来源与句柄核验，删除152个确认停用的测试目录（含真实LRU测试产物），完整路径/清单hash及两次清理结果见[初次清理](task123-transaction-evidence/full-regression-cleanup.json)和[补充清理](task123-transaction-evidence/full-regression-cleanup-followup.json)。31个目录因虚拟化进程仍持有只读目录句柄保留，未强停用户服务；释放后须重新核验才可清理。此保留不改变测试通过事实，也不冒充清理全部完成。APFS可用空间变化不代表精确回收量。
