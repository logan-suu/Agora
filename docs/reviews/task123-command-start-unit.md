# 12.3 受信暂停启动闸门

日期：2026-09-16。承接Leader“继续”，沿用已接受的原生有界清理、固定Seatbelt验收目录和Go固定测试授权，使用agora-retry-task恢复、agora-sync-docs同步。没有扩大部署/外发范围、添加依赖或开放产品入口。

## 问题与依据

此前监督夹具的项目载荷在stdin等待后才执行，能验证监督器，却不能证明任意项目代码在登记前不运行。正式约束仍为详设§12.2.2和§12.2.6：“受信 launcher 在 exec 项目代码前安装 Seatbelt 策略。”“停止检查和策略证据只由受信控制器生成，不接受模型/项目进程自报。”

Apple的[XNU exec实现](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_exec.c)在exec更新进程身份版本，并对`POSIX_SPAWN_START_SUSPENDED`在运行前暂停目标；[内核身份查找](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_proc.c)核对audit token中的版本。因此不能登记包装器后，假定其exec后的项目进程仍有同一身份。本机SDK公开的Darwin扩展定义包含START_SUSPENDED和CLOEXEC_DEFAULT，具体头文件hash见[sdk证据](task123-start-evidence/sdk-evidence.json)。这些源码/声明只提供机制依据，不替代真实探针或最低系统验证。

## 实现

新增内部`local-command-bootstrap.c`与`runHeldLocalCommand`。控制器以清空后重建的环境、固定stdio和私有fd3，先通过系统sandbox-exec进入既有Seatbelt策略，再运行受信bootstrap。bootstrap只在私有控制通道收到启动字符后，以START_SUSPENDED创建目标程序；它不运行项目shell字符串，也不在目标程序内注入等待逻辑。

顺序为：读取受信bootstrap就绪 → 从内核取得并持久登记bootstrap身份 → 创建已装载且暂停的目标 → 用现有内核父子关系复核目标身份 → 原子登记目标及关系 → 接上输出监督 → 重查受信授权接缝和当前日志revision/隔离状态 → 通过audit-token绑定的SIGCONT放行。启动期限5秒，计入默认30秒命令期限；错误、撤权、登记失败或期限耗尽不放行，尝试有界停止已核验身份并保留阻断。未能核验的身份不凭PID发信号，失败可能留下隔离的暂停资源，必须继续保留并另行核验，不能假报全部停止。

目标spawn使用CLOEXEC_DEFAULT，只有stdin/stdout/stderr显式继承，控制fd不传给项目程序。控制器不继承宿主环境，固定重建NODE_ENV、HOME、TMPDIR、LANG、LC_ALL；当前HOME/TMPDIR共用本命令新输出根，独立home/tmp/cache子域仍需后续完整布局。策略只新增受信bootstrap的精确执行/映射路径，不放开输出根执行。项目在运行后再次exec导致身份变化时，仍按既有规则标为不确定，不自动接管新身份。

bootstrap用真实waitpid取得目标退出码或信号，仅在私有控制通道回传。返回值将`payloadResult`与监督器的bootstrap `mainResult`分开：目标exit7或SIGUSR1时，bootstrap可以正常exit0，但不能据此报告项目成功。当前payloadResult只在内部启动返回值中，尚未形成正式持久工具/恢复回执；既有观察摘要持久化的是bootstrap观察事实，必须保留这一界限。前置启动失败另返回`startupStop`，不丢失停止是否成功的事实。

监督器现在可接受已登记的启动cohort，仍要求第一个身份对应活ChildProcess；只有内部受信放行回调在输出观察接好后执行一次。释放回调失败即进入已有不确定收尾。冻结SandboxManager方法、公共导出、Web/Desktop/MCP组合根均未改变。

## 验证

TDD先因fixture缺失而红；首轮6项真实测试通过。首次类型检查发现项目ProcessEnv要求NODE_ENV及测试可空记录，显式补全并校正类型后通过。补信号退出测试先得到目标exit7的预期红；固定探针随后启用SIGUSR1分支，没有改弱断言。最终8项启动测试已在Phase12累计8文件/55项测试中全通过（66.04秒）。其后保留启动失败停止回执并加入对应断言，最终版本由完整回归再验证。

真实探针在C构造函数立即写标记，没有项目自报就绪/等待协议。控制器在放行检查点确认标记不存在且两个内核身份已持久登记，放行后确认标记存在。其他用例覆盖撤权不运行、持久登记失败不运行、继承控制fd/宿主假秘密不可见、无效可执行文件、策略hash漂移无spawn、授权回调后日志隔离二次拒绝，以及目标信号与bootstrap退出区分。测试使用真实临时目录、编译器、Seatbelt、内核查询和信号，无mock。

最终源码原始`pnpm test`退出0：7项脚本测试、197个Vitest文件/1395项测试全部通过、0skip，583.49秒；8项新增启动场景在完整环境全通过。真实LRU130.269秒、Harness单回合10.985秒、群聊摘要6.335秒，均OpenCode Go deepseek-v4-flash；未换提供方、改期限、弱化断言或恢复正式Benchmark。最终typecheck、lint（514文件）和native构建通过，11份源码快照与完整回归输入一致。

当前主机仍为macOS26.5/arm64；编译目标15.0不等于macOS15真实验收。完整G4本轮通过，不能替代未完成的生产G5或12.3验收。

## 尚未完成的保护

- 受信可执行文件/工具链完整性、OS启动探测、持续grant与根/父链/输入版本绑定，范围清单/链接及硬链接准入；当前authorize只是内部受信接缝，不是已实装的Leader授权registry。
- 生产launcher/companion、持久目标退出回执和完整cleanup/output/resource状态闭合；新内部原语始终保持资源隔离，不签发checked、工具成功或可回收证明。
- D17 lease/composition admission、失败范围阻断及恢复；真实项目工具链、网络/IPC和服务场景、最低系统/签名应用与完整L01–L18仍待验收。

12.3保持in_progress；没有commit/push/PR。下一实现接合点是持续授权与根绑定，再接正式workspace能力，不能把本单元当完整生产G5。

## 证据与清理

每个fixture先保存OS/编译器、源码/二进制/策略hash、出生关系与返回结果，再核对同一uid/dev/inode/规范路径、无句柄和无挂载后清理。失败也留证；测试注入的固定journal锁只由固定fixture在控制器返回后复核并删除，产品不删除崩溃锁或恢复旧执行。

[Phase12累计](task123-start-evidence/phase12-regression.log)、[完整回归](task123-start-evidence/full-regression.log)、[类型检查](task123-start-evidence/typecheck-final.log)、[Lint](task123-start-evidence/lint-final.log)、[native构建](task123-start-evidence/native-build.log)、[源码快照](task123-start-evidence/source-checkpoint.json)。原始fixture的binaries字段记录编译后初始字节；bad-executable随后注入固定无效字节，其输入hash另见[固定故障输入](task123-start-evidence/fault-input-evidence.json)，不将初始二进制hash冒充故障时输入。

最终清理：122个单元fixture（启动30个）全部留证并删除；完整回归另152个目录在来源/身份/内容hash/无句柄/无挂载复查后删除，31个停用证据不足目录保留。APFS空间观察+6541312字节，不当作精确回收量。临时清理控制器归档后删除；没有停止用户服务，未删除用户项目、正常依赖/共享缓存、安装应用或产品数据。见[单元清理索引](task123-start-evidence/unit-fixture-cleanup-index.json)、[回归清理](task123-start-evidence/full-regression-cleanup.json)、[最终60份证据索引](task123-start-evidence/summary.json)。此前45+23+44+67+52份历史证据hash保持。
